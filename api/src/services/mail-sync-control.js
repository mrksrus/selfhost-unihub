const { READ_ONLY_MAIL_JOB_KINDS } = require('./mail-sync-scheduler');
const { evictImapConnections } = require('./mail-engine/connection-pool');
const { db } = require('../state');
const { isModuleEnabled, isModuleBackgroundEnabled } = require('./module-settings');
const { isSectionRestoreActive } = require('./restore-locks');
const { toBooleanFlag } = require('./mail-host-policy');
const { durableScheduler, foregroundMutationAccounts, normalizeMailAccountId } = require('./mail-durable-jobs');
const { mailDeleteStopRequests } = require('./mail-server-delete');
const { publishMailJob } = require('./server-events');

const DEFAULT_MAIL_SYNC_FETCH_LIMIT = 'all';
const MAIL_SYNC_FETCH_LIMITS = new Set(['all']);
const LEGACY_MAIL_SYNC_FETCH_LIMITS = new Set(['100', '500', '1000', '2000']);

function normalizeSyncFetchLimit(value, fallbackValue = DEFAULT_MAIL_SYNC_FETCH_LIMIT) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallbackValue;
  if (LEGACY_MAIL_SYNC_FETCH_LIMITS.has(normalized)) return DEFAULT_MAIL_SYNC_FETCH_LIMIT;
  if (!MAIL_SYNC_FETCH_LIMITS.has(normalized)) return null;
  return normalized;
}

async function cancelMailAccountSync(accountId) {
  // HTTP /sync/cancel is read-only. Accepted operation/reconcile jobs remain
  // runnable and keep their dispatch/uncertainty journal intact.
  const key = normalizeMailAccountId(accountId);
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [key]);
  if (!accounts.length) return false;
  let cursor = '', changed = false;
  for (;;) {
    const [jobs] = await db.execute(`SELECT id FROM mail_engine_jobs WHERE user_id = ? AND mail_account_id = ?
      AND kind IN (${[...READ_ONLY_MAIL_JOB_KINDS].map(() => '?').join(',')})
      AND state IN ('queued','running') AND id > ? ORDER BY id LIMIT 100`,
    [accounts[0].user_id, key, ...READ_ONLY_MAIL_JOB_KINDS, cursor]);
    if (!jobs.length) break;
    for (const job of jobs) {
      changed = await durableScheduler.cancel({ userId: accounts[0].user_id, accountId: key, jobId: job.id }) || changed;
    }
    cursor = jobs[jobs.length - 1].id;
  }
  // A queued job is cancelled without reaching the scheduler's state callback.
  if (changed) publishMailJob({ user_id: accounts[0].user_id, mail_account_id: key, state: 'cancelled' });
  return changed;
}
async function yieldMailReadWork(accountId) {
  const key = normalizeMailAccountId(accountId);
  if (!key) return false;
  return durableScheduler.yieldReadWork(key);
}
// Operation/reconcile jobs are ordinary durable jobs. Admission and the due scan
// call this after enqueueing so the work starts now, not at the next poll: a
// read-only job of the same account yields its lease at a safe boundary, and
// the scheduler keeps a slot read-only jobs cannot take (see readConcurrency).
// foreground marks the account's next mutation job as user-initiated: it runs
// while background sync is off and refreshes with a follow-up sync.
async function runMailOperationsNow(accountId, { foreground = false } = {}) {
  const key = normalizeMailAccountId(accountId);
  if (!key) return false;
  if (foreground) foregroundMutationAccounts.add(key);
  await durableScheduler.yieldReadWork(key);
  await durableScheduler.drain();
  return true;
}
// Disconnect/settings/module shutdown is a different operation from /sync/cancel.
// Fencing first prevents new provider dispatch; dispatched effects remain
// inspectable until reconnect. A running operation job is aborted with the
// account's other jobs, which hard-closes its guarded transport.
async function stopMailAccountWork(accountId, reason = 'Account stopped') {
  const key = normalizeMailAccountId(accountId);
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [key]);
  if (!accounts.length) return false;
  await require('./mail-engine/runtime').pauseAccount({ userId: accounts[0].user_id, accountId: key, reason });
  mailDeleteStopRequests.add(key);
  foregroundMutationAccounts.delete(key);
  durableScheduler.interruptAccount(key);
  evictImapConnections(key);
  return true;
}

// background: periodic/service-worker work; skipped while the user's mail
// background setting is off. followUp: internal refresh after a user action;
// runs regardless of that setting. Neither is manual: no pause resume, no
// forced flags/presence resweep. Background is enforced here at admission
// because durable stream jobs carry no origin and manual Sync spawns them too.
async function scheduleMailAccountSync(accountId, options = {}) {
  const id = normalizeMailAccountId(accountId);
  if (!id) throw new Error('Account ID required');
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [id]);
  if (!accounts.length) throw new Error('Mail account not found');
  if (options.background && !await isModuleBackgroundEnabled(accounts[0].user_id, 'mail')) {
    const result = { success: false, skipped: true, error: 'Mail background sync disabled' };
    return { started: false, alreadyRunning: false, skipped: true, job_id: null, promise: Promise.resolve(result) };
  }
  const manual = !options.background && !options.followUp;
  // A manual request may reopen only a background/module pause, never a
  // disconnect, settings fence or active restore. The route calls this entry
  // directly, so the resume belongs at admission, not only syncMailAccount.
  if (manual && await isModuleEnabled(accounts[0].user_id, 'mail')
      && !await isSectionRestoreActive(accounts[0].user_id, 'mail'))
    await require('./mail-engine/runtime').resumeAccount({ userId: accounts[0].user_id,
      accountId: id, resumeStreams: true, reasons: ['Mail module disabled', 'Mail background paused'] });
  await durableScheduler.start();
  const prior = await durableScheduler.state({ userId: accounts[0].user_id, accountId: id });
  const alreadyRunning = prior && prior.kind === 'sync' && ['queued', 'running'].includes(prior.state);
  const job = await durableScheduler.enqueue({ userId: accounts[0].user_id, accountId: id,
    kind: 'sync', priority: 5, manualRefresh: manual });
  if (!alreadyRunning) publishMailJob({ ...job, user_id: accounts[0].user_id, mail_account_id: id, kind: 'sync', state: 'queued' });
  return { started: !alreadyRunning, alreadyRunning: !!alreadyRunning, job_id: job.id,
    promise: Promise.resolve({ success: true, started: !alreadyRunning, alreadyRunning: !!alreadyRunning, job_id: job.id }) };
}
async function getMailSyncState(accountId) {
  const id = normalizeMailAccountId(accountId);
  if (!id) return null;
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [id]);
  if (!accounts.length) return null;
  const job = await durableScheduler.state({ userId: accounts[0].user_id, accountId: id });
  if (!job) return null;
  return { account_id: id, job_id: job.id, state: job.state, phase: job.phase,
    processed: Number(job.processed || 0), total: job.total == null ? null : Number(job.total),
    coverage: typeof job.coverage_json === 'string' ? JSON.parse(job.coverage_json) : job.coverage_json,
    started_at: job.started_at, updated_at: job.updated_at, completed_at: job.completed_at,
    cancellation_requested: toBooleanFlag(job.cancellation_requested), error: job.error };
}
async function syncMailAccount(accountId, options = {}) {
  const id = normalizeMailAccountId(accountId);
  if (!id) return { success: false, error: 'Account ID required' };
  const job = await scheduleMailAccountSync(id, options);
  return job.promise;
}

// Periodic cadence. Each tick only follows INBOX arrivals ('recent', usually on
// a parked session). Folder discovery and its per-folder recent/flags/history/
// presence fan-out run at most every MAIL_DISCOVERY_INTERVAL_SECONDS, or again
// after a failed pass. Manual Sync stays immediate and complete.
const MAIL_DISCOVERY_INTERVAL_SECONDS = 5 * 60;
async function schedulePeriodicMailWork(accountId, { executor = db, scheduler = durableScheduler } = {}) {
  const id = normalizeMailAccountId(accountId);
  if (!id) throw new Error('Account ID required');
  const [accounts] = await executor.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [id]);
  if (!accounts.length) throw new Error('Mail account not found');
  const userId = accounts[0].user_id;
  // Background off is enforced at admission; the INBOX follow-up is background work too.
  if (!await isModuleBackgroundEnabled(userId, 'mail'))
    return { started: false, alreadyRunning: false, skipped: true, promise: Promise.resolve({ success: true, skipped: true }) };
  const [[discovery]] = await executor.execute(`SELECT COUNT(*) AS n FROM mail_engine_jobs
    WHERE user_id = ? AND mail_account_id = ? AND kind = 'sync' AND (state IN ('queued','running')
      OR (state = 'idle' AND completed_at >= UTC_TIMESTAMP() - INTERVAL ? SECOND))`, [userId, id, MAIL_DISCOVERY_INTERVAL_SECONDS]);
  const [inboxes] = Number(discovery?.n) ? await executor.execute(`SELECT m.id FROM mail_remote_mailboxes m
    JOIN mail_folder_remote_boxes b ON b.mail_account_id=m.mail_account_id AND BINARY b.remote_name=BINARY m.remote_name
    JOIN mail_folders f ON f.id=b.folder_id AND f.user_id=m.user_id
    WHERE m.user_id=? AND m.mail_account_id=? AND m.state='active' AND f.slug='inbox'`, [userId, id]) : [[]];
  if (!inboxes.length) return scheduleMailAccountSync(id, { background: true });
  await scheduler.start();
  for (const box of inboxes) await scheduler.enqueue({ userId, accountId: id, mailboxId: box.id, kind: 'recent', priority: 10 });
  return { started: false, alreadyRunning: false, discovery: false, promise: Promise.resolve({ success: true }) };
}

module.exports = {
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  MAIL_SYNC_FETCH_LIMITS,
  normalizeSyncFetchLimit,
  cancelMailAccountSync,
  yieldMailReadWork,
  runMailOperationsNow,
  stopMailAccountWork,
  scheduleMailAccountSync,
  getMailSyncState,
  syncMailAccount,
  MAIL_DISCOVERY_INTERVAL_SECONDS,
  schedulePeriodicMailWork,
};
