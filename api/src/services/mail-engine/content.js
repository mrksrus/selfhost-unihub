const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const uint32 = value => {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return null;
  if (!/^[0-9]+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 0xffffffff ? n : null;
};

function requireRawBuffer(raw, maxBytes = DEFAULT_MAX_BYTES) {
  if (!Buffer.isBuffer(raw)) throw Object.assign(new TypeError('Provider raw message must be exact octets (Buffer)'), { code: 'MAIL_RAW_NOT_OCTETS' });
  if (raw.length > maxBytes) throw Object.assign(new Error('Provider message exceeds body byte budget'), { code: 'MAIL_BODY_TOO_LARGE' });
  return raw;
}
function rawDigest(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function safePath(root, userId, emailId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(emailId)) || !/^[0-9a-f-]{36}$/i.test(String(userId))) {
    throw new Error('Invalid archive owner or item identifier');
  }
  return path.join(path.resolve(root), String(userId), `${emailId}-${crypto.randomUUID()}.eml`);
}

// The published file is immutable. A crash before DB commit leaves only an
// orphan; it cannot leave a committed row pointing at a partially written file.
async function publishRaw({ root, userId, emailId, raw, maxBytes = DEFAULT_MAX_BYTES }) {
  requireRawBuffer(raw, maxBytes);
  const finalPath = safePath(root, userId, emailId);
  const directory = path.dirname(finalPath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${finalPath}.part`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, finalPath);
    const dirHandle = await fs.open(directory, 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    // Never remove a published file: DB COMMIT may already be in progress.
    throw error;
  }
  return { rawStoragePath: finalPath, rawSha256: rawDigest(raw), rawBytes: raw.length, rawFormat: 'exact_octets', rawVerified: true };
}

async function readVerifiedArchive(row, { root, userId = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (userId != null && !/^[0-9a-f-]{36}$/i.test(String(userId))) return null;
  if (row?.raw_format !== 'exact_octets' || !(row.raw_verified === true || row.raw_verified === 1 || row.raw_verified === '1')) return null;
  if (!Number.isSafeInteger(Number(row.raw_bytes)) || Number(row.raw_bytes) < 0 || Number(row.raw_bytes) > maxBytes) return null;
  if (!/^[a-f0-9]{64}$/i.test(String(row.raw_sha256 || ''))) return null;
  const full = path.resolve(row.raw_storage_path || '');
  const base = path.resolve(root || '/app/uploads/mail-raw', ...(userId == null ? [] : [String(userId)]));
  if (!full.startsWith(`${base}${path.sep}`)) return null;
  let handle;
  try {
    handle = await fs.open(full, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== Number(row.raw_bytes)) return null;
    const content = await handle.readFile();
    return content.length === Number(row.raw_bytes) && rawDigest(content) === row.raw_sha256.toLowerCase() ? content : null;
  } catch { return null; }
  finally { if (handle) await handle.close(); }
}
async function verifyArchive(row, options = {}) {
  return await readVerifiedArchive(row, options) !== null;
}

async function eligibleForProviderErasure({ row, sourceFolder, uid, uidValidity, selectedUidValidity, root }) {
  const expected = uint32(uidValidity), selected = uint32(selectedUidValidity), sourceUid = uint32(uid);
  if (!expected || !selected || expected !== selected || !sourceUid || !sourceFolder ||
    row?.remote_missing === true || row?.remote_missing === 1 || row?.remote_missing === '1') return false;
  if (String(row.remote_folder || row.source_folder) !== String(sourceFolder)
    || uint32(row.remote_uid ?? row.imap_uid) !== sourceUid
    || uint32(row.remote_uidvalidity ?? row.imap_uidvalidity) !== expected
    || !(row.import_complete === true || row.import_complete === 1 || row.import_complete === '1')) return false;
  return verifyArchive(row, { root });
}

async function fetchRawBounded(transport, connection, address, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('Body fetch cancelled'), { code: 'MAIL_SYNC_CANCELLED' });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    try { connection.end(); } catch { /* already closed */ }
    reject(Object.assign(new Error('Body fetch deadline exceeded'), { code: 'MAIL_BODY_TIMEOUT' }));
  }, timeoutMs); });
  try {
    const result = await Promise.race([transport.fetchRawMessage(connection,
      { folder: address.folder, uidvalidity: address.uidvalidity, uid: address.uid, maxBytes }, { signal }), timeout]);
    if (signal?.aborted) throw Object.assign(new Error('Body fetch cancelled'), { code: 'MAIL_SYNC_CANCELLED' });
    return requireRawBuffer(result?.raw, maxBytes);
  } finally { clearTimeout(timer); }
}

async function processBodySlice({ db, connection, account, folder, mailboxId, signal, job = null, report = () => {} }) {
  const { simpleParser } = require('mailparser');
  const transport = require('./transport');
  const runtime = require('./runtime');
  const markDeferred = async emailId => require('./repository').withTransaction(async cx => {
    if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id,
      workerId: job.lease_owner, generation: job.worker_generation }, cx);
    await cx.execute(`UPDATE emails SET content_state = 'deferred' WHERE id = ? AND user_id = ? AND mail_account_id = ?
      AND import_complete = FALSE`, [emailId, account.user_id, account.id]);
  }, db);
  const [rows] = await db.execute(`SELECT o.id AS occurrence_id, o.uid, o.uidvalidity, o.email_id,
      e.raw_storage_path, e.raw_sha256, e.raw_bytes, e.raw_format, e.raw_verified,
      e.import_complete, e.message_id, e.is_read
    FROM mail_remote_occurrences o JOIN emails e ON e.id = o.email_id AND e.user_id = o.user_id
    JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.uidvalidity = o.uidvalidity AND m.state = 'active'
    WHERE o.user_id = ? AND o.mail_account_id = ? AND o.mailbox_id = ? AND o.presence = 'present'
      AND e.content_state = 'queued' AND e.import_complete = FALSE
    ORDER BY o.uid DESC LIMIT 1`, [account.user_id, account.id, mailboxId]);
  if (!rows.length) return { processed: 0, more: false };
  const row = rows[0];
  if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id, workerId: job.lease_owner,
    generation: job.worker_generation }, db);
  const selected = await transport.selectMailbox(connection, { folder: folder.folderName, readOnly: true, signal });
  if (uint32(selected.uidvalidity) !== uint32(row.uidvalidity)) throw new Error('Body source epoch changed');
  let raw;
  try {
    raw = await fetchRawBounded(transport, connection, { folder: folder.folderName,
      uidvalidity: uint32(row.uidvalidity), uid: uint32(row.uid) }, { signal });
  } catch (error) {
    if (error.message === 'Raw fetch must return exactly one message') {
      // The raw FETCH also rejects malformed/multiple replies. It cannot by
      // itself prove absence. Confirm an exact, complete same-epoch UID window
      // before considering a retained local archive.
      if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id,
        workerId: job.lease_owner, generation: job.worker_generation }, db);
      if (signal?.aborted) throw error;
      const probe = await transport.fetchMetadataWindow(connection, { folder: folder.folderName,
        uidvalidity: uint32(row.uidvalidity), startUid: uint32(row.uid), endUid: uint32(row.uid),
        maxMessages: 1, maxBytes: 1024 * 1024 }, { signal });
      const present = require('./sync').validateWindowReply(probe,
        { start: uint32(row.uid), end: uint32(row.uid) }, uint32(row.uidvalidity));
      if (present.length) throw error;
      // Only previously verified exact octets inside this owner's archive root
      // may repair the import; an unverified legacy file is not provider proof.
      raw = await readVerifiedArchive(row, { root: require('../mail').MAIL_RAW_STORAGE_ROOT, userId: account.user_id });
      if (!raw) throw error;
    } else if (['MAIL_IMAP_LIMIT', 'MAIL_BODY_TOO_LARGE'].includes(error.code)) {
      await markDeferred(row.email_id);
      return { processed: 0, deferred: true, reason: 'byte_budget', more: true };
    } else throw error;
  }
  if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id, workerId: job.lease_owner,
    generation: job.worker_generation }, db);
  let parsed;
  try { parsed = await simpleParser(raw); }
  catch (error) {
    await markDeferred(row.email_id);
    return { processed: 0, deferred: true, reason: 'parse_failure', more: true };
  }
  const address = parsed.from?.value?.[0];
  const { persistImportedMessage } = require('../mail-import');
  const result = await persistImportedMessage({ db, account, accountId: account.id, folderName: folder.folderName,
    uid: row.uid, uidValidity: row.uidvalidity, existingEmail: { id: row.email_id, raw_storage_path: row.raw_storage_path },
    messageId: parsed.messageId || null, fullEmail: raw, parsed, fromAddress: address?.address || 'unknown',
    fromName: address?.name || null, toAddresses: (parsed.to?.value || []).map(a => a.address).filter(Boolean),
    folder: folder.dbFolderName, isRead: !!row.is_read,
    archiveRaw: data => publishRaw({ root: require('../mail').MAIL_RAW_STORAGE_ROOT, ...data, raw: data.rawEmail }),
    enqueueDeletion: require('../mail').recordMailServerMessageForDeletion,
    suppressNotifications: true,
    validateOccurrence: async (cx, emailId) => {
      if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id,
        workerId: job.lease_owner, generation: job.worker_generation }, cx);
      const [[occ]] = await cx.execute(`SELECT o.email_id FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id=o.mailbox_id
        WHERE o.id=? AND o.user_id=? AND o.mail_account_id=? AND o.mailbox_id=? AND o.uidvalidity=? AND o.uid=?
          AND o.presence='present' AND m.uidvalidity=o.uidvalidity AND m.state='active' FOR UPDATE`,
      [row.occurrence_id, account.user_id, account.id, mailboxId, row.uidvalidity, row.uid]);
      if (!occ || occ.email_id !== emailId) throw new Error('Body occurrence changed before archive commit');
    } });
  await report({ phase: 'bodies', processed: 1, total: null });
  return { processed: 1, emailId: result.emailId, more: true };
}

module.exports = { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, requireRawBuffer, rawDigest, publishRaw, verifyArchive, eligibleForProviderErasure, fetchRawBounded, processBodySlice, uint32 };
