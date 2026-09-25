const crypto = require('crypto');
const { db } = require('../state');
const { withMailAccountLock } = require('./mail-account-lock');
const { isSectionRestoreActive } = require('./restore-locks');
const { isModuleEnabled, isModuleBackgroundEnabled } = require('./module-settings');
const active = new Map();
const fields = { read: 'is_read', star: 'is_starred', move: 'folder' };
const flags = { read: '\\Seen', star: '\\Flagged' };
function fail(message, status = 409) { return Object.assign(new Error(message), { status }); }
function remoteEligible(email) {
  return email.sync_mode === 'sync' && !email.is_draft && !email.is_legacy && !email.remote_missing
    && (!email.filing_account_id || email.filing_account_id === email.mail_account_id);
}
function verifiedIdentity(email) {
  return typeof email.remote_folder === 'string' && email.remote_folder.length > 0
    && Number.isSafeInteger(Number(email.remote_uid)) && Number(email.remote_uid) > 0
    && Number.isSafeInteger(Number(email.remote_uidvalidity)) && Number(email.remote_uidvalidity) > 0;
}
async function cancelForAccount(connection, accountId, userId) {
  await connection.execute(`UPDATE mail_writebacks SET status = 'conflict', error = 'Cancelled because account settings changed'
    WHERE mail_account_id = ? AND user_id = ? AND status IN ('pending', 'failed')`, [accountId, userId]);
}
// Called inside the transaction that validates every selected message/destination.
// Old local state is never uploaded: only these explicit user requests create commands.
async function queueChanges(connection, userId, emails, changes) {
  const accounts = new Set();
  for (const email of emails) {
    for (const [action, value] of Object.entries(changes)) {
      if (!fields[action]) throw fail('Unsupported mail change', 400);
      if (!remoteEligible(email)) {
        await connection.execute(`UPDATE emails SET ${fields[action]} = ? WHERE id = ? AND user_id = ?`, [value, email.id, userId]);
        continue;
      }
      if (!verifiedIdentity(email)) throw fail('Sync this account before changing this message on the provider.');
      let target = action === 'move' ? String(value) : (value ? '1' : '0'), targetFolder = null;
      if (action === 'move') {
        const [mappings] = await connection.execute(`SELECT b.remote_name FROM mail_folder_remote_boxes b
          JOIN mail_folders f ON f.id = b.folder_id
          WHERE f.user_id = ? AND f.slug = ? AND b.mail_account_id = ?`, [userId, value, email.mail_account_id]);
        if (mappings.length !== 1) throw fail('Choose a folder connected to this message’s provider account.');
        target = mappings[0].remote_name;
        targetFolder = value;
      }
      const [previous] = await connection.execute('SELECT * FROM mail_writebacks WHERE email_id = ? AND action = ? FOR UPDATE', [email.id, action]);
      const old = previous[0];
      if (action === 'move' && old?.dispatched && old.status !== 'done' && old.remote_folder === email.remote_folder && Number(old.remote_uid) === Number(email.remote_uid) && Number(old.remote_uidvalidity) === Number(email.remote_uidvalidity)) {
        throw fail('The previous move needs reconciliation. Sync the account before moving this message again.');
      }
      if (old?.status === 'pending' && old.target_value === target) { accounts.add(email.mail_account_id); continue; }
      const base = action === 'move' ? email.remote_folder : String(Number(!!email[fields[action]]));
      await connection.execute('DELETE FROM mail_writebacks WHERE email_id = ? AND action = ?', [email.id, action]);
      await connection.execute(`INSERT INTO mail_writebacks
        (id, user_id, mail_account_id, email_id, action, target_value, base_value, target_folder, remote_folder, remote_uid, remote_uidvalidity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), userId, email.mail_account_id, email.id, action, target, base, targetFolder,
        email.remote_folder, email.remote_uid, email.remote_uidvalidity]);
      accounts.add(email.mail_account_id);
    }
  }
  return accounts;
}
async function withAccountLocks(ids, callback) {
  const sorted = [...new Set(ids.filter(Boolean))].sort();
  const next = i => i === sorted.length ? callback() : withMailAccountLock(sorted[i], () => next(i + 1));
  return next(0);
}
async function mutateMessages(userId, ids, changes, validate = async () => {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw fail('Select between 1 and 500 messages.', 400);
  ids = [...new Set(ids)];
  const placeholders = ids.map(() => '?').join(',');
  const [sources] = await db.execute(`SELECT mail_account_id FROM emails WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, userId]);
  return withAccountLocks(sources.map(row => row.mail_account_id), async () => {
    if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore in progress');
    if (!await isModuleEnabled(userId, 'mail')) throw fail('Mail module is disabled');
    const connection = await db.getConnection();
    let accounts;
    try {
      await connection.beginTransaction();
      const [emails] = await connection.execute(`SELECT e.*, a.sync_mode FROM emails e
        LEFT JOIN mail_accounts a ON a.id = e.mail_account_id AND a.user_id = e.user_id
        WHERE e.id IN (${placeholders}) AND e.user_id = ? FOR UPDATE`, [...ids, userId]);
      if (emails.length !== ids.length) throw fail('Some selected emails are unavailable', 404);
      await validate(connection, emails);
      accounts = await queueChanges(connection, userId, emails, changes);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    // Start after releasing account locks; promises are observed and tracked for restore.
    for (const accountId of accounts) setImmediate(() => startWritebacks(accountId));
    return { message: accounts.size ? 'Provider changes queued' : 'Messages updated', sync_pending: accounts.size > 0 };
  });
}
function imapCall(imap, method, ...args) {
  return new Promise((resolve, reject) => imap[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}
async function readRemote(connection, op) {
  const box = await connection.openBox(op.remote_folder, false);
  if (Number(box.uidvalidity) !== Number(op.remote_uidvalidity)) throw fail('Mailbox identity changed; server state retained');
  const rows = await connection.search([['UID', Number(op.remote_uid)]], { bodies: [], markSeen: false });
  if (rows.length !== 1 || Number(rows[0].attributes.uid) !== Number(op.remote_uid)) throw fail('Message moved or disappeared on the server');
  return rows[0].attributes;
}
// Pure protocol boundary, dependency-injected in focused tests. Never use SET FLAGS
// or the library's COPY/EXPUNGE fallback for MOVE.
async function executeOperation(connection, op, { markDispatched, read = readRemote } = {}) {
  const remote = await read(connection, op);
  const imap = connection.imap;
  if (op.action === 'move') {
    if (op.target_value === op.remote_folder) return { moved: false };
    if (op.dispatched) throw fail('Previous move outcome is uncertain; sync and check the provider before another move');
    if (!imap.serverSupports('MOVE')) throw fail('This server does not support safe IMAP MOVE; move this message at the provider');
    if (Number(op.attempts) >= 2) throw fail('Automatic retry limit reached', 422);
    await markDispatched();
    const destinationUid = await imapCall(imap, 'move', Number(op.remote_uid), op.target_value);
    return { moved: true, destinationUid: /^\d+$/.test(String(destinationUid)) ? Number(destinationUid) : null };
  }
  const flag = flags[op.action];
  if (!flag) throw fail('Unsupported mail change');
  const current = remote.flags.includes(flag) ? '1' : '0';
  if (current === op.target_value) return { value: Number(current) };
  if (current !== op.base_value) throw fail('Server state changed; local action was not applied');
  if (op.dispatched && (!op.dispatch_modseq || String(remote.modseq) !== op.dispatch_modseq)) {
    throw fail('Provider state changed after an interrupted update; server state retained');
  }
  const conditional = remote.modseq && !imap._box?.nomodseq && imap.serverSupports('CONDSTORE');
  if (Number(op.attempts) >= 2) throw fail('Automatic retry limit reached', 422);
  await markDispatched(conditional ? String(remote.modseq) : null);
  const method = op.target_value === '1' ? 'addFlags' : 'delFlags';
  if (conditional) await imapCall(imap, method + 'Since', Number(op.remote_uid), flag, String(remote.modseq));
  else await imapCall(imap, method, Number(op.remote_uid), flag);
  // node-imap does not expose tagged OK [MODIFIED] for conditional STORE.
  // Read-back is required to distinguish a rejected conditional write from success.
  const after = await read(connection, op);
  if ((after.flags.includes(flag) ? '1' : '0') !== op.target_value) throw fail('Server changed during the update; server state retained');
  return { value: Number(op.target_value) };
}
async function settle(op, status, error = null) {
  await db.execute('UPDATE mail_writebacks SET status = ?, error = ? WHERE id = ? AND user_id = ?', [status, error, op.id, op.user_id]);
}
async function processPending(account, connection, { background = false } = {}) {
  const [ops] = await db.execute(`SELECT * FROM mail_writebacks WHERE mail_account_id = ? AND user_id = ?
    AND status = 'pending' AND available_at <= UTC_TIMESTAMP() ORDER BY (action = 'move'), created_at, id LIMIT 500`, [account.id, account.user_id]);
  let needsSync = false, connectionFailed = false;
  for (const op of ops) {
    if (await isSectionRestoreActive(account.user_id, 'mail') || !await (background ? isModuleBackgroundEnabled : isModuleEnabled)(account.user_id, 'mail')) break;
    const [rows] = await db.execute(`SELECT e.*, a.sync_mode, a.is_active FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id
      WHERE e.id = ? AND e.user_id = ? AND a.user_id = ?`, [op.email_id, op.user_id, op.user_id]);
    const email = rows[0];
    if (!email || !email.is_active || !remoteEligible(email) || !verifiedIdentity(email)
      || email.remote_folder !== op.remote_folder || Number(email.remote_uid) !== Number(op.remote_uid)
      || Number(email.remote_uidvalidity) !== Number(op.remote_uidvalidity)) {
      await settle(op, 'conflict', 'Message or account changed; server state retained'); continue;
    }
    try {
      await db.execute('UPDATE mail_writebacks SET attempts = attempts + 1 WHERE id = ?', [op.id]);
      const result = await executeOperation(connection, op, { markDispatched: async (modseq = null) => {
        // Persist BEFORE the remote command: a crash must not replay an uncertain move.
        if (await isSectionRestoreActive(op.user_id, 'mail') || !await (background ? isModuleBackgroundEnabled : isModuleEnabled)(op.user_id, 'mail')) throw fail('Mail paused before the provider update');
        const [dispatch] = await db.execute(`UPDATE mail_writebacks SET dispatched = TRUE, dispatch_modseq = ?
          WHERE id = ? AND user_id = ? AND status = 'pending'
          AND EXISTS (SELECT 1 FROM mail_accounts a WHERE a.id = mail_writebacks.mail_account_id
            AND a.user_id = ? AND a.sync_mode = 'sync' AND a.is_active = TRUE)`, [modseq, op.id, op.user_id, op.user_id]);
        if (!dispatch.affectedRows) throw fail('Change cancelled before the provider update');
        op.dispatched = true;
      } });
      if (op.action === 'move') {
        needsSync = true;
        if (result.moved) {
          // Verify COPYUID's destination against the source's immutable raw hash.
          if (!result.destinationUid || !email.raw_sha256) throw fail('Move accepted; refresh mail to reconcile its new identity');
          const box = await connection.openBox(op.target_value, true);
          const messages = await connection.search([['UID', result.destinationUid]], { bodies: [''], markSeen: false });
          const raw = messages[0]?.parts?.find(part => part.which === '')?.body;
          const hash = raw && crypto.createHash('sha256').update(raw).digest('hex');
          if (messages.length !== 1 || hash !== email.raw_sha256 || !Number(box.uidvalidity)) throw fail('Move accepted; refresh mail to reconcile its new identity');
          await db.execute(`UPDATE emails SET folder = ?, remote_folder = ?, remote_uid = ?, remote_uidvalidity = ? WHERE id = ? AND user_id = ?`,
            [op.target_folder, op.target_value, result.destinationUid, box.uidvalidity, op.email_id, op.user_id]);
        }
      } else await db.execute(`UPDATE emails SET ${fields[op.action]} = ? WHERE id = ? AND user_id = ?`, [result.value, op.email_id, op.user_id]);
      await settle(op, 'done');
    } catch (error) {
      if (error.status === 409) { await settle(op, 'conflict', error.message); needsSync = true; }
      else if (op.action === 'move' && op.dispatched) {
        await settle(op, 'conflict', 'Move outcome uncertain; sync and check the provider before another move'); needsSync = true;
      } else if (Number(op.attempts) + 1 >= 2) await settle(op, 'failed', 'Provider update failed after one retry. Check the connection and retry manually.');
      else await db.execute(`UPDATE mail_writebacks SET error = 'Connection interrupted; will check the provider before one retry',
        available_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?`, [op.id]);
      if (error.status !== 409) { connectionFailed = true; break; } // A broken connection is not reusable.
    }
  }
  await db.execute("DELETE FROM mail_writebacks WHERE mail_account_id = ? AND status = 'done' AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)", [account.id]);
  return { needsSync, connectionFailed };
}
function startWritebacks(accountId) {
  if (active.has(accountId)) return active.get(accountId);
  let needsSync = false;
  const promise = withMailAccountLock(accountId, async () => {
    let connection;
    try {
      const [[account]] = await db.execute('SELECT * FROM mail_accounts WHERE id = ?', [accountId]);
      if (!account || account.sync_mode !== 'sync' || !account.is_active || await isSectionRestoreActive(account.user_id, 'mail')
        || !await isModuleEnabled(account.user_id, 'mail')) return;
      const { buildImapConnectionConfig } = require('./mail');
      const config = await buildImapConnectionConfig(account, { keepalive: false });
      if (!config) throw new Error('Missing credentials');
      config.imap.connTimeout = 15000; config.imap.authTimeout = 15000; config.imap.socketTimeout = 30000;
      connection = await require('imap-simple').connect(config);
      connection.on('error', () => {});
      ({ needsSync } = await processPending(account, connection));
    } catch {
      // Connection failures occur before per-command processing. Count and bound
      // them too; never silently leave a request pending forever.
      await db.execute(`UPDATE mail_writebacks SET attempts = attempts + 1,
        status = IF(attempts >= 2, 'failed', 'pending'), error = 'Could not connect to provider; retry or check account settings',
        available_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)
        WHERE mail_account_id = ? AND status = 'pending' AND available_at <= UTC_TIMESTAMP()`, [accountId]).catch(() => {});
    } finally { if (connection) connection.end(); }
  }).catch(error => console.error('[MAIL WRITEBACK] Worker failed:', error.message)).finally(() => {
    active.delete(accountId);
    if (needsSync) setImmediate(() => require('./mail').syncMailAccount(accountId).catch(() => {}));
  });
  active.set(accountId, promise);
  return promise;
}
async function retryWriteback(userId, id) {
  const [[op]] = await db.execute('SELECT * FROM mail_writebacks WHERE id = ? AND user_id = ?', [id, userId]);
  if (!op) throw fail('Change not found', 404);
  await withMailAccountLock(op.mail_account_id, async () => {
    if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore in progress');
    const [result] = await db.execute(`UPDATE mail_writebacks SET status = 'pending', attempts = 0, error = NULL, available_at = UTC_TIMESTAMP()
      WHERE id = ? AND user_id = ? AND status = 'failed' AND NOT (action = 'move' AND dispatched = TRUE)`, [id, userId]);
    if (!result.affectedRows) throw fail('This change cannot be retried; refresh mail and check its server state.');
  });
  startWritebacks(op.mail_account_id);
  return { message: 'Retry queued' };
}
module.exports = { mutateMessages, queueChanges, processPending, startWritebacks, retryWriteback, cancelForAccount,
  isWritebackRunning: () => active.size > 0, executeOperation, remoteEligible, verifiedIdentity };
