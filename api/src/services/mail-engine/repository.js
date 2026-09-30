'use strict';
const { randomUUID } = require('node:crypto');
const { db } = require('../../state');
const { assertUid32, assertDecimal64 } = require('./repository-identity');
const STREAMS = new Set(['recent', 'history', 'flags', 'presence', 'bodies']);
const requireId = (v, label) => { if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${label} required`); return v; };
const fail = (code, message) => Object.assign(new Error(message), { code });
// InnoDB picks a deadlock victim and rolls its whole transaction back, so the
// callback can run again from the start. Callbacks here only touch the
// database; provider commands never run inside a transaction.
const DEADLOCK_RETRIES = 3;
const isDeadlock = error => error?.code === 'ER_LOCK_DEADLOCK' || error?.errno === 1213;
async function withTransaction(callback, executor = db) {
  if (typeof executor.getConnection !== 'function') throw new TypeError('withTransaction requires a pool; pass your existing connection directly to helpers');
  for (let attempt = 1; ; attempt++) {
    const cx = await executor.getConnection();
    try {
      await cx.beginTransaction();
      const result = await callback(cx);
      await cx.commit();
      return result;
    } catch (error) {
      await cx.rollback();
      if (!isDeadlock(error) || attempt > DEADLOCK_RETRIES) throw error;
    } finally { cx.release(); }
    await new Promise(resolve => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
  }
}
async function ownAccount(cx, userId, accountId, lock = false) {
  requireId(userId, 'userId'); requireId(accountId, 'accountId');
  const [rows] = await cx.execute(`SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [accountId, userId]);
  if (!rows.length) throw fail('MAIL_ACCOUNT_NOT_OWNED', 'Mail account not found');
}
async function ownMailbox(cx, userId, accountId, mailboxId, lock = false) {
  requireId(mailboxId, 'mailboxId');
  const [rows] = await cx.execute(`SELECT * FROM mail_remote_mailboxes WHERE id = ? AND user_id = ? AND mail_account_id = ?${lock ? ' FOR UPDATE' : ''}`, [mailboxId, userId, accountId]);
  if (!rows.length) throw fail('MAILBOX_NOT_OWNED', 'Remote mailbox not found');
  return rows[0];
}
function pathName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || name.includes('\0')) throw new TypeError('Invalid remote mailbox path');
  return /^[iI][nN][bB][oO][xX]$/.test(name) ? 'INBOX' : name;
}
async function ensureMailbox({ userId, accountId, folderName, epoch = null, metadata = {} }, executor = db) {
  if (typeof executor.getConnection === 'function') return withTransaction(cx => ensureMailbox({ userId, accountId, folderName, epoch, metadata }, cx), executor);
  const cx = executor, name = pathName(folderName);
  if (epoch !== null) epoch = assertUid32(epoch);
  await ownAccount(cx, userId, accountId, true);
  const [present] = await cx.execute('SELECT * FROM mail_remote_mailboxes WHERE mail_account_id = ? AND remote_name = ? FOR UPDATE', [accountId, name]);
  let mailbox = present[0];
  if (!mailbox) {
    const id = randomUUID();
    await cx.execute(`INSERT INTO mail_remote_mailboxes (id,user_id,mail_account_id,remote_name,uidvalidity,delimiter,special_use,provider_mailbox_id)
      VALUES (?,?,?,?,?,?,?,?)`, [id, userId, accountId, name, epoch, metadata.delimiter ?? null, metadata.specialUse ?? null, metadata.providerMailboxId ?? null]);
    const [rows] = await cx.execute('SELECT * FROM mail_remote_mailboxes WHERE id = ?', [id]);
    return rows[0];
  }
  if (mailbox.user_id !== userId) throw fail('MAILBOX_OWNER_CONFLICT', 'Mailbox owner mismatch');
  if (epoch !== null && mailbox.uidvalidity !== null && Number(mailbox.uidvalidity) !== epoch) {
    if (metadata.allowEpochChange === false) return mailbox; // legacy backfill cannot establish live epoch
    await cx.execute("UPDATE mail_remote_occurrences SET presence = 'quarantined', quarantine_reason = 'epoch_changed' WHERE mailbox_id = ? AND presence = 'present'", [mailbox.id]);
    await cx.execute('DELETE FROM mail_engine_cursors WHERE mailbox_id = ?', [mailbox.id]);
    // Old addresses may have been reused; never dispatch accepted work on them.
    // Only a dispatched effect needs a provider outcome check. Undispatched
    // intents are kept but need a user retry (rebased after sync) or discard.
    const stale = `user_id = ? AND mail_account_id = ? AND (BINARY remote_folder = BINARY ?
        OR (? = 'INBOX' AND remote_folder REGEXP '^[iI][nN][bB][oO][xX]$')) AND remote_uidvalidity <> ?
        AND state IN ('queued','executing','verifying','retry_wait')`;
    // Keep recorded COPYUID/UID mapping evidence; the outcome check needs it.
    await cx.execute(`UPDATE mail_writebacks SET state = 'reconciling', status = 'pending',
      evidence_json = JSON_SET(COALESCE(evidence_json, JSON_OBJECT()), '$.reason', 'epoch_changed')
      WHERE dispatched = TRUE AND ${stale}`, [userId, accountId, name, name, epoch]);
    await cx.execute(`UPDATE mail_writebacks SET state = 'needs_attention', status = 'conflict',
      error = 'Provider reset this mailbox; sync, then retry or discard this change',
      evidence_json = JSON_OBJECT('reason','epoch_changed') WHERE dispatched = FALSE AND ${stale}`, [userId, accountId, name, name, epoch]);
    await cx.execute(`UPDATE mail_remote_mailboxes SET uidvalidity = ?, state = 'active', epoch_revision = epoch_revision + 1 WHERE id = ?`, [epoch, mailbox.id]);
  } else if (epoch !== null && mailbox.uidvalidity === null) {
    await cx.execute("UPDATE mail_remote_mailboxes SET uidvalidity = ?, state = 'active', epoch_revision = epoch_revision + 1 WHERE id = ?", [epoch, mailbox.id]);
  } else if (epoch !== null && mailbox.state === 'quarantined' && metadata.allowEpochChange !== false) {
    // Only a live SELECT (not a historical backfill) may lift mailbox quarantine.
    await cx.execute("UPDATE mail_remote_mailboxes SET state = 'active', epoch_revision = epoch_revision + 1 WHERE id = ?", [mailbox.id]);
  }
  if (metadata.delimiter !== undefined || metadata.specialUse !== undefined || metadata.providerMailboxId !== undefined) {
    await cx.execute('UPDATE mail_remote_mailboxes SET delimiter = COALESCE(?,delimiter), special_use = COALESCE(?,special_use), provider_mailbox_id = COALESCE(?,provider_mailbox_id) WHERE id = ?',
      [metadata.delimiter ?? null, metadata.specialUse ?? null, metadata.providerMailboxId ?? null, mailbox.id]);
  }
  const [rows] = await cx.execute('SELECT * FROM mail_remote_mailboxes WHERE id = ?', [mailbox.id]);
  return rows[0];
}
async function getOccurrence({ userId, accountId, mailboxId, epoch, uid }, executor = db) {
  epoch = assertUid32(epoch); uid = assertUid32(uid);
  const [rows] = await executor.execute(`SELECT o.* FROM mail_remote_occurrences o
    JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.user_id = o.user_id AND m.mail_account_id = o.mail_account_id
    WHERE o.user_id = ? AND o.mail_account_id = ? AND o.mailbox_id = ? AND o.uidvalidity = ? AND o.uid = ?`, [userId, accountId, mailboxId, epoch, uid]);
  return rows[0] || null;
}
async function upsertOccurrence({ userId, accountId, mailboxId, epoch, uid, emailId, flags = [], modseq = null, gmailMsgId = null, observationRevision = null }, executor = db) {
  if (typeof executor.getConnection === 'function') return withTransaction(cx => upsertOccurrence({ userId, accountId, mailboxId, epoch, uid, emailId, flags, modseq, gmailMsgId, observationRevision }, cx), executor);
  const cx = executor;
  epoch = assertUid32(epoch); uid = assertUid32(uid); requireId(emailId, 'emailId');
  if (modseq != null) modseq = assertDecimal64(modseq);
  if (gmailMsgId != null) gmailMsgId = assertDecimal64(gmailMsgId);
  if (observationRevision != null && (!Number.isSafeInteger(observationRevision) || observationRevision < 0)) throw new RangeError('Invalid observation revision');
  if (!Array.isArray(flags) || flags.some(f => typeof f !== 'string' || f.length > 128) || flags.length > 128) throw new TypeError('Invalid flags');
  const mailbox = await ownMailbox(cx, userId, accountId, mailboxId, true);
  if (Number(mailbox.uidvalidity) !== epoch || mailbox.state !== 'active') throw fail('MAIL_EPOCH_STALE', 'Mailbox epoch is not current');
  const [items] = await cx.execute('SELECT id FROM emails WHERE id = ? AND user_id = ? AND mail_account_id = ?', [emailId, userId, accountId]);
  if (!items.length) throw fail('MAIL_ITEM_NOT_OWNED', 'Email not found for this account');
  if (gmailMsgId) {
    const [known] = await cx.execute('SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND gmail_msgid = ? FOR UPDATE', [accountId, gmailMsgId]);
    if (known.length && known[0].email_id !== emailId) throw fail('GMAIL_IDENTITY_CONFLICT', 'Gmail identity belongs to another local item');
    if (!known.length) await cx.execute('INSERT INTO mail_gmail_messages (mail_account_id,gmail_msgid,user_id,email_id) VALUES (?,?,?,?)', [accountId, gmailMsgId, userId, emailId]);
  }
  const [existing] = await cx.execute('SELECT * FROM mail_remote_occurrences WHERE mailbox_id = ? AND uidvalidity = ? AND uid = ? FOR UPDATE', [mailboxId, epoch, uid]);
  const old = existing[0];
  if (old && old.email_id !== emailId) throw fail('MAIL_TUPLE_CONFLICT', 'Provider UID belongs to another local item');
  if (old && old.presence === 'quarantined') throw fail('MAIL_OCCURRENCE_QUARANTINED', 'Ambiguous occurrence needs reconciliation');
  if (old && ((modseq != null && old.observed_modseq != null && BigInt(modseq) < BigInt(old.observed_modseq)) ||
    (observationRevision != null && observationRevision < Number(old.observation_revision)))) return old;
  const nextRevision = observationRevision ?? (Number(old?.observation_revision || 0) + 1);
  const id = old?.id ?? randomUUID();
  if (old) await cx.execute(`UPDATE mail_remote_occurrences SET observed_flags = ?, observed_modseq = ?, gmail_msgid = COALESCE(?,gmail_msgid),
      presence = 'present', observation_revision = ?, observed_at = UTC_TIMESTAMP(), absent_at = NULL WHERE id = ?`,
    [JSON.stringify(flags), modseq ?? old.observed_modseq, gmailMsgId, nextRevision, id]);
  else await cx.execute(`INSERT INTO mail_remote_occurrences
    (id,user_id,mail_account_id,mailbox_id,uidvalidity,uid,email_id,observed_flags,observed_modseq,gmail_msgid,observation_revision,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
    [id, userId, accountId, mailboxId, epoch, uid, emailId, JSON.stringify(flags), modseq, gmailMsgId, nextRevision]);
  return getOccurrence({ userId, accountId, mailboxId, epoch, uid }, cx);
}
async function loadCursor({ userId, accountId, mailboxId, stream, epoch }, executor = db) {
  if (!STREAMS.has(stream)) throw new TypeError('Invalid coverage stream');
  epoch = assertUid32(epoch);
  const [rows] = await executor.execute(`SELECT c.* FROM mail_engine_cursors c JOIN mail_remote_mailboxes m ON m.id = c.mailbox_id
    WHERE c.user_id = ? AND c.mail_account_id = ? AND c.mailbox_id = ? AND c.stream = ?
      AND c.uidvalidity = ? AND m.uidvalidity = ? AND m.state = 'active'`, [userId, accountId, mailboxId, stream, epoch, epoch]);
  return rows[0] || null;
}
async function saveCursor({ userId, accountId, mailboxId, stream, epoch, windowStart, windowEnd, coveredThrough, checkpoint = null, sweepGeneration = 0, coverage = null, complete = true }, executor = db) {
  if (!complete) throw fail('INCOMPLETE_COVERAGE', 'Cannot checkpoint incomplete window');
  if (!STREAMS.has(stream)) throw new TypeError('Invalid coverage stream');
  epoch = assertUid32(epoch);
  for (const [label, n] of Object.entries({ windowStart, windowEnd, coveredThrough })) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 4294967295) throw new RangeError(`Invalid ${label}`);
  }
  if (windowStart > windowEnd || coveredThrough < windowStart || coveredThrough > windowEnd || windowEnd - windowStart > 10000) throw new RangeError('Unbounded or uncovered UID window');
  if (!Number.isSafeInteger(sweepGeneration) || sweepGeneration < 0) throw new RangeError('Invalid sweep generation');
  if (checkpoint != null) checkpoint = assertDecimal64(checkpoint);
  const mailbox = await ownMailbox(executor, userId, accountId, mailboxId, true);
  if (Number(mailbox.uidvalidity) !== epoch || mailbox.state !== 'active') throw fail('MAIL_EPOCH_STALE', 'Cannot checkpoint a stale epoch');
  const [previous] = await executor.execute('SELECT * FROM mail_engine_cursors WHERE mailbox_id = ? AND stream = ? FOR UPDATE', [mailboxId, stream]);
  const old = previous[0];
  if (old && Number(old.uidvalidity) === epoch) {
    if (coveredThrough < Number(old.covered_through)) throw fail('CURSOR_REGRESSION', 'Covered UID cannot move backwards');
    if (checkpoint != null && old.checkpoint != null && BigInt(checkpoint) < BigInt(old.checkpoint)) throw fail('CURSOR_REGRESSION', 'Checkpoint cannot move backwards');
    if (sweepGeneration < Number(old.sweep_generation)) throw fail('CURSOR_REGRESSION', 'Sweep generation cannot move backwards');
  }
  const json = coverage == null ? null : JSON.stringify(coverage);
  await executor.execute(`INSERT INTO mail_engine_cursors (mailbox_id,stream,user_id,mail_account_id,uidvalidity,window_start,window_end,covered_through,checkpoint,sweep_generation,coverage_json,last_covered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE
    uidvalidity=VALUES(uidvalidity), window_start=VALUES(window_start), window_end=VALUES(window_end),
    covered_through=VALUES(covered_through), checkpoint=VALUES(checkpoint), sweep_generation=VALUES(sweep_generation),
    coverage_json=VALUES(coverage_json), last_covered_at=UTC_TIMESTAMP()`,
    [mailboxId, stream, userId, accountId, epoch, windowStart, windowEnd, coveredThrough, checkpoint ?? old?.checkpoint ?? null, sweepGeneration, json]);
  return loadCursor({ userId, accountId, mailboxId, stream, epoch }, executor);
}
async function markAbsentInWindow({ userId, accountId, mailboxId, epoch, windowStart, windowEnd, presentUids, complete }, executor = db) {
  if (!complete) throw fail('INCOMPLETE_COVERAGE', 'Cannot infer absence from incomplete response');
  epoch = assertUid32(epoch);
  if (!Number.isSafeInteger(windowStart) || !Number.isSafeInteger(windowEnd) || windowStart < 1 || windowEnd < windowStart || windowEnd - windowStart > 10000) throw new RangeError('Invalid bounded window');
  if (!Array.isArray(presentUids) || presentUids.length > 10001) throw new TypeError('Invalid UID inventory');
  const ids = [...new Set(presentUids.map(assertUid32))];
  if (ids.some(uid => uid < windowStart || uid > windowEnd)) throw new RangeError('UID outside covered window');
  const mailbox = await ownMailbox(executor, userId, accountId, mailboxId, true);
  if (mailbox.state !== 'active' || Number(mailbox.uidvalidity) !== epoch) throw fail('MAIL_EPOCH_STALE', 'Cannot infer absence across epochs');
  // Large windows should be split into smaller slices by caller. Parameterized list.
  const [result] = await executor.execute(`UPDATE mail_remote_occurrences SET presence = 'absent', absent_at = UTC_TIMESTAMP()
    WHERE user_id = ? AND mail_account_id = ? AND mailbox_id = ? AND uidvalidity = ?
      AND uid BETWEEN ? AND ? AND presence = 'present'${ids.length ? ` AND uid NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
    [userId, accountId, mailboxId, epoch, windowStart, windowEnd, ...ids]);
  return result.affectedRows;
}
function validateClientKey(key) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TypeError('Invalid idempotency key');
  return key;
}
async function getReceipt({ userId, clientKey }, executor = db) {
  validateClientKey(clientKey); requireId(userId, 'userId');
  const [rows] = await executor.execute('SELECT * FROM mail_command_receipts WHERE user_id = ? AND client_key = ?', [userId, clientKey]);
  return rows[0] || null;
}
async function recordReceipt({ userId, clientKey, requestHash, response }, executor = db) {
  validateClientKey(clientKey); requireId(userId, 'userId');
  if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(requestHash)) throw new TypeError('Invalid request hash');
  // Caller uses one transaction for row lock, command insert and receipt. Unique PK
  // arbitrates concurrent inserts; duplicate-key follows with locking read.
  const [known] = await executor.execute('SELECT request_hash,response_json FROM mail_command_receipts WHERE user_id = ? AND client_key = ? FOR UPDATE', [userId, clientKey]);
  if (known.length) {
    if (known[0].request_hash !== requestHash) throw fail('IDEMPOTENCY_KEY_REUSED', 'Idempotency key belongs to a different request');
    return { response: typeof known[0].response_json === 'string' ? JSON.parse(known[0].response_json) : known[0].response_json, replayed: true };
  }
  await executor.execute(`INSERT INTO mail_command_receipts (user_id,client_key,request_hash,response_json)
    VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE user_id = user_id`,
    [userId, clientKey, requestHash, JSON.stringify(response)]);
  const [accepted] = await executor.execute('SELECT request_hash,response_json FROM mail_command_receipts WHERE user_id = ? AND client_key = ? FOR UPDATE', [userId, clientKey]);
  if (accepted[0].request_hash !== requestHash) throw fail('IDEMPOTENCY_KEY_REUSED', 'Idempotency key belongs to a different request');
  return { response: typeof accepted[0].response_json === 'string' ? JSON.parse(accepted[0].response_json) : accepted[0].response_json,
    replayed: false };
}
module.exports = { withTransaction, isDeadlock, ownAccount, ownMailbox, ensureMailbox, upsertOccurrence, getOccurrence, loadCursor, saveCursor, markAbsentInWindow, getReceipt, recordReceipt };
