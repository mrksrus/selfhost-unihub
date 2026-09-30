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

// Synthetic store for acceptServerState: evaluates the endpoint's own WHERE
// clause against the row and records every statement and follow-up sync.
function acceptStore(t, op, { account = { is_active: 1, disconnected_at: null, sync_mode: 'sync' } } = {}) {
  const old = getDb(); t.after(() => setDb(old));
  const log = [], syncs = [];
  const execute = async (sql, args = []) => {
    log.push({ sql, args });
    if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
    if (sql.includes('SELECT id,email_id,action')) return [[op]];
    if (sql.startsWith('SELECT id,mail_account_id,action,dispatched,state FROM mail_writebacks'))
      return [[args[0] === op.id && args[1] === op.user_id ? op : null].filter(Boolean)];
    if (sql.startsWith("UPDATE mail_writebacks SET state='superseded'")) {
      const ok = args[0] === op.id && args[1] === op.user_id && args[2] === op.mail_account_id
        && op.action === 'move' && Number(op.dispatched) === 1 && op.state === 'needs_attention';
      if (ok) Object.assign(op, { state: 'superseded', status: 'done', is_current: 0, error: null,
        evidence: { ...op.evidence, reason: 'user_accepted_server_state' } });
      return [{ affectedRows: ok ? 1 : 0 }];
    }
    if (sql.startsWith('SELECT is_active,disconnected_at FROM mail_accounts')) return [[account]];
    return [{ affectedRows: 1 }];
  };
  const cx = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  setDb({ execute, getConnection: async () => cx });
  t.mock.method(require('../src/services/mail'), 'scheduleMailAccountSync', async (accountId, options) => {
    syncs.push({ accountId, options }); return { started: true };
  });
  for (const name of ['selectMailbox', 'fetchMetadataWindow', 'nativeMove', 'setFlag'])
    t.mock.method(transport, name, () => assert.fail(`${name} must not run`));
  t.mock.method(runtime, 'enqueueJob', async () => assert.fail('no provider job may be queued'));
  return { log, syncs };
}

test('accept server state flag matches what the endpoint accepts for every state', async t => {
  const states = ['queued', 'executing', 'verifying', 'reconciling', 'retry_wait', 'needs_attention', 'confirmed', 'rejected', 'cancelled', 'superseded'];
  const rows = [];
  for (const state of states) for (const action of ['move', 'read', 'star']) for (const dispatched of [0, 1]) for (const current of [0, 1])
    rows.push({ state, action, dispatched, is_current: current });
  for (const row of rows) {
    const op = moveOp({ id: 'op', ...row, evidence: { kind: 'bounded_move_check' } });
    const label = JSON.stringify(row), expected = row.action === 'move' && row.dispatched === 1 && row.state === 'needs_attention';
    const { log, syncs } = acceptStore(t, op);
    const [view] = (await writes.listWritebacks('owner')).operations;
    assert.equal(view.can_accept_server_state, expected, label);
    const accepted = await writes.acceptServerState('owner', 'op').then(() => true, error => { assert.equal(error.status, 409, label); return false; });
    assert.equal(accepted, expected, `accept ${label}`);
    assert.equal(syncs.length, expected ? 1 : 0, label);
    if (!expected) assert.equal(op.state, row.state, `unchanged ${label}`);
    assert(!log.some(entry => /DELETE/i.test(entry.sql)), 'never deletes accepted operations');
    t.mock.restoreAll();
  }
});

test('accepting the server state resolves a sent MOVE without provider writes and queues a manual sync', async t => {
  const op = moveOp({ id: 'older', intent_revision: 1, state: 'needs_attention', status: 'conflict', dispatched: 1, attempts: 3,
    error: 'MOVE has no correlated COPYUID', evidence: { kind: 'bounded_move_check', sourcePresent: false } });
  const { log, syncs } = acceptStore(t, op);
  assert.deepEqual(await writes.acceptServerState('owner', 'older'),
    { message: 'UniHub stopped tracking this move and is syncing from the server', sync_queued: true });
  assert.deepEqual(syncs, [{ accountId: 'account', options: undefined }], 'manual (non-background, non-follow-up) sync');
  assert.equal(op.state, 'superseded'); assert.equal(op.status, 'done'); assert.equal(op.is_current, 0);
  assert.equal(op.dispatched, 1, 'dispatch record is kept'); assert.equal(op.attempts, 3);
  const update = log.find(entry => entry.sql.startsWith("UPDATE mail_writebacks SET state='superseded'"));
  assert.match(update.sql, /evidence_json=JSON_SET\(COALESCE\(evidence_json,JSON_OBJECT\(\)\),'\$\.reason','user_accepted_server_state'\)/);
  assert.match(update.sql, /WHERE id=\? AND user_id=\? AND mail_account_id=\? AND action='move' AND dispatched=TRUE AND state='needs_attention'/);
  assert.deepEqual(update.args, ['older', 'owner', 'account']);
  assert(!log.some(entry => /mail_operation_attempts/.test(entry.sql)), 'attempt journal untouched');
  await assert.rejects(writes.acceptServerState('owner', 'older'), { status: 409 });
  await assert.rejects(writes.acceptServerState('intruder', 'older'), { status: 404 });
  assert.equal(syncs.length, 1);
});

test('accepting on a disconnected account resolves without a sync and the result says so', async t => {
  const op = moveOp({ id: 'older', state: 'needs_attention', dispatched: 1 });
  const { syncs } = acceptStore(t, op, { account: { is_active: 0, disconnected_at: new Date(), sync_mode: 'sync' } });
  assert.equal((await writes.acceptServerState('owner', 'older')).sync_queued, false);
  assert.equal(op.state, 'superseded'); assert.deepEqual(syncs, []);
});

test('after the server state is accepted a newer MOVE of that message is no longer blocked', async t => {
  const older = { id: 'older', state: 'needs_attention' };
  const op = moveOp();
  const { log } = store(t, op, { email: { remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 } });
  // Evaluate the prior-MOVE query's own terminal-state list.
  const execute = getDb().execute;
  const priorAware = async (sql, args) => {
    if (sql.includes('SELECT id,state FROM mail_writebacks WHERE user_id=')) {
      const terminal = /state NOT IN \(([^)]*)\)/.exec(sql)[1].split(',').map(s => s.trim().replace(/'/g, ''));
      return [[older].filter(row => !terminal.includes(row.state))];
    }
    return execute(sql, args);
  };
  setDb({ execute: priorAware, getConnection: async () => ({ execute: priorAware, beginTransaction: async () => {},
    commit: async () => {}, rollback: async () => {}, release() {} }) });
  await ops.applyMove(op, {}, 1, null, 'worker', 'job');
  assert.deepEqual(op.evidence, { kind: 'blocked_by_unconfirmed_move', prior: 'older' });
  older.state = 'superseded'; // what acceptServerState commits
  Object.assign(op, { state: 'queued', status: 'pending', evidence: null });
  t.mock.method(transport, 'selectMailbox', async () => ({ uidvalidity: 10, capabilities: {} }));
  log.length = 0;
  await ops.applyMove(op, {}, 1, null, 'worker', 'job');
  assert.notDeepEqual(op.evidence, { kind: 'blocked_by_unconfirmed_move', prior: 'older' });
  assert.equal(transport.selectMailbox.mock.callCount(), 1, 'the newer move proceeds to its own source check');
  assert.equal(op.dispatched, 0, 'epoch mismatch here: still nothing sent');
});
