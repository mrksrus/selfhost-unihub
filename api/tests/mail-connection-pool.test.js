const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns').promises;
const imapClient = require('../src/services/mail-imap-client');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'mail-connection-pool-test-only-key';
const pool = require('../src/services/mail-engine/connection-pool');
const { runGuardedImap } = require('../src/services/mail-imap-guard');
const mail = require('../src/services/mail');
const runtime = require('../src/services/mail-engine/runtime');
const operations = require('../src/services/mail-engine/operations');
const { encrypt } = require('../src/security/encryption');
const { getDb, setDb } = require('../src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Stands in for an authenticated ImapFlow client. Like the library, a NOOP
// that hits a dropped session closes the client and still resolves.
function fakeImap() {
  const connection = new EventEmitter();
  connection.stats = { destroyed: 0, noops: 0 };
  Object.assign(connection, { usable: true, isClosed: false, idling: false, socket: { ref() {}, unref() {} } });
  connection.close = () => {
    if (connection.isClosed) return;
    connection.stats.destroyed++;
    Object.assign(connection, { usable: false, isClosed: true });
    connection.emit('close');
  };
  connection.noop = () => new Promise(resolve => setImmediate(() => {
    connection.stats.noops++;
    if (connection.noopError) connection.close();
    resolve();
  }));
  connection.search = async () => [];
  return connection;
}
function harness(t) {
  const made = [];
  const connect = async () => { const c = fakeImap(); made.push(c); return c; };
  t.after(() => pool.evictImapConnections());
  return { made, connect };
}
const account = (id, extra = {}) => ({ id, user_id: 'owner', imap_host: 'imap.example.test', imap_port: 993,
  email_address: 'a@example.test', encrypted_password: 'cipher-1', ...extra });

test('sequential successful jobs of one account reuse one authenticated session', async t => {
  const { made, connect } = harness(t), a = account('pool-reuse');
  for (let job = 0; job < 5; job++) {
    const controller = new AbortController();
    const connection = await pool.acquireImapConnection(a, {}, { signal: controller.signal, connect });
    await connection.search(['ALL'], {});
    assert.equal(pool.releaseImapConnection(connection, { reusable: true }), true);
  }
  assert.equal(made.length, 1, 'one LOGIN for five jobs');
  assert.equal(made[0].stats.noops, 4, 'each reuse is health-checked first');
  assert.equal(made[0].stats.destroyed, 0);
});

test('a reused session is rebound: the previous job signal no longer reaches it, the current one does', async t => {
  const { made, connect } = harness(t), a = account('pool-rebind');
  const first = new AbortController(), second = new AbortController();
  const c1 = await pool.acquireImapConnection(a, {}, { signal: first.signal, connect });
  pool.releaseImapConnection(c1, { reusable: true });
  const c2 = await pool.acquireImapConnection(a, {}, { signal: second.signal, connect });
  assert.equal(c1, c2);
  first.abort();
  assert.equal(made[0].stats.destroyed, 0, 'stale job listener was detached on reuse');
  await c2.search(['ALL'], {});
  second.abort();
  assert.equal(made[0].stats.destroyed, 1);
  await assert.rejects(runGuardedImap(c2, () => c2.search()), { code: 'MAIL_SYNC_CANCELLED' });
  assert.equal(pool.releaseImapConnection(c2, { reusable: true }), false, 'aborted transport is never parked');
  const c3 = await pool.acquireImapConnection(a, {}, { connect });
  assert.notEqual(c3, c2); assert.equal(made.length, 2);
});

test('errored, aborted-while-parked, dead and fenced-completion sessions are not reused', async t => {
  const { made, connect } = harness(t), a = account('pool-noreuse');
  // Error/cancel/fence: the job reports not reusable.
  let c = await pool.acquireImapConnection(a, {}, { connect });
  pool.releaseImapConnection(c, { reusable: false });
  assert.equal(made[0].stats.destroyed, 1);
  // A late abort of the finished job destroys its parked session in place.
  const late = new AbortController();
  c = await pool.acquireImapConnection(a, {}, { signal: late.signal, connect });
  pool.releaseImapConnection(c, { reusable: true });
  late.abort();
  assert.equal(made[1].stats.destroyed, 1);
  c = await pool.acquireImapConnection(a, {}, { connect });
  assert.equal(made.length, 3, 'stopped session was discarded, not handed out');
  // Provider silently dropped the idle session: NOOP fails, a fresh session is used.
  pool.releaseImapConnection(c, { reusable: true });
  made[2].noopError = new Error('BYE');
  c = await pool.acquireImapConnection(a, {}, { connect });
  assert.equal(made.length, 4); assert.equal(c, made[3]); assert.equal(made[2].stats.destroyed, 1);
  // Socket closed while parked.
  pool.releaseImapConnection(c, { reusable: true });
  made[3].emit('close');
  c = await pool.acquireImapConnection(a, {}, { connect });
  assert.equal(made.length, 5);
  // Account stop/disconnect/module disable evicts.
  pool.releaseImapConnection(c, { reusable: true });
  pool.evictImapConnections(a.id);
  assert.equal(made[4].stats.destroyed, 1); assert.equal(pool.parkedCount(), 0);
});

test('a credential, host or TLS trust change never reuses an old session', async t => {
  const { made, connect } = harness(t);
  for (const change of [{ encrypted_password: 'cipher-2' }, { imap_host: 'other.example.test' }, { allow_self_signed: 1 }, { username: 'alias' }]) {
    pool.evictImapConnections();
    const before = made.length;
    const c = await pool.acquireImapConnection(account('pool-print'), {}, { connect });
    pool.releaseImapConnection(c, { reusable: true });
    const changed = await pool.acquireImapConnection(account('pool-print', change), {}, { connect });
    assert.equal(made.length, before + 2, JSON.stringify(change));
    assert.equal(made[before].stats.destroyed, 1);
    pool.releaseImapConnection(changed, { reusable: false });
  }
});

test('idle parked sessions are closed after the TTL', async t => {
  const { made, connect } = harness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await pool.acquireImapConnection(account('pool-idle'), {}, { connect });
  pool.releaseImapConnection(c, { reusable: true });
  t.mock.timers.tick(pool.IDLE_MS - 1);
  assert.equal(made[0].stats.destroyed, 0); assert.equal(pool.parkedCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(made[0].stats.destroyed, 1); assert.equal(pool.parkedCount(), 0);
});

function durableFixture(t, { due = new Set(), siblings = [], throttled = false } = {}) {
  const old = getDb(); t.after(() => { setDb(old); pool.evictImapConnections(); });
  const row = { id: 'pool-durable', user_id: 'owner', sync_mode: 'sync', is_active: 1, email_address: 'mail@example.test',
    imap_host: 'imap.example.test', encrypted_password: encrypt('synthetic-test-password') };
  const made = [], processed = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(imapClient, 'connectImap', async () => { const c = fakeImap(); made.push(c); return c; });
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  setDb({ execute: async (sql, params) => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[row]];
    if (sql.includes('FROM user_settings') || sql.includes('FROM backup_restore_jobs')) return [[]];
    if (sql.includes('FROM mail_writebacks WHERE id=?')) return [due.has(params[0]) ? [{ id: params[0] }] : []];
    if (sql.includes('FROM mail_writebacks WHERE mail_account_id=?')) return [siblings.filter(id => due.has(id)).map(id => ({ id }))];
    if (sql.includes('FROM mail_engine_cursors')) return [throttled ? [{ mailbox_id: params[0] }] : []];
    assert.fail(`Unexpected SQL: ${sql}`);
  } });
  const job = (id, extra = {}) => ({ id: `job-${id}`, user_id: 'owner', mail_account_id: row.id, lease_owner: 'worker',
    worker_generation: 1, kind: 'operation', operation_id: id, ...extra });
  return { made, processed, job, due };
}

test('a bulk change drains due operations of one account on one connection', async t => {
  const ids = Array.from({ length: 120 }, (_, i) => `op-${String(i).padStart(3, '0')}`);
  const f = durableFixture(t, { due: new Set(ids), siblings: ids });
  const connections = new Set();
  t.mock.method(operations, 'processDueOperations', async (_account, connection, options) => {
    connections.add(connection); f.processed.push(options.operationId); f.due.delete(options.operationId);
    return { needsSync: false, connectionFailed: false };
  });
  // Every accepted change has its own durable job; most find their work already done.
  for (const id of ids) {
    const result = await mail.runDurableMailJob(f.job(id), new AbortController().signal, async () => {});
    assert.equal(result.success, true);
  }
  assert.deepEqual([...f.processed].sort(), ids, 'each operation executed exactly once, individually');
  assert.equal(f.made.length, 1, 'one LOGIN for 120 queued operations');
  assert.equal(connections.size, 1);
});

test('a failed operation batch closes its transport; the next job logs in again', async t => {
  const f = durableFixture(t, { due: new Set(['op-a', 'op-b']), siblings: ['op-a', 'op-b'] });
  let fail = true;
  t.mock.method(operations, 'processDueOperations', async (_account, _connection, options) => {
    f.processed.push(options.operationId);
    return { needsSync: false, connectionFailed: fail };
  });
  assert.equal((await mail.runDurableMailJob(f.job('op-a'), new AbortController().signal, async () => {})).success, false);
  assert.deepEqual(f.processed, ['op-a'], 'batch stops at the first transport failure');
  assert.equal(f.made[0].stats.destroyed, 1);
  fail = false;
  await mail.runDurableMailJob(f.job('op-b'), new AbortController().signal, async () => {});
  assert.equal(f.made.length, 2);
});

test('a throttled background sweep and an already settled operation finish without connecting', async t => {
  const f = durableFixture(t, { throttled: true });
  t.mock.method(operations, 'processDueOperations', async () => assert.fail('nothing due'));
  const signal = new AbortController().signal;
  assert.equal((await mail.runDurableMailJob(f.job('settled'), signal, async () => {})).skipped, true);
  for (const kind of ['flags', 'presence']) {
    const result = await mail.runDurableMailJob(f.job(null, { kind, mailbox_id: 'box-1' }), signal, async () => {});
    assert.deepEqual(result, { success: true, more: false, skipped: true });
  }
  assert.equal(f.made.length, 0);
});

test('periodic cadence follows INBOX only and fans out folder discovery at most every few minutes', async t => {
  const old = getDb(); t.after(() => setDb(old));
  let recentDiscovery = 1, background = true;
  const enqueued = [], queries = [];
  const executor = { execute: async (sql, params) => {
    queries.push(sql);
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { enabled: true, background } }) }]];
    if (sql.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes("kind = 'sync'")) { assert.equal(params[2], mail.MAIL_DISCOVERY_INTERVAL_SECONDS); return [[{ n: recentDiscovery }]]; }
    if (sql.includes("f.slug='inbox'")) return [[{ id: 'inbox-box' }]];
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
  const scheduler = { start: async () => {}, enqueue: async input => { enqueued.push(input); return { id: 'j' }; } };
  setDb(executor);
  // Background off: the INBOX follow-up is background work and is not admitted.
  background = false;
  assert.equal((await mail.schedulePeriodicMailWork('A', { executor, scheduler })).skipped, true);
  assert.equal(enqueued.length, 0);
  background = true;
  for (let tickNo = 0; tickNo < 10; tickNo++) await mail.schedulePeriodicMailWork('A', { executor, scheduler });
  assert.equal(enqueued.length, 10);
  assert.ok(enqueued.every(job => job.kind === 'recent' && job.mailboxId === 'inbox-box'), 'no per-folder fan-out on a 30s tick');
  assert.ok(mail.MAIL_DISCOVERY_INTERVAL_SECONDS >= 300);
  // Discovery due (none recent, or last one failed): the full background sync.
  recentDiscovery = 0;
  setDb(executor);
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => null);
  t.mock.method(runtime, 'getJobStatus', async () => null);
  const durable = [];
  t.mock.method(runtime, 'enqueueJob', async input => { durable.push(input); return { id: 'sync-job' }; });
  await mail.schedulePeriodicMailWork('A', { executor, scheduler });
  assert.deepEqual(durable.map(job => [job.kind, job.manualRefresh]), [['sync', false]]);
  assert.equal(enqueued.length, 10);
});
