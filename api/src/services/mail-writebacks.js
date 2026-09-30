const crypto = require('node:crypto');
const { db } = require('../state');
const { withMailAccountLock } = require('./mail-account-lock');
const { acquireImapConnection, releaseImapConnection } = require('./mail-engine/connection-pool');
const { operationDue, processOperationBatch } = require('./mail-engine/operation-batch');
const { isSectionRestoreActive } = require('./restore-locks');
const { isModuleEnabled, isModuleBackgroundEnabled } = require('./module-settings');
const engine = require('./mail-engine/operations');
const runtime = require('./mail-engine/runtime');
const active = new Map(), queued = new Map(), foregroundReruns = new Set();
const activeControllers = new Map();
let dueCursor = '';
const fields = { read: 'is_read', star: 'is_starred', move: 'folder' };
function fail(message, status = 409) { return Object.assign(new Error(message), { status }); }
function remoteEligible(email) {
  return email.sync_mode === 'sync' && !email.is_draft && !email.is_legacy && !email.remote_missing
    && (!email.filing_account_id || email.filing_account_id === email.mail_account_id);
}
function verifiedIdentity(email) {
  return typeof email.remote_folder === 'string' && email.remote_folder.length > 0
    && [email.remote_uid, email.remote_uidvalidity].every(v => /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 4294967295);
}
function keyCheck(key) {
  if (key === undefined || key === null) return null;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw fail('Invalid Idempotency-Key', 400);
  return key;
}
function canonicalRequest(ids, changes) {
  const clean = {};
  for (const action of Object.keys(changes).sort()) {
    if (!fields[action]) throw fail('Unsupported mail change', 400);
    clean[action] = action === 'move' ? String(changes[action]) : Number(Boolean(changes[action]));
  }
  if (!Object.keys(clean).length) throw fail('No mail change requested', 400);
  return crypto.createHash('sha256').update(JSON.stringify({ ids: [...ids].sort(), changes: clean })).digest('hex');
}
function receiptResponse(saved) {
  const value = typeof saved === 'string' ? JSON.parse(saved) : saved;
  return value?.recovery_required ? { ...value, sync_pending: false,
    message: 'Recovered command requires provider revalidation; no mutation was replayed' } : value;
}
// Caller holds email row locks and a transaction. Never delete an accepted intent.
async function queueChanges(cx, userId, emails, changes, options = {}) {
  const accounts = new Set(), operationIds = options.operationIds || [], revisions = options.revisions || [];
  for (const email of emails) {
    for (const [action, value] of Object.entries(changes)) {
      if (!fields[action]) throw fail('Unsupported mail change', 400);
      if (!remoteEligible(email) || Number(email.is_active) === 0) {
        await cx.execute(`UPDATE emails SET ${fields[action]}=? WHERE id=? AND user_id=?`, [value, email.id, userId]);
        continue;
      }
      if (!verifiedIdentity(email)) throw fail('Sync this account before changing this message on the provider.');
      let target = action === 'move' ? String(value) : Number(Boolean(value)).toString(), targetFolder = null;
      if (action === 'move') {
        const [mappings] = await cx.execute(`SELECT b.remote_name FROM mail_folder_remote_boxes b JOIN mail_folders f ON f.id=b.folder_id
          WHERE f.user_id=? AND f.slug=? AND b.mail_account_id=?`, [userId, value, email.mail_account_id]);
        if (mappings.length !== 1) throw fail('Choose a folder connected to this provider account.');
        targetFolder = value; target = mappings[0].remote_name;
      }
      const [oldRows] = await cx.execute(`SELECT * FROM mail_writebacks WHERE user_id=? AND mail_account_id=? AND email_id=? AND action=?
        ORDER BY intent_revision DESC,created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [userId, email.mail_account_id, email.id, action]);
      const old = oldRows[0];
      if (old && Number(old.is_current) && ['queued', 'executing', 'verifying', 'reconciling', 'retry_wait'].includes(old.state)
        && old.target_value === target) {
        operationIds.push(old.id); revisions.push(Number(old.intent_revision)); accounts.add(email.mail_account_id); continue;
      }
      const revision = Number(old?.intent_revision || 0) + 1;
      if (old && !Number.isSafeInteger(revision)) throw fail('Mail intent revision exhausted');
      if (old && Number(old.is_current)) {
        const pendingEffect = Number(old.dispatched) && old.state !== 'confirmed';
        await cx.execute(`UPDATE mail_writebacks SET is_current=FALSE,state=?,status=? WHERE id=? AND user_id=? AND mail_account_id=?`,
          [pendingEffect ? 'reconciling' : old.state === 'confirmed' ? 'confirmed' : 'superseded',
            pendingEffect ? 'pending' : old.state === 'confirmed' ? 'done' : 'done', old.id, userId, email.mail_account_id]);
      }
      const [[source]] = await cx.execute(`SELECT o.id FROM mail_remote_occurrences o JOIN mail_remote_mailboxes b ON b.id=o.mailbox_id
        WHERE o.user_id=? AND o.mail_account_id=? AND o.email_id=? AND o.presence='present'
        AND BINARY b.remote_name=BINARY ? AND o.uidvalidity=? AND o.uid=? LIMIT 1`,
        [userId, email.mail_account_id, email.id, email.remote_folder, email.remote_uidvalidity, email.remote_uid]);
      const base = action === 'move' ? email.remote_folder : old && Number(old.dispatched) ? old.target_value : Number(Boolean(email[fields[action]])).toString();
      const id = crypto.randomUUID();
      await cx.execute(`INSERT INTO mail_writebacks
        (id,user_id,mail_account_id,email_id,action,target_value,base_value,target_folder,remote_folder,remote_uid,remote_uidvalidity,
          status,state,is_current,intent_revision,client_key,source_occurrence_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending','queued',TRUE,?,?,?)`,
      [id, userId, email.mail_account_id, email.id, action, target, base, targetFolder, email.remote_folder,
        email.remote_uid, email.remote_uidvalidity, revision, options.idempotencyKey || null, source?.id || null]);
      await runtime.enqueueJob({ userId, accountId: email.mail_account_id, operationId: id, kind: 'operation', priority: 0,
        foreground: Number(email.is_active) === 1 }, cx);
      operationIds.push(id); revisions.push(revision); accounts.add(email.mail_account_id);
    }
  }
  return accounts;
}
async function mutateMessages(userId, ids, changes, validate = async () => {}, options = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw fail('Select between 1 and 500 messages.', 400);
  ids = [...new Set(ids)].sort();
  const key = keyCheck(options?.idempotencyKey);
  const requestHash = canonicalRequest(ids, changes);
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore in progress');
  if (!await isModuleEnabled(userId, 'mail')) throw fail('Mail module is disabled');
  const cx = await db.getConnection(); let accounts = new Set(), response;
  try {
    await cx.beginTransaction();
    if (key) {
      const [[prior]] = await cx.execute('SELECT * FROM mail_command_receipts WHERE user_id=? AND client_key=? FOR UPDATE', [userId, key]);
      if (prior) {
        if (prior.request_hash !== requestHash) throw fail('Idempotency-Key already used for a different request');
        response = receiptResponse(prior.response_json);
        await cx.commit(); return response;
      }
      await cx.execute(`INSERT INTO mail_command_receipts (user_id,client_key,request_hash,response_json) VALUES (?,?,?,?)`,
        [userId, key, requestHash, JSON.stringify({ pending: true })]);
    }
    const placeholders = ids.map(() => '?').join(',');
    const [emails] = await cx.execute(`SELECT e.*,a.sync_mode,a.is_active FROM emails e
      LEFT JOIN mail_accounts a ON a.id=e.mail_account_id AND a.user_id=e.user_id
      WHERE e.id IN (${placeholders}) AND e.user_id=? ORDER BY e.id FOR UPDATE`, [...ids, userId]);
    if (emails.length !== ids.length) throw fail('Some selected emails are unavailable', 404);
    if (await isSectionRestoreActive(userId, 'mail') || !await isModuleEnabled(userId, 'mail')) throw fail('Mail is paused');
    await validate(cx, emails);
    const operationIds = [], revisions = [];
    accounts = await queueChanges(cx, userId, emails, changes, { idempotencyKey: key, operationIds, revisions });
    response = { message: accounts.size ? 'Provider changes queued' : 'Messages updated', sync_pending: accounts.size > 0,
      operation_ids: operationIds, accepted_revision: revisions.length ? Math.max(...revisions) : null };
    if (key) await cx.execute(`UPDATE mail_command_receipts SET response_json=? WHERE user_id=? AND client_key=?`,
      [JSON.stringify(response), userId, key]);
    await cx.commit();
  } catch (error) {
    await cx.rollback();
    if (key && error.code === 'ER_DUP_ENTRY') {
      const [[prior]] = await db.execute('SELECT request_hash,response_json FROM mail_command_receipts WHERE user_id=? AND client_key=?', [userId, key]);
      if (prior) {
        if (prior.request_hash !== requestHash) throw fail('Idempotency-Key already used for a different request');
        return receiptResponse(prior.response_json);
      }
    }
    throw error;
  } finally { cx.release(); }
  for (const accountId of accounts) setImmediate(() => startWritebacks(accountId));
  return response;
}
async function getOperationReceipt(userId, key) {
  keyCheck(key);
  if (!key) throw fail('Idempotency-Key required', 400);
  const [[receipt]] = await db.execute('SELECT response_json FROM mail_command_receipts WHERE user_id=? AND client_key=?', [userId, key]);
  if (!receipt) return { found: false, response: null, operations: [] };
  const response = receiptResponse(receipt.response_json);
  if (!response?.operation_ids?.length) return { found: true, response, operations: [] };
  const [ops] = await db.execute(`SELECT id,email_id,action,target_value,status,state,is_current,intent_revision,dispatched,attempts,error,available_at,created_at,updated_at
    FROM mail_writebacks WHERE user_id=? AND id IN (${response.operation_ids.map(() => '?').join(',')}) ORDER BY created_at,id`,
    [userId, ...response.operation_ids]);
  return { found: true, response, operations: ops.map(projectOperation) };
}
// These predicates mirror the WHERE clauses of retryWriteback/cancelWriteback.
// A dispatched MOVE only gets a read-only outcome check and is never discarded:
// its provider effect may have happened. Flag set/clear is idempotent, so a
// stuck flag is retried from a fresh provider read or discarded.
const RETRY_STATES = ['needs_attention', 'retry_wait', 'rejected', 'reconciling'];
const CANCEL_STATES = ['queued', 'retry_wait', 'needs_attention', 'reconciling'];
const moveCheck = op => op.action === 'move' && Number(op.dispatched);
function canRetry(op) {
  if (moveCheck(op)) return ['needs_attention', 'reconciling', 'retry_wait'].includes(op.state);
  if (!Number(op.is_current)) return false;
  return Number(op.dispatched) ? op.state === 'needs_attention' : RETRY_STATES.includes(op.state);
}
function canCancel(op) {
  if (Number(op.dispatched)) return op.action !== 'move' && op.state === 'needs_attention';
  return CANCEL_STATES.includes(op.state);
}
function projectOperation(op) {
  return { ...op, is_current: Boolean(Number(op.is_current)), can_retry: canRetry(op), can_cancel: canCancel(op),
    retry_action: moveCheck(op) ? 'check_outcome' : 'retry' };
}
async function listWritebacks(userId, { accountId = null, includeHistory = false, limit = 100 } = {}) {
  limit = String(Math.floor(Math.min(200, Math.max(1, Number(limit) || 100))));
  const [ops] = await db.execute(`SELECT id,email_id,action,target_value,target_folder,status,state,is_current,intent_revision,
    attempts,error,available_at,created_at,updated_at,dispatched FROM mail_writebacks
    WHERE user_id=? ${accountId ? 'AND mail_account_id=?' : ''}
      ${includeHistory ? '' : "AND (is_current=TRUE OR state IN ('reconciling','needs_attention','executing','verifying'))"}
    ORDER BY created_at DESC,id DESC LIMIT ?`, accountId ? [userId, accountId, limit] : [userId, limit]);
  return { operations: ops.map(projectOperation) };
}
async function cancelWriteback(userId, id) {
  // Row lock arbitrates with beginDispatch: once dispatched=TRUE commits, only
  // a stopped flag (needs_attention) may still be discarded.
  const [result] = await db.execute(`UPDATE mail_writebacks SET state='cancelled',status='done',is_current=FALSE,error=NULL
    WHERE id=? AND user_id=? AND ((dispatched=FALSE AND state IN (${CANCEL_STATES.map(() => '?').join(',')}))
      OR (dispatched=TRUE AND action IN ('read','star') AND state='needs_attention'))`, [id, userId, ...CANCEL_STATES]);
  if (!result.affectedRows) {
    const [[op]] = await db.execute('SELECT id FROM mail_writebacks WHERE id=? AND user_id=?', [id, userId]);
    throw fail(op ? 'This change may already be at the provider; check its outcome instead' : 'Change not found', op ? 409 : 404);
  }
  return { message: 'Change discarded' };
}
async function cancelForAccount(cx, accountId, userId) {
  // Disconnect/settings pause does not erase an accepted or uncertain provider effect.
  await cx.execute(`UPDATE mail_writebacks SET state='reconciling',status='pending',error='Account paused; check provider after reconnect'
    WHERE mail_account_id=? AND user_id=? AND dispatched=TRUE AND state IN ('executing','verifying','retry_wait')`, [accountId, userId]);
}
async function processPending(account, connection, options = {}) {
  // The legacy full-scan caller has no durable lease. It must not become a
  // second remote writer while the claimed operation scheduler runs.
  if (!options.workerId || !options.workerGeneration) return { needsSync: false, connectionFailed: false };
  return engine.processDueOperations(account, connection, options);
}
function runWritebacks(accountId, background) {
  let needsSync = false, processedAccount = accountId;
  const promise = (async () => {
    const workerId = `writeback:${process.pid}:${crypto.randomUUID()}`;
    // Cooperative admission: read-only backlog yields at a safe boundary.
    await require('./mail').yieldMailReadWork?.(accountId);
    // Claim a durable operation job, not an in-process queue entry. A different
    // account may be first in fair priority order; serialize its provider writer.
    const job = await runtime.claimDueJob({ workerId, accountId, kinds: ['operation', 'reconcile'], leaseSeconds: 60 });
    if (!job) return;
    processedAccount = job.mail_account_id;
    await require('./mail').yieldMailReadWork?.(processedAccount);
    await withMailAccountLock(processedAccount, async () => {
      let connection, account, state = 'idle', errorText = null, connectionFailed = false;
      const controller = new AbortController();
      activeControllers.set(processedAccount, controller);
      const generation = Number(job.worker_generation);
      let heartbeat, heartbeatPending = Promise.resolve();
      const pulse = async () => {
        if (controller.signal.aborted) return;
        try {
          const status = await runtime.updateJob({ jobId: job.id, accountId: processedAccount,
            workerId, generation, phase: 'operations', leaseSeconds: 60 });
          if (status.cancellationRequested) controller.abort();
        } catch { controller.abort(); }
      };
      try {
        heartbeat = setInterval(() => { heartbeatPending = heartbeatPending.then(pulse); }, 10000);
        heartbeat.unref?.();
        await pulse();
        if (controller.signal.aborted) { state = 'cancelled'; return; }
        [[account]] = await db.execute('SELECT * FROM mail_accounts WHERE id=? AND user_id=?', [processedAccount, job.user_id]);
        if (!account || account.sync_mode !== 'sync' || !Number(account.is_active) || account.disconnected_at
          || await isSectionRestoreActive(account.user_id, 'mail')
          || !await (background ? isModuleBackgroundEnabled : isModuleEnabled)(account.user_id, 'mail')) {
          state = 'paused'; return;
        }
        const { buildImapConnectionConfig } = require('./mail');
        const config = await buildImapConnectionConfig(account, { keepalive: false });
        if (!config) throw new Error('Missing credentials');
        config.imap.connTimeout = 15000; config.imap.authTimeout = 15000; config.imap.socketTimeout = 30000;
        if (job.kind === 'operation' && job.operation_id && !await operationDue(account, job.operation_id)) return;
        connection = await acquireImapConnection(account, config, { signal: controller.signal });
        await pulse();
        if (controller.signal.aborted) { state = 'cancelled'; return; }
        const options = { background, workerId, workerGeneration: generation, jobId: job.id,
          operationId: job.operation_id, signal: controller.signal };
        ({ needsSync, connectionFailed } = job.kind === 'operation'
          ? await processOperationBatch(account, connection, options, { process: processPending })
          : await processPending(account, connection, options));
      } catch (error) {
        if (controller.signal.aborted || error.code === 'MAIL_WORKER_FENCED') {
          state = 'cancelled';
        } else {
          state = 'error'; errorText = /^[A-Z][A-Z0-9_]{1,63}$/.test(String(error.code || ''))
            ? error.code : 'Provider connection unavailable';
          if (account) await engine.deferAccountOffline(account.id, account.user_id, error);
        }
      } finally {
        clearInterval(heartbeat);
        if (activeControllers.get(processedAccount) === controller) activeControllers.delete(processedAccount);
        await heartbeatPending;
        // Close before completion releases the lease; park only after this
        // generation's completion committed.
        const reusable = !!connection && state === 'idle' && !connectionFailed && !controller.signal.aborted;
        if (connection && !reusable) connection.end();
        let completed = false;
        // Expired/paused generation must not commit a stale completion.
        try { await runtime.completeJob({ jobId: job.id, accountId: processedAccount, workerId,
          generation, state: controller.signal.aborted ? 'cancelled' : state, error: errorText }); completed = true; }
        catch (error) { if (error.code !== 'MAIL_WORKER_FENCED') throw error; }
        finally { if (reusable) releaseImapConnection(connection, { reusable: completed && !controller.signal.aborted }); }
      }
    });
  })().catch(error => console.error('[MAIL WRITEBACK] Worker failed:', error.code || 'provider unavailable')).finally(() => {
    active.delete(accountId);
    // Throttled refresh, never a manual resweep or pause resume. A foreground
    // write may still settle while background sync is off.
    if (needsSync) setImmediate(() => require('./mail').syncMailAccount(processedAccount,
      background ? { background: true } : { followUp: true }).catch(() => {}));
    if (foregroundReruns.delete(accountId)) startWritebacks(accountId);
    drainWritebacks();
  });
  active.set(accountId, promise); return promise;
}
function drainWritebacks() {
  if (!queued.size || active.size >= 4) return;
  for (const [id, job] of queued) {
    if (active.size >= 4) break;
    if (require('./mail').isMailAccountWriteRunning(id)) continue;
    queued.delete(id); runWritebacks(id, job.background).then(job.resolve, job.reject);
  }
}
function stopWritebacks(accountId) {
  const id = String(accountId), controller = activeControllers.get(id), waiting = queued.get(id);
  foregroundReruns.delete(id);
  if (waiting) { queued.delete(id); waiting.resolve({ paused: true }); }
  controller?.abort();
  return Boolean(controller || waiting);
}
function startWritebacks(accountId, { background = false } = {}) {
  const id = String(accountId);
  if (active.has(id)) { if (!background) foregroundReruns.add(id); return active.get(id); }
  if (queued.has(id)) { if (!background) queued.get(id).background = false; return queued.get(id).promise; }
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  queued.set(id, { promise, resolve, reject, background }); drainWritebacks(); return promise;
}
async function runDueWritebacks() {
  // Only rows processDueOperations can act on. Whatever an executor path does
  // (including a failed connect), an operation whose last job ended recently
  // waits an exponential interval in its job count, never a 1s login loop.
  const dueSql = `SELECT w.id,w.user_id,w.mail_account_id,w.state,w.action FROM mail_writebacks w
    JOIN mail_accounts a ON a.id=w.mail_account_id AND a.user_id=w.user_id
    WHERE ((w.is_current=TRUE AND w.state IN ('queued','retry_wait'))
        OR (w.dispatched=TRUE AND w.state IN ('executing','verifying','reconciling')))
      AND w.available_at<=UTC_TIMESTAMP()
      AND a.is_active=TRUE AND a.disconnected_at IS NULL AND a.sync_mode='sync' AND w.mail_account_id>?
      AND NOT EXISTS (SELECT 1 FROM mail_engine_jobs j WHERE j.operation_id=w.id AND j.user_id=w.user_id
        AND j.completed_at>DATE_SUB(UTC_TIMESTAMP(), INTERVAL LEAST(3600,15*POW(2,LEAST(8,
          (SELECT COUNT(*) FROM mail_engine_jobs c WHERE c.operation_id=w.id AND c.user_id=w.user_id)-1))) SECOND))
    ORDER BY w.mail_account_id,w.created_at LIMIT 20`;
  let [rows] = await db.execute(dueSql, [dueCursor]);
  if (!rows.length && dueCursor) { dueCursor = ''; [rows] = await db.execute(dueSql, [dueCursor]); }
  for (const row of rows) {
    dueCursor = row.mail_account_id;
    if (!await isModuleBackgroundEnabled(row.user_id, 'mail')) continue;
    if (row.state === 'reconciling' && row.action === 'move') {
      // Exactly one bounded, nonmutating outcome check. It reaches confirmed
      // on direct evidence or needs_attention, never a perpetual sync loop.
      await runtime.enqueueJob({ userId: row.user_id, accountId: row.mail_account_id,
        operationId: row.id, kind: 'reconcile', priority: 0 });
      startWritebacks(row.mail_account_id, { background: true });
    } else {
      await db.execute(`UPDATE mail_engine_jobs j JOIN mail_engine_accounts a ON a.mail_account_id=j.mail_account_id
        SET j.state='queued',j.due_at=UTC_TIMESTAMP()
        WHERE j.operation_id=? AND j.user_id=? AND j.mail_account_id=? AND j.state='paused'
          AND a.user_id=? AND a.paused_reason IS NULL`,
      [row.id, row.user_id, row.mail_account_id, row.user_id]);
      await runtime.enqueueJob({ userId: row.user_id, accountId: row.mail_account_id,
        operationId: row.id, kind: 'operation', priority: 0 });
      startWritebacks(row.mail_account_id, { background: true });
    }
  }
  return rows.length;
}
async function retryWriteback(userId, id) {
  const [[op]] = await db.execute('SELECT * FROM mail_writebacks WHERE id = ? AND user_id = ?', [id, userId]);
  if (!op) throw fail('Change not found', 404);
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore in progress');
  if (op.action === 'move' && Number(op.dispatched)) {
    await db.execute(`UPDATE mail_writebacks SET state='reconciling',status='pending',available_at=UTC_TIMESTAMP()
      WHERE id=? AND user_id=? AND state IN ('needs_attention','reconciling','retry_wait')`, [id, userId]);
    await runtime.enqueueJob({ userId, accountId: op.mail_account_id, operationId: id,
      kind: 'reconcile', priority: 0, foreground: true });
    startWritebacks(op.mail_account_id);
    // No provider mutation. The bounded outcome checker takes this ID.
    return { message: 'Move outcome check queued', retry_action: 'check_outcome' };
  }
  if (!await requeue(userId, op)) throw fail('This change cannot be safely retried; check provider outcome.');
  await runtime.enqueueJob({ userId, accountId: op.mail_account_id, operationId: id, kind: 'operation', priority: 0, foreground: true });
  startWritebacks(op.mail_account_id); return { message: 'Retry queued', retry_action: 'retry' };
}
// User retry gives a fresh bounded attempt budget. A stopped dispatched flag is
// idempotent: clearing dispatch sends it back through the executor, which reads
// provider state first and only writes if the bit still differs. An address made
// stale by a mailbox reset or a confirmed move is rebased onto the item's
// currently verified occurrence, as applyMove does; otherwise it stays as-is and
// the executor marks attention again without writing.
async function requeue(userId, op) {
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const [[row]] = await cx.execute('SELECT * FROM mail_writebacks WHERE id=? AND user_id=? FOR UPDATE', [op.id, userId]);
    if (!row || moveCheck(row) || !canRetry(row)) { await cx.rollback(); return false; }
    const [[email]] = await cx.execute(`SELECT remote_folder,remote_uid,remote_uidvalidity FROM emails
      WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE`, [row.email_id, userId, row.mail_account_id]);
    if (email?.remote_folder && (email.remote_folder !== row.remote_folder || String(email.remote_uid) !== String(row.remote_uid)
      || String(email.remote_uidvalidity) !== String(row.remote_uidvalidity))) {
      const [[occ]] = await cx.execute(`SELECT o.id FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id=o.mailbox_id
        AND m.user_id=o.user_id AND m.mail_account_id=o.mail_account_id AND m.state='active' AND m.uidvalidity=o.uidvalidity
        WHERE o.email_id=? AND o.user_id=? AND o.mail_account_id=? AND o.presence='present'
        AND BINARY m.remote_name=BINARY ? AND o.uid=? AND o.uidvalidity=? LIMIT 1`,
      [row.email_id, userId, row.mail_account_id, email.remote_folder, email.remote_uid, email.remote_uidvalidity]);
      if (occ) await cx.execute(`UPDATE mail_writebacks SET remote_folder=?,remote_uid=?,remote_uidvalidity=?,source_occurrence_id=?
        WHERE id=? AND user_id=? AND mail_account_id=?`,
      [email.remote_folder, email.remote_uid, email.remote_uidvalidity, occ.id, row.id, userId, row.mail_account_id]);
    }
    await cx.execute(`UPDATE mail_writebacks SET state='queued',status='pending',error=NULL,dispatched=FALSE,attempts=0,
      available_at=UTC_TIMESTAMP() WHERE id=? AND user_id=? AND mail_account_id=?`, [row.id, userId, row.mail_account_id]);
    await cx.commit(); return true;
  } catch (error) { await cx.rollback(); throw error; }
  finally { cx.release(); }
}
// Compatibility pure protocol probe retained for older dependency-injected tests.
// The durable worker above exclusively uses the guarded transport adapter.
function imapCall(imap, method, ...args) {
  return new Promise((resolve, reject) => imap[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}
async function legacyReadRemote(connection, op) {
  const box = await connection.openBox(op.remote_folder, false);
  if (Number(box.uidvalidity) !== Number(op.remote_uidvalidity)) throw fail('Mailbox identity changed; server state retained');
  const rows = await connection.search([['UID', Number(op.remote_uid)]], { bodies: [], markSeen: false });
  if (rows.length !== 1 || Number(rows[0].attributes.uid) !== Number(op.remote_uid)) throw fail('Message moved or disappeared on the server');
  return rows[0].attributes;
}
async function executeOperation(connection, op, { markDispatched, read = legacyReadRemote } = {}) {
  const remote = await read(connection, op), imap = connection.imap;
  if (op.action === 'move') {
    if (op.target_value === op.remote_folder) return { moved: false };
    if (op.dispatched) throw fail('Previous MOVE outcome must be reconciled, not repeated');
    if (!imap.serverSupports('MOVE')) throw fail('Native MOVE unavailable; no fallback');
    await markDispatched();
    const destinationUid = await imapCall(imap, 'move', Number(op.remote_uid), op.target_value);
    return { moved: true, destinationUid: /^\d+$/.test(String(destinationUid)) ? Number(destinationUid) : null };
  }
  const flag = op.action === 'read' ? '\\Seen' : op.action === 'star' ? '\\Flagged' : null;
  if (!flag) throw fail('Unsupported mail change');
  const current = remote.flags.includes(flag) ? '1' : '0';
  if (current === op.target_value) return { value: Number(current) };
  if (current !== op.base_value) throw fail('Server state changed; local action was not applied');
  if (op.dispatched && (!op.dispatch_modseq || String(remote.modseq) !== op.dispatch_modseq))
    throw fail('Provider state changed after interrupted update; server state retained');
  const conditional = remote.modseq && !imap._box?.nomodseq && imap.serverSupports('CONDSTORE');
  await markDispatched(conditional ? String(remote.modseq) : null);
  const method = op.target_value === '1' ? 'addFlags' : 'delFlags';
  if (conditional) await imapCall(imap, method + 'Since', Number(op.remote_uid), flag, String(remote.modseq));
  else await imapCall(imap, method, Number(op.remote_uid), flag);
  const after = await read(connection, op);
  if ((after.flags.includes(flag) ? '1' : '0') !== op.target_value) throw fail('Server changed during update; server state retained');
  return { value: Number(op.target_value) };
}
module.exports = { mutateMessages, queueChanges, processPending, startWritebacks, stopWritebacks, runDueWritebacks, drainWritebacks,
  retryWriteback, cancelForAccount, cancelWriteback, getOperationReceipt, listWritebacks, executeOperation,
  isWritebackRunning: () => active.size > 0, remoteEligible, verifiedIdentity, keyCheck, canonicalRequest };
