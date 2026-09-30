'use strict';
const { randomUUID } = require('node:crypto');
const { db } = require('../../state');
const { withTransaction, ownAccount } = require('./repository');
const { bool } = require('./repository-identity');
const { HOLD_REASON } = require('./rollout');
const requireId = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} required`); return value; };
const fenced = () => Object.assign(new Error('Mail worker lease or generation was lost'), { code: 'MAIL_WORKER_FENCED' });
const tx = (executor, callback) => typeof executor.getConnection === 'function' ? withTransaction(callback, executor) : callback(executor);
const int = (n, low, high, name) => { if (!Number.isSafeInteger(n) || n < low || n > high) throw new RangeError(`Invalid ${name}`); return n; };
function safeEvidence(evidence) {
  // Structured correlation only. Never persist arbitrary server text/MIME/PII.
  if (evidence == null) return null;
  if (typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('Evidence must be structured');
  const out = {};
  for (const key of ['reason','responseCode','sourceUidvalidity','destinationUidvalidity','sourceUid','destinationUid','modseq','mappingValid','transmitted','verified','occurrenceId','mailboxId']) {
    if (!Object.hasOwn(evidence, key) || evidence[key] == null) continue;
    const value = evidence[key];
    if (typeof value === 'boolean') out[key] = value;
    else if ((typeof value === 'string' || typeof value === 'number') && String(value).length <= 80 && /^[a-zA-Z0-9_ .:-]+$/.test(String(value))) out[key] = String(value);
    else throw new TypeError(`Unsafe evidence ${key}`);
  }
  return JSON.stringify(out);
}
async function enqueueJob({ userId, accountId, mailboxId = null, operationId = null, kind = 'sync', priority = 50, dueAt = null, foreground = false, manualRefresh = false }, executor = db) {
  if (!/^[a-z_]{1,32}$/.test(kind)) throw new TypeError('Invalid job kind');
  if (typeof manualRefresh !== 'boolean' || (manualRefresh && !['sync', 'flags', 'presence'].includes(kind)))
    throw new TypeError('Manual refresh requires a sync, flags or presence job');
  int(priority, -1000, 1000, 'priority');
  if (dueAt != null && (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime()))) throw new TypeError('dueAt must be Date');
  return tx(executor, async cx => {
    if (foreground && ['operation', 'reconcile'].includes(kind)) await resumeAccount({ userId, accountId,
      resumeStreams: false, reasons: ['Mail module disabled', 'Mail background paused'] }, cx);
    await ownAccount(cx, userId, accountId, true);
    if (mailboxId) {
      const [boxes] = await cx.execute('SELECT id FROM mail_remote_mailboxes WHERE id = ? AND user_id = ? AND mail_account_id = ?', [mailboxId, userId, accountId]);
      if (!boxes.length) throw new Error('Mailbox not owned by account');
    }
    if (operationId) {
      const [ops] = await cx.execute('SELECT id FROM mail_writebacks WHERE id = ? AND user_id = ? AND mail_account_id = ?', [operationId, userId, accountId]);
      if (!ops.length) throw new Error('Operation not owned by account');
    }
    // A manual request after a scan began must survive its captured UIDNEXT
    // and cursor decision. Keep at most one queued successor, never mutate a
    // running lease. Paused/queued jobs may be promoted in place.
    const [existing] = await cx.execute(`SELECT * FROM mail_engine_jobs WHERE user_id = ? AND mail_account_id = ?
      AND kind = ? AND mailbox_id <=> ? AND operation_id <=> ? AND state IN ('queued','running','paused')
      ORDER BY CASE state WHEN 'queued' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at
      LIMIT 1 FOR UPDATE`, [userId, accountId, kind, mailboxId, operationId]);
    if (existing.length && !(existing[0].state === 'running' &&
      (kind === 'recent' || (manualRefresh && ['sync', 'flags', 'presence'].includes(kind))))) {
      if (manualRefresh && !Number(existing[0].manual_refresh)) {
        await cx.execute('UPDATE mail_engine_jobs SET manual_refresh = TRUE WHERE id = ? AND state IN (\'queued\',\'paused\')', [existing[0].id]);
        existing[0].manual_refresh = 1;
      }
      return existing[0];
    }
    const id = randomUUID();
    await cx.execute(`INSERT INTO mail_engine_jobs (id,user_id,mail_account_id,mailbox_id,operation_id,kind,priority,due_at,manual_refresh)
      VALUES (?,?,?,?,?,?,?,COALESCE(?,UTC_TIMESTAMP()),?)`, [id, userId, accountId, mailboxId, operationId, kind, priority, dueAt, manualRefresh]);
    const [rows] = await cx.execute('SELECT * FROM mail_engine_jobs WHERE id = ?', [id]);
    return rows[0];
  });
}
async function claimDueJob({ workerId, leaseSeconds = 30, kinds = null, accountId = null }, executor = db) {
  requireId(workerId, 'workerId'); if (workerId.length > 128) throw new RangeError('workerId too long');
  int(leaseSeconds, 5, 3600, 'leaseSeconds');
  if (accountId !== null) requireId(accountId, 'accountId');
  if (kinds && (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !/^[a-z_]{1,32}$/.test(kind)))) throw new TypeError('Invalid kinds');
  return tx(executor, async cx => {
    const params = [...(kinds || []), ...(accountId === null ? [] : [accountId])];
    const [jobs] = await cx.execute(`SELECT j.* FROM mail_engine_jobs j JOIN mail_accounts a ON a.id = j.mail_account_id
      LEFT JOIN mail_engine_accounts held ON held.mail_account_id = a.id
      WHERE j.state = 'queued' AND j.due_at <= UTC_TIMESTAMP() AND j.cancellation_requested = FALSE
      AND a.is_active = TRUE AND a.disconnected_at IS NULL AND held.paused_reason IS NULL
      -- Only candidates from accounts that can be claimed now: a busy account's
      -- backlog must not fill the candidate window and starve every other account.
      AND (held.mail_account_id IS NULL OR (held.lease_owner IS NULL
        AND (held.lease_until IS NULL OR held.lease_until <= UTC_TIMESTAMP())))
      ${kinds ? `AND j.kind IN (${kinds.map(() => '?').join(',')})` : ''}
      ${accountId === null ? '' : 'AND j.mail_account_id = ?'}
      ORDER BY GREATEST(-1000, j.priority - (TIMESTAMPDIFF(SECOND, j.created_at, UTC_TIMESTAMP()) DIV 30)) ASC,
        j.due_at ASC, j.created_at ASC LIMIT 32 FOR UPDATE SKIP LOCKED`, params);
    for (const job of jobs) {
      await cx.execute(`INSERT INTO mail_engine_accounts (mail_account_id,user_id) VALUES (?,?) ON DUPLICATE KEY UPDATE mail_account_id = mail_account_id`, [job.mail_account_id, job.user_id]);
      const [accounts] = await cx.execute('SELECT * FROM mail_engine_accounts WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [job.mail_account_id, job.user_id]);
      const account = accounts[0];
      if (!account || account.paused_reason || (account.lease_until && new Date(account.lease_until).getTime() > Date.now())) continue;
      // An expired lease that recovery has not cleared yet may still have a
      // running job whose provider outcome is unknown; wait for recovery.
      if (account.lease_owner != null) continue;
      const generation = Number(account.generation) + 1;
      if (!Number.isSafeInteger(generation)) throw new RangeError('Generation exhausted');
      await cx.execute(`UPDATE mail_engine_accounts SET generation = ?, lease_owner = ?,
        lease_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE mail_account_id = ? AND user_id = ?`,
      [generation, workerId, leaseSeconds, job.mail_account_id, job.user_id]);
      await cx.execute(`UPDATE mail_engine_jobs SET state = 'running', phase = 'connecting', lease_owner = ?,
        lease_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), worker_generation = ?,
        started_at = COALESCE(started_at,UTC_TIMESTAMP()), heartbeat_at = UTC_TIMESTAMP()
        WHERE id = ?`, [workerId, leaseSeconds, generation, job.id]);
      const [claimed] = await cx.execute('SELECT * FROM mail_engine_jobs WHERE id = ?', [job.id]);
      return claimed[0];
    }
    return null;
  });
}
async function assertFence({ accountId, jobId = null, workerId, generation }, executor = db) {
  requireId(accountId, 'accountId'); requireId(workerId, 'workerId'); int(generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
  const [rows] = await executor.execute(`SELECT a.generation, a.lease_until, a.lease_owner, a.paused_reason,
    ${jobId ? 'j.id AS job_id, j.state AS job_state, j.cancellation_requested' : 'NULL AS job_id, NULL AS job_state, FALSE AS cancellation_requested'}
    FROM mail_engine_accounts a ${jobId ? 'JOIN mail_engine_jobs j ON j.mail_account_id = a.mail_account_id AND j.id = ?' : ''}
    WHERE a.mail_account_id = ? AND a.generation = ? AND a.lease_owner = ?
      AND a.lease_until > UTC_TIMESTAMP()${jobId ? " AND j.worker_generation = ? AND j.lease_owner = ? AND j.state = 'running' AND j.lease_until > UTC_TIMESTAMP()" : ''}`,
  jobId ? [jobId, accountId, generation, workerId, generation, workerId] : [accountId, generation, workerId]);
  if (!rows.length || rows[0].paused_reason) throw fenced();
  return { cancellationRequested: bool(rows[0].cancellation_requested), generation };
}
async function updateJob({ jobId, accountId, workerId, generation, phase = null, processed = null, total = undefined, coverage = undefined, leaseSeconds = 30 }, executor = db) {
  int(leaseSeconds, 5, 3600, 'leaseSeconds');
  if (processed != null) int(processed, 0, Number.MAX_SAFE_INTEGER, 'processed');
  if (total !== undefined && total != null) int(total, 0, Number.MAX_SAFE_INTEGER, 'total');
  return tx(executor, async cx => {
    const fence = await assertFence({ accountId, jobId, workerId, generation }, cx);
    const [accountLease] = await cx.execute(`UPDATE mail_engine_accounts SET lease_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
      WHERE mail_account_id = ? AND lease_owner = ? AND generation = ? AND lease_until > UTC_TIMESTAMP()`, [leaseSeconds, accountId, workerId, generation]);
    if (accountLease.affectedRows !== 1) throw fenced();
    const [updated] = await cx.execute(`UPDATE mail_engine_jobs SET phase = COALESCE(?,phase), processed = COALESCE(?,processed),
      total = ${total === undefined ? 'total' : '?'}, coverage_json = ${coverage === undefined ? 'coverage_json' : '?'},
      heartbeat_at = UTC_TIMESTAMP(), lease_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
      WHERE id = ? AND mail_account_id = ? AND lease_owner = ? AND worker_generation = ? AND state = 'running' AND lease_until > UTC_TIMESTAMP()`,
    [phase, processed, ...(total === undefined ? [] : [total]), ...(coverage === undefined ? [] : [coverage === null ? null : JSON.stringify(coverage)]),
      leaseSeconds, jobId, accountId, workerId, generation]);
    if (updated.affectedRows !== 1) throw fenced();
    return fence;
  });
}
// Only for a claim whose executor has not been invoked. Never use this to
// retry a dispatched provider operation or an unknown transport outcome.
async function releaseUnstartedJob({ jobId, accountId, workerId, generation }, executor = db) {
  return tx(executor, async cx => {
    await assertFence({ accountId, jobId, workerId, generation }, cx);
    const [updated] = await cx.execute(`UPDATE mail_engine_jobs
      SET state = IF(cancellation_requested, 'cancelled', 'queued'), phase = NULL,
        lease_owner = NULL, lease_until = NULL, worker_generation = NULL,
        completed_at = IF(cancellation_requested, UTC_TIMESTAMP(), NULL)
      WHERE id = ? AND mail_account_id = ? AND lease_owner = ? AND worker_generation = ?
        AND state = 'running' AND lease_until > UTC_TIMESTAMP()`,
    [jobId, accountId, workerId, generation]);
    if (updated.affectedRows !== 1) throw fenced();
    await cx.execute(`UPDATE mail_engine_accounts SET lease_owner = NULL, lease_until = NULL
      WHERE mail_account_id = ? AND lease_owner = ? AND generation = ?`, [accountId, workerId, generation]);
  });
}
async function completeJob({ jobId, accountId, workerId, generation, state = 'idle', error = null }, executor = db) {
  if (!['idle', 'error', 'cancelled', 'paused'].includes(state)) throw new TypeError('Invalid final state');
  return tx(executor, async cx => {
    await assertFence({ accountId, jobId, workerId, generation }, cx);
    const [updated] = await cx.execute(`UPDATE mail_engine_jobs SET state = ?, phase = NULL, error = ?,
      completed_at = UTC_TIMESTAMP(), heartbeat_at = UTC_TIMESTAMP(), lease_until = NULL, lease_owner = NULL
      WHERE id = ? AND mail_account_id = ? AND lease_owner = ? AND worker_generation = ? AND state = 'running' AND lease_until > UTC_TIMESTAMP()`,
    [state, error?.slice(0, 255) ?? null, jobId, accountId, workerId, generation]);
    if (updated.affectedRows !== 1) throw fenced();
    await cx.execute(`UPDATE mail_engine_accounts SET lease_owner = NULL, lease_until = NULL
      WHERE mail_account_id = ? AND lease_owner = ? AND generation = ?`, [accountId, workerId, generation]);
  });
}
async function requestCancellation({ userId, accountId, jobId }, executor = db) {
  return tx(executor, async cx => {
    await ownAccount(cx, userId, accountId, true);
    const [changed] = await cx.execute(`UPDATE mail_engine_jobs SET cancellation_requested = TRUE,
      completed_at = IF(state = 'queued', UTC_TIMESTAMP(), completed_at),
      state = IF(state = 'queued', 'cancelled', state)
      WHERE id = ? AND user_id = ? AND mail_account_id = ? AND state IN ('queued','running')`, [jobId, userId, accountId]);
    return changed.affectedRows === 1;
  });
}
// An operator canary hold outranks every other pause: the stop still fences
// workers, but only releaseRollout may clear the hold. Absorbed reasons stay
// enforced by is_active/disconnected_at and live module checks.
async function pauseAccount({ userId, accountId, reason }, executor = db) {
  if (typeof reason !== 'string' || !reason || reason.length > 255) throw new TypeError('Invalid pause reason');
  return tx(executor, async cx => {
    await ownAccount(cx, userId, accountId, true);
    await cx.execute(`INSERT INTO mail_engine_accounts (mail_account_id,user_id,paused_reason) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE paused_reason = IF(paused_reason <=> ?, paused_reason, VALUES(paused_reason)),
        generation = generation + 1, lease_owner = NULL, lease_until = NULL`, [accountId, userId, reason, HOLD_REASON]);
    await cx.execute("UPDATE mail_engine_jobs SET state='paused', lease_owner=NULL, lease_until=NULL WHERE mail_account_id=? AND state IN ('queued','running')", [accountId]);
  });
}
// Explicit authenticated reconnect (all reasons but a canary hold), or permitted
// user interaction (only named module pauses). Never resume archived provider
// writes as jobs.
async function resumeAccount({ userId, accountId, resumeStreams = true, reasons = null }, executor = db) {
  return tx(executor, async cx => {
    await ownAccount(cx, userId, accountId, true);
    let streamsOnly = false;
    if (reasons !== null) {
      if (!Array.isArray(reasons) || !reasons.length || reasons.some(reason => typeof reason !== 'string')) throw new TypeError('Invalid resume reasons');
      const [[paused]] = await cx.execute('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      streamsOnly = Boolean(paused && paused.paused_reason === null && resumeStreams);
      if (!paused || (!streamsOnly && !reasons.includes(paused.paused_reason))) return { resumed: 0, retired: 0 };
    }
    const [[account]] = await cx.execute('SELECT is_active, disconnected_at FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
    if (!account || !bool(account.is_active) || account.disconnected_at) throw Object.assign(new Error('Reconnect and verify this account before resuming mail work'), { status: 409 });
    if (streamsOnly) {
      // A foreground flag may have resumed only the writer. A later explicit
      // Sync resumes retained read jobs without fencing that active writer.
      const [resumed] = await cx.execute(`UPDATE mail_engine_jobs SET state = 'queued', cancellation_requested = FALSE,
        lease_owner = NULL, lease_until = NULL, worker_generation = NULL, due_at = UTC_TIMESTAMP(),
        phase = 'revalidation', completed_at = NULL, error = NULL
        WHERE mail_account_id = ? AND user_id = ? AND state = 'paused' AND operation_id IS NULL
          AND kind IN ('sync','recent','flags','history','presence','body')`, [accountId, userId]);
      return { resumed: resumed.affectedRows, retired: 0 };
    }
    await cx.execute(`UPDATE mail_engine_accounts SET paused_reason = IF(paused_reason <=> ?, paused_reason, NULL),
      generation = generation + 1, lease_owner = NULL, lease_until = NULL WHERE mail_account_id = ? AND user_id = ?`,
    [HOLD_REASON, accountId, userId]);
    const readOnly = "operation_id IS NULL AND kind IN ('sync','recent','flags','history','presence','body')";
    const [retired] = await cx.execute(`UPDATE mail_engine_jobs SET state = 'cancelled', cancellation_requested = TRUE,
      lease_owner = NULL, lease_until = NULL, completed_at = UTC_TIMESTAMP(),
      error = 'Reconnect retained prior provider intent for review; this historical job was not replayed'
      WHERE mail_account_id = ? AND user_id = ? AND state = 'paused' AND NOT (${readOnly})`, [accountId, userId]);
    const [resumed] = resumeStreams ? await cx.execute(`UPDATE mail_engine_jobs SET state = 'queued', cancellation_requested = FALSE,
      lease_owner = NULL, lease_until = NULL, worker_generation = NULL, due_at = UTC_TIMESTAMP(),
      phase = 'revalidation', completed_at = NULL, error = NULL
      WHERE mail_account_id = ? AND user_id = ? AND state = 'paused' AND (${readOnly})`, [accountId, userId]) : [{ affectedRows: 0 }];
    return { resumed: resumed.affectedRows, retired: retired.affectedRows };
  });
}
async function recoverExpiredJobs(executor = db) {
  return tx(executor, async cx => {
    // Fencing invalidates old local commits, not provider effects. Old workers must
    // close transport before a successor performs any provider mutation.
    const [jobs] = await cx.execute(`UPDATE mail_engine_jobs SET state = IF(cancellation_requested, 'cancelled', 'queued'),
      kind = IF(operation_id IS NULL,kind,'reconcile'), phase = 'recovery', lease_owner = NULL,
      lease_until = NULL, worker_generation = NULL,
      due_at = UTC_TIMESTAMP(), completed_at = IF(cancellation_requested,UTC_TIMESTAMP(),NULL)
      WHERE state = 'running' AND (lease_until IS NULL OR lease_until <= UTC_TIMESTAMP())`);
    await cx.execute(`UPDATE mail_engine_accounts SET generation = generation + 1, lease_owner = NULL, lease_until = NULL
      WHERE lease_owner IS NOT NULL AND (lease_until IS NULL OR lease_until <= UTC_TIMESTAMP())`);
    const [ops] = await cx.execute(`UPDATE mail_writebacks w
      LEFT JOIN mail_engine_accounts a ON a.mail_account_id = w.mail_account_id
      SET w.state = 'reconciling', w.status = 'pending'
      WHERE (w.state IN ('executing','verifying') AND
        (a.mail_account_id IS NULL OR a.lease_owner IS NULL OR a.lease_until <= UTC_TIMESTAMP()))
        OR (w.dispatched = TRUE AND w.state IN ('queued','retry_wait'))`);
    await cx.execute(`UPDATE mail_engine_jobs j JOIN mail_writebacks w ON w.id = j.operation_id
      SET j.kind = 'reconcile' WHERE j.state = 'queued' AND w.state = 'reconciling' AND j.kind <> 'reconcile'`);
    return { jobs: jobs.affectedRows, operations: ops.affectedRows };
  });
}
// Finished jobs are scheduling history, not evidence. Keep the latest job of
// each account/kind/mailbox (status, discovery cadence) and every job of an
// unsettled operation (runDueWritebacks backs off on its job count).
const FINISHED_JOB_STATES = ['idle', 'cancelled', 'error'];
const SETTLED_OPERATION_STATES = ['confirmed', 'cancelled', 'superseded', 'rejected'];
async function pruneFinishedJobs({ olderThanDays = 7, batchSize = 1000, maxBatches = 20 } = {}, executor = db) {
  int(olderThanDays, 1, 3650, 'olderThanDays'); int(batchSize, 1, 1000, 'batchSize'); int(maxBatches, 1, 1000, 'maxBatches');
  const finished = FINISHED_JOB_STATES.map(() => '?').join(','), settled = SETTLED_OPERATION_STATES.map(() => '?').join(',');
  let deleted = 0, batches = 0;
  while (batches < maxBatches) {
    batches++;
    const [rows] = await executor.execute(`SELECT j.id FROM mail_engine_jobs j
      WHERE j.state IN (${finished}) AND j.completed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        AND EXISTS (SELECT 1 FROM mail_engine_jobs n WHERE n.user_id = j.user_id AND n.mail_account_id = j.mail_account_id
          AND n.kind = j.kind AND n.mailbox_id <=> j.mailbox_id
          AND (n.created_at > j.created_at OR (n.created_at = j.created_at AND n.id > j.id)))
        AND (j.operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM mail_writebacks w WHERE w.id = j.operation_id
          AND w.user_id = j.user_id AND (w.state IS NULL OR w.state NOT IN (${settled}))))
      ORDER BY j.completed_at, j.id LIMIT ?`, [...FINISHED_JOB_STATES, olderThanDays, ...SETTLED_OPERATION_STATES, String(batchSize)]);
    if (!rows.length) break;
    // Short autocommit statement by primary key; finished states are final.
    const [result] = await executor.execute(`DELETE FROM mail_engine_jobs WHERE id IN (${rows.map(() => '?').join(',')})
      AND state IN (${finished}) AND completed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`,
    [...rows.map(row => row.id), ...FINISHED_JOB_STATES, olderThanDays]);
    deleted += Number(result.affectedRows) || 0;
    if (rows.length < batchSize) break;
  }
  return { deleted, batches };
}
async function getJobStatus({ userId, accountId }, executor = db) {
  const [rows] = await executor.execute(`SELECT * FROM mail_engine_jobs WHERE user_id = ? AND mail_account_id = ?
    ORDER BY (state IN ('running','queued','paused')) DESC, created_at DESC LIMIT 1`, [userId, accountId]);
  return rows[0] || null;
}
async function beginOperationAttempt({ operationId, userId, accountId, workerId, generation }, executor = db) {
  return tx(executor, async cx => {
    await assertFence({ accountId, workerId, generation }, cx);
    const [rows] = await cx.execute('SELECT * FROM mail_writebacks WHERE id = ? AND user_id = ? AND mail_account_id = ? FOR UPDATE', [operationId, userId, accountId]);
    const op = rows[0];
    if (!op || !['queued','retry_wait'].includes(op.state) || bool(op.dispatched)) throw Object.assign(new Error('Operation is not safe to dispatch'), { code: 'MAIL_OPERATION_UNCERTAIN' });
    // The accepted source address must still resolve to the same item and the
    // currently selected mailbox epoch before a dispatch fence is committed.
    const [sources] = await cx.execute(`SELECT o.id FROM mail_remote_occurrences o
      JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id
      WHERE o.user_id = ? AND o.mail_account_id = ? AND o.email_id = ?
        AND m.remote_name = ? AND m.uidvalidity = o.uidvalidity AND m.state = 'active'
        AND o.uid = ? AND o.uidvalidity = ? AND o.presence = 'present'
        AND (? IS NULL OR o.id = ?) FOR UPDATE`,
    [userId, accountId, op.email_id, op.remote_folder, op.remote_uid, op.remote_uidvalidity,
      op.source_occurrence_id, op.source_occurrence_id]);
    if (sources.length !== 1) throw Object.assign(new Error('Operation source identity needs reconciliation'), { code: 'MAIL_EPOCH_STALE' });
    if (!op.source_occurrence_id) await cx.execute('UPDATE mail_writebacks SET source_occurrence_id = ? WHERE id = ?', [sources[0].id, operationId]);
    const id = randomUUID();
    await cx.execute(`INSERT INTO mail_operation_attempts (id,operation_id,user_id,mail_account_id,worker_generation,dispatch_fence,dispatched_at)
      VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())`, [id, operationId, userId, accountId, generation, id]);
    await cx.execute("UPDATE mail_writebacks SET state = 'executing', status = 'pending', dispatched = TRUE, attempts = attempts + 1 WHERE id = ?", [operationId]);
    const [attempts] = await cx.execute('SELECT * FROM mail_operation_attempts WHERE id = ?', [id]);
    return attempts[0];
  });
}
async function finishOperationAttempt({ attemptId, operationId, userId, accountId, workerId, generation, outcome, transmission, evidence = null }, executor = db) {
  if (!['confirmed','verifying','uncertain','not_transmitted','rejected'].includes(outcome)) throw new TypeError('Invalid outcome');
  if (!['yes','no','unknown'].includes(transmission)) throw new TypeError('Invalid transmission');
  if (outcome === 'not_transmitted' && transmission !== 'no') throw new TypeError('Non-transmission requires proof');
  if (outcome === 'confirmed' && evidence?.verified !== true) throw new TypeError('Confirmation requires verified provider evidence');
  return tx(executor, async cx => {
    await assertFence({ accountId, workerId, generation }, cx);
    const [attempts] = await cx.execute('SELECT * FROM mail_operation_attempts WHERE id = ? AND operation_id = ? AND user_id = ? AND mail_account_id = ? AND worker_generation = ? FOR UPDATE', [attemptId, operationId, userId, accountId, generation]);
    if (!attempts.length || attempts[0].outcome !== 'prepared') throw fenced();
    const json = safeEvidence(evidence);
    const state = outcome === 'not_transmitted' ? 'retry_wait' : outcome === 'confirmed' ? 'confirmed' : outcome === 'verifying' ? 'verifying' : outcome === 'rejected' && transmission === 'no' ? 'rejected' : 'reconciling';
    await cx.execute(`UPDATE mail_operation_attempts SET outcome = ?, transmission = ?, evidence_json = ?, completed_at = UTC_TIMESTAMP() WHERE id = ?`, [outcome, transmission, json, attemptId]);
    const [updated] = await cx.execute(`UPDATE mail_writebacks SET state = ?, status = ?, evidence_json = ?, dispatched = ?
      WHERE id = ? AND user_id = ? AND mail_account_id = ? AND state = 'executing'`,
    [state, ['confirmed','rejected'].includes(state) ? state === 'confirmed' ? 'done' : 'failed' : 'pending', json, transmission === 'no' ? 0 : 1, operationId, userId, accountId]);
    if (updated.affectedRows !== 1) throw fenced();
    return state;
  });
}
module.exports = { enqueueJob, claimDueJob, assertFence, updateJob, releaseUnstartedJob, completeJob, requestCancellation, pauseAccount, resumeAccount, recoverExpiredJobs, pruneFinishedJobs, getJobStatus, beginOperationAttempt, finishOperationAttempt };
