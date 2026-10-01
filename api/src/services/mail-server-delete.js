const { withMailAccountLock } = require('./mail-account-lock');
const crypto = require('crypto');
require('../imap-patch');
const imaps = require('imap-simple');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { db } = require('../state');
const { isModuleBackgroundEnabled } = require('./module-settings');
const { isSectionRestoreActive } = require('./restore-locks');
const { toBooleanFlag, buildImapConnectionConfig } = require('./mail-host-policy');
const { normalizeMailAccountId, isMailAccountSyncRunning } = require('./mail-durable-jobs');

const rm = promisify(fs.rm);

const mailDeleteStopRequests = new Set();
const activeMailServerDeleteAccounts = new Set();
const MAIL_SERVER_DELETE_GRACE_MS = 10 * 60 * 1000;
const MAIL_SERVER_DELETE_BATCH_SIZE = 100;
const MAIL_RAW_STORAGE_ROOT = process.env.MAIL_RAW_STORAGE_ROOT || '/app/uploads/mail-raw';

function isMailServerDeleteRunning(accountId) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  return !!normalizedAccountId && activeMailServerDeleteAccounts.has(normalizedAccountId);
}

function isAnyMailServerDeleteRunning() {
  return activeMailServerDeleteAccounts.size > 0;
}

function getRunningMailServerDeleteAccountIds() {
  return Array.from(activeMailServerDeleteAccounts.keys());
}

function isAttachmentPathUnderUploads(storagePath) {
  const uploadsRoot = path.resolve(process.env.MAIL_ATTACHMENT_UPLOAD_ROOT || '/app/uploads/attachments');
  const resolvedPath = path.resolve(storagePath || '');
  return resolvedPath === uploadsRoot || resolvedPath.startsWith(`${uploadsRoot}${path.sep}`);
}

async function deleteStoredAttachmentFiles(storagePaths) {
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
      await rm(path.resolve(storagePath), { force: true });
      deletedFiles++;
    } catch (error) {
      failedFiles++;
      console.error('[ATTACH] Failed to delete attachment file:', error.message);
    }
  }

  return { deletedFiles, failedFiles };
}

function getMailRawStoragePath(userId, emailId, messageId = '') {
  const safeMessagePart = String(messageId || emailId)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return path.join(MAIL_RAW_STORAGE_ROOT, String(userId), `${emailId}-${safeMessagePart}.eml`);
}

function isMailRawPathUnderRoot(storagePath) {
  const root = path.resolve(MAIL_RAW_STORAGE_ROOT);
  const resolvedPath = path.resolve(storagePath || '');
  return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
}

function isUsableRawEmailArchive(storagePath) {
  if (!storagePath || !isMailRawPathUnderRoot(storagePath)) return false;
  try {
    return fs.existsSync(path.resolve(storagePath));
  } catch {
    return false;
  }
}

function getCurrentBoxUidValidity(connection) {
  const candidates = [
    connection?.imap?._box?.uidvalidity,
    connection?.imap?._box?.uidValidity,
    connection?._box?.uidvalidity,
    connection?._box?.uidValidity,
  ];
  const value = candidates.find(candidate => candidate !== undefined && candidate !== null);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function loadExistingImportedUidSet({ connection = db, accountId, folderName, uids, uidValidity }) {
  const normalizedUids = Array.from(new Set((uids || []).filter(uid => typeof uid === 'number' && Number.isFinite(uid))));
  const existingUids = new Set();
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

    const [rows] = await connection.execute(query, params);
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
}) {
  const { uint32, verifyArchive } = require('./mail-engine/content');
  const normalizedUid = uint32(imapUid), epoch = uint32(imapUidValidity);
  const folderName = String(sourceFolder || '');
  if (!userId || !accountId || !emailId || !folderName || !normalizedUid || !epoch
    || rawFormat !== 'exact_octets' || rawVerified !== true) return false;
  if (!await verifyArchive({ raw_storage_path: rawStoragePath, raw_sha256: rawSha256,
    raw_bytes: rawBytes, raw_format: rawFormat, raw_verified: rawVerified }, { root: MAIL_RAW_STORAGE_ROOT })) return false;

  await connection.execute(
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

async function seedMailServerDeletionQueueForAccount({ userId, accountId, connection = db }) {
  if (!userId || !accountId) return { queued: 0 };
  let queued = 0, afterId = '';
  for (;;) {
    const [emails] = await connection.execute(
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

async function markMailServerMessageDeleteStatus({ connection = db, id, status, error = null }) {
  const allowedStatuses = new Set(['pending', 'deleted', 'missing', 'failed', 'skipped']);
  if (!id || !allowedStatuses.has(status)) return;
  await connection.execute(
    `UPDATE mail_server_messages
     SET delete_status = ?,
         delete_attempts = delete_attempts + 1,
         delete_error = ?,
         deleted_at = CASE WHEN ? = 'deleted' OR ? = 'missing' THEN UTC_TIMESTAMP() ELSE deleted_at END
     WHERE id = ?`,
    [status, error ? String(error).slice(0, 2000) : null, status, status, id]
  );
}

function imapSupportsUidExpunge(connection) {
  try {
    return !!connection?.imap?.serverSupports?.('UIDPLUS');
  } catch {
    return false;
  }
}

function addImapUidFlag(connection, uid, flag) {
  return new Promise((resolve, reject) => {
    connection.imap.addFlags(uid, flag, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function removeImapUidFlag(connection, uid, flag) {
  return new Promise((resolve, reject) => {
    connection.imap.delFlags(uid, flag, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function expungeImapUid(connection, uid) {
  return new Promise((resolve, reject) => {
    connection.imap.expunge(uid, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function deleteImapUid(connection, uid) {
  if (!imapSupportsUidExpunge(connection)) {
    throw new Error('IMAP server does not support UIDPLUS; refusing mailbox-wide expunge for safety.');
  }

  let markedDeleted = false;
  try {
    await addImapUidFlag(connection, uid, '\\Deleted');
    markedDeleted = true;
    await expungeImapUid(connection, uid);
  } catch (error) {
    if (markedDeleted) {
      try {
        await removeImapUidFlag(connection, uid, '\\Deleted');
      } catch (removeError) {
        console.error(`[SERVER DELETE] Failed to remove \\Deleted flag from UID ${uid}:`, removeError.message);
      }
    }
    throw error;
  }
}

async function isMailServerDeletionStillEnabled(accountId) {
  if (mailDeleteStopRequests.has(normalizeMailAccountId(accountId))) return false;
  const [rows] = await db.execute(
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

async function processMailServerDeletionForAccountUnlocked(accountId, { limit = MAIL_SERVER_DELETE_BATCH_SIZE } = {}) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  if (!normalizedAccountId || activeMailServerDeleteAccounts.has(normalizedAccountId)) {
    return { accountId: normalizedAccountId, skipped: true, reason: 'already_running' };
  }
  if (isMailAccountSyncRunning(normalizedAccountId)) {
    return { accountId: normalizedAccountId, skipped: true, reason: 'mail_sync_running' };
  }

  activeMailServerDeleteAccounts.add(normalizedAccountId);
  let connection = null;
  try {
    const [accounts] = await db.execute(
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

    const config = await buildImapConnectionConfig(account);
    if (!config) return { accountId: normalizedAccountId, success: false, error: 'No password configured for this account' };

    const safeLimit = Math.min(Math.max(Number(limit) || MAIL_SERVER_DELETE_BATCH_SIZE, 1), 500);
    const [messages] = await db.execute(
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
      await db.execute('UPDATE mail_accounts SET server_delete_last_run_at = UTC_TIMESTAMP() WHERE id = ?', [normalizedAccountId]);
      return { accountId: normalizedAccountId, success: true, processed: 0, deleted: 0, missing: 0, failed: 0, stopped: false };
    }

    console.log(`[SERVER DELETE] Connecting to delete ${messages.length} queued message(s) for ${account.email_address}`);
    connection = await imaps.connect(config);
    connection.on('error', (err) => {
      console.error('[SERVER DELETE] IMAP connection error (handled):', err.message);
    });

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
          await connection.openBox(sourceFolder);
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

        const found = await connection.search([['UID', uid]], { bodies: ['HEADER.FIELDS (MESSAGE-ID)'], markSeen: false });
        if (!Array.isArray(found) || found.some(item => uint32(item?.attributes?.uid) !== uid)) {
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
        const [freshRows] = await db.execute(`SELECT m.id, m.source_folder, m.imap_uid, m.imap_uidvalidity,
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
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'failed', error: error.message || String(error) });
        failed++;
        processed++;
      }
    }

    await db.execute('UPDATE mail_accounts SET server_delete_last_run_at = UTC_TIMESTAMP() WHERE id = ?', [normalizedAccountId]);
    console.log(`[SERVER DELETE] ${account.email_address}: deleted=${deleted}, missing=${missing}, failed=${failed}, skipped=${skipped}, stopped=${stopped}`);
    return { accountId: normalizedAccountId, success: failed === 0, processed, deleted, missing, failed, skipped, stopped };
  } catch (error) {
    console.error(`[SERVER DELETE] Account ${normalizedAccountId} failed:`, error.message);
    return { accountId: normalizedAccountId, success: false, error: error.message || String(error) };
  } finally {
    if (connection) {
      try { connection.end(); } catch (e) { /* ignore */ }
    }
    activeMailServerDeleteAccounts.delete(normalizedAccountId);
    mailDeleteStopRequests.delete(normalizedAccountId);
  }
}

async function processMailServerDeletionForAccount(accountId, options = {}) {
  const key = normalizeMailAccountId(accountId);
  if (!key || activeMailServerDeleteAccounts.has(key)) return { accountId: key, skipped: true, reason: 'already_running' };
  if (isMailAccountSyncRunning(key)) return { accountId: key, skipped: true, reason: 'mail_sync_running' };
  return withMailAccountLock(accountId, () => processMailServerDeletionForAccountUnlocked(accountId, options));
}

async function runMailServerDeletionPass({ accountId = null, limit = MAIL_SERVER_DELETE_BATCH_SIZE } = {}) {
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

  const [accounts] = await db.execute(query, params);
  const results = [];
  for (const account of accounts || []) {
    results.push(await processMailServerDeletionForAccount(account.id, { limit }));
  }
  return { skipped: false, accounts: results };
}

module.exports = {
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
