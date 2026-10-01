const { withMailAccountLock } = require('./mail-account-lock');
const { createDurableMailScheduler, MUTATION_MAIL_JOB_KINDS } = require('./mail-sync-scheduler');
const { acquireImapConnection, releaseImapConnection } = require('./mail-engine/connection-pool');
const { operationDue, processOperationBatch } = require('./mail-engine/operation-batch');
const { db } = require('../state');
const { publishMailJob } = require('./server-events');
const { isModuleEnabled, isModuleBackgroundEnabled } = require('./module-settings');
const { isSectionRestoreActive } = require('./restore-locks');
const { toBooleanFlag, buildImapConnectionConfig } = require('./mail-host-policy');
const { ensureDefaultMailFoldersForUser, listAvailableImapFolders, isVirtualMailFolderName, registerCustomImapFoldersForUser, pickImapSyncFolders } = require('./mail-folders');

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('Mail sync cancelled; completed messages are retained.');
    error.code = 'MAIL_SYNC_CANCELLED';
    throw error;
  }
}
const foregroundMutationAccounts = new Set();

function normalizeMailAccountId(accountId) {
  return String(accountId || '').trim();
}

function isMailAccountSyncRunning(accountId) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  return !!normalizedAccountId && runningDurableAccounts.has(normalizedAccountId);
}

function isAnyMailAccountSyncRunning() {
  return runningDurableAccounts.size > 0;
}

function getRunningMailSyncAccountIds() {
  return [...runningDurableAccounts];
}

const runningDurableAccounts = new Set();
let durableScheduler;
async function runRecoveredReconcileJob({ job, account, connection, signal, report }) {
  const runtime = require('./mail-engine/runtime');
  const transport = require('./mail-engine/transport');
  const { uint32 } = require('./mail-engine/content');
  const { settleFlagObservation } = require('./mail-engine/reconciliation');
  const { validateWindowReply } = require('./mail-engine/sync');
  const fence = () => runtime.assertFence({ accountId: account.id, jobId: job.id,
    workerId: job.lease_owner, generation: Number(job.worker_generation) });
  if (!job.operation_id || account.sync_mode !== 'sync') return { success: false, error: 'Reconciliation requires a Sync operation' };
  const [[op]] = await db.execute(`SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=?`,
    [job.operation_id, account.user_id, account.id]);
  if (!op) return { success: false, error: 'Reconciliation operation missing' };
  if (['confirmed', 'cancelled', 'superseded', 'rejected'].includes(op.state)) return { success: true };
  if (!Number(op.dispatched)) return { success: false, error: 'Undispatched operation is not a reconciliation job' };
  if (op.action === 'move') {
    // The operations executor owns the bounded MOVE outcome classifier. Its
    // dispatched branch reads provider state and can settle/mark attention;
    // it must never call nativeMove again after the persisted dispatch fence.
    await require('./mail-engine/operations').applyMove(op, connection, Number(job.worker_generation),
      signal, job.lease_owner, job.id);
    await fence();
    const [[current]] = await db.execute('SELECT state FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=?',
      [op.id, account.user_id, account.id]);
    if (current?.state === 'confirmed')
      await runtime.enqueueJob({ userId: account.user_id, accountId: account.id, kind: 'sync', priority: 5 });
    return { success: true, observationOnly: true };
  }
  const [boxes] = await db.execute(`SELECT m.id, m.remote_name, m.uidvalidity, f.slug FROM mail_remote_mailboxes m
    JOIN mail_folder_remote_boxes b ON b.mail_account_id=m.mail_account_id AND BINARY b.remote_name=BINARY m.remote_name
    JOIN mail_folders f ON f.id=b.folder_id AND f.user_id=m.user_id
    WHERE m.user_id=? AND m.mail_account_id=? AND m.state='active'
      AND BINARY m.remote_name=BINARY ?`, [account.user_id, account.id, op.remote_folder]);
  const source = boxes.find(box => box.remote_name === op.remote_folder);
  if (['read', 'star'].includes(op.action) && source && uint32(op.remote_uidvalidity) === uint32(source.uidvalidity)
      && uint32(op.remote_uid)) {
    const selected = await transport.selectMailbox(connection,
      { folder: source.remote_name, readOnly: true, signal });
    if (uint32(selected.uidvalidity) !== uint32(op.remote_uidvalidity))
      return { success: false, error: 'Flag source epoch changed; identity requires attention' };
    const uid = Number(op.remote_uid), window = { start: uid, end: uid };
    const reply = await transport.fetchMetadataWindow(connection, { folder: source.remote_name,
      uidvalidity: Number(op.remote_uidvalidity), startUid: uid, endUid: uid, maxMessages: 1, maxBytes: 1024 * 1024 }, { signal });
    const [item] = validateWindowReply(reply, window, Number(op.remote_uidvalidity));
    if (item) {
      await fence();
      const [[email]] = await db.execute('SELECT observation_revision FROM emails WHERE id=? AND user_id=? AND mail_account_id=?',
        [op.email_id, account.user_id, account.id]);
      if (email) {
        const settled = await settleFlagObservation({ operationId: op.id, userId: account.user_id,
          accountId: account.id, workerGeneration: Number(job.worker_generation), workerId: job.lease_owner,
          jobId: job.id, source: { folder: op.remote_folder, uid, uidvalidity: Number(op.remote_uidvalidity) },
          flags: item.flags, modseq: item.modseq, observationRevision: email.observation_revision });
        if (settled.settled) return { success: true, observationOnly: true };
      }
    }
  }
  // If the bit still differs, the normal operation executor performs another
  // fresh read and classifies a safe idempotent flag retry/attention. This job
  // never blindly replays an interrupted provider command.
  if (['read', 'star'].includes(op.action)) {
    await require('./mail-engine/operations').applyFlag(op, connection, Number(job.worker_generation),
      signal, job.lease_owner, job.id);
    return { success: true, observationOnly: true };
  }
  return { success: false, error: 'Unsupported reconciliation action' };
}
// Jobs that provably have no provider work finish before any transport opens.
async function durableJobIdle(job, account) {
  if (job.kind === 'operation' && job.operation_id) return !await operationDue(account, job.operation_id);
  if (['flags', 'presence'].includes(job.kind) && job.mailbox_id && Number(job.manual_refresh) !== 1)
    return require('./mail-engine/sync').sweepThrottled(db, { userId: account.user_id, accountId: account.id,
      mailboxId: job.mailbox_id, stream: job.kind });
  return false;
}
// Provider writes (operation) and their outcome checks (reconcile). The account
// lock serializes them with settings changes and server deletion. Only the
// account's next job after a foreground admission uses the interactive rules
// (module enabled, follow-up refresh); due-scan retries are background work.
async function runDurableMutationJob(job, signal, report) {
  const runtime = require('./mail-engine/runtime');
  const accountId = job.mail_account_id;
  const background = !foregroundMutationAccounts.delete(accountId);
  return withMailAccountLock(accountId, async () => {
    let connection, account, needsSync = false, reusable = false;
    const fence = () => runtime.assertFence({ accountId, jobId: job.id, workerId: job.lease_owner,
      generation: Number(job.worker_generation) });
    try {
      // The lock may have waited for a settings change or deletion pass.
      checkCancelled(signal);
      if ((await fence()).cancellationRequested) return { cancelled: true };
      [[account]] = await db.execute('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, job.user_id]);
      if (!account || account.sync_mode !== 'sync' || !toBooleanFlag(account.is_active) || account.disconnected_at
        || await isSectionRestoreActive(account.user_id, 'mail')
        || !await (background ? isModuleBackgroundEnabled : isModuleEnabled)(account.user_id, 'mail')) return { paused: true };
      const config = await require('./mail').buildImapConnectionConfig(account, { keepalive: false });
      if (!config) throw new Error('Missing credentials');
      // A click should fail fast, not wait out the read-path timeouts.
      config.imap.connTimeout = 15000; config.imap.authTimeout = 15000; config.imap.socketTimeout = 30000;
      if (await durableJobIdle(job, account)) { reusable = true; return { success: true, more: false, skipped: true }; }
      connection = await acquireImapConnection(account, config, { signal });
      checkCancelled(signal);
      if ((await fence()).cancellationRequested) return { cancelled: true };
      if (job.kind === 'reconcile') {
        const result = await runRecoveredReconcileJob({ job, account, connection, signal, report });
        reusable = result.success === true;
        return result;
      }
      const result = await processOperationBatch(account, connection, { background,
        workerGeneration: Number(job.worker_generation), workerId: job.lease_owner, jobId: job.id,
        operationId: job.operation_id, signal }, { process: require('./mail-engine/operations').processDueOperations });
      needsSync = result.needsSync;
      reusable = !result.connectionFailed;
      return { success: !result.connectionFailed, more: false, ...result };
    } catch (error) {
      reusable = false;
      if (error.code === 'MAIL_WORKER_FENCED') throw error;
      if (signal.aborted || error.code === 'MAIL_SYNC_CANCELLED') return { success: false, cancelled: true };
      // A connect/login failure backs off the account's due operations instead
      // of retrying every second; accepted intents are never discarded.
      if (account) await require('./mail-engine/operations').deferAccountOffline(account.id, account.user_id, error);
      return { success: false, error: /^[A-Z][A-Z0-9_]{1,63}$/.test(String(error.code || '')) ? error.code : 'Provider connection unavailable' };
    } finally {
      if (connection) releaseImapConnection(connection, { reusable: reusable && !signal.aborted });
      // Throttled refresh, never a manual resweep or pause resume. A foreground
      // write still settles while background sync is off.
      if (needsSync) setImmediate(() => require('./mail').syncMailAccount(accountId,
        background ? { background: true } : { followUp: true }).catch(() => {}));
    }
  });
}
async function runDurableMailJob(job, signal, report) {
  if (MUTATION_MAIL_JOB_KINDS.includes(job.kind)) return runDurableMutationJob(job, signal, report);
  const runtime = require('./mail-engine/runtime');
  const { scanMailboxSlice } = require('./mail-engine/sync');
  const { processBodySlice } = require('./mail-engine/content');
  const accountId = job.mail_account_id;
  let connection, outcome, threw = true;
  const done = value => { outcome = value; threw = false; return value; };
  try {
    const [accounts] = await db.execute('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, job.user_id]);
    const account = accounts[0];
    if (!account || !toBooleanFlag(account.is_active) || account.disconnected_at) return { success: false, error: 'Account inactive or disconnected' };
    if (!await isModuleEnabled(account.user_id, 'mail') || await isSectionRestoreActive(account.user_id, 'mail'))
      return { success: false, error: 'Mail module paused or restore in progress' };
    checkCancelled(signal);
    await runtime.assertFence({ accountId, jobId: job.id, workerId: job.lease_owner,
      generation: Number(job.worker_generation) });
    if (job.kind === 'prune') {
      // Local Sync policy only: no credentials, no provider connection.
      const result = await require('./mail-sync-policy').runPruneSlice({ account, job, signal, report });
      return done({ success: true, ...result });
    }
    const config = await buildImapConnectionConfig(account);
    if (!config) return { success: false, error: 'Mail credentials unavailable' };
    if (await durableJobIdle(job, account)) return { success: true, more: false, skipped: true };
    connection = await acquireImapConnection(account, config, { signal });
    checkCancelled(signal);
    if (job.kind === 'sync') {
      const specialUses = new Map(), allMailboxes = new Set();
      const names = await listAvailableImapFolders(connection, specialUses, true, allMailboxes);
      for (const planned of pickImapSyncFolders(names)) {
        if (names.includes(planned.folderName) && !specialUses.has(planned.folderName)) specialUses.set(planned.folderName, planned.dbFolderName);
      }
      await ensureDefaultMailFoldersForUser(account.user_id);
      const registered = await registerCustomImapFoldersForUser(account.user_id, account.id, names, db, specialUses, true);
      if (registered.length !== names.filter(name => !isVirtualMailFolderName(name)).length)
        throw new Error('Remote folder mapping incomplete');
      for (const folder of registered) {
        checkCancelled(signal);
        const selected = await require('./mail-engine/transport').selectMailbox(connection,
          { folder: folder.remoteName, readOnly: true, signal });
        const mailbox = await require('./mail-engine/repository').withTransaction(executor =>
          require('./mail-engine/repository').ensureMailbox({ userId: account.user_id,
            accountId, folderName: folder.remoteName, epoch: selected.uidvalidity,
            metadata: { localFolderSlug: folder.slug,
              specialUse: allMailboxes.has(folder.remoteName) ? 'all' : specialUses.get(folder.remoteName) || null } }, executor), db);
        // These are durable independent jobs, never a global inventory equality gate.
        for (const [kind, priority] of account.sync_mode === 'sync'
          ? [['recent', 10], ['flags', 20], ['history', 60], ['presence', 70]]
          : [['recent', 10], ['history', 60]]) {
          await runtime.enqueueJob({ userId: account.user_id, accountId, mailboxId: mailbox.id,
            kind, priority, manualRefresh: Number(job.manual_refresh) === 1 && ['flags', 'presence'].includes(kind) });
        }
      }
      // Sync policy (retention, proven absence, Gmail merge, archive filing)
      // is applied by a low-priority local job after each discovery pass.
      if (account.sync_mode === 'sync') await require('./mail-sync-policy').enqueuePrune({ userId: account.user_id, accountId });
      // Stream jobs select a single mapped mailbox in account-scoped rounds.
      return done({ success: true, started: true, folders: registered.length });
    }
    if (!['recent', 'flags', 'history', 'presence', 'body'].includes(job.kind))
      return { success: false, error: 'Unsupported mail job kind' };
    if (account.sync_mode !== 'sync' && ['flags', 'presence'].includes(job.kind))
      return { success: false, error: 'Remote mirroring disabled in Download mode' };
    let mailbox;
    if (job.mailbox_id) {
      const [rows] = await db.execute(`SELECT m.id, m.remote_name, f.slug FROM mail_remote_mailboxes m
        JOIN mail_folder_remote_boxes b ON b.mail_account_id=m.mail_account_id AND BINARY b.remote_name=BINARY m.remote_name
        JOIN mail_folders f ON f.id=b.folder_id AND f.user_id=m.user_id
        WHERE m.id=? AND m.user_id=? AND m.mail_account_id=? AND m.state='active' LIMIT 1`,
      [job.mailbox_id, account.user_id, account.id]);
      mailbox = rows[0];
    }
    if (!mailbox) return { success: false, error: 'Durable mailbox mapping missing' };
    const folder = { folderName: mailbox.remote_name, dbFolderName: mailbox.slug };
    const result = job.kind === 'body'
      ? await processBodySlice({ db, account, connection, folder, mailboxId: mailbox.id, signal, job, report })
      : await scanMailboxSlice({ db, account, connection, folder, stream: job.kind, signal, job, report,
        manualRefresh: Number(job.manual_refresh) === 1 });
    return done({ success: true, more: result.more, ...result });
  } catch (error) {
    if (signal.aborted || error.code === 'MAIL_SYNC_CANCELLED') return { success: false, cancelled: true };
    throw error;
  } finally {
    if (connection) releaseImapConnection(connection, { reusable: !threw && outcome?.success === true && !signal.aborted });
  }
}

// Three slots, at most two for read-only work: one is always free for accepted
// provider changes of any account (see createDurableMailScheduler).
durableScheduler = createDurableMailScheduler(runDurableMailJob, { concurrency: 3, readConcurrency: 2, onState: state => {
  if (!state.mail_account_id) return;
  publishMailJob(state); // live status for the account owner's open tabs
  // Operator log: job kind, account id and the stored error text only — no
  // addresses or mail content. Without this, failing jobs were invisible in logs.
  if (state.state === 'error') console.error(`[MAIL JOB] ${state.kind || 'job'} failed for account ${state.mail_account_id}:`,
    String(state.error || state.result?.error || 'unknown error').slice(0, 200));
  if (state.state === 'running') runningDurableAccounts.add(state.mail_account_id);
  else if (['idle', 'error', 'cancelled', 'paused'].includes(state.state)) runningDurableAccounts.delete(state.mail_account_id);
  // A continuation is committed atomically with the completed job by the
  // durable scheduler. An in-memory callback must not create extra work.
} });
async function startMailEngineScheduler() { await durableScheduler.start(); }

module.exports = {
  durableScheduler,
  foregroundMutationAccounts,
  normalizeMailAccountId,
  isMailAccountSyncRunning,
  isAnyMailAccountSyncRunning,
  getRunningMailSyncAccountIds,
  runRecoveredReconcileJob,
  runDurableMailJob,
  startMailEngineScheduler,
};
