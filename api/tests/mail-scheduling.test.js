const test = require('node:test');
const assert = require('node:assert/strict');
const { queueChanges, processPending, startWritebacks, stopWritebacks, drainWritebacks, runDueWritebacks } = require('../src/services/mail-writebacks');
const { getDb, setDb } = require('../src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('HTTP sync acknowledgement is prompt and status never includes another owner', async t => {
  const routePath = require.resolve('../src/routes/mail');
  const servicePath = require.resolve('../src/services/mail');
  const oldRoute = require.cache[routePath], oldService = require.cache[servicePath], oldDb = getDb();
  t.after(() => { setDb(oldDb); if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath]; });
  delete require.cache[routePath];
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
  const routes = require('../src/routes/mail');
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
  const settle = require('../src/services/mail-engine/reconciliation');
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
  const runtime = require('../src/services/mail-engine/runtime');
  t.mock.method(runtime, 'enqueueJob', async job => { enqueued.push(job); });
  t.mock.method(runtime, 'claimDueJob', async () => null);
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
  assert(calls.some(item => item.sql.includes('available_at<=UTC_TIMESTAMP()')));
  assert(!calls.some(item => item.sql.includes('UPDATE mail_writebacks SET available_at=')),
    'uncertain MOVE must not loop indefinitely');
});

test('direct writeback intake is bounded; a slow read yields while mutation work blocks its own account', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../src/services/mail');
  const imaps = require('imap-simple');
  const runtime = require('../src/services/mail-engine/runtime');
  let writing = true, readRunning = true;
  const connects = [], rejects = [], yields = [], claims = [], unexpected = [];
  t.mock.method(mail, 'isMailAccountSyncRunning', id => readRunning && id === 'syncing');
  t.mock.method(mail, 'isMailAccountWriteRunning', id => writing && id === 'six');
  t.mock.method(mail, 'yieldMailReadWork', async id => {
    yields.push(id);
    if (id === 'syncing' && readRunning) { readRunning = false; return true; }
    return false;
  });
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  const claimable = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'syncing']);
  t.mock.method(runtime, 'claimDueJob', async ({ accountId }) => {
    claims.push(accountId);
    if (!claimable.delete(accountId)) return null;
    return { id: `job-${accountId}`, user_id: 'owner', mail_account_id: accountId,
      operation_id: `op-${accountId}`, worker_generation: 1 };
  });
  t.mock.method(runtime, 'completeJob', async () => {});
  t.mock.method(runtime, 'updateJob', async () => ({ cancellationRequested: false }));
  t.mock.method(imaps, 'connect', async () => {
    connects.push(1);
    return new Promise((_resolve, reject) => rejects.push(reject));
  });
  setDb({ execute: async (sql, params) => {
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: params[0], user_id: 'owner', sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('UPDATE mail_writebacks')) return [{ affectedRows: 0 }];
    unexpected.push(sql); assert.fail(sql);
  } });
  const jobs = [startWritebacks('syncing')];
  for (const id of ['one', 'two', 'three', 'four', 'five', 'six']) jobs.push(startWritebacks(id));
  await tick();
  assert.equal(connects.length, 4, 'direct actions obey global connection cap');
  assert.equal(startWritebacks('five'), jobs[5], 'one queued job per account');
  assert(yields.includes('syncing'), 'writeback intake actually calls read-only yield on a slow same-account scan');
  assert.equal(readRunning, false, 'read transport has yielded before the writeback connects');
  rejects.shift()(new Error('synthetic connection failure'));
  await tick(); await tick();
  assert.equal(connects.length, 5, 'free slot goes to unrelated account despite blocked writer');
  for (let i = 0; i < 50 && connects.length < 6; i++) {
    while (rejects.length) rejects.shift()(new Error('synthetic connection failure'));
    await tick();
  }
  while (rejects.length) { rejects.shift()(new Error('synthetic connection failure')); await tick(); }
  assert.equal(connects.length, 6, JSON.stringify({ claims, claimable: [...claimable], yields, unexpected }));
  assert.equal(claimable.has('six'), true, 'write-running account retains its unclaimed job');
  writing = false;
  drainWritebacks();
  for (let i = 0; i < 20 && !rejects.length; i++) await tick();
  assert.equal(rejects.length, 1);
  rejects.shift()(new Error('synthetic connection failure'));
  await Promise.all(jobs);
  assert.equal(connects.length, 7);
  assert.equal(claims.filter(id => id === 'six').length, 1, 'account-scoped claim never steals another account job');
  assert.equal(claimable.size, 0);
});

test('active writeback heartbeat sees cancellation before connecting, retains the accepted operation', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../src/services/mail');
  const imaps = require('imap-simple');
  const runtime = require('../src/services/mail-engine/runtime');
  let connects = 0, heartbeats = 0, completion;
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(runtime, 'claimDueJob', async () => ({ id: 'cancel-job', user_id: 'owner',
    mail_account_id: 'cancel-account', worker_generation: 1, operation_id: 'accepted-op' }));
  t.mock.method(runtime, 'updateJob', async () => { heartbeats++; return { cancellationRequested: true }; });
  t.mock.method(runtime, 'completeJob', async value => { completion = value; });
  t.mock.method(imaps, 'connect', async () => { connects++; assert.fail('cancelled worker connected'); });
  setDb({ execute: async () => assert.fail('cancelled worker queried account or discarded operation') });
  await startWritebacks('cancel-account');
  assert.equal(heartbeats, 1); assert.equal(connects, 0);
  assert.equal(completion.state, 'cancelled');
});

test('lease lost after connect destroys transport before any provider operation', async t => {
  const { EventEmitter } = require('node:events');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../src/services/mail');
  const imaps = require('imap-simple');
  const runtime = require('../src/services/mail-engine/runtime');
  const engine = require('../src/services/mail-engine/operations');
  let pulses = 0, destroys = 0, completion;
  const connection = new EventEmitter();
  connection.imap = { _sock: { destroy: () => { destroys++; } }, destroy: () => {} };
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imaps, 'connect', async () => connection);
  t.mock.method(runtime, 'claimDueJob', async () => ({ id: 'lost-job', user_id: 'owner',
    mail_account_id: 'lost-account', worker_generation: 1, operation_id: 'accepted-op' }));
  t.mock.method(runtime, 'updateJob', async () => {
    pulses++; if (pulses === 2) throw Object.assign(new Error('lease lost'), { code: 'MAIL_WORKER_FENCED' });
    return { cancellationRequested: false };
  });
  t.mock.method(runtime, 'completeJob', async value => { completion = value; });
  t.mock.method(engine, 'processDueOperations', () => assert.fail('provider commands after lease loss'));
  setDb({ execute: async sql => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: 'lost-account', user_id: 'owner',
      sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
    throw new Error(`Unexpected ${sql}`);
  } });
  await startWritebacks('lost-account');
  assert.equal(pulses, 2); assert.equal(destroys, 1);
  assert.equal(completion.state, 'cancelled');
});

test('account stop synchronously aborts an active direct writeback and destroys its guarded socket', async t => {
  const { EventEmitter } = require('node:events');
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../src/services/mail');
  const imaps = require('imap-simple');
  const runtime = require('../src/services/mail-engine/runtime');
  const engine = require('../src/services/mail-engine/operations');
  const connection = new EventEmitter();
  let socketDestroyed = 0, entered = false, completion, remoteCommands = 0;
  connection.imap = { _sock: { destroy() { socketDestroyed++; } }, destroy() {} };
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imaps, 'connect', async () => connection);
  t.mock.method(runtime, 'claimDueJob', async ({ accountId }) => accountId === 'stop-account'
    ? { id: 'stop-job', user_id: 'owner', mail_account_id: accountId, operation_id: 'accepted-op', worker_generation: 1 } : null);
  t.mock.method(runtime, 'updateJob', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'completeJob', async value => { completion = value; });
  t.mock.method(engine, 'processDueOperations', (_account, _connection, { signal }) => {
    entered = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  setDb({ execute: async sql => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: 'stop-account', user_id: 'owner', sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    remoteCommands++; assert.fail(`Unexpected provider/mutation SQL after stop: ${sql}`);
  } });
  const worker = startWritebacks('stop-account');
  for (let i = 0; i < 30 && !entered; i++) await tick();
  assert.equal(entered, true);
  assert.equal(stopWritebacks('stop-account'), true);
  assert.equal(socketDestroyed, 1, 'abort immediately hard-closes the active IMAP socket');
  await worker;
  assert.equal(completion.state, 'cancelled');
  assert.equal(remoteCommands, 0);
});
