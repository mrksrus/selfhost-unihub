import type { FixtureValue, RouteTable } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
process.env.ENCRYPTION_KEY = 'mail-background-setting-test-only-key';
const mail = require('../dist/src/services/mail') as typeof import('../src/services/mail');
const runtime = require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));
const REASONS = ['Mail module disabled', 'Mail background paused'];

function settingsDb(prefs: FixtureValue) {
  return { execute: async (sql: string) => {
    if (sql.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: prefs }) }]];
    if (sql.includes('FROM backup_restore_jobs')) return [[]];
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
}
function engineSpies(t: import('node:test').TestContext) {
  const resumes: FixtureValue[] = [], enqueued: FixtureValue[] = [];
  t.mock.method(runtime, 'resumeAccount', async (input: FixtureValue) => { resumes.push(input); return { resumed: 0 }; });
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => null);
  t.mock.method(runtime, 'getJobStatus', async () => null);
  t.mock.method(runtime, 'enqueueJob', async (input: FixtureValue) => { enqueued.push(input); return { id: `job-${enqueued.length}` }; });
  return { resumes, enqueued };
}

test('background off: periodic admission enqueues nothing; manual and follow-up work still run without lifting it', async t => {
  const old = getDb(); t.after(() => setDb(old));
  setDb(settingsDb({ enabled: true, background: false }) as FixtureValue);
  const { resumes, enqueued } = engineSpies(t);
  const periodic = await mail.scheduleMailAccountSync('A', { background: true });
  assert.deepEqual([periodic.started, periodic.skipped], [false, true]);
  assert.equal(((await periodic.promise) as FixtureValue).skipped, true);
  assert.deepEqual(enqueued, [], 'a background tick must not create durable sync work');
  await mail.scheduleMailAccountSync('A', { followUp: true });
  assert.equal(enqueued.length, 1);
  assert.equal((enqueued[0] as FixtureValue).manualRefresh, false, 'a follow-up is never a manual resweep');
  assert.deepEqual(resumes, [], 'a follow-up never resumes a pause');
  await mail.scheduleMailAccountSync('A');
  assert.equal((enqueued.at as FixtureValue)(-1).manualRefresh, true, 'the Sync button still runs a manual refresh');
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: true, reasons: REASONS }]);
});

test('background on: periodic sync is admitted as non-manual and never resumes', async t => {
  const old = getDb(); t.after(() => setDb(old));
  setDb(settingsDb({ enabled: true, background: true }) as FixtureValue);
  const { resumes, enqueued } = engineSpies(t);
  const job = await mail.scheduleMailAccountSync('A', { background: true });
  assert.equal(job.skipped, undefined);
  assert.deepEqual([enqueued.length, enqueued[0].manualRefresh, resumes.length], [1, false, 0]);
});

// An operation job runs on the module's durable scheduler; the runtime is
// mocked so the job is claimed exactly once.
function operationJob(t: import('node:test').TestContext, accountId: string, { prefs = {}, needsSync = true }: FixtureValue = {}) {
  const { EventEmitter } = (require('node:events') as typeof import('node:events'));
  const imapClient = require('../dist/src/services/mail-imap-client') as typeof import('../src/services/mail-imap-client');
  const engine = require('../dist/src/services/mail-engine/operations') as typeof import('../src/services/mail-engine/operations');
  const repository = require('../dist/src/services/mail-engine/repository') as typeof import('../src/services/mail-engine/repository');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const followUps: FixtureValue[] = [], completions: FixtureValue[] = [], processed: FixtureValue[] = [];
  let claimed = false, connects = 0;
  const connection: FixtureValue = new EventEmitter();
  connection.close = () => {};
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imapClient, 'connectImap', async () => { connects++; return connection; });
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => {
    if (claimed) return null;
    claimed = true;
    return { id: `op-job-${accountId}`, user_id: 'owner', mail_account_id: accountId, kind: 'operation',
      lease_owner: 'worker', worker_generation: 1, operation_id: 'accepted-op' };
  });
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'updateJob', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'completeJob', async (input: FixtureValue) => { completions.push(input.state); });
  t.mock.method(repository, 'withTransaction', async (callback: FixtureValue) => callback(undefined));
  t.mock.method(engine, 'processDueOperations', async (_account: FixtureValue, _connection: FixtureValue, options: FixtureValue) => {
    processed.push(options.background); return { needsSync, connectionFailed: false };
  });
  t.mock.method(mail, 'syncMailAccount', async (id: FixtureValue, options: FixtureValue) => { followUps.push([id, options]); return { success: true }; });
  setDb({ execute: (async (sql: string) => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: accountId, user_id: 'owner', sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: prefs }) }]];
    if (sql.includes('FROM backup_restore_jobs')) return [[]];
    if (sql.includes('FROM mail_writebacks WHERE id=?')) return [[{ id: 'accepted-op' }]];
    if (sql.includes('FROM mail_writebacks WHERE mail_account_id=?')) return [[]];
    assert.fail(`Unexpected SQL: ${sql}`);
  }) } as FixtureValue);
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
  const routePath = require.resolve('../dist/src/routes/mail');
  const servicePath = require.resolve('../dist/src/services/mail');
  const oldRoute = require.cache[routePath], oldService = require.cache[servicePath], oldDb = getDb();
  t.after(() => { setDb(oldDb); if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath]; });
  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  const calls: FixtureValue[] = [];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    scheduleMailAccountSync: async (id: FixtureValue, options: FixtureValue) => {
      calls.push([id, options]);
      return id === 'off' ? { started: false, skipped: true, promise: Promise.resolve({ success: false, skipped: true }) }
        : { started: true, promise: Promise.resolve({ success: true }) };
    },
  } } as NodeJS.Module;
  setDb({ execute: (async (sql: string) => {
    if (sql.includes('FROM mail_accounts')) return [[{ id: 'off', last_synced_at: null }, { id: 'on', last_synced_at: null }]];
    assert.fail(sql);
  }) } as FixtureValue);
  const routes = require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>;
  const result = await routes['POST /api/mail/sync/background']({ url: '/api/mail/sync/background' } as FixtureValue, 'owner', {});
  assert.deepEqual(calls, [['off', { background: true }], ['on', { background: true }]]);
  assert.deepEqual([result.started, result.skipped, result.alreadyRunning], [['on'], ['off'], []]);
});

test('module toggle: background off drops read work without fencing; disable still stops; enable never lifts other pauses', async t => {
  const { applyModuleChange } = require('../dist/src/services/module-lifecycle') as typeof import('../src/services/module-lifecycle');
  const { durableScheduler } = require('../dist/src/services/mail-durable-jobs') as typeof import('../src/services/mail-durable-jobs');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const stops: FixtureValue[] = [], cancels: FixtureValue[] = [], resumes: FixtureValue[] = [];
  const jobsListed = new Set<string>();
  setDb({ execute: (async (sql: string, params: FixtureValue) => {
    if (sql.includes('SELECT id, is_active, disconnected_at FROM mail_accounts')) return [[{ id: 'A', is_active: 1, disconnected_at: null },
      { id: 'B', is_active: 0, disconnected_at: null }]];
    if (sql.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes('FROM mail_engine_jobs')) {
      // One queued background job per account; a cancel keeps manual jobs.
      assert.match(sql, /manual_refresh = FALSE/);
      if (jobsListed.has(params[1])) return [[]];
      jobsListed.add(params[1]);
      return [[{ id: `job-${params[1]}` }]];
    }
    assert.fail(sql);
  }) } as FixtureValue);
  t.mock.method(runtime, 'pauseAccount', async (input: FixtureValue) => { stops.push([input.accountId, input.reason]); return {}; });
  t.mock.method(runtime, 'resumeAccount', async (input: FixtureValue) => { resumes.push(input); return { resumed: 0, retired: 0 }; });
  t.mock.method(durableScheduler, 'cancel', async (input: FixtureValue) => { cancels.push(input.accountId); return true; });
  const state = (enabled: boolean, background: boolean) => [{ id: 'mail', enabled, background }];
  await applyModuleChange('owner', state(true, true), state(true, false));
  assert.deepEqual(stops, [], 'background off is a scheduling preference, not an account fence');
  assert.deepEqual(cancels, ['A', 'B']);
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: false, reasons: REASONS }]);
  await applyModuleChange('owner', state(true, false), state(false, false));
  assert.deepEqual(stops, [['A', 'Mail module disabled'], ['B', 'Mail module disabled']]);
  cancels.length = 0; resumes.length = 0; jobsListed.clear();
  await applyModuleChange('owner', state(false, false), state(true, true));
  assert.deepEqual(cancels, []);
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: true, reasons: REASONS }]);
  assert.ok(resumes.every(input => !input.reasons.includes('Deployment canary hold')));
  // An unchanged choice, or a change to another module, runs no mail work.
  await applyModuleChange('owner', state(true, true), [...state(true, true), { id: 'contacts', enabled: false, background: true }]);
  assert.deepEqual([stops.length, cancels.length, resumes.length], [2, 0, 1]);
});

test('PUT /api/modules saves the choice and then applies it with the states before and after', async t => {
  const lifecycle = require('../dist/src/services/module-lifecycle') as typeof import('../src/services/module-lifecycle');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const saved: FixtureValue = {};
  setDb({ execute: (async (sql: string, params: FixtureValue) => {
    if (sql.startsWith('INSERT INTO user_settings')) {
      for (const [id, value] of Object.entries(JSON.parse(params[2]))) saved[id] = { ...saved[id], ...(value as FixtureValue) };
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify(saved) }]];
    assert.fail(sql);
  }) } as FixtureValue);
  const applied: FixtureValue[] = [];
  t.mock.method(lifecycle, 'applyModuleChange', async (userId: string, previous: FixtureValue, next: FixtureValue) => { applied.push([userId, previous, next]); });
  const route = (require('../dist/src/routes/modules') as typeof import('../src/routes/modules'))['PUT /api/modules'].handler;
  const result = await route({} as FixtureValue, 'owner', { modules: { mail: { background: false } } });
  assert.ok(result.modules);
  assert.equal(applied.length, 1);
  const [userId, previous, next] = applied[0];
  assert.equal(userId, 'owner');
  assert.deepEqual([previous.find((m: FixtureValue) => m.id === 'mail').background, next.find((m: FixtureValue) => m.id === 'mail').background], [true, false]);
});
