const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');
const ops = require('../src/services/mail-engine/operations');
const writes = require('../src/services/mail-writebacks');
const repository = require('../src/services/mail-engine/repository');
const runtime = require('../src/services/mail-engine/runtime');
const transport = require('../src/services/mail-engine/transport');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Synthetic single-operation store with a controllable clock (seconds).
function store(t, op, { prior = [], email = null, occurrence = null } = {}) {
  const old = getDb(); t.after(() => setDb(old));
  const clock = { now: 0 }, log = [];
  const execute = async (sql, args = []) => {
    log.push({ sql, args });
    if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
    if (sql.includes('SELECT id,state FROM mail_writebacks WHERE user_id=')) return [prior];
    if (sql.includes('SELECT e.generation, a.is_active')) return [[{ generation: 1, is_active: 1, sync_mode: 'sync' }]];
    if (sql.includes('SELECT * FROM mail_writebacks WHERE id')) return [[args[0] === op.id && args[1] === op.user_id ? op : null].filter(Boolean)];
    if (sql.includes('SELECT observation_revision FROM emails')) return [[{ observation_revision: 3 }]];
    if (sql.includes('SELECT remote_folder,remote_uid,remote_uidvalidity FROM emails')) return [[email].filter(Boolean)];
    if (sql.includes('SELECT o.id FROM mail_remote_occurrences')) return [[occurrence].filter(Boolean)];
    if (sql.startsWith('UPDATE mail_writebacks SET state=?')) {
      Object.assign(op, { state: args[0], status: args[1], error: args[2] ?? op.error, available_at: clock.now + args[5],
        attempts: op.attempts + args[6], dispatched: args[4] ? 0 : op.dispatched });
      if (args[3]) op.evidence = JSON.parse(args[3]);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SELECT w.id,w.user_id,w.mail_account_id')) {
      return [['queued', 'retry_wait', 'executing', 'verifying', 'reconciling'].includes(op.state) && op.available_at <= clock.now
        ? [{ id: op.id, user_id: op.user_id, mail_account_id: op.mail_account_id, state: op.state, action: op.action }] : []];
    }
    return [{ affectedRows: 1 }];
  };
  const cx = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  setDb({ execute, getConnection: async () => cx });
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  for (const name of ['selectMailbox', 'fetchMetadataWindow', 'nativeMove', 'setFlag'])
    t.mock.method(transport, name, () => assert.fail(`${name} must not run`));
  return { clock, log };
}
const moveOp = extra => ({ id: 'newer', user_id: 'owner', mail_account_id: 'account', email_id: 'item', action: 'move',
  target_value: 'Archive', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, intent_revision: 2,
  state: 'queued', status: 'pending', is_current: 1, dispatched: 0, attempts: 0, available_at: 0, ...extra });

test('a newer MOVE behind an unresolved dispatched MOVE asks for attention instead of spinning', async t => {
  const op = moveOp();
  store(t, op, { prior: [{ id: 'older', state: 'needs_attention' }] });
  assert.deepEqual(await ops.applyMove(op, {}, 1, null, 'worker', 'job'), {});
  assert.equal(op.state, 'needs_attention'); assert.equal(op.status, 'conflict'); assert.equal(op.dispatched, 0);
  assert.deepEqual(op.evidence, { kind: 'blocked_by_unconfirmed_move', prior: 'older' });
  setDb({ execute: async () => [[op]] });
  const [view] = (await writes.listWritebacks('owner')).operations;
  assert.equal(view.can_retry, true); assert.equal(view.can_cancel, true); assert.equal(view.retry_action, 'retry');
});

test('a stuck operation is not re-dispatched every second by the due scan', async t => {
  const op = moveOp();
  const { clock, log } = store(t, op, { prior: [{ id: 'older', state: 'reconciling' }] });
  const enqueued = [];
  t.mock.method(runtime, 'enqueueJob', async job => { enqueued.push({ ...job, at: clock.now }); });
  t.mock.method(runtime, 'claimDueJob', async () => null);
  for (clock.now = 0; clock.now < 120; clock.now++) {
    const before = enqueued.length;
    await writes.runDueWritebacks(); await tick();
    // The enqueued job executes the operation, which cannot progress yet.
    if (enqueued.length > before) await ops.applyMove(op, {}, 1, null, 'worker', 'job');
  }
  assert.deepEqual(enqueued.map(job => job.at), [0, 15, 45, 105], 'exponential backoff, never a 1s loop');
  assert.equal(op.state, 'retry_wait'); assert.equal(op.dispatched, 0, 'no MOVE was sent');
  const due = log.find(entry => entry.sql.includes('SELECT w.id,w.user_id,w.mail_account_id')).sql;
  assert.match(due, /NOT EXISTS \(SELECT 1 FROM mail_engine_jobs j WHERE j\.operation_id=w\.id AND j\.user_id=w\.user_id/);
  assert.match(due, /w\.is_current=TRUE AND w\.state IN \('queued','retry_wait'\)/);
  assert.match(due, /w\.dispatched=TRUE AND w\.state IN \('executing','verifying','reconciling'\)/);
  for (let n = 0; n < 8; n++) await ops.applyMove(op, {}, 1, null, 'worker', 'job');
  assert.equal(op.state, 'needs_attention', 'bounded stalls end in an actionable state');
});

test('a flag already at the provider but not yet locally settled backs off instead of spinning', async t => {
  const op = moveOp({ action: 'read', target_value: '1', dispatched: 1, state: 'reconciling', attempts: 1 });
  const { clock } = store(t, op);
  const settle = require('../src/services/mail-engine/reconciliation');
  t.mock.method(settle, 'settleFlagObservation', async () => ({ settled: false, reason: 'stale_observation' }));
  t.mock.method(transport, 'selectMailbox', async () => ({ uidvalidity: 9, capabilities: {} }));
  t.mock.method(transport, 'fetchMetadataWindow', async () => ({ items: [{ uid: 12, flags: ['\\Seen'], modseq: null }] }));
  clock.now = 100;
  assert.deepEqual(await ops.applyFlag(op, {}, 1, null, 'worker', 'job'), { needsSync: true });
  assert.equal(op.state, 'reconciling'); assert.equal(op.attempts, 2); assert.equal(op.available_at, 130);
});

test('mailbox epoch reset parks undispatched intents in attention and checks dispatched ones', async () => {
  const calls = [];
  const mailbox = { id: 'box', user_id: 'owner', mail_account_id: 'account', remote_name: 'INBOX', uidvalidity: 9, state: 'active' };
  const cx = { execute: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM mail_accounts')) return [[{ id: 'account' }]];
    if (sql.includes('FROM mail_remote_mailboxes')) return [[mailbox]];
    return [{ affectedRows: 1 }];
  } };
  await repository.ensureMailbox({ userId: 'owner', accountId: 'account', folderName: 'INBOX', epoch: 10 }, cx);
  const updates = calls.filter(call => call.sql.startsWith('UPDATE mail_writebacks'));
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /state = 'reconciling'[\s\S]*WHERE dispatched = TRUE AND user_id = \? AND mail_account_id = \?/);
  assert.match(updates[1].sql, /state = 'needs_attention', status = 'conflict'[\s\S]*WHERE dispatched = FALSE AND user_id = \?/);
  for (const update of updates) assert.deepEqual(update.args, ['owner', 'account', 'INBOX', 'INBOX', 10]);
});

test('retry/cancel flags match what the endpoints accept for every stuck state', async t => {
  const old = getDb(); t.after(() => setDb(old));
  const cases = [
    // [row, can_retry, can_cancel, retry_action]
    [{ action: 'star', dispatched: 1, is_current: 1, state: 'needs_attention' }, true, true, 'retry'],
    [{ action: 'read', dispatched: 1, is_current: 1, state: 'reconciling' }, false, false, 'retry'],
    [{ action: 'read', dispatched: 1, is_current: 0, state: 'needs_attention' }, false, true, 'retry'],
    [{ action: 'read', dispatched: 0, is_current: 1, state: 'needs_attention' }, true, true, 'retry'],
    [{ action: 'move', dispatched: 0, is_current: 1, state: 'reconciling' }, true, true, 'retry'],
    [{ action: 'move', dispatched: 0, is_current: 1, state: 'queued' }, false, true, 'retry'],
    [{ action: 'move', dispatched: 1, is_current: 1, state: 'needs_attention' }, true, false, 'check_outcome'],
    [{ action: 'move', dispatched: 1, is_current: 1, state: 'executing' }, false, false, 'check_outcome'],
  ];
  for (const [row, canRetry, canCancel, action] of cases) {
    const op = { id: 'op', user_id: 'owner', mail_account_id: 'account', email_id: 'item', remote_folder: 'INBOX',
      remote_uid: 12, remote_uidvalidity: 9, attempts: 8, ...row };
    const sql = [], enqueued = [];
    t.mock.method(runtime, 'enqueueJob', async job => { enqueued.push(job); });
    t.mock.method(runtime, 'claimDueJob', async () => null);
    const execute = async (text, args = []) => {
      sql.push({ text, args });
      if (text.includes('backup_restore_jobs') || text.includes('user_settings')) return [[]];
      if (text.includes('SELECT id,email_id,action')) return [[op]];
      if (text.includes('FROM mail_writebacks WHERE id')) return [[args[0] === 'op' && args[1] === 'owner' ? op : null].filter(Boolean)];
      if (text.includes('FROM emails')) return [[{ remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 }]];
      if (text.startsWith("UPDATE mail_writebacks SET state='cancelled'")) {
        // Evaluate the endpoint's own WHERE parameters against the synthetic row.
        const states = args.slice(2);
        const ok = (!op.dispatched && states.includes(op.state)) || (op.dispatched && ['read', 'star'].includes(op.action) && op.state === 'needs_attention');
        return [{ affectedRows: ok ? 1 : 0 }];
      }
      return [{ affectedRows: 1 }];
    };
    const cx = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
    setDb({ execute, getConnection: async () => cx });
    const [view] = (await writes.listWritebacks('owner')).operations;
    const label = JSON.stringify(row);
    assert.equal(view.can_retry, canRetry, label); assert.equal(view.can_cancel, canCancel, label); assert.equal(view.retry_action, action, label);
    const cancelled = await writes.cancelWriteback('owner', 'op').then(() => true, error => { assert.equal(error.status, 409); return false; });
    assert.equal(cancelled, canCancel, `cancel ${label}`);
    if (action === 'check_outcome') continue; // dispatched MOVE: read-only check path, covered elsewhere
    sql.length = 0;
    const retried = await writes.retryWriteback('owner', 'op').then(() => true, error => { assert.equal(error.status, 409); return false; });
    assert.equal(retried, canRetry, `retry ${label}`);
    const requeue = sql.find(entry => entry.text.startsWith("UPDATE mail_writebacks SET state='queued'"));
    assert.equal(Boolean(requeue), canRetry, label);
    if (requeue) {
      assert.match(requeue.text, /dispatched=FALSE,attempts=0/);
      assert.deepEqual(enqueued.map(job => job.kind), ['operation']);
    }
    await tick();
  }
});

test('retry after a mailbox reset rebases the undispatched intent onto the verified current address', async t => {
  const op = { id: 'op', user_id: 'owner', mail_account_id: 'account', email_id: 'item', action: 'read', dispatched: 0,
    is_current: 1, state: 'needs_attention', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, attempts: 0 };
  const { log } = store(t, op, { email: { remote_folder: 'INBOX', remote_uid: 40, remote_uidvalidity: 10 }, occurrence: { id: 'fresh' } });
  t.mock.method(runtime, 'enqueueJob', async () => {});
  t.mock.method(runtime, 'claimDueJob', async () => null);
  await writes.retryWriteback('owner', 'op'); await tick();
  const occurrence = log.find(entry => entry.sql.includes('SELECT o.id FROM mail_remote_occurrences'));
  assert.match(occurrence.sql, /m\.state='active' AND m\.uidvalidity=o\.uidvalidity/);
  assert.match(occurrence.sql, /o\.presence='present'/);
  assert.deepEqual(occurrence.args, ['item', 'owner', 'account', 'INBOX', 40, 10]);
  const rebase = log.find(entry => entry.sql.startsWith('UPDATE mail_writebacks SET remote_folder=?'));
  assert.deepEqual(rebase.args, ['INBOX', 40, 10, 'fresh', 'op', 'owner', 'account']);
});

test('a worker holding a stale copy cannot revive a cancelled or superseded change', async t => {
  for (const state of ['cancelled', 'superseded']) {
    const op = moveOp({ state });
    const { log } = store(t, op, { prior: [{ id: 'older', state: 'reconciling' }] });
    await ops.applyMove({ ...op, state: 'queued' }, {}, 1, null, 'worker', 'job');
    assert.equal(op.state, state);
    assert(!log.some(entry => entry.sql.startsWith('UPDATE mail_writebacks SET state=?')));
  }
});
