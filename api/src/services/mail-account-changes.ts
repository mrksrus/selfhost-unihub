import type { ExecuteValues, RowDataPacket } from 'mysql2/promise';
import type { ApiError, MailAccountIdentity, StoredFlag } from '../types';
import type { PolicyActor } from './settings';
import * as mailWritebacks from './mail-writebacks';
import { mailAccountModeChange, sameProviderMailbox, modePolicyInput, assertModeAllowed, modePolicyKeys } from './mail-account-mode';
import { parseMailAccountInput } from './mail-account-input';
import * as mailSyncPolicy from './mail-sync-policy';
import { withMailAccountLock } from './mail-account-lock';
import crypto from 'crypto';
import { db } from '../state';
import { withTransaction } from './transactions';
import { assertFinalStep } from './final-step';
import { encrypt } from '../security/encryption';
import { inspectMailCertificate, normalizeFingerprint } from '../security/mail-certificates';
import {
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  toBooleanFlag,
  ensureDefaultMailFoldersForUser,
  normalizeSyncFetchLimit,
  seedMailServerDeletionQueueForAccount,
  buildMailHostTrustResult,
  validateMailHostPolicy,
  testImapConnection,
  stopMailAccountWork,
  scheduleMailAccountSync,
} from './mail';
import * as calendarAccounts from './calendar-accounts';
import { log } from '../log';

// Adding and changing a mail account: POST and PUT /api/mail/accounts[/:id]
// (routes/mail-accounts.ts) and the administrator's path for a person
// (routes/admin-people.ts) run these same steps, with the person's id. The
// answers are the routes' (a refusal with its status, or the account); a
// thrown error is the route's to answer (routes/mail-route-helpers.ts
// routeError). The
// mode and the provider-deletion switch depend on the body, so their
// data-safety policies are checked here (services/mail-account-mode.ts);
// an administrator's actor passes them (F13).

/** Starts the account's mail sync without waiting for it; false when one is already running (routes/mail-route-helpers.ts re-exports it). */
async function startMailSyncInBackground(accountId: string, label = accountId, options: Record<string, unknown> = {}) {
  const job = await scheduleMailAccountSync(accountId, options);
  if (job.skipped) return null;
  job.promise
    .then((result: { success?: boolean; error?: string } | null | undefined) => {
      if (result?.success === false) log.error('SYNC', `Background sync failed for ${label}`, result.error || 'Unknown error');
    })
    .catch((error: Error) => log.error('SYNC', `Background sync failed for ${label}`, error));
  return job.started;
}

interface Input extends Record<string, unknown> {
  email_address?: string;
  display_name?: string;
  provider?: string;
  username?: string | null;
  imap_host?: string;
  imap_port?: number | string;
  smtp_host?: string;
  smtp_port?: number | string;
  encrypted_password?: string;
  sync_fetch_limit?: unknown;
  delete_emails_on_server?: unknown;
  accept_host_trust?: unknown;
  trusted_imap_fingerprint256?: unknown;
  trusted_smtp_fingerprint256?: unknown;
  try_calendar_sync?: unknown;
  caldav_url?: string | null;
  time_zone?: unknown;
  is_active?: unknown;
  sync_window_days?: unknown;
  trash_window_days?: unknown;
  confirm_address?: unknown;
  encrypt?: unknown;
}
interface AccountRow extends RowDataPacket, MailAccountIdentity {
  id: string;
  user_id: string;
  email_address: string;
  imap_host: string;
  smtp_host: string;
  smtp_port: number | string;
  encrypted_password: string | null;
  is_active: StoredFlag;
  display_name: string | null;
  sync_policy_confirmed_at: string | Date | null;
  sync_window_days: number | null;
  trash_window_days: number | null;
  sync_fetch_limit: number | null;
}

async function buildHostTrustConfirmationResponse({ imap_host, imap_port, smtp_host, smtp_port, imapTlsError, smtpTlsError }: Parameters<typeof buildMailHostTrustResult>[0]) {
  const mailHostTrust = await buildMailHostTrustResult({
    imap_host,
    imap_port,
    smtp_host,
    smtp_port,
    imapTlsError,
    smtpTlsError,
  });
  return {
    error: 'Review and confirm mail server authenticity before continuing.',
    status: 409,
    requiresHostTrustConfirmation: true,
    mailHostTrust,
  };
}

// The certificates the user saw when confirming the server; the account then
// trusts exactly these (security/mail-certificates.ts). An older client sends
// none: the IMAP certificate of the confirming login is kept instead, and the
// SMTP one at the first send.
function confirmedFingerprints(body: Input): { imap: string | null; smtp: string | null } | ApiError {
  const parse = (value: unknown) => value === undefined || value === null || value === '' ? null : normalizeFingerprint(value) ?? false;
  const imap = parse(body.trusted_imap_fingerprint256), smtp = parse(body.trusted_smtp_fingerprint256);
  if (imap === false || smtp === false) return Object.assign(new Error('Certificate fingerprints must be SHA-256 fingerprints'), { status: 400, code: 'INVALID_FINGERPRINT' });
  return { imap, smtp };
}

const ACCOUNT_COLUMNS = `id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
  smtp_host, smtp_port, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
  server_delete_enabled_at, server_delete_grace_until, server_delete_last_run_at,
  is_active, disconnected_at, engine_version, last_synced_at, created_at,
  sync_window_days, trash_window_days, sync_policy_confirmed_at, signature_html, signature_text,
  (encrypted_password IS NOT NULL) AS has_saved_password`;

// Sync policy fields of the account JSON. Removal counts are only computed for
// Sync accounts whose policy is not confirmed yet (what confirming would remove).
async function withPolicyFields(account: AccountRow) {
  if (!account) return account;
  const windows = mailSyncPolicy.storedWindows(account);
  let pending: number | null = null, warnings: string[] = [];
  if (account.sync_mode === 'sync') {
    try { pending = await mailSyncPolicy.pendingRemovals(account); }
    catch (error) { log.error('ACCOUNT', 'Could not count pending Sync removals', error); }
    try { warnings = await mailSyncPolicy.syncWarnings(account); }
    catch (error) { log.error('ACCOUNT', 'Could not check Sync warnings', error); }
  }
  const { sync_policy_confirmed_at: confirmedAt, ...rest } = account;
  return { ...rest, delete_emails_on_server: toBooleanFlag(account.delete_emails_on_server), has_saved_password: toBooleanFlag(account.has_saved_password),
    sync_window_days: windows.sync, trash_window_days: windows.trash,
    sync_policy_confirmed: !!confirmedAt, sync_policy_pending_removals: pending, sync_warnings: warnings };
}
async function loadAccountJson(userId: string, accountId: string) {
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>(`SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE id = ? AND user_id = ?`, [accountId, userId]);
  return rows[0] ? withPolicyFields(rows[0]) : null;
}

async function createMailAccount(userId: string, input: Input, actor: PolicyActor = {}) {
  // The policies for new accounts preselect the mode and the deletion
  // switch, and refuse a choice against them, before anything else.
  const body = await modePolicyInput(userId, input, actor);
  // A refused field answers 400 here, before the provider is contacted;
  // the connection test and the stored row use these same values.
  const { email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password } = parseMailAccountInput(body);
  const { sync_fetch_limit, accept_host_trust, try_calendar_sync, caldav_url } = body;
  log.info('ACCOUNT', `Add mail account requested for ${email_address} via ${provider}`);

  const normalizedSyncFetchLimit = normalizeSyncFetchLimit(sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT);
  if (!normalizedSyncFetchLimit) {
    return { error: 'Invalid sync fetch limit. Allowed value: all', status: 400 };
  }

  const trustAccepted = toBooleanFlag(accept_host_trust);
  const confirmed = trustAccepted ? confirmedFingerprints(body) : { imap: null, smtp: null };
  if (confirmed instanceof Error) return { error: confirmed.message, code: confirmed.code, status: 400 };
  const modeChange = mailAccountModeChange(null, body);
  await assertModeAllowed(userId, null, modeChange, actor);
  const serverDeleteEnabled = modeChange.deleteEnabled;
  // Missing: all mail, and 30 days for Trash/Junk. Windows apply in Sync only.
  const syncWindowDays = mailSyncPolicy.parseWindowDays(body.sync_window_days, 'sync_window_days') ?? null;
  const parsedTrashWindow = mailSyncPolicy.parseWindowDays(body.trash_window_days, 'trash_window_days');
  const trashWindowDays = parsedTrashWindow === undefined ? mailSyncPolicy.DEFAULT_TRASH_WINDOW_DAYS : parsedTrashWindow;

  log.info('ACCOUNT', `Checking mail host policy for ${email_address}: IMAP ${imap_host}:${imap_port}, SMTP ${smtp_host}:${smtp_port}`);
  const hostPolicyResult = await validateMailHostPolicy({
    imap_host,
    imap_port,
    smtp_host,
    smtp_port,
  });
  log.info('ACCOUNT', `Host policy check complete for ${email_address}: blocked=${hostPolicyResult.mailHostTrust?.blocked ? 'yes' : 'no'}, trust_accepted=${trustAccepted ? 'yes' : 'no'}`);
  if (hostPolicyResult.error) {
    log.warn('ACCOUNT', `Host policy rejected for ${email_address}: ${hostPolicyResult.error}`);
    return hostPolicyResult;
  }

  const encryptedPasswordForStorage = encrypt(encrypted_password);
  // Verify authentication using strict TLS unless the user explicitly accepted an IMAP certificate failure.
  const tempAccount = {
    email_address,
    username,
    imap_host,
    imap_port,
    allow_self_signed: trustAccepted ? 1 : 0,
    trusted_imap_fingerprint256: confirmed.imap,
    encrypted_password: encryptedPasswordForStorage,
  };

  // Test IMAP connection and auth (wrong password / connection errors still returned)
  log.info('ACCOUNT', `Testing IMAP connection for ${email_address} (strict_tls=${trustAccepted ? 'no' : 'yes'})...`);
  let keptImapFingerprint: string | null = null;
  const testResult = await testImapConnection(tempAccount, { record: fingerprint => { keptImapFingerprint = fingerprint; } });

  if (!testResult.success) {
    // After a confirmation this means the certificate changed since it was shown: show the new one.
    if (testResult.tlsTrustError) {
      log.warn('ACCOUNT', `IMAP TLS trust confirmation required for ${email_address}: ${testResult.details || testResult.error}`);
      return buildHostTrustConfirmationResponse({
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        imapTlsError: testResult.details || testResult.error,
      });
    }
    return {
      error: testResult.error,
      details: testResult.details,
      status: 400
    };
  }

  // Auth successful - save account immediately, after the final check
  // (final-step.ts): accounts.add and the mode's policies as committed now
  // (an administrator's actor passes them), Mail on and not being restored.
  const accountId = crypto.randomUUID();
  await withTransaction(async cx => {
    await assertFinalStep(cx, { userId, policies: ['accounts.add', ...modePolicyKeys(null, modeChange)], actor, modules: ['mail'] });
    await cx.execute(
      `INSERT INTO mail_accounts
         (id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
          smtp_host, smtp_port, encrypted_password, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
          server_delete_enabled_at, server_delete_grace_until, allow_self_signed,
          trusted_imap_fingerprint256, trusted_smtp_fingerprint256,
          sync_window_days, trash_window_days, sync_policy_confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${serverDeleteEnabled ? 'UTC_TIMESTAMP()' : 'NULL'},
               ${serverDeleteEnabled ? 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)' : 'NULL'}, ?, ?, ?, ?, ?,
               ${modeChange.mode === 'sync' ? 'UTC_TIMESTAMP()' : 'NULL'})`,
      [
        accountId,
        userId,
        email_address,
        display_name,
        provider,
        username,
        imap_host || null,
        imap_port,
        smtp_host || null,
        smtp_port,
        encryptedPasswordForStorage,
        normalizedSyncFetchLimit,
        modeChange.mode,
        modeChange.mode === 'sync' ? 'pending' : 'idle',
        serverDeleteEnabled ? 1 : 0,
        trustAccepted ? 1 : 0,
        trustAccepted ? confirmed.imap ?? keptImapFingerprint : null,
        trustAccepted ? confirmed.smtp : null,
        syncWindowDays,
        trashWindowDays,
      ]
    );
  });
  await ensureDefaultMailFoldersForUser(userId);
  // A new Sync account has no local-only mail yet: its policy is
  // confirmed at creation (sync_policy_confirmed_at above).
  const accounts = [await loadAccountJson(userId, accountId)];

  let calendarSync: Record<string, unknown> | null = null;
  if (toBooleanFlag(try_calendar_sync)) {
    try {
      const connected = await calendarAccounts.connectCalDavAccount({
        userId,
        emailAddress: email_address,
        displayName: display_name || email_address,
        username,
        password: encrypted_password,
        imapHost: imap_host,
        caldavUrl: caldav_url || null,
        mailAccountId: accountId,
        timeZone: body.time_zone,
      // The calendar just connected is this mail account's: one a sync linked
      // to it by address meanwhile is unlinked in the same transaction.
      }, { actor, mail: { id: accountId } });
      calendarSync = {
        attempted: true,
        success: true,
        account: connected.account,
        calendars: connected.calendars.length,
        server: connected.server || null,
        hint: connected.hint || null,
      };
    } catch (calendarError) {
      log.warn('CALDAV', `Calendar setup failed for ${email_address}`, undefined, calendarError);
      calendarSync = {
        attempted: true,
        success: false,
        code: (calendarError as ApiError).code || null,
        warning: (calendarError as ApiError).status ? (calendarError as ApiError).message : 'Calendar setup failed',
      };
    }
  }

  // Start sync in background (non-blocking)
  log.info('ACCOUNT', `Starting background sync for ${email_address}...`);
  const syncStarted = await startMailSyncInBackground(accountId);

  // Return success immediately
  return {
    account: accounts[0],
    authSuccess: true,
    syncInProgress: syncStarted,
    calendarSync,
    mailHostTrust: hostPolicyResult.mailHostTrust,
    message: syncStarted
      ? 'Account connected successfully. Syncing emails in the background — this may take several minutes for large mailboxes.'
      : 'Account connected successfully. A mail sync is already running; this account will sync on the next scheduled pass.'
  };
}

async function updateMailAccount(userId: string, id: string, body: Input, actor: PolicyActor = {}) {
  const { sync_fetch_limit, accept_host_trust } = body;

  // Verify account belongs to user
  const [accounts] = await db.execute<(RowDataPacket & AccountRow)[]>(
    'SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  if (accounts.length === 0) return { error: 'Account not found', status: 404 };
  // Checked before the lock and before any work stops: a refused field
  // leaves a working account untouched. The values used below come from
  // the row re-read under the lock.
  const requested = parseMailAccountInput(body, accounts[0]);
  const requestedMode = mailAccountModeChange(accounts[0], body);
  await assertModeAllowed(userId, accounts[0], requestedMode, actor);
  // Accepted in both modes (they only take effect in Sync); missing = unchanged.
  const requestedSyncWindow = mailSyncPolicy.parseWindowDays(body.sync_window_days, 'sync_window_days');
  const requestedTrashWindow = mailSyncPolicy.parseWindowDays(body.trash_window_days, 'trash_window_days');
  const stopRequired = Boolean(requestedMode.changed || body.is_active === true || requested.encrypted_password !== undefined
    || requested.email_address !== undefined || requested.imap_host !== undefined || requested.imap_port !== undefined
    || requested.username !== undefined || body.delete_emails_on_server !== undefined);
  return await withMailAccountLock(id, async () => {
  const [fresh] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
  if (!fresh.length) return { error: 'Account not found', status: 404 };
  const existingAccount = fresh[0];
  const modeChange = mailAccountModeChange(existingAccount, body);
  await assertModeAllowed(userId, existingAccount, modeChange, actor);
  const { email_address, display_name, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, next } = parseMailAccountInput(body, existingAccount);
  const { email_address: nextEmailAddress, username: nextUsername, imap_host: nextImapHost, imap_port: nextImapPort, smtp_host: nextSmtpHost, smtp_port: nextSmtpPort } = next;
  if (!sameProviderMailbox(existingAccount, { email_address: nextEmailAddress, username: nextUsername, imap_host: nextImapHost, imap_port: nextImapPort })) {
    const [identified] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT id FROM emails WHERE mail_account_id = ? AND user_id = ? AND (imap_uid IS NOT NULL OR remote_uid IS NOT NULL) LIMIT 1', [id, userId]);
    if (identified.length) return { error: 'This account already contains imported mail. Add a separate account for a different mailbox or IMAP server to preserve message identity.', status: 409 };
  }
  const nextEncryptedPassword = encrypted_password ? encrypt(encrypted_password) : existingAccount.encrypted_password;
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') return { error: 'Active state must be boolean', status: 400 };
  // Disconnect deletes the stored password; an account a restore paused
  // keeps it, so it reconnects with that password after a fresh login test.
  if (body.is_active === true && !encrypted_password && (existingAccount.disconnected_at || !existingAccount.encrypted_password)) {
    return { error: 'Reconnect by providing and verifying the account credentials again.', status: 400 };
  }
  if (body.is_active === false) return { error: 'Use Disconnect to pause this account and remove its stored credentials.', status: 400 };
  const trustAccepted = toBooleanFlag(accept_host_trust);
  const confirmed = trustAccepted ? confirmedFingerprints(body) : { imap: null, smtp: null };
  if (confirmed instanceof Error) return { error: confirmed.message, code: confirmed.code, status: 400 };
  const imapServerChanged = imap_host !== undefined || imap_port !== undefined;
  const hostSettingsChanged = Boolean(body.is_active === true || imap_host !== undefined || imap_port !== undefined || smtp_host !== undefined || smtp_port !== undefined);
  const imapLoginSettingsChanged = Boolean(body.is_active === true || email_address !== undefined || username !== undefined
    || imap_host !== undefined || imap_port !== undefined || encrypted_password !== undefined);
  let shouldUpdateTlsTrust = false;
  let nextAllowSelfSigned = toBooleanFlag(existingAccount.allow_self_signed) ? 1 : 0;
  let keptImapFingerprint: string | null = null;
  let nextSmtpFingerprint: string | null | undefined;

  if (hostSettingsChanged) {
    const hostPolicyResult = await validateMailHostPolicy({
      imap_host: nextImapHost,
      imap_port: nextImapPort,
      smtp_host: nextSmtpHost,
      smtp_port: nextSmtpPort,
    });
    if (hostPolicyResult.error) return hostPolicyResult;
  }

  // A confirmed account moving to another SMTP server keeps trusting only
  // a certificate that verifies, unless the user confirms the new one.
  if ((smtp_host !== undefined || smtp_port !== undefined) && !trustAccepted && !imapServerChanged && toBooleanFlag(existingAccount.allow_self_signed)) {
    const smtpCertificate = await inspectMailCertificate(nextSmtpHost, Number(nextSmtpPort) || 587, 'smtp').catch((error: Error) => ({ authorized: false, authorizationError: error.message, fingerprint256: null }));
    if (!smtpCertificate.authorized || !smtpCertificate.fingerprint256) {
      return buildHostTrustConfirmationResponse({
        imap_host: nextImapHost, imap_port: nextImapPort, smtp_host: nextSmtpHost, smtp_port: nextSmtpPort,
        smtpTlsError: smtpCertificate.authorizationError || 'The certificate could not be verified',
      });
    }
    nextSmtpFingerprint = smtpCertificate.fingerprint256;
  }

  if (imapLoginSettingsChanged) {
    const existingTrustStillApplies = toBooleanFlag(existingAccount.allow_self_signed) && !imapServerChanged;
    const allowInsecureForTest = trustAccepted || existingTrustStillApplies;
    const testAccount = {
      email_address: nextEmailAddress,
      username: nextUsername,
      imap_host: nextImapHost,
      imap_port: nextImapPort,
      encrypted_password: nextEncryptedPassword,
      allow_self_signed: allowInsecureForTest ? 1 : 0,
      trusted_imap_fingerprint256: trustAccepted ? confirmed.imap : existingTrustStillApplies ? existingAccount.trusted_imap_fingerprint256 : null,
    };
    log.info('ACCOUNT', `Testing updated IMAP connection for ${nextEmailAddress} (strict_tls=${allowInsecureForTest ? 'no' : 'yes'})...`);
    const testResult = await testImapConnection(testAccount, { record: fingerprint => { keptImapFingerprint = fingerprint; } });
    if (!testResult.success) {
      // Unconfirmed, or the server now presents a different certificate than the confirmed one.
      if (testResult.tlsTrustError) {
        log.warn('ACCOUNT', `IMAP TLS trust confirmation required for updated account ${nextEmailAddress}: ${testResult.details || testResult.error}`);
        return buildHostTrustConfirmationResponse({
          imap_host: nextImapHost,
          imap_port: nextImapPort,
          smtp_host: nextSmtpHost,
          smtp_port: nextSmtpPort,
          imapTlsError: testResult.details || testResult.error,
        });
      }
      return {
        error: testResult.error,
        details: testResult.details,
        status: 400,
      };
    }

    if (imapServerChanged) {
      nextAllowSelfSigned = trustAccepted ? 1 : 0;
      shouldUpdateTlsTrust = true;
    }
  }
  if (trustAccepted) {
    nextAllowSelfSigned = 1;
    shouldUpdateTlsTrust = true;
  }

  // Build update query dynamically
  const updates: string[] = [];
  const params: ExecuteValues[] = [];
  const serverDeleteSettingProvided = modeChange.deleteSettingProvided;
  const requestedServerDeleteEnabled = modeChange.deleteEnabled;
  const currentServerDeleteEnabled = toBooleanFlag(existingAccount.delete_emails_on_server);
  let shouldSeedServerDeleteQueue = false;

  if (modeChange.changed) {
    updates.push('sync_mode = ?', 'sync_status = ?');
    params.push(modeChange.mode, modeChange.mode === 'sync' ? 'pending' : 'idle');
    // The typed address confirmed Sync's removal policy for this account;
    // leaving Sync drops the confirmation, a later switch asks again.
    updates.push(`sync_policy_confirmed_at = ${modeChange.mode === 'sync' ? 'UTC_TIMESTAMP()' : 'NULL'}`);
  }
  const previousWindows = mailSyncPolicy.storedWindows(existingAccount);
  const nextWindows = { sync: requestedSyncWindow === undefined ? previousWindows.sync : requestedSyncWindow,
    trash: requestedTrashWindow === undefined ? previousWindows.trash : requestedTrashWindow };
  const wider = (before: number | null, after: number | null) => before !== null && (after === null || after > before);
  const windowsChanged = nextWindows.sync !== previousWindows.sync || nextWindows.trash !== previousWindows.trash;
  const windowsWidened = wider(previousWindows.sync, nextWindows.sync) || wider(previousWindows.trash, nextWindows.trash);
  if (requestedSyncWindow !== undefined) { updates.push('sync_window_days = ?'); params.push(nextWindows.sync); }
  if (requestedTrashWindow !== undefined) { updates.push('trash_window_days = ?'); params.push(nextWindows.trash); }
  if (email_address !== undefined) { updates.push('email_address = ?'); params.push(email_address); }
  if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
  if (username !== undefined) { updates.push('username = ?'); params.push(nextUsername); }
  if (imap_host !== undefined) { updates.push('imap_host = ?'); params.push(imap_host); }
  if (imap_port !== undefined) { updates.push('imap_port = ?'); params.push(imap_port); }
  if (smtp_host !== undefined) { updates.push('smtp_host = ?'); params.push(smtp_host); }
  if (smtp_port !== undefined) { updates.push('smtp_port = ?'); params.push(smtp_port); }
  if (encrypted_password !== undefined) { updates.push('encrypted_password = ?'); params.push(nextEncryptedPassword); }
  if (body.is_active === true) updates.push('is_active = TRUE', 'disconnected_at = NULL');
  if (shouldUpdateTlsTrust) {
    updates.push('allow_self_signed = ?');
    params.push(nextAllowSelfSigned);
    updates.push('trusted_imap_fingerprint256 = ?');
    params.push(trustAccepted ? confirmed.imap ?? keptImapFingerprint ?? (imapServerChanged ? null : existingAccount.trusted_imap_fingerprint256 ?? null) : null);
    updates.push('trusted_smtp_fingerprint256 = ?');
    params.push(trustAccepted ? confirmed.smtp : null);
  } else {
    // An account confirmed before fingerprints were kept keeps the certificate of this login.
    if (keptImapFingerprint && !existingAccount.trusted_imap_fingerprint256) { updates.push('trusted_imap_fingerprint256 = ?'); params.push(keptImapFingerprint); }
    if (nextSmtpFingerprint !== undefined) { updates.push('trusted_smtp_fingerprint256 = ?'); params.push(nextSmtpFingerprint); }
  }
  if (sync_fetch_limit !== undefined) {
    const normalizedSyncFetchLimit = normalizeSyncFetchLimit(sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT);
    if (!normalizedSyncFetchLimit) {
      return { error: 'Invalid sync fetch limit. Allowed value: all', status: 400 };
    }
    updates.push('sync_fetch_limit = ?');
    params.push(normalizedSyncFetchLimit);
  }
  if (serverDeleteSettingProvided) {
    if (requestedServerDeleteEnabled && !currentServerDeleteEnabled) {
      updates.push('delete_emails_on_server = TRUE');
      updates.push('server_delete_enabled_at = UTC_TIMESTAMP()');
      updates.push('server_delete_grace_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)');
      shouldSeedServerDeleteQueue = true;
    } else if (!requestedServerDeleteEnabled && currentServerDeleteEnabled) {
      updates.push('delete_emails_on_server = FALSE');
      updates.push('server_delete_enabled_at = NULL');
      updates.push('server_delete_grace_until = NULL');
    }
  }

  if (updates.length === 0 && !serverDeleteSettingProvided) return { error: 'No fields to update', status: 400 };
  // Failed validation/authentication must not pause a working account.
  if (stopRequired) await stopMailAccountWork(id, 'Account settings changing');

  if (updates.length > 0) {
    params.push(id, userId);
    // Under the account's row and the final check (final-step.ts): the
    // mode's policies, Mail on and not being restored, as committed now. A
    // refusal resumes work that was stopped for the change.
    try {
      await withTransaction(async cx => {
        const [[current]] = await cx.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
        if (!current) throw Object.assign(new Error('Account not found'), { status: 404 });
        await assertFinalStep(cx, { userId, policies: modePolicyKeys(existingAccount, modeChange), actor, modules: ['mail'] });
        await cx.execute(`UPDATE mail_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      });
    } catch (error) {
      if (stopRequired && toBooleanFlag(existingAccount.is_active))
        await (require('../services/mail-engine/runtime') as typeof import('../services/mail-engine/runtime')).resumeAccount({ userId, accountId: id });
      throw error;
    }
  }

  if (modeChange.changed) await mailWritebacks.cancelForAccount(db, id, userId, { leavingSync: modeChange.mode !== 'sync' });
  if (stopRequired && (body.is_active === true || toBooleanFlag(existingAccount.is_active)))
    await (require('../services/mail-engine/runtime') as typeof import('../services/mail-engine/runtime')).resumeAccount({ userId, accountId: id });

  if (modeChange.changed) {
    await db.execute("UPDATE mail_server_messages SET delete_status = 'skipped', delete_error = 'Cancelled by mail mode change' WHERE mail_account_id = ? AND user_id = ? AND delete_status IN ('pending', 'failed')", [id, userId]);
  }
  if (shouldSeedServerDeleteQueue) {
    await seedMailServerDeletionQueueForAccount({ userId, accountId: id });
  }
  if (modeChange.mode === 'sync' && (modeChange.changed || windowsChanged)) {
    try {
      // Wider windows: older history becomes eligible again, rescan it.
      if (windowsWidened) await db.execute("DELETE FROM mail_engine_cursors WHERE mail_account_id = ? AND user_id = ? AND stream = 'history'", [id, userId]);
      await mailSyncPolicy.enqueuePrune({ userId, accountId: id });
    } catch (error) {
      // The next discovery pass queues the same policy job.
      log.warn('ACCOUNT', 'Could not queue Sync policy job', undefined, error);
    }
  }

  const updatedAccount = await loadAccountJson(userId, id);
  // A linked calendar reads the mail login when it needs it; it only syncs
  // now instead of at its next turn.
  if (encrypted_password !== undefined || username !== undefined || email_address !== undefined || body.is_active === true) {
    await (require('../services/calendar-sync') as typeof import('../services/calendar-sync')).syncLinkedCalendars(userId, id)
      .catch((error: Error) => log.warn('CALENDAR', 'Could not start linked calendar sync', undefined, error));
  }
  if (body.is_active === true) setImmediate(() => startMailSyncInBackground(id).catch(error => log.error('SYNC', 'Reconnect scheduling failed', error)));
  if (modeChange.changed && modeChange.mode === 'download') {
    return { account: updatedAccount, message: 'Download mode keeps every local copy. Nothing is deleted; UniHub stops sending read, star, move and delete changes to the server.' };
  }
  return { account: updatedAccount };
  });
}

export { createMailAccount, updateMailAccount, loadAccountJson, withPolicyFields, startMailSyncInBackground, ACCOUNT_COLUMNS };
export type { Input as MailAccountInput, AccountRow as MailAccountRow };
