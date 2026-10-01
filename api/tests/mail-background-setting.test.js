const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ENCRYPTION_KEY = 'mail-background-setting-test-only-key';
const mail = require('../src/services/mail');
const runtime = require('../src/services/mail-engine/runtime');
const { getDb, setDb } = require('../src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));
const REASONS = ['Mail module disabled', 'Mail background paused'];

function settingsDb(prefs) {
  return { execute: async sql => {
    if (sql.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: prefs }) }]];
    if (sql.includes('FROM backup_restore_jobs')) return [[]];
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
}
function engineSpies(t) {
  const resumes = [], enqueued = [];
  t.mock.method(runtime, 'resumeAccount', async input => { resumes.push(input); return { resumed: 0 }; });
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => null);
  t.mock.method(runtime, 'getJobStatus', async () => null);
  t.mock.method(runtime, 'enqueueJob', async input => { enqueued.push(input); return { id: `job-${enqueued.length}` }; });
  return { resumes, enqueued };
}

test('background off: periodic admission enqueues nothing; manual and follow-up work still run without lifting it', async t => {
  const old = getDb(); t.after(() => setDb(old));
  setDb(settingsDb({ enabled: true, background: false }));
  const { resumes, enqueued } = engineSpies(t);
  const periodic = await mail.scheduleMailAccountSync('A', { background: true });
  assert.deepEqual([periodic.started, periodic.skipped], [false, true]);
  assert.equal((await periodic.promise).skipped, true);
  assert.deepEqual(enqueued, [], 'a background tick must not create durable sync work');
  await mail.scheduleMailAccountSync('A', { followUp: true });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].manualRefresh, false, 'a follow-up is never a manual resweep');
  assert.deepEqual(resumes, [], 'a follow-up never resumes a pause');
  await mail.scheduleMailAccountSync('A');
  assert.equal(enqueued.at(-1).manualRefresh, true, 'the Sync button still runs a manual refresh');
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: true, reasons: REASONS }]);
});

test('background on: periodic sync is admitted as non-manual and never resumes', async t => {
  const old = getDb(); t.after(() => setDb(old));
  setDb(settingsDb({ enabled: true, background: true }));
  const { resumes, enqueued } = engineSpies(t);
  const job = await mail.scheduleMailAccountSync('A', { background: true });
  assert.equal(job.skipped, undefined);
  assert.deepEqual([enqueued.length, enqueued[0].manualRefresh, resumes.length], [1, false, 0]);
});

// An operation job runs on the module's durable scheduler; the runtime is
// mocked so the job is claimed exactly once.
function operationJob(t, accountId, { prefs = {}, needsSync = true } = {}) {
  const { EventEmitter } = require('node:events');
  const imaps = require('imap-simple');
  const engine = require('../src/services/mail-engine/operations');
  const repository = require('../src/services/mail-engine/repository');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const followUps = [], completions = [], processed = [];
  let claimed = false, connects = 0;
  const connection = new EventEmitter();
  connection.imap = { destroy() {} }; connection.end = () => {};
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imaps, 'connect', async () => { connects++; return connection; });
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => {
    if (claimed) return null;
    claimed = true;
    return { id: `op-job-${accountId}`, user_id: 'owner', mail_account_id: accountId, kind: 'operation',
      lease_owner: 'worker', worker_generation: 1, operation_id: 'accepted-op' };
  });
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'updateJob', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'completeJob', async input => { completions.push(input.state); });
  t.mock.method(repository, 'withTransaction', async callback => callback(undefined));
  t.mock.method(engine, 'processDueOperations', async (_account, _connection, options) => {
    processed.push(options.background); return { needsSync, connectionFailed: false };
  });
  t.mock.method(mail, 'syncMailAccount', async (id, options) => { followUps.push([id, options]); return { success: true }; });
  setDb({ execute: async sql => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: accountId, user_id: 'owner', sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: prefs }) }]];
    if (sql.includes('FROM backup_restore_jobs')) return [[]];
    if (sql.includes('FROM mail_writebacks WHERE id=?')) return [[{ id: 'accepted-op' }]];
    if (sql.includes('FROM mail_writebacks WHERE mail_account_id=?')) return [[]];
    assert.fail(`Unexpected SQL: ${sql}`);
  } });
  return { followUps, completions, processed, connects: () => connects, async finished() {
    for (let i = 0; i < 100 && !completions.length; i++) await tick();
    for (let i = 0; i < 5; i++) await tick();
  } };
}

for (const background of [false, true]) test(`post-writeback follow-up sync is ${background ? 'background' : 'follow-up'}, never manual`, async t => {
  const accountId = `follow-${background}`;
  const job = operationJob(t, accountId);
  await mail.runMailOperationsNow(accountId, { foreground: !background });
  await job.finished();
  assert.deepEqual(job.completions, ['idle']);
  assert.deepEqual(job.processed, [background]);
  assert.deepEqual(job.followUps, [[accountId, background ? { background: true } : { followUp: true }]]);
});

test('background off: a due-scan operation job pauses without connecting; a clicked change still runs', async t => {
  const prefs = { enabled: true, background: false };
  await t.test('background retry', async t => {
    const job = operationJob(t, 'bg-off', { prefs });
    await mail.runMailOperationsNow('bg-off');
    await job.finished();
    assert.deepEqual(job.completions, ['paused'], 'the due scan requeues it once background sync is on');
    assert.equal(job.connects(), 0);
  });
  await t.test('foreground change', async t => {
    const job = operationJob(t, 'bg-off', { prefs });
    await mail.runMailOperationsNow('bg-off', { foreground: true });
    await job.finished();
    assert.deepEqual(job.completions, ['idle']);
    assert.deepEqual(job.followUps, [['bg-off', { followUp: true }]]);
  });
});

test('service-worker background trigger uses background admission and reports a disabled setting as skipped', async t => {
  const routePath = require.resolve('../src/routes/mail');
  const servicePath = require.resolve('../src/services/mail');
  const oldRoute = require.cache[routePath], oldService = require.cache[servicePath], oldDb = getDb();
  t.after(() => { setDb(oldDb); if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath]; });
  t.after(require('./helpers/mail-service-modules').evictMailRouteModules());
  const calls = [];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    scheduleMailAccountSync: async (id, options) => {
      calls.push([id, options]);
      return id === 'off' ? { started: false, skipped: true, promise: Promise.resolve({ success: false, skipped: true }) }
        : { started: true, promise: Promise.resolve({ success: true }) };
    },
  } };
  setDb({ execute: async sql => {
    if (sql.includes('FROM mail_accounts')) return [[{ id: 'off', last_synced_at: null }, { id: 'on', last_synced_at: null }]];
    assert.fail(sql);
  } });
  const routes = require('../src/routes/mail');
  const result = await routes['POST /api/mail/sync/background']({ url: '/api/mail/sync/background' }, 'owner', {});
  assert.deepEqual(calls, [['off', { background: true }], ['on', { background: true }]]);
  assert.deepEqual([result.started, result.skipped, result.alreadyRunning], [['on'], ['off'], []]);
});

test('module toggle: background off drops read work without fencing; disable still stops; enable never lifts other pauses', async t => {
  const routePath = require.resolve('../src/routes/modules');
  const oldRoute = require.cache[routePath], oldDb = getDb();
  t.after(() => { setDb(oldDb); if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath]; });
  delete require.cache[routePath];
  let saved = {};
  const stops = [], cancels = [], resumes = [];
  setDb({ execute: async (sql, params) => {
    if (sql.startsWith('INSERT INTO user_settings')) {
      for (const [id, value] of Object.entries(JSON.parse(params[2]))) saved[id] = { ...saved[id], ...value };
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify(saved) }]];
    if (sql.includes('FROM mail_accounts')) return [[{ id: 'A', is_active: 1, disconnected_at: null },
      { id: 'B', is_active: 0, disconnected_at: null }]];
    assert.fail(sql);
  } });
  t.mock.method(mail, 'stopMailAccountWork', async (id, reason) => { stops.push([id, reason]); return true; });
  t.mock.method(mail, 'cancelMailAccountSync', async id => { cancels.push(id); return true; });
  t.mock.method(runtime, 'resumeAccount', async input => { resumes.push(input); return { resumed: 0, retired: 0 }; });
  const route = require('../src/routes/modules')['PUT /api/modules'];
  await route({}, 'owner', { modules: { mail: { background: false } } });
  assert.deepEqual(stops, [], 'background off is a scheduling preference, not an account fence');
  assert.deepEqual(cancels, ['A', 'B']);
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: false, reasons: REASONS }]);
  await route({}, 'owner', { modules: { mail: { enabled: false } } });
  assert.deepEqual(stops, [['A', 'Mail module disabled'], ['B', 'Mail module disabled']]);
  cancels.length = 0; resumes.length = 0;
  await route({}, 'owner', { modules: { mail: { enabled: true, background: true } } });
  assert.deepEqual(cancels, []);
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: true, reasons: REASONS }]);
  assert.ok(resumes.every(input => !input.reasons.includes('Deployment canary hold')));
});
