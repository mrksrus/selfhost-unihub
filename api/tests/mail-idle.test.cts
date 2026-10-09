'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
// IMAP IDLE supervisor: eligibility, coalescing, durable-job admission, the
// read-only command surface, reconnect/backoff, auth give-up, the global cap,
// stop paths and the relaxed periodic INBOX cadence. A fake ImapFlow-like
// client stands in for the network; mail-idle-protocol.test.cts uses a socket.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
process.env.ENCRYPTION_KEY = 'mail-idle-test-only-key';
const { createIdleSupervisor, defaultListEligible, kindsFor, idleSupervisor } = require('../dist/src/services/mail-idle');
const control = require('../dist/src/services/mail-sync-control');
const runtime = require('../dist/src/services/mail-engine/runtime');
const { imapFlowOptions } = require('../dist/src/services/mail-imap-client');
const { installShutdownHandler } = require('../dist/src/services/server-events');
const { getDb, setDb } = require('../dist/src/state');

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: FixtureValue, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await wait(2);
  }
}

// Methods the supervisor may call. Anything else (fetch, store, move, delete,
// expunge, append, create, raw exec, ...) fails the test.
const ALLOWED = new Set<FixtureValue>(['on', 'once', 'emit', 'off', 'removeListener', 'addListener', 'listeners', 'listenerCount',
  'mailboxOpen', 'idle', 'close', 'setMaxListeners', 'prependListener', 'rawListeners', 'eventNames']);
function fakeClient({ caps = ['IMAP4rev1', 'IDLE'] }: FixtureValue = {}) {
  const target = new EventEmitter();
  const used = new Set<FixtureValue>(), opens: FixtureValue[] = [];
  Object.assign(target, {
    capabilities: new Map(caps.map((cap: FixtureValue) => [cap, true])), usable: true, isClosed: false, idles: 0,
    async mailboxOpen(path: FixtureValue, options: FixtureValue) { opens.push([path, options]); return { path, exists: 3 }; },
    idle() { this.idles++; return new Promise(resolve => { (this as FixtureValue).endIdle = resolve; }); },
    close() {
      if (this.isClosed) return;
      this.isClosed = true; this.usable = false;
      (this as FixtureValue).endIdle?.(); (this as FixtureValue).emit('close');
    },
    // Present only so that a call would be recorded and rejected.
    messageFlagsAdd() {}, messageMove() {}, messageDelete() {}, exec() {}, noop() {}, fetch() {}, append() {}, mailboxCreate() {},
  });
  const proxy = new Proxy(target, { get(obj, prop, receiver) {
    const value = Reflect.get(obj, prop, receiver);
    if (typeof value === 'function' && typeof prop === 'string') used.add(prop);
    return typeof value === 'function' ? value.bind(receiver) : value;
  } });
  return { client: proxy, used, opens, raw: target };
}
const row = (accountId: string, extra: FixtureValue = {}) => ({ accountId, userId: `user-${accountId}`, syncMode: 'sync', mailboxId: `inbox-${accountId}`,
  remoteName: 'INBOX', fingerprint: `fp-${accountId}`, ...extra });
function harness(t: import('node:test').TestContext, { rows = [row('A')], connect, ...options }: FixtureValue = {}) {
  const enqueued: FixtureValue[] = [], clients: FixtureValue[] = [], connects: FixtureValue[] = [];
  let eligible = rows;
  const supervisor = createIdleSupervisor({ debounceMs: 15, pollMs: 60 * 60 * 1000, backoffBaseMs: 5, backoffMaxMs: 40,
    random: () => 1, log: () => {}, listEligible: async () => eligible,
    connect: connect || (async (entry: FixtureValue) => { connects.push(entry.accountId); const fake = fakeClient(); clients.push(fake); return fake.client; }),
    enqueue: async (input: FixtureValue) => { enqueued.push(input); }, ...options });
  t.after(() => supervisor.stop());
  return { supervisor, enqueued, clients, connects, setRows: (next: FixtureValue) => { eligible = next; } };
}

test('eligibility: active, connected, unpaused accounts with a mapped INBOX, mail background on, no restore', async t => {
  const old = getDb(); t.after(() => setDb(old));
  let sql = '';
  setDb({ execute: async (query: string) => {
    if (query.includes('FROM mail_accounts a')) {
      sql = query;
      return [[
        { id: 'A', user_id: 'u1', sync_mode: 'sync', imap_host: 'imap.example.test', mailbox_id: 'm1', remote_name: 'INBOX' },
        { id: 'B', user_id: 'u2', sync_mode: 'download', imap_host: 'imap.example.test', mailbox_id: 'm2', remote_name: 'INBOX' },
        { id: 'C', user_id: 'u3', sync_mode: 'sync', imap_host: 'imap.example.test', mailbox_id: 'm3', remote_name: 'INBOX' },
        { id: 'D', user_id: 'u4', sync_mode: 'sync', imap_host: 'imap.example.test', mailbox_id: 'm4', remote_name: 'INBOX' },
      ]];
    }
    if (query.includes('FROM user_settings')) return [[
      { user_id: 'u3', setting_value: JSON.stringify({ mail: { background: false } }) },
    ]];
    if (query.includes('FROM backup_restore_jobs')) return [[{ user_id: 'u4', requested_sections: JSON.stringify(['mail']) }]];
    assert.fail(`Unexpected SQL: ${query}`);
  } });
  const rows = await defaultListEligible();
  assert.deepEqual(rows.map((r: FixtureValue) => [r.accountId, r.syncMode, r.mailboxId]), [['A', 'sync', 'm1'], ['B', 'download', 'm2']],
    'background off (u3) and a running mail restore (u4) are not eligible; both modes import new mail');
  for (const clause of ['a.is_active = TRUE', 'a.disconnected_at IS NULL', 'e.paused_reason IS NULL',
    "a.sync_mode IN ('sync','download')", "f.slug = 'inbox'", "m.state = 'active'"]) assert.ok(sql.includes(clause), clause);
  assert.match(rows[0].fingerprint, /^[0-9a-f]{64}$/);
});

test('event kinds: EXISTS imports in both modes; FLAGS/EXPUNGE only refresh Sync accounts', () => {
  assert.deepEqual(kindsFor('exists', 'download'), ['recent']);
  assert.deepEqual(kindsFor('exists', 'sync'), ['recent']);
  assert.deepEqual(kindsFor('flags', 'sync'), ['flags']);
  assert.deepEqual(kindsFor('expunge', 'sync'), ['presence']);
  assert.deepEqual(kindsFor('flags', 'download'), []);
  assert.deepEqual(kindsFor('expunge', 'download'), []);
});

test('EXISTS during IDLE is coalesced into one recent refresh; the session is read-only', async t => {
  const { supervisor, enqueued, clients } = harness(t);
  await supervisor.start();
  await until(() => enqueued.length === 1);
  assert.deepEqual(enqueued[0], { accountId: 'A', userId: 'user-A', mailboxId: 'inbox-A', kinds: ['recent'] },
    'one catch-up refresh once listening: mail that arrived before IDLE raises no event');
  assert.equal(supervisor.isHealthy('A'), true);
  const [{ client, used, opens }] = clients;
  assert.deepEqual(opens, [['INBOX', { readOnly: true }]], 'EXAMINE, never SELECT');
  client.emit('exists', { path: 'INBOX', count: 4, prevCount: 3 });
  client.emit('exists', { path: 'INBOX', count: 5, prevCount: 4 });
  client.emit('flags', { path: 'INBOX', seq: 1, flags: new Set<FixtureValue>(['\\Seen']) });
  client.emit('exists', { path: 'INBOX', count: 6, prevCount: 5 });
  await until(() => enqueued.length === 2);
  await wait(40);
  assert.equal(enqueued.length, 2, 'a burst is one refresh');
  assert.deepEqual(enqueued[1].kinds.sort(), ['flags', 'recent']);
  client.emit('expunge', { path: 'INBOX', seq: 2 });
  await until(() => enqueued.length === 3);
  assert.deepEqual(enqueued[2].kinds, ['presence']);
  supervisor.stop();
  const unexpected = [...used].filter(name => !ALLOWED.has(name) && name !== 'endIdle'); // endIdle: the fake's own hook
  assert.deepEqual(unexpected, [], `never a mutating or fetching command: ${unexpected.join(', ')}`);
  assert.ok(used.has('idle') && used.has('close'));
});

test('a Download account ignores FLAGS/EXPUNGE but still imports new mail', async t => {
  const { supervisor, enqueued, clients } = harness(t, { rows: [row('A', { syncMode: 'download' })] });
  await supervisor.start();
  await until(() => enqueued.length === 1);
  clients[0].client.emit('flags', { path: 'INBOX', seq: 1, flags: new Set<FixtureValue>() });
  clients[0].client.emit('expunge', { path: 'INBOX', seq: 1 });
  await wait(40);
  assert.equal(enqueued.length, 1);
  clients[0].client.emit('exists', { path: 'INBOX', count: 9 });
  await until(() => enqueued.length === 2);
  assert.deepEqual(enqueued[1].kinds, ['recent']);
});

test('a lost session reconnects with exponential backoff and jitter, capped', async t => {
  const delays: FixtureValue[] = [];
  const timers = { setTimeout: (fn: FixtureValue, ms: number) => { delays.push(ms); return setTimeout(fn, 1); }, clearTimeout, setInterval, clearInterval };
  let attempts = 0;
  const { supervisor } = harness(t, ({ timers, debounceMs: 999, random: () => 0.5,
    connect: async () => { attempts++; throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); } } as FixtureValue));
  await supervisor.start();
  await until(() => attempts >= 6);
  supervisor.stop();
  // base 5 ms doubling, capped at 40 ms; jitter factor 0.5 + random*0.5 = 0.75.
  assert.deepEqual(delays.filter(ms => ms !== 999).slice(0, 5), [4, 8, 15, 30, 30]);
  const settled = attempts;
  await wait(20);
  assert.equal(attempts, settled, 'stop() cancels the pending retry');
});

test('a closed IDLE connection is reopened and listens again', async t => {
  const { supervisor, clients, enqueued } = harness(t);
  await supervisor.start();
  await until(() => clients.length === 1 && supervisor.isHealthy('A') && enqueued.length === 1);
  clients[0].client.close();
  assert.equal(supervisor.isHealthy('A'), false, 'polling cadence comes back while IDLE is down');
  await until(() => clients.length === 2 && supervisor.isHealthy('A'));
  await until(() => enqueued.length >= 2);
  assert.ok(enqueued.every(job => job.kinds.includes('recent')), 'a reconnect catches up on INBOX');
});

test('a rejected login stops IDLE for the account until its settings change', async t => {
  let attempts = 0;
  const { supervisor, setRows } = harness(t, ({ connect: async () => {
    attempts++;
    throw Object.assign(new Error('Authentication failed'), { authenticationFailed: true });
  } } as FixtureValue));
  await supervisor.start();
  await until(() => attempts === 1 && supervisor.size() === 0);
  await wait(30);
  await supervisor.refresh();
  await wait(20);
  assert.equal(attempts, 1, 'no retry, no lockout risk at the provider');
  assert.equal(supervisor.blocked().get('A').reason, 'auth');
  setRows([row('A', { fingerprint: 'fp-A-new-password' })]);
  await supervisor.refresh();
  await until(() => attempts === 2);
});

test('a server without IDLE is skipped; polling remains', async t => {
  const fake: FixtureValue = fakeClient({ caps: ['IMAP4rev1'] });
  const { supervisor, enqueued } = harness(t, ({ connect: async () => fake.client } as FixtureValue));
  await supervisor.start();
  await until(() => fake.raw.isClosed);
  assert.equal(supervisor.isHealthy('A'), false);
  assert.equal(supervisor.blocked().get('A').reason, 'unsupported');
  assert.equal(enqueued.length, 0);
  assert.equal(fake.opens.length, 0);
});

test('global cap: at most maxSessions IDLE sessions, one per account', async t => {
  const { supervisor, connects } = harness(t, ({ maxSessions: 2, rows: [row('A'), row('A'), row('B'), row('C')] } as FixtureValue));
  await supervisor.start();
  await until(() => connects.length === 2);
  await supervisor.refresh();
  await wait(20);
  assert.deepEqual(connects, ['A', 'B']);
  assert.equal(supervisor.size(), 2);
  const off = createIdleSupervisor({ maxSessions: 0, listEligible: async () => assert.fail('disabled') });
  await off.start();
  assert.equal(off.size(), 0);
});

test('ineligible accounts lose their session at the next eligibility pass', async t => {
  const { supervisor, clients, setRows } = harness(t, { rows: [row('A'), row('B')] });
  await supervisor.start();
  await until(() => clients.length === 2 && supervisor.isHealthy('B'));
  setRows([row('A')]); // B paused, disconnected, background off or restoring
  await supervisor.refresh();
  assert.equal(supervisor.isHealthy('B'), false);
  assert.equal(clients[1].raw.isClosed, true);
  assert.equal(supervisor.isHealthy('A'), true);
  setRows([row('A', { fingerprint: 'fp-A-host-changed' })]);
  await supervisor.refresh();
  assert.equal(clients[0].raw.isClosed, true, 'a settings change reconnects with the new settings');
  await until(() => clients.length === 3 && supervisor.isHealthy('A'));
});

test('stopAccount closes the session at once and wins over an in-flight eligibility pass', async t => {
  let release: FixtureValue;
  const { supervisor, clients, setRows } = harness(t);
  await supervisor.start();
  await until(() => supervisor.isHealthy('A'));
  assert.equal(supervisor.stopAccount('A'), true);
  assert.equal(clients[0].raw.isClosed, true);
  assert.equal(supervisor.isHealthy('A'), false);
  // A pass that read the database before the stop must not reopen it.
  const gate = new Promise(resolve => { release = resolve; });
  const slow = createIdleSupervisor({ debounceMs: 15, log: () => {}, listEligible: async () => { await gate; return [row('A')]; },
    connect: async () => assert.fail('must not connect'), enqueue: async () => {} });
  t.after(() => slow.stop());
  const pass = slow.start();
  await wait(5);
  slow.stopAccount('A');
  release();
  await pass;
  assert.equal(slow.size(), 0);
  setRows([]);
});

test('stopMailAccountWork stops the account IDLE session', async t => {
  const old = getDb(); t.after(() => setDb(old));
  setDb({ execute: async (query: string) => {
    if (query.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    assert.fail(`Unexpected SQL: ${query}`);
  } });
  t.mock.method(runtime, 'pauseAccount', async () => ({}));
  const stopped: FixtureValue[] = [];
  t.mock.method(idleSupervisor, 'stopAccount', (key: FixtureValue) => { stopped.push(key); return true; });
  assert.equal(await control.stopMailAccountWork('acct-1', 'Account disconnected'), true);
  assert.deepEqual(stopped, ['acct-1']);
});

test('background sync off in module settings stops IDLE sessions', async t => {
  const old = getDb(); t.after(() => setDb(old));
  setDb({ execute: async (query: string, params: FixtureValue) => {
    if (query.startsWith('INSERT INTO user_settings')) return [{}];
    if (query.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { background: false } }) }]];
    if (query.includes('SELECT id, is_active, disconnected_at FROM mail_accounts')) return [[{ id: 'acct-1', is_active: 1, disconnected_at: null }]];
    if (query.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: params[0] === 'acct-1' ? 'owner' : null }]];
    if (query.includes('FROM mail_engine_jobs')) return [[]];
    assert.fail(`Unexpected SQL: ${query}`);
  } });
  t.mock.method(runtime, 'resumeAccount', async () => ({ resumed: 0 }));
  const stopped: FixtureValue[] = [];
  t.mock.method(idleSupervisor, 'stopAccount', (key: FixtureValue) => { stopped.push(key); return true; });
  const routes = require('../dist/src/routes/modules');
  const result = await routes['PUT /api/modules']({}, 'owner', { modules: { mail: { background: false } } });
  assert.ok(result.modules);
  assert.deepEqual(stopped, ['acct-1']);
});

function admissionDb({ background = true, account = { user_id: 'owner', sync_mode: 'sync' } }: FixtureValue = {}) {
  return { execute: async (query: string) => {
    if (query.includes('LEFT JOIN mail_engine_accounts')) return [account ? [account] : []];
    if (query.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { background } }) }]];
    if (query.includes('FROM backup_restore_jobs')) return [[]];
    assert.fail(`Unexpected SQL: ${query}`);
  } };
}
test('IDLE refresh is ordinary background admission: durable jobs, no manual resweep', async t => {
  const old = getDb(); t.after(() => setDb(old));
  const jobs: FixtureValue[] = [];
  const scheduler = { start: async () => {}, enqueue: async (input: FixtureValue) => { jobs.push(input); return { id: 'j' }; } };
  setDb(admissionDb());
  const input = { accountId: 'A', userId: 'owner', mailboxId: 'inbox-A', kinds: ['recent', 'flags', 'presence', 'history'] };
  const result = await control.enqueueIdleRefresh(input, { executor: getDb(), scheduler });
  assert.deepEqual(result.enqueued, ['recent', 'flags', 'presence'], 'never history or a full sync');
  assert.deepEqual(jobs.map(job => [job.kind, job.mailboxId, job.manualRefresh]), [['recent', 'inbox-A', undefined],
    ['flags', 'inbox-A', undefined], ['presence', 'inbox-A', undefined]]);
  jobs.length = 0;
  setDb(admissionDb({ account: { user_id: 'owner', sync_mode: 'download' } }));
  await control.enqueueIdleRefresh(input, { executor: getDb(), scheduler });
  assert.deepEqual(jobs.map(job => job.kind), ['recent'], 'Download mode never mirrors remote flags');
  jobs.length = 0;
  setDb(admissionDb({ background: false }));
  await control.enqueueIdleRefresh(input, { executor: getDb(), scheduler });
  setDb(admissionDb({ account: null })); // paused, disconnected or inactive
  await control.enqueueIdleRefresh(input, { executor: getDb(), scheduler });
  assert.deepEqual(jobs, []);
});

test('periodic INBOX follow-up relaxes to a 5-minute safety net while IDLE is healthy', async t => {
  const old = getDb(); t.after(() => setDb(old));
  const executor = { execute: async (query: string) => {
    if (query.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (query.includes('FROM user_settings')) return [[]];
    if (query.includes('COUNT(*) AS n')) return [[{ n: 1 }]];
    if (query.includes('FROM mail_remote_mailboxes m')) return [[{ id: 'inbox-box' }]];
    assert.fail(`Unexpected SQL: ${query}`);
  } };
  setDb(executor);
  const enqueued: FixtureValue[] = [];
  const scheduler = { start: async () => {}, enqueue: async (input: FixtureValue) => { enqueued.push(input); return { id: 'j' }; } };
  let clock = 1_000_000, healthy = true;
  const tick = () => control.schedulePeriodicMailWork('idle-acct', { executor, scheduler, idleHealthy: () => healthy, now: () => clock });
  await tick();
  assert.equal(enqueued.length, 1, 'first tick still runs');
  for (let i = 0; i < 9; i++) { clock += 30_000; assert.equal((await tick()).idle, true); }
  assert.equal(enqueued.length, 1, 'no 30 s polling while IDLE is up');
  clock += 30_000;
  await tick();
  assert.equal(enqueued.length, 2, 'safety net after 5 minutes');
  healthy = false;
  for (let i = 0; i < 3; i++) { clock += 30_000; await tick(); }
  assert.equal(enqueued.length, 5, '30 s cadence restored while IDLE is down');
  assert.ok(enqueued.every(job => job.kind === 'recent' && job.mailboxId === 'inbox-box'));
});

test('IDLE session options: explicit IDLE with periodic restart, still no automatic IDLE/COMPRESS', () => {
  const options = imapFlowOptions({ imap: { host: '203.0.113.7', port: 993, user: 'u', password: 'p', tls: true,
    tlsOptions: { servername: 'imap.example.test' }, keepalive: true, idleRestartMs: 10 * 60 * 1000 } });
  assert.equal(options.maxIdleTime, 10 * 60 * 1000);
  assert.ok(options.maxIdleTime < 29 * 60 * 1000, 'RFC 2177');
  assert.ok(options.socketTimeout > options.maxIdleTime);
  assert.equal(options.disableAutoIdle, true);
  assert.equal(options.logger, false);
  assert.equal(imapFlowOptions({ imap: { host: 'h', keepalive: true } }).maxIdleTime, undefined);
});

test('process shutdown runs the IDLE stop hook before re-raising the signal', () => {
  const signals = new EventEmitter();
  let stopped = 0, killed = null;
  installShutdownHandler({ bus: { closeAll() {} }, signals, onShutdown: [() => { stopped++; }, () => { throw new Error('ignored'); }],
    kill: (signal: FixtureValue) => { killed = signal; }, timers: { setTimeout: (fn: FixtureValue) => fn() } });
  signals.emit('SIGTERM');
  assert.equal(stopped, 1);
  assert.equal(killed, 'SIGTERM');
});
