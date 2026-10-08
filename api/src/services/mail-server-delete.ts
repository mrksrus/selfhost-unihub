import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, ApiError } from '../types';
import type { ProtocolConnection, ProtocolError } from '../types/imap-protocol';
interface QueueInput { connection?: SqlExecutor; userId: string; accountId: string; emailId: string; sourceFolder?: string; imapUid?: number | null; imapUidValidity?: number | null; rawStoragePath?: string | null; rawSha256?: string | null; rawBytes?: number | null; rawFormat?: string | null; rawVerified?: boolean }
import imported1 = require('./mail-account-lock');
const { withMailAccountLock } = imported1;
import crypto = require('crypto');
import imapClient = require('./mail-imap-client');
import imported2 = require('./mail-imap-guard');
const { guardImapConnection, runGuardedImap, closeImapConnection } = imported2;
import fs = require('fs');
import path = require('path');
import imported3 = require('util');
const { promisify } = imported3;
import imported4 = require('../state');
const { db } = imported4;
import imported5 = require('./module-settings');
const { isModuleBackgroundEnabled } = imported5;
import imported6 = require('./restore-locks');
const { isSectionRestoreActive } = imported6;
import imported7 = require('./mail-host-policy');
const { toBooleanFlag, buildImapConnectionConfig } = imported7;
import imported8 = require('./mail-durable-jobs');
const { normalizeMailAccountId, isMailAccountSyncRunning } = imported8;

const rm = promisify(fs.rm);

const mailDeleteStopRequests = new Set<string>();
const activeMailServerDeleteAccounts = new Set<string>();
const MAIL_SERVER_DELETE_GRACE_MS = 10 * 60 * 1000;
const MAIL_SERVER_DELETE_BATCH_SIZE = 100;
const MAIL_RAW_STORAGE_ROOT = process.env.MAIL_RAW_STORAGE_ROOT || '/app/uploads/mail-raw';

function isMailServerDeleteRunning(accountId: unknown) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  return !!normalizedAccountId && activeMailServerDeleteAccounts.has(normalizedAccountId);
}

function isAnyMailServerDeleteRunning() {
  return activeMailServerDeleteAccounts.size > 0;
}

function getRunningMailServerDeleteAccountIds() {
  return Array.from(activeMailServerDeleteAccounts.keys());
}

function isAttachmentPathUnderUploads(storagePath: string | null | undefined) {
  const uploadsRoot = path.resolve(process.env.MAIL_ATTACHMENT_UPLOAD_ROOT || '/app/uploads/attachments');
  const resolvedPath = path.resolve(storagePath || '');
  return resolvedPath === uploadsRoot || resolvedPath.startsWith(`${uploadsRoot}${path.sep}`);
}

async function deleteStoredAttachmentFiles(storagePaths: readonly (string | null | undefined)[]) {
  const uniquePaths = Array.from(new Set((storagePaths || []).filter(Boolean)));
  let deletedFiles = 0;
  let failedFiles = 0;

  for (const storagePath of uniquePaths) {
    if (!isAttachmentPathUnderUploads(storagePath)) {
      console.error('[ATTACH] Skipped deleting attachment outside uploads root:', storagePath);
      failedFiles++;
      continue;
    }

    try {
      await rm(path.resolve(storagePath!), { force: true });
      deletedFiles++;
    } catch (error) {
      failedFiles++;
      console.error('[ATTACH] Failed to delete attachment file:', (error as ApiError).message);
    }
  }

  return { deletedFiles, failedFiles };
}

function getMailRawStoragePath(userId: string, emailId: string, messageId: string | null = '') {
  const safeMessagePart = String(messageId || emailId)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return path.join(MAIL_RAW_STORAGE_ROOT, String(userId), `${emailId}-${safeMessagePart}.eml`);
}

function isMailRawPathUnderRoot(storagePath: string | null | undefined) {
  const root = path.resolve(MAIL_RAW_STORAGE_ROOT);
  const resolvedPath = path.resolve(storagePath || '');
  return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
}

function isUsableRawEmailArchive(storagePath: string | null | undefined) {
  if (!storagePath || !isMailRawPathUnderRoot(storagePath)) return false;
  try {
    return fs.existsSync(path.resolve(storagePath!));
  } catch {
    return false;
  }
}

function getCurrentBoxUidValidity(connection: ProtocolConnection | null) {
  const box = connection?.state === connection?.states?.SELECTED ? connection?.mailbox : null;
  const value: unknown = (box as Exclude<ProtocolConnection['mailbox'], false> | null)?.uidValidity;
  if (value === undefined || value === null || value === false) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function chunkArray<T>(values: T[], chunkSize: number) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function loadExistingImportedUidSet({ connection = db, accountId, folderName, uids, uidValidity }: { connection?: SqlExecutor; accountId: string; folderName: string; uids: number[]; uidValidity?: number | null }) {
  const normalizedUids = Array.from(new Set((uids || []).filter(uid => typeof uid === 'number' && Number.isFinite(uid))));
  const existingUids = new Set<number>();
  if (!accountId || !folderName || normalizedUids.length === 0) return existingUids;

  for (const uidChunk of chunkArray(normalizedUids, 1000)) {
    const placeholders = uidChunk.map(() => '?').join(',');
    const params = [accountId, folderName, ...uidChunk];
    let query = `
      SELECT imap_uid
      FROM emails
      WHERE mail_account_id = ?
        AND source_folder = ?
        AND imap_uid IN (${placeholders})
        AND import_complete = TRUE
        AND raw_storage_path IS NOT NULL`;

    if (uidValidity !== null && uidValidity !== undefined) {
      query += ' AND imap_uidvalidity = ?';
      params.push(uidValidity);
    }

    const [rows] = await connection.execute<RowDataPacket[]>(query, params);
    for (const row of rows || []) {
      const uid = Number(row.imap_uid);
      if (Number.isFinite(uid)) existingUids.add(uid);
    }
  }

  return existingUids;
}

async function recordMailServerMessageForDeletion({
  connection = db,
  userId,
  accountId,
  emailId,
  sourceFolder,
  imapUid,
  imapUidValidity,
  rawStoragePath,
  rawSha256,
  rawBytes,
  rawFormat,
  rawVerified,
}: QueueInput) {
  const { uint32, verifyArchive } = require('./mail-engine/content');
  const normalizedUid = uint32(imapUid), epoch = uint32(imapUidValidity);
  const folderName = String(sourceFolder || '');
  if (!userId || !accountId || !emailId || !folderName || !normalizedUid || !epoch
    || rawFormat !== 'exact_octets' || rawVerified !== true) return false;
  if (!await verifyArchive({ raw_storage_path: rawStoragePath, raw_sha256: rawSha256,
    raw_bytes: rawBytes, raw_format: rawFormat, raw_verified: rawVerified }, { root: MAIL_RAW_STORAGE_ROOT })) return false;

  await connection.execute<RowDataPacket[]>(
    `INSERT INTO mail_server_messages
       (id, user_id, mail_account_id, email_id, source_folder, imap_uid, imap_uidvalidity)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       imap_uidvalidity = IF(mail_server_messages.email_id = VALUES(email_id)
         AND mail_server_messages.imap_uidvalidity = VALUES(imap_uidvalidity), VALUES(imap_uidvalidity), mail_server_messages.imap_uidvalidity)`,
    [
      crypto.randomUUID(),
      userId,
      accountId,
      emailId,
      folderName,
      normalizedUid,
      imapUidValidity === undefined ? null : imapUidValidity,
    ]
  );
  return true;
}

async function seedMailServerDeletionQueueForAccount({ userId, accountId, connection = db }: { userId: string; accountId: string; connection?: SqlExecutor }) {
  if (!userId || !accountId) return { queued: 0 };
  let queued = 0, afterId = '';
  for (;;) {
    const [emails] = await connection.execute<RowDataPacket[]>(
      `SELECT id, COALESCE(remote_folder, source_folder) AS source_folder,
         COALESCE(remote_uid, imap_uid) AS imap_uid, COALESCE(remote_uidvalidity, imap_uidvalidity) AS imap_uidvalidity,
         raw_storage_path, raw_sha256, raw_bytes, raw_format, raw_verified
       FROM emails WHERE user_id = ? AND mail_account_id = ? AND id > ?
         AND import_complete = TRUE AND raw_verified = TRUE AND raw_format = 'exact_octets'
         AND COALESCE(remote_uidvalidity, imap_uidvalidity) IS NOT NULL
       ORDER BY id LIMIT 200`, [userId, accountId, afterId]);
    for (const email of emails) {
      if (await recordMailServerMessageForDeletion({ connection, userId, accountId, emailId: email.id,
        sourceFolder: email.source_folder, imapUid: email.imap_uid, imapUidValidity: email.imap_uidvalidity,
        rawStoragePath: email.raw_storage_path, rawSha256: email.raw_sha256, rawBytes: Number(email.raw_bytes),
        rawFormat: email.raw_format, rawVerified: toBooleanFlag(email.raw_verified) })) queued++;
    }
    if (emails.length < 200) break;
    afterId = emails[emails.length - 1].id;
    await new Promise(resolve => setImmediate(resolve));
  }
  // A failed/skipped destructive attempt is not silently reset to pending.
  return { queued };
}

async function markMailServerMessageDeleteStatus({ connection = db, id, status, error = null }: { connection?: SqlExecutor; id: string; status: string; error?: unknown }) {
  const allowedStatuses = new Set(['pending', 'deleted', 'missing', 'failed', 'skipped']);
  if (!id || !allowedStatuses.has(status)) return;
  await connection.execute<RowDataPacket[]>(
    `UPDATE mail_server_messages
     SET delete_status = ?,
         delete_attempts = delete_attempts + 1,
         delete_error = ?,
         deleted_at = CASE WHEN ? = 'deleted' OR ? = 'missing' THEN UTC_TIMESTAMP() ELSE deleted_at END
     WHERE id = ?`,
    [status, error ? String(error).slice(0, 2000) : null, status, status, id]
  );
}

function imapSupportsUidExpunge(connection: ProtocolConnection | null) {
  return connection?.capabilities instanceof Map && connection.capabilities.has('UIDPLUS');
}

// UID STORE/UID EXPUNGE go through ImapFlow's command queue directly: its
// messageDelete() falls back to a mailbox-wide EXPUNGE without UIDPLUS and its
// flag helpers report a rejected command only as `false`.
async function runImapUidCommand(connection: ProtocolConnection, command: string, attributes: unknown[]) {
  try {
    await runGuardedImap(connection, async () => {
      const reply = await connection.exec(command, attributes);
      reply.next();
    });
  } catch (error) {
    if (!(error as ProtocolError)?.responseStatus) throw error;
    throw new Error(`IMAP ${command} rejected${(error as ProtocolError & { responseText?: string }).responseText ? `: ${(error as ProtocolError & { responseText?: string }).responseText}` : ''}`);
  }
}

function setImapUidFlag(connection: ProtocolConnection, uid: number, flag: string, add: boolean) {
  return runImapUidCommand(connection, 'UID STORE', [{ type: 'SEQUENCE', value: String(uid) },
    { type: 'ATOM', value: `${add ? '+' : '-'}FLAGS.SILENT` }, [{ type: 'ATOM', value: flag }]]);
}

function expungeImapUid(connection: ProtocolConnection, uid: number) {
  return runImapUidCommand(connection, 'UID EXPUNGE', [{ type: 'SEQUENCE', value: String(uid) }]);
}

async function deleteImapUid(connection: ProtocolConnection, uid: number) {
  if (!imapSupportsUidExpunge(connection)) {
    throw new Error('IMAP server does not support UIDPLUS; refusing mailbox-wide expunge for safety.');
  }

  let markedDeleted = false;
  try {
    await setImapUidFlag(connection, uid, '\\Deleted', true);
    markedDeleted = true;
    await expungeImapUid(connection, uid);
  } catch (error) {
    if (markedDeleted) {
      try {
        await setImapUidFlag(connection, uid, '\\Deleted', false);
      } catch (removeError) {
        console.error(`[SERVER DELETE] Failed to remove \\Deleted flag from UID ${uid}:`, (removeError as Error).message);
      }
    }
    throw error;
  }
}

async function isMailServerDeletionStillEnabled(accountId: string) {
  if (mailDeleteStopRequests.has(normalizeMailAccountId(accountId))) return false;
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT user_id, delete_emails_on_server, is_active, server_delete_grace_until, sync_mode
     FROM mail_accounts
     WHERE id = ?
     LIMIT 1`,
    [accountId]
  );
  const account = rows[0];
  if (!account || account.sync_mode === 'sync') return false;
  if (!toBooleanFlag(account.delete_emails_on_server) || !toBooleanFlag(account.is_active)) return false;
  if (!await isModuleBackgroundEnabled(account.user_id, 'mail') || await isSectionRestoreActive(account.user_id, 'mail')) return false;
  if (!account.server_delete_grace_until) return false;
  return new Date(account.server_delete_grace_until).getTime() <= Date.now();
}

async function processMailServerDeletionForAccountUnlocked(accountId: string, { limit = MAIL_SERVER_DELETE_BATCH_SIZE } = {}) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  if (!normalizedAccountId || activeMailServerDeleteAccounts.has(normalizedAccountId)) {
    return { accountId: normalizedAccountId, skipped: true, reason: 'already_running' };
  }
  if (isMailAccountSyncRunning(normalizedAccountId)) {
    return { accountId: normalizedAccountId, skipped: true, reason: 'mail_sync_running' };
  }

  activeMailServerDeleteAccounts.add(normalizedAccountId);
  let connection: ProtocolConnection | null = null;
  try {
    const [accounts] = await db.execute<RowDataPacket[]>(
      `SELECT *
       FROM mail_accounts
       WHERE id = ?
         AND sync_mode = 'download'
         AND delete_emails_on_server = TRUE
         AND is_active = TRUE
         AND server_delete_grace_until IS NOT NULL
         AND server_delete_grace_until <= UTC_TIMESTAMP()
       LIMIT 1`,
      [normalizedAccountId]
    );
    const account = accounts[0];
    if (!account || account.sync_mode === 'sync') return { accountId: normalizedAccountId, skipped: true, reason: 'not_enabled_or_grace_pending' };
    if (!await isModuleBackgroundEnabled(account.user_id, 'mail')) {
      return { accountId: normalizedAccountId, skipped: true, reason: 'module_paused' };
    }
    if (await isSectionRestoreActive(account.user_id, 'mail')) {
      return { accountId: normalizedAccountId, skipped: true, reason: 'mail_restore_running' };
    }

    const config = await buildImapConnectionConfig(account as RowDataPacket & Parameters<typeof buildImapConnectionConfig>[0]);
    if (!config) return { accountId: normalizedAccountId, success: false, error: 'No password configured for this account' };

    const safeLimit = Math.min(Math.max(Number(limit) || MAIL_SERVER_DELETE_BATCH_SIZE, 1), 500);
    const [messages] = await db.execute<RowDataPacket[]>(
      `SELECT m.id, m.user_id, m.mail_account_id, m.email_id, m.source_folder, m.imap_uid, m.imap_uidvalidity,
         e.raw_storage_path, e.raw_sha256, e.raw_bytes, e.raw_format, e.raw_verified, e.import_complete,
         e.remote_folder, e.remote_uid, e.remote_uidvalidity, e.source_folder AS email_source_folder,
         e.imap_uid AS email_imap_uid, e.imap_uidvalidity AS email_imap_uidvalidity, e.remote_missing
       FROM mail_server_messages m JOIN emails e ON e.id = m.email_id AND e.user_id = m.user_id AND e.mail_account_id = m.mail_account_id
       WHERE m.mail_account_id = ?
         AND m.user_id = ?
         AND m.delete_status = 'pending'
       ORDER BY m.created_at ASC
       LIMIT ${safeLimit}`,
      [normalizedAccountId, account.user_id]
    );

    if (!messages.length) {
      await db.execute<RowDataPacket[]>('UPDATE mail_accounts SET server_delete_last_run_at = UTC_TIMESTAMP() WHERE id = ?', [normalizedAccountId]);
      return { accountId: normalizedAccountId, success: true, processed: 0, deleted: 0, missing: 0, failed: 0, stopped: false };
    }

    console.log(`[SERVER DELETE] Connecting to delete ${messages.length} queued message(s) for ${account.email_address}`);
    connection = guardImapConnection(await imapClient.connectImap(config));

    let currentFolder = null;
    let processed = 0;
    let deleted = 0;
    let missing = 0;
    let failed = 0;
    let skipped = 0;
    let stopped = false;

    for (const message of messages) {
      if (!(await isMailServerDeletionStillEnabled(normalizedAccountId))) {
        stopped = true;
        break;
      }

      const { uint32, eligibleForProviderErasure } = require('./mail-engine/content');
      const uid = uint32(message.imap_uid);
      const sourceFolder = String(message.source_folder || '');
      const expectedEpoch = uint32(message.imap_uidvalidity);
      if (!uid || !sourceFolder || !expectedEpoch) {
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'skipped', error: 'Missing verified source folder, UID or epoch.' });
        skipped++;
        processed++;
        continue;
      }

      try {
        if (currentFolder !== sourceFolder) {
          await runGuardedImap(connection, () => connection!.mailboxOpen(sourceFolder));
          currentFolder = sourceFolder;
        }

        const currentUidValidity = uint32(getCurrentBoxUidValidity(connection));
        if (currentUidValidity !== expectedEpoch) {
          await markMailServerMessageDeleteStatus({
            id: message.id, status: 'skipped',
            error: `UIDVALIDITY unverified or changed for ${sourceFolder}.`,
          });
          skipped++; processed++; continue;
        }
        const archived = { ...message, source_folder: message.email_source_folder,
          imap_uid: message.email_imap_uid, imap_uidvalidity: message.email_imap_uidvalidity };
        if (!await eligibleForProviderErasure({ row: archived, sourceFolder, uid,
          uidValidity: expectedEpoch, selectedUidValidity: currentUidValidity, root: MAIL_RAW_STORAGE_ROOT })) {
          await markMailServerMessageDeleteStatus({ id: message.id, status: 'skipped', error: 'Exact archive or current source identity unverified.' });
          skipped++; processed++; continue;
        }

        const found = await runGuardedImap(connection, () => connection!.search({ uid: String(uid) }, { uid: true }));
        if (!Array.isArray(found) || found.some(item => uint32(item) !== uid)) {
          throw new Error('Malformed provider UID verification; deletion withheld');
        }
        if (found.length === 0) {
          await markMailServerMessageDeleteStatus({ id: message.id, status: 'missing', error: null });
          missing++;
          processed++;
          continue;
        }

        // Settings and local identity may change while SEARCH is in flight.
        if (!(await isMailServerDeletionStillEnabled(normalizedAccountId))) { stopped = true; break; }
        const [freshRows] = await db.execute<RowDataPacket[]>(`SELECT m.id, m.source_folder, m.imap_uid, m.imap_uidvalidity,
          e.source_folder AS email_source_folder, e.imap_uid AS email_imap_uid,
          e.imap_uidvalidity AS email_imap_uidvalidity, e.remote_folder, e.remote_uid,
          e.remote_uidvalidity, e.remote_missing, e.import_complete, e.raw_storage_path,
          e.raw_sha256, e.raw_bytes, e.raw_format, e.raw_verified
          FROM mail_server_messages m JOIN emails e ON e.id=m.email_id AND e.user_id=m.user_id AND e.mail_account_id=m.mail_account_id
          WHERE m.id=? AND m.user_id=? AND m.mail_account_id=? AND m.delete_status='pending'`,
        [message.id, account.user_id, normalizedAccountId]);
        const fresh = freshRows[0];
        if (!fresh || String(fresh.source_folder) !== sourceFolder || uint32(fresh.imap_uid) !== uid
          || uint32(fresh.imap_uidvalidity) !== expectedEpoch
          || uint32(getCurrentBoxUidValidity(connection)) !== expectedEpoch
          || !await eligibleForProviderErasure({ row: { ...fresh, source_folder: fresh.email_source_folder,
            imap_uid: fresh.email_imap_uid, imap_uidvalidity: fresh.email_imap_uidvalidity },
          sourceFolder, uid, uidValidity: expectedEpoch, selectedUidValidity: expectedEpoch, root: MAIL_RAW_STORAGE_ROOT })) {
          await markMailServerMessageDeleteStatus({ id: message.id, status: 'skipped', error: 'Archive/source changed before dispatch.' });
          skipped++; processed++; continue;
        }
        await deleteImapUid(connection, uid);
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'deleted', error: null });
        deleted++;
        processed++;
      } catch (error) {
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'failed', error: (error as ApiError).message || String(error) });
        failed++;
        processed++;
      }
    }

    await db.execute<RowDataPacket[]>('UPDATE mail_accounts SET server_delete_last_run_at = UTC_TIMESTAMP() WHERE id = ?', [normalizedAccountId]);
    console.log(`[SERVER DELETE] ${account.email_address}: deleted=${deleted}, missing=${missing}, failed=${failed}, skipped=${skipped}, stopped=${stopped}`);
    return { accountId: normalizedAccountId, success: failed === 0, processed, deleted, missing, failed, skipped, stopped };
  } catch (error) {
    console.error(`[SERVER DELETE] Account ${normalizedAccountId} failed:`, (error as ApiError).message);
    return { accountId: normalizedAccountId, success: false, error: (error as ApiError).message || String(error) };
  } finally {
    if (connection) closeImapConnection(connection);
    activeMailServerDeleteAccounts.delete(normalizedAccountId);
    mailDeleteStopRequests.delete(normalizedAccountId);
  }
}

async function processMailServerDeletionForAccount(accountId: string, options: { limit?: number } = {}) {
  const key = normalizeMailAccountId(accountId);
  if (!key || activeMailServerDeleteAccounts.has(key)) return { accountId: key, skipped: true, reason: 'already_running' };
  if (isMailAccountSyncRunning(key)) return { accountId: key, skipped: true, reason: 'mail_sync_running' };
  return withMailAccountLock(accountId, () => processMailServerDeletionForAccountUnlocked(accountId, options));
}

async function runMailServerDeletionPass({ accountId = null, limit = MAIL_SERVER_DELETE_BATCH_SIZE }: { accountId?: string | null; limit?: number } = {}) {
  const params = [];
  let query = `
    SELECT id
    FROM mail_accounts
    WHERE sync_mode = 'download' AND delete_emails_on_server = TRUE
      AND is_active = TRUE
      AND server_delete_grace_until IS NOT NULL
      AND server_delete_grace_until <= UTC_TIMESTAMP()`;
  if (accountId) {
    query += ' AND id = ?';
    params.push(accountId);
  }
  query += ' ORDER BY server_delete_grace_until ASC LIMIT 10';

  const [accounts] = await db.execute<RowDataPacket[]>(query, params);
  const results = [];
  for (const account of accounts || []) {
    results.push(await processMailServerDeletionForAccount(account.id, { limit }));
  }
  return { skipped: false, accounts: results };
}

export = {
  mailDeleteStopRequests,
  MAIL_SERVER_DELETE_GRACE_MS,
  MAIL_SERVER_DELETE_BATCH_SIZE,
  MAIL_RAW_STORAGE_ROOT,
  isMailServerDeleteRunning,
  isAnyMailServerDeleteRunning,
  getRunningMailServerDeleteAccountIds,
  isAttachmentPathUnderUploads,
  deleteStoredAttachmentFiles,
  getMailRawStoragePath,
  isMailRawPathUnderRoot,
  isUsableRawEmailArchive,
  getCurrentBoxUidValidity,
  loadExistingImportedUidSet,
  recordMailServerMessageForDeletion,
  seedMailServerDeletionQueueForAccount,
  markMailServerMessageDeleteStatus,
  deleteImapUid,
  processMailServerDeletionForAccount,
  runMailServerDeletionPass,
};
