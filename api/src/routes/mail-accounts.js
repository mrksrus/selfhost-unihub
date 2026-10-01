const mailWritebacks = require('../services/mail-writebacks');
const mailAccountLifecycle = require('../services/mail-account-lifecycle');
const { mailAccountModeChange, sameProviderMailbox } = require('../services/mail-account-mode');
const { withMailAccountLock } = require('../services/mail-account-lock');
const { FILING_ACCOUNT_SQL } = require('../services/mail-folder-reconciliation');
const crypto = require('crypto');
const { db } = require('../state');
const { encrypt } = require('../security/encryption');
const {
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  toBooleanFlag,
  ensureDefaultMailFoldersForUser,
  normalizeSyncFetchLimit,
  seedMailServerDeletionQueueForAccount,
  buildMailHostTrustResult,
  validateMailHostPolicy,
  testImapConnection,
  stopMailAccountWork,
  getRunningMailServerDeleteAccountIds,
} = require('../services/mail');
const { createCalDavAccountForMail } = require('../services/caldav');
const { EFFECTIVE_READ_SQL, startMailSyncInBackground, extractMailRouteId } = require('./mail-route-helpers');

async function buildHostTrustConfirmationResponse({ imap_host, imap_port, smtp_host, smtp_port, imapTlsError }) {
  const mailHostTrust = await buildMailHostTrustResult({
    imap_host,
    imap_port,
    smtp_host,
    smtp_port,
    imapTlsError,
  });
  return {
    error: 'Review and confirm mail server authenticity before continuing.',
    status: 409,
    requiresHostTrustConfirmation: true,
    mailHostTrust,
  };
}

module.exports = {
  'GET /api/mail/accounts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [accounts] = await db.execute(
        `SELECT id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
                smtp_host, smtp_port, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
                server_delete_enabled_at, server_delete_grace_until, server_delete_last_run_at,
                is_active, disconnected_at, engine_version, last_synced_at, created_at
         FROM mail_accounts
         WHERE user_id = ?`,
        [userId]
      );
      await ensureDefaultMailFoldersForUser(userId);

      // Fetch unread email counts per account
      const [unreadRows] = await db.execute(
        `SELECT CASE WHEN is_legacy THEN 'legacy' ELSE ${FILING_ACCOUNT_SQL} END AS mail_account_id, COUNT(*) as unread_count FROM emails WHERE user_id = ? AND ${EFFECTIVE_READ_SQL} = 0 GROUP BY 1`,
        [userId]
      );

      const unreadByAccount = {};
      for (const row of unreadRows) {
        unreadByAccount[row.mail_account_id] = row.unread_count;
      }

      const [deleteRows] = await db.execute(
        `SELECT mail_account_id,
                SUM(CASE WHEN delete_status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN delete_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                SUM(CASE WHEN delete_status = 'deleted' THEN 1 ELSE 0 END) AS deleted_count,
                SUM(CASE WHEN delete_status = 'missing' THEN 1 ELSE 0 END) AS missing_count,
                SUM(CASE WHEN delete_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
         FROM mail_server_messages
         WHERE user_id = ?
         GROUP BY mail_account_id`,
        [userId]
      );
      const deleteCountsByAccount = {};
      for (const row of deleteRows || []) {
        deleteCountsByAccount[row.mail_account_id] = {
          pending: Number(row.pending_count) || 0,
          failed: Number(row.failed_count) || 0,
          deleted: Number(row.deleted_count) || 0,
          missing: Number(row.missing_count) || 0,
          skipped: Number(row.skipped_count) || 0,
        };
      }
      const runningDeleteAccountIds = new Set(getRunningMailServerDeleteAccountIds());

      const accountsWithUnread = accounts.map((account) => ({
        ...account,
        delete_emails_on_server: toBooleanFlag(account.delete_emails_on_server),
        sync_fetch_limit: normalizeSyncFetchLimit(account.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT,
        unread_count: unreadByAccount[account.id] || 0,
        server_delete_counts: deleteCountsByAccount[account.id] || { pending: 0, failed: 0, deleted: 0, missing: 0, skipped: 0 },
        server_delete_running: runningDeleteAccountIds.has(account.id),
      }));

      return { accounts: accountsWithUnread };
    } catch (error) {
      return { error: 'Failed to get mail accounts', status: 500 };
    }
  },

  'POST /api/mail/accounts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const {
        email_address,
        display_name,
        provider,
        username,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        encrypted_password,
        sync_fetch_limit,
        delete_emails_on_server,
        accept_host_trust,
        try_calendar_sync,
        caldav_url,
      } = body;
      console.log(`[ACCOUNT] Add mail account requested for ${email_address || '(missing email)'} via ${provider || 'unknown provider'}`);
      
      if (!email_address || !encrypted_password) {
        return { error: 'Email address and password are required', status: 400 };
      }
      if (!imap_host || !smtp_host) {
        return { error: 'IMAP and SMTP server addresses are required', status: 400 };
      }
      const normalizedSyncFetchLimit = normalizeSyncFetchLimit(sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT);
      if (!normalizedSyncFetchLimit) {
        return { error: 'Invalid sync fetch limit. Allowed value: all', status: 400 };
      }

      const normalizedImapPort = Number(imap_port) || 993;
      const normalizedSmtpPort = Number(smtp_port) || 587;
      const trustAccepted = toBooleanFlag(accept_host_trust);
      const modeChange = mailAccountModeChange(null, body);
      const serverDeleteEnabled = modeChange.deleteEnabled;

      console.log(`[ACCOUNT] Checking mail host policy for ${email_address}: IMAP ${imap_host}:${normalizedImapPort}, SMTP ${smtp_host}:${normalizedSmtpPort}`);
      const hostPolicyResult = await validateMailHostPolicy({
        imap_host,
        imap_port: normalizedImapPort,
        smtp_host,
        smtp_port: normalizedSmtpPort,
      });
      console.log(`[ACCOUNT] Host policy check complete for ${email_address}: blocked=${hostPolicyResult.mailHostTrust?.blocked ? 'yes' : 'no'}, trust_accepted=${trustAccepted ? 'yes' : 'no'}`);
      if (hostPolicyResult.error) {
        console.warn(`[ACCOUNT] Host policy rejected for ${email_address}: ${hostPolicyResult.error}`);
        return hostPolicyResult;
      }

      const encryptedPasswordForStorage = encrypt(encrypted_password);
      // Verify authentication using strict TLS unless the user explicitly accepted an IMAP certificate failure.
      const tempAccount = {
        email_address,
        username: username || email_address,
        imap_host,
        imap_port: normalizedImapPort,
        allow_self_signed: trustAccepted ? 1 : 0,
        trusted_imap_fingerprint256: null,
        encrypted_password: encryptedPasswordForStorage,
      };
      
      // Test IMAP connection and auth (wrong password / connection errors still returned)
      console.log(`[ACCOUNT] Testing IMAP connection for ${email_address} (strict_tls=${trustAccepted ? 'no' : 'yes'})...`);
      const testResult = await testImapConnection(tempAccount);
      
      if (!testResult.success) {
        if (testResult.tlsTrustError && !trustAccepted) {
          console.warn(`[ACCOUNT] IMAP TLS trust confirmation required for ${email_address}: ${testResult.details || testResult.error}`);
          return buildHostTrustConfirmationResponse({
            imap_host,
            imap_port: normalizedImapPort,
            smtp_host,
            smtp_port: normalizedSmtpPort,
            imapTlsError: testResult.details || testResult.error,
          });
        }
        return { 
          error: testResult.error, 
          details: testResult.details,
          status: 400 
        };
      }
      
      // Auth successful - save account immediately
      const accountId = crypto.randomUUID();
      const actualUsername = username || email_address;
      await db.execute(
        `INSERT INTO mail_accounts
           (id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
            smtp_host, smtp_port, encrypted_password, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
            server_delete_enabled_at, server_delete_grace_until, allow_self_signed,
            trusted_imap_fingerprint256, trusted_smtp_fingerprint256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${serverDeleteEnabled ? 'UTC_TIMESTAMP()' : 'NULL'},
                 ${serverDeleteEnabled ? 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)' : 'NULL'}, ?, ?, ?)`,
        [
          accountId,
          userId,
          email_address,
          display_name || null,
          provider,
          actualUsername,
          imap_host || null,
          normalizedImapPort,
          smtp_host || null,
          normalizedSmtpPort,
          encryptedPasswordForStorage,
          normalizedSyncFetchLimit,
          modeChange.mode,
          modeChange.mode === 'sync' ? 'pending' : 'idle',
          serverDeleteEnabled ? 1 : 0,
          trustAccepted ? 1 : 0,
          null,
          null,
        ]
      );
      await ensureDefaultMailFoldersForUser(userId);
      
      const [accounts] = await db.execute(
        `SELECT id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
                smtp_host, smtp_port, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
                server_delete_enabled_at, server_delete_grace_until, server_delete_last_run_at, is_active
         FROM mail_accounts
         WHERE id = ?`,
        [accountId]
      );
      if (accounts[0]) accounts[0].delete_emails_on_server = toBooleanFlag(accounts[0].delete_emails_on_server);

      let calendarSync = null;
      if (toBooleanFlag(try_calendar_sync)) {
        try {
          const caldavResult = await createCalDavAccountForMail({
            userId,
            emailAddress: email_address,
            displayName: display_name || email_address,
            username: actualUsername,
            password: encrypted_password,
            imapHost: imap_host,
            caldavUrl: caldav_url,
          });
          calendarSync = {
            attempted: true,
            success: true,
            account: caldavResult.account,
            calendars: caldavResult.calendars,
            importedEvents: caldavResult.importedEvents,
          };
        } catch (calendarError) {
          console.warn(`[CALDAV] Calendar sync setup failed for ${email_address}:`, calendarError.message);
          calendarSync = {
            attempted: true,
            success: false,
            warning: calendarError.message || 'Calendar sync setup failed',
          };
        }
      }
      
      // Start sync in background (non-blocking)
      console.log(`[ACCOUNT] Starting background sync for ${email_address}...`);
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
    } catch (error) {
      console.error('[ACCOUNT] Create mail account error:', error);
      return { error: error.message || 'Failed to create mail account', status: error.status || 500 };
    }
  },

  'PUT /api/mail/accounts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = extractMailRouteId(req);
      const {
        email_address,
        display_name,
        username,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        encrypted_password,
        sync_fetch_limit,
        delete_emails_on_server,
        accept_host_trust,
      } = body;
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      const requestedMode = mailAccountModeChange(accounts[0], body);
      const stopRequired = Boolean(requestedMode.changed || body.is_active === true || body.encrypted_password
        || body.email_address || body.imap_host || body.imap_port || body.username !== undefined || body.delete_emails_on_server !== undefined);
      return await withMailAccountLock(id, async () => {
      const [fresh] = await db.execute('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      if (!fresh.length) return { error: 'Account not found', status: 404 };
      const existingAccount = fresh[0];
      const modeChange = mailAccountModeChange(existingAccount, body);

      const nextEmailAddress = email_address || existingAccount.email_address;
      const nextUsername = username !== undefined ? (username || nextEmailAddress) : (existingAccount.username || nextEmailAddress);
      const nextImapHost = imap_host || existingAccount.imap_host;
      const nextImapPort = Number(imap_port) || Number(existingAccount.imap_port) || 993;
      const nextSmtpHost = smtp_host || existingAccount.smtp_host;
      const nextSmtpPort = Number(smtp_port) || Number(existingAccount.smtp_port) || 587;
      if (!sameProviderMailbox(existingAccount, { email_address: nextEmailAddress, username: nextUsername, imap_host: nextImapHost, imap_port: nextImapPort })) {
        const [identified] = await db.execute('SELECT id FROM emails WHERE mail_account_id = ? AND user_id = ? AND (imap_uid IS NOT NULL OR remote_uid IS NOT NULL) LIMIT 1', [id, userId]);
        if (identified.length) return { error: 'This account already contains imported mail. Add a separate account for a different mailbox or IMAP server to preserve message identity.', status: 409 };
      }
      const nextEncryptedPassword = encrypted_password ? encrypt(encrypted_password) : existingAccount.encrypted_password;
      if (body.is_active !== undefined && typeof body.is_active !== 'boolean') return { error: 'Active state must be boolean', status: 400 };
      if (body.is_active === true && existingAccount.disconnected_at && !encrypted_password) {
        return { error: 'Reconnect by providing and verifying the account credentials again.', status: 400 };
      }
      if (body.is_active === false) return { error: 'Use Disconnect to pause this account and remove its stored credentials.', status: 400 };
      const trustAccepted = toBooleanFlag(accept_host_trust);
      const hostSettingsChanged = Boolean(body.is_active === true || imap_host || imap_port || smtp_host || smtp_port);
      const imapLoginSettingsChanged = Boolean(body.is_active === true || email_address || username !== undefined || imap_host || imap_port || encrypted_password);
      let shouldUpdateTlsTrust = false;
      let nextAllowSelfSigned = toBooleanFlag(existingAccount.allow_self_signed) ? 1 : 0;

      if (hostSettingsChanged) {
        const hostPolicyResult = await validateMailHostPolicy({
          imap_host: nextImapHost,
          imap_port: nextImapPort,
          smtp_host: nextSmtpHost,
          smtp_port: nextSmtpPort,
        });
        if (hostPolicyResult.error) return hostPolicyResult;
      }

      if (imapLoginSettingsChanged) {
        const existingTrustStillApplies = toBooleanFlag(existingAccount.allow_self_signed) && !imap_host && !imap_port;
        const allowInsecureForTest = trustAccepted || existingTrustStillApplies;
        const testAccount = {
          email_address: nextEmailAddress,
          username: nextUsername,
          imap_host: nextImapHost,
          imap_port: nextImapPort,
          encrypted_password: nextEncryptedPassword,
          allow_self_signed: allowInsecureForTest ? 1 : 0,
        };
        console.log(`[ACCOUNT] Testing updated IMAP connection for ${nextEmailAddress} (strict_tls=${allowInsecureForTest ? 'no' : 'yes'})...`);
        const testResult = await testImapConnection(testAccount);
        if (!testResult.success) {
          if (testResult.tlsTrustError && !allowInsecureForTest) {
            console.warn(`[ACCOUNT] IMAP TLS trust confirmation required for updated account ${nextEmailAddress}: ${testResult.details || testResult.error}`);
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

        if (trustAccepted || imap_host || imap_port) {
          nextAllowSelfSigned = trustAccepted ? 1 : 0;
          shouldUpdateTlsTrust = true;
        }
      }
      
      // Build update query dynamically
      const updates = [];
      const params = [];
      const serverDeleteSettingProvided = modeChange.deleteSettingProvided;
      const requestedServerDeleteEnabled = modeChange.deleteEnabled;
      const currentServerDeleteEnabled = toBooleanFlag(existingAccount.delete_emails_on_server);
      let shouldSeedServerDeleteQueue = false;
      
      if (modeChange.changed) {
        updates.push('sync_mode = ?', 'sync_status = ?');
        params.push(modeChange.mode, modeChange.mode === 'sync' ? 'pending' : 'idle');
      }
      if (email_address) { updates.push('email_address = ?'); params.push(email_address); }
      if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name || null); }
      if (username !== undefined) { updates.push('username = ?'); params.push(nextUsername); }
      if (imap_host) { updates.push('imap_host = ?'); params.push(imap_host); }
      if (imap_port) { updates.push('imap_port = ?'); params.push(imap_port); }
      if (smtp_host) { updates.push('smtp_host = ?'); params.push(smtp_host); }
      if (smtp_port) { updates.push('smtp_port = ?'); params.push(smtp_port); }
      if (encrypted_password) { updates.push('encrypted_password = ?'); params.push(nextEncryptedPassword); }
      if (body.is_active === true) updates.push('is_active = TRUE', 'disconnected_at = NULL');
      if (shouldUpdateTlsTrust) {
        updates.push('allow_self_signed = ?');
        params.push(nextAllowSelfSigned);
        updates.push('trusted_imap_fingerprint256 = ?');
        params.push(null);
        updates.push('trusted_smtp_fingerprint256 = ?');
        params.push(null);
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
        await db.execute(
          `UPDATE mail_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
          params
        );
      }

      if (modeChange.changed) await mailWritebacks.cancelForAccount(db, id, userId);
      if (stopRequired && (body.is_active === true || toBooleanFlag(existingAccount.is_active)))
        await require('../services/mail-engine/runtime').resumeAccount({ userId, accountId: id });

      if (modeChange.changed) {
        await db.execute("UPDATE mail_server_messages SET delete_status = 'skipped', delete_error = 'Cancelled by mail mode change' WHERE mail_account_id = ? AND user_id = ? AND delete_status IN ('pending', 'failed')", [id, userId]);
      }
      if (shouldSeedServerDeleteQueue) {
        await seedMailServerDeletionQueueForAccount({ userId, accountId: id });
      }
      
      const [updated] = await db.execute(
        `SELECT id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
                smtp_host, smtp_port, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
                server_delete_enabled_at, server_delete_grace_until, server_delete_last_run_at, is_active
         FROM mail_accounts
         WHERE id = ?`,
        [id]
      );
      
      const updatedAccount = updated[0] || null;
      if (updatedAccount) updatedAccount.delete_emails_on_server = toBooleanFlag(updatedAccount.delete_emails_on_server);
      if (body.is_active === true) setImmediate(() => startMailSyncInBackground(id).catch(error => console.error('[SYNC] Reconnect scheduling failed:', error.message)));
      return { account: updatedAccount };
      });
    } catch (error) {
      console.error('[ACCOUNT] Update error:', error);
      return { error: error.message || 'Failed to update mail account', status: error.status || 500 };
    }
  },

  'GET /api/mail/accounts/:id/purge-preview': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try { return await mailAccountLifecycle.purgePreview(userId, req.params.id); }
    catch (error) { return { error: error.status ? error.message : 'Could not preview account purge', status: error.status || 500 }; }
  },

  'DELETE /api/mail/accounts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = extractMailRouteId(req);
      const query = new URL(req.url, 'http://localhost').searchParams;
      return query.get('purge') === 'true'
        ? await mailAccountLifecycle.purgeAccount(userId, id, query.get('confirm_purge'))
        : await mailAccountLifecycle.disconnectAccount(userId, id);
    } catch (error) {
      return { error: error.status ? error.message : 'Could not change mail account connection', status: error.status || 500 };
    }
  },
};
