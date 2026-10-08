const test = require('node:test');
const assert = require('node:assert/strict');
const { queueChanges, runDueWritebacks, mutateMessages } = require('../dist/src/services/mail-writebacks');
const { getDb, setDb } = require('../dist/src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('HTTP sync acknowledgement is prompt and status never includes another owner', async t => {
  const routePath = require.resolve('../dist/src/routes/mail');
  const servicePath = require.resolve('../dist/src/services/mail');
  const oldRoute = require.cache[routePath], oldService = require.cache[servicePath], oldDb = getDb();
  t.after(() => { setDb(oldDb); if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath]; });
  t.after(require('./helpers/mail-service-modules').evictMailRouteModules());
  const jobs = new Map(), cancellations = [];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    scheduleMailAccountSync: id => {
      if (jobs.has(id)) return { started: false, alreadyRunning: true, promise: jobs.get(id) };
      const never = new Promise(() => {}); jobs.set(id, never);
      return { started: true, alreadyRunning: false, promise: never };
    },
    cancelMailAccountSync: id => { cancellations.push(id); return jobs.delete(id); },
    getMailSyncState: id => ({ account_id: id, state: 'queued', phase: null, processed: 0, total: null,
      started_at: null, updated_at: new Date().toISOString(), error: null }),
  } };
  setDb({ execute: async (sql, params) => {
    if (sql.includes('FROM mail_accounts')) {
      if (sql.includes('WHERE id = ? AND user_id = ?')) {
        const owned = params[1] === 'alice' ? 'alice-mail' : 'bob-mail';
        return [params[0] === owned ? [{ id: owned, is_active: 1, sync_status: 'idle' }] : []];
      }
      const owned = params[0] === 'alice' ? [{ id: 'alice-mail', sync_status: 'idle' }] : [{ id: 'bob-mail', sync_status: 'idle' }];
      return [params.length > 1 ? owned.filter(row => row.id === params[1]) : owned];
    }
    assert.fail(sql);
  } });
  const routes = require('../dist/src/routes/mail');
  const req = url => ({ url });
  assert.equal((await routes['POST /api/mail/sync'](req('/api/mail/sync'), 'alice', { account_id: 'bob-mail' })).status, 404);
  const accepted = await routes['POST /api/mail/sync'](req('/api/mail/sync'), 'alice', { account_id: 'alice-mail' });
  assert.deepEqual([accepted.status, accepted.started, accepted.alreadyRunning], [202, true, false]);
  const again = await routes['POST /api/mail/sync'](req('/api/mail/sync'), 'alice', { account_id: 'alice-mail' });
  assert.deepEqual([again.status, again.started, again.alreadyRunning], [200, false, true]);
  const status = await routes['GET /api/mail/sync/status'](req('/api/mail/sync/status'), 'alice');
  assert.deepEqual(status.accounts.map(row => row.account_id), ['alice-mail']);
  assert.equal((await routes['GET /api/mail/sync/status'](req('/api/mail/sync/status?account_id=bob-mail'), 'alice')).status, 404);
  const cancel = routes['POST /api/mail/sync/cancel'];
  assert.equal((await cancel(req('/api/mail/sync/cancel'), null, { account_id: 'alice-mail' })).status, 401);
  assert.equal((await cancel(req('/api/mail/sync/cancel'), 'alice', {})).status, 400);
  assert.equal((await cancel(req('/api/mail/sync/cancel'), 'alice', { account_id: 'bob-mail' })).status, 404);
  assert.deepEqual(cancellations, [], 'foreign or invalid cancellation never reaches the scheduler');
  const cancelled = await cancel(req('/api/mail/sync/cancel'), 'alice', { account_id: 'alice-mail' });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.cancellationRequested, true);
  assert.deepEqual(cancellations, ['alice-mail']);
  assert.equal((await cancel(req('/api/mail/sync/cancel'), 'alice', { account_id: 'alice-mail' })).cancellationRequested, false);
});

test('opposite intent accepted after dispatch uses prior target, not stale stored flag', async () => {
  const email = { id: 'email', mail_account_id: 'account', sync_mode: 'sync', remote_folder: 'INBOX',
    remote_uid: 1, remote_uidvalidity: 9, is_read: 0 };
  const previous = { id: 'old', user_id: 'owner', mail_account_id: 'account', email_id: 'email',
    status: 'pending', state: 'executing', is_current: 1, intent_revision: 1, dispatched: 1,
    target_value: '1', remote_folder: 'INBOX', remote_uid: 1, remote_uidvalidity: 9 };
  const statements = [];
  const connection = { execute: async (sql, args) => {
    statements.push({ sql, args });
    if (sql.includes('SELECT * FROM mail_writebacks')) return [[previous]];
    if (sql.includes('SELECT o.id FROM mail_remote_occurrences')) return [[]];
    if (sql.includes('SELECT id FROM mail_accounts WHERE id')) return [[{ id: 'account' }]];
    if (sql.includes('SELECT id FROM mail_writebacks WHERE id')) return [[{ id: args[0] }]];
    if (sql.includes('SELECT * FROM mail_engine_jobs')) return [[]];
    return [{ affectedRows: 1 }];
  } };
  await queueChanges(connection, 'owner', [email], { read: 0 });
  const insert = statements.find(item => item.sql.includes('INSERT INTO mail_writebacks'));
  assert.equal(insert.args[5], '0');
  assert.equal(insert.args[6], '1');
  assert.equal(insert.args[11], 2, 'new intent gets ordered revision');
  assert(!statements.some(item => item.sql.includes('DELETE FROM mail_writebacks')),
    'Accepted older intent and its uncertain attempt remain inspectable');
  const supersede = statements.find(item => item.sql.includes('UPDATE mail_writebacks SET is_current=FALSE'));
  assert.deepEqual(supersede.args.slice(0, 2), ['reconciling', 'pending']);
  assert(statements.some(item => item.sql.includes('INSERT INTO mail_engine_jobs')),
    'The newer intent is runnable after durable acceptance');
});

test('stale flag completion cannot erase a newer opposite request', async t => {
  const settle = require('../dist/src/services/mail-engine/reconciliation');
  const email = { id: 'email', user_id: 'owner', mail_account_id: 'account', observation_revision: 0, is_read: 0 };
  const old = { id: 'old', user_id: 'owner', mail_account_id: 'account', email_id: 'email', action: 'read',
    remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, target_value: '1', is_current: 0,
    state: 'reconciling', status: 'pending' };
  const newest = { ...old, id: 'new', target_value: '0', is_current: 1, state: 'queued' };
  const commands = [old, newest];
  const cx = { execute: async (sql, args = []) => {
    if (sql.includes('SELECT * FROM mail_writebacks WHERE id=')) return [[commands.find(op => op.id === args[0])]];
    if (sql.includes('SELECT * FROM emails WHERE id=')) return [[email]];
    if (sql.startsWith('UPDATE emails SET is_read=')) { email.is_read = args[0]; email.observation_revision++; }
    if (sql.includes("UPDATE mail_writebacks SET state='confirmed'")) {
      const op = commands.find(item => item.id === args[1]); op.state = 'confirmed'; op.status = 'done';
    }
    if (sql.includes('SELECT id FROM mail_operation_attempts')) return [[]];
    return [{ affectedRows: 1 }];
  } };
  const first = await settle.settleFlagObservation({ operationId: old.id, userId: 'owner', accountId: 'account',
    source: { folder: 'INBOX', uid: 12, uidvalidity: 9 }, flags: ['\\Seen'], observationRevision: 0, executor: cx });
  assert.equal(first.settled, true); assert.equal(email.is_read, 1);
  assert.equal(old.state, 'confirmed'); assert.equal(newest.state, 'queued');
  assert.equal(newest.is_current, 1); assert.equal(newest.status, 'pending', 'newer opposite overlay remains visible');
  const second = await settle.settleFlagObservation({ operationId: newest.id, userId: 'owner', accountId: 'account',
    source: { folder: 'INBOX', uid: 12, uidvalidity: 9 }, flags: [], observationRevision: 1, executor: cx });
  assert.equal(second.settled, true); assert.equal(email.is_read, 0); assert.equal(newest.state, 'confirmed');
});

test('startup/due pass schedules uncertain MOVE observation, never another mutation', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const calls = [], enqueued = [];
  const runtime = require('../dist/src/services/mail-engine/runtime');
  t.mock.method(runtime, 'enqueueJob', async job => { enqueued.push(job); });
  const nudged = [];
  t.mock.method(require('../dist/src/services/mail'), 'runMailOperationsNow', async id => { nudged.push(id); return true; });
  setDb({ execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM user_settings')) return [[]];
    if (sql.includes('SELECT w.id,w.user_id,w.mail_account_id')) return [[{ id: 'move-op', user_id: 'owner',
      mail_account_id: 'due-account', state: 'reconciling', action: 'move' }]];
    assert.fail(sql);
  } });
  assert.equal(await runDueWritebacks(), 1);
  await tick();
  assert.deepEqual(enqueued, [{ userId: 'owner', accountId: 'due-account', operationId: 'move-op', kind: 'reconcile', priority: 0 }]);
  assert.deepEqual(nudged, ['due-account']);
  assert(calls.some(item => item.sql.includes('available_at<=UTC_TIMESTAMP()')));
  assert(!calls.some(item => item.sql.includes('UPDATE mail_writebacks SET available_at=')),
    'uncertain MOVE must not loop indefinitely');
});

// Drives the module's own durable scheduler with a mocked runtime: the job is
// claimed once, then runDurableMailJob executes it like any other durable job.
function durableOperation(t, job) {
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const repository = require('../dist/src/services/mail-engine/repository');
  let claimed = false;
  const completions = [];
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => {
    if (claimed) return null;
    claimed = true;
    return { user_id: 'owner', lease_owner: 'worker', worker_generation: 1, kind: 'operation', operation_id: 'accepted-op', ...job };
  });
  t.mock.method(runtime, 'updateJob', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'completeJob', async value => { completions.push(value); });
  t.mock.method(runtime, 'enqueueJob', async () => assert.fail('an operation job queues no continuation'));
  t.mock.method(repository, 'withTransaction', async callback => callback(undefined));
  return { completions, async finished() {
    for (let i = 0; i < 200 && !completions.length; i++) await tick();
    // Let the scheduler's post-completion drain settle before mocks are restored.
    for (let i = 0; i < 5; i++) await tick();
    return completions[0];
  } };
}

test('accepted changes nudge the durable scheduler as foreground work; the due scan as background', async t => {
  const mail = require('../dist/src/services/mail');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const nudges = [];
  t.mock.method(mail, 'runMailOperationsNow', async (id, options) => { nudges.push([id, options]); return true; });
  t.mock.method(runtime, 'enqueueJob', async job => ({ id: `job-${job.operationId}` }));
  const email = { id: 'item', mail_account_id: 'acct', sync_mode: 'sync', is_active: 1, remote_folder: 'INBOX',
    remote_uid: 4, remote_uidvalidity: 9, is_read: 0 };
  const cx = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async sql => {
      if (sql.includes('FROM emails e')) return [[email]];
      if (sql.includes('SELECT * FROM mail_writebacks')) return [[]];
      if (sql.includes('FROM mail_remote_occurrences')) return [[]];
      return [{ affectedRows: 1 }];
    } };
  setDb({ getConnection: async () => cx, execute: async sql => {
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    if (sql.includes('SELECT w.id,w.user_id,w.mail_account_id')) return [[
      { id: 'due-1', user_id: 'owner', mail_account_id: 'due-acct', state: 'retry_wait', action: 'read' },
      { id: 'due-2', user_id: 'owner', mail_account_id: 'due-acct', state: 'queued', action: 'star' }]];
    if (sql.includes("j.state='paused'")) return [[]];
    assert.fail(sql);
  } });
  const result = await mutateMessages('owner', ['item'], { read: 1 });
  assert.equal(result.sync_pending, true);
  assert.deepEqual(nudges, [], 'the HTTP response does not wait for a read job to yield');
  await tick();
  assert.deepEqual(nudges, [['acct', { foreground: true }]]);
  nudges.length = 0;
  assert.equal(await runDueWritebacks(), 2);
  await tick();
  assert.deepEqual(nudges, [['due-acct', undefined]], 'one background nudge per account and pass');
});

test('the mail scheduler reserves a slot for provider changes and a nudge yields same-account reads first', async t => {
  const service = require.resolve('../dist/src/services/mail');
  const schedulerPath = require.resolve('../dist/src/services/mail-sync-scheduler');
  const old = new Map([service, schedulerPath].map(p => [p, require.cache[p]]));
  const real = require(schedulerPath);
  const calls = [];
  let options;
  require.cache[schedulerPath] = { id: schedulerPath, loaded: true, exports: { ...real,
    createDurableMailScheduler: (_run, value) => {
      options = value;
      return { yieldReadWork: async id => { calls.push(['yield', id]); return true; },
        drain: async () => { calls.push(['drain']); } };
    } } };
  t.after(require('./helpers/mail-service-modules').evictMailServiceModules());
  t.after(() => { for (const [p, entry] of old) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  const mail = require(service);
  assert.deepEqual([options.concurrency, options.readConcurrency], [3, 2]);
  assert.equal(await mail.runMailOperationsNow(' acct '), true);
  assert.deepEqual(calls, [['yield', 'acct'], ['drain']]);
  assert.equal(await mail.runMailOperationsNow(''), false);
});

test('a durable operation job sees cancellation before connecting and retains the accepted operation', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../dist/src/services/mail');
  const imapClient = require('../dist/src/services/mail-imap-client');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  let connects = 0, fences = 0;
  const harness = durableOperation(t, { id: 'cancel-job', mail_account_id: 'cancel-account' });
  t.mock.method(runtime, 'assertFence', async () => { fences++; return { cancellationRequested: true }; });
  t.mock.method(imapClient, 'connectImap', async () => { connects++; assert.fail('cancelled worker connected'); });
  setDb({ execute: async () => assert.fail('cancelled worker queried account or discarded operation') });
  await mail.runMailOperationsNow('cancel-account');
  assert.equal((await harness.finished()).state, 'cancelled');
  assert.equal(fences, 1); assert.equal(connects, 0);
});

test('lease lost after connect destroys transport before any provider operation', async t => {
  const { EventEmitter } = require('node:events');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../dist/src/services/mail');
  const imapClient = require('../dist/src/services/mail-imap-client');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const engine = require('../dist/src/services/mail-engine/operations');
  let fences = 0, destroys = 0;
  const connection = new EventEmitter();
  connection.close = () => { destroys++; };
  const harness = durableOperation(t, { id: 'lost-job', mail_account_id: 'lost-account' });
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imapClient, 'connectImap', async () => connection);
  t.mock.method(runtime, 'assertFence', async () => {
    fences++; if (fences === 2) throw Object.assign(new Error('lease lost'), { code: 'MAIL_WORKER_FENCED' });
    return { cancellationRequested: false };
  });
  t.mock.method(engine, 'processDueOperations', () => assert.fail('provider commands after lease loss'));
  setDb({ execute: async sql => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: 'lost-account', user_id: 'owner',
      sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('FROM mail_writebacks WHERE id=?')) return [[{ id: 'accepted-op' }]];
    if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
    throw new Error(`Unexpected ${sql}`);
  } });
  await mail.runMailOperationsNow('lost-account');
  for (let i = 0; i < 100 && !destroys; i++) await tick();
  assert.equal(fences, 2); assert.equal(destroys, 1);
  await harness.finished();
  assert.deepEqual(harness.completions, [], 'a fenced generation never commits a completion');
});

test('account stop aborts a running operation job and destroys its guarded socket', async t => {
  const { EventEmitter } = require('node:events');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../dist/src/services/mail');
  const imapClient = require('../dist/src/services/mail-imap-client');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const engine = require('../dist/src/services/mail-engine/operations');
  const connection = new EventEmitter();
  let socketDestroyed = 0, entered = false, remoteCommands = 0;
  const paused = [];
  connection.close = () => { socketDestroyed++; };
  const harness = durableOperation(t, { id: 'stop-job', mail_account_id: 'stop-account' });
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imapClient, 'connectImap', async () => connection);
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'pauseAccount', async input => { paused.push(input); });
  t.mock.method(engine, 'processDueOperations', (_account, _connection, { signal }) => {
    entered = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  setDb({ execute: async sql => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: 'stop-account', user_id: 'owner', sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes('FROM mail_writebacks WHERE id=?')) return [[{ id: 'accepted-op' }]];
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    remoteCommands++; assert.fail(`Unexpected provider/mutation SQL after stop: ${sql}`);
  } });
  await mail.runMailOperationsNow('stop-account', { foreground: true });
  for (let i = 0; i < 50 && !entered; i++) await tick();
  assert.equal(entered, true);
  assert.equal(mail.isMailAccountSyncRunning('stop-account'), true);
  assert.equal(await mail.stopMailAccountWork('stop-account', 'Account disconnected'), true);
  assert.deepEqual(paused, [{ userId: 'owner', accountId: 'stop-account', reason: 'Account disconnected' }]);
  assert.equal(socketDestroyed, 1, 'abort immediately hard-closes the active IMAP socket');
  assert.equal((await harness.finished()).state, 'cancelled');
  assert.equal(mail.isMailAccountSyncRunning('stop-account'), false);
  assert.equal(remoteCommands, 0);
});
