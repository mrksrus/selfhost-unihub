const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardImapConnection } = require('../src/services/mail-imap-guard');
const { withMailAccountLock } = require('../src/services/mail-account-lock');
const { executeOperation } = require('../src/services/mail-writebacks');
const operations = require('../src/services/mail-engine/operations');
const transport = require('../src/services/mail-engine/transport');
const { getDb, setDb } = require('../src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const connection = new EventEmitter();
  let destroyed = 0, socketDestroyed = 0, commands = 0, reply;
  connection.imap = { _sock: { destroy() { socketDestroyed++; } },
    destroy() { assert.equal(socketDestroyed, 1); destroyed++; }, addFlags(...args) { commands++; reply = args.at(-1); } };
  connection.search = () => { commands++; return new Promise(resolve => { reply = (_error, value) => resolve(value); }); };
  connection.openBox = async () => ({ uidvalidity: 9 });
  connection.getBoxes = async () => ({ INBOX: {} });
  return { connection: guardImapConnection(connection, options), get destroyed() { return destroyed; }, get socketDestroyed() { return socketDestroyed; },
    get commands() { return commands; }, reply: (...args) => reply(...args) };
}

test('command timeout destroys transport, rejects stalled promises and ignores late success', async () => {
  const f = fixture({ timeoutMs: 10 });
  let continued = false;
  const wait = f.connection.search(['ALL'], {}).then(() => { continued = true; });
  await assert.rejects(wait, { code: 'MAIL_IMAP_TIMEOUT' });
  assert.equal(f.destroyed, 1);
  assert.equal(f.socketDestroyed, 1);
  f.reply(null, []); await tick();
  assert.equal(continued, false);
  await assert.rejects(f.connection.openBox('INBOX'), { code: 'MAIL_IMAP_TIMEOUT' });
  assert.equal(f.commands, 1);
});

for (const event of ['error', 'close', 'end']) test(`socket ${event} settles a wait even if imap-simple never calls back`, async () => {
  const f = fixture();
  const wait = f.connection.search(['ALL'], {});
  f.connection.emit(event, event === 'error' ? new Error('socket timeout') : undefined);
  await assert.rejects(wait, /socket timeout|unexpectedly/);
  assert.equal(f.destroyed, 1);
  f.connection.emit('error', new Error('late socket error'));
  assert.equal(f.destroyed, 1);
});

test('abort keeps account locked through cleanup and late replies cannot mutate or resume', async () => {
  const controller = new AbortController(), f = fixture({ signal: controller.signal });
  let cleanup, cleanupStarted = false, mutated = false;
  const worker = withMailAccountLock('guarded', async () => {
    try { await f.connection.search(['ALL'], {}); mutated = true; }
    finally { cleanupStarted = true; await new Promise(resolve => { cleanup = resolve; }); }
  });
  await tick(); controller.abort(); await tick();
  assert.equal(cleanupStarted, true);
  assert.equal(f.destroyed, 1);
  await assert.rejects(withMailAccountLock('guarded', () => assert.fail('unsafe overlap'), { wait: false }), { code: 'MAIL_ACCOUNT_BUSY' });
  f.reply(null, []); await tick(); assert.equal(mutated, false);
  cleanup(); await assert.rejects(worker, { code: 'MAIL_SYNC_CANCELLED' });
  assert.equal(await withMailAccountLock('guarded', async () => 'released', { wait: false }), 'released');
});

test('cancelled connection cannot dispatch any new commands', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture({ signal: controller.signal });
  await assert.rejects(f.connection.search(['ALL'], {}), { code: 'MAIL_SYNC_CANCELLED' });
  assert.equal(f.commands, 0); assert.equal(f.destroyed, 1);
});

test('timed-out provider flag remains uncertain and never continues to readback or confirms success', async () => {
  const f = fixture({ timeoutMs: 10 });
  let dispatched = false, reads = 0;
  const operation = executeOperation(f.connection, { action: 'read', remote_uid: 12, target_value: '1', base_value: '0' }, {
    read: async () => { reads++; return { flags: [] }; }, markDispatched: async () => { dispatched = true; },
  });
  await assert.rejects(operation, { code: 'MAIL_IMAP_TIMEOUT' });
  assert.equal(dispatched, true); assert.equal(reads, 1); assert.equal(f.destroyed, 1);
  f.reply(null); await tick();
  assert.equal(reads, 1, 'Late success must not trigger a confirmation read or local UPDATE');
});

for (const action of ['read', 'star', 'move']) {
  test(`timed-out fenced ${action} retains journal and pending reconciliation; late reply cannot confirm`, async t => {
    const old = getDb(); t.after(() => setDb(old));
    const original = { selectMailbox: transport.selectMailbox, fetchMetadataWindow: transport.fetchMetadataWindow,
      setFlag: transport.setFlag, nativeMove: transport.nativeMove };
    t.after(() => Object.assign(transport, original));
    const op = { id: 'op', email_id: 'email', user_id: 'owner', mail_account_id: 'account', action,
      state: 'queued', status: 'pending', is_current: 1, attempts: 0, dispatched: 0, intent_revision: 1,
      remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9,
      target_value: action === 'move' ? 'Filed' : '1', base_value: '0' };
    const trace = [], f = fixture({ timeoutMs: 10 });
    const cx = { beginTransaction: async () => trace.push('begin'), commit: async () => trace.push('commit'),
      rollback: async () => trace.push('rollback'), release() {},
      execute: async (sql, args = []) => {
        trace.push(sql);
        if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
        if (sql.includes('SELECT observation_revision FROM emails')) return [[{ observation_revision: 0 }]];
        if (sql.includes('SELECT remote_folder,remote_uid,remote_uidvalidity FROM emails'))
          return [[{ remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 }]];
        if (sql.includes('SELECT id,state FROM mail_writebacks WHERE user_id=')) return [[]];
        if (sql.includes('FROM mail_engine_accounts a') && sql.includes('lease_owner')) return [[{ generation: 1 }]];
        if (sql.includes('SELECT e.generation, a.is_active')) return [[{ generation: 1, is_active: 1, sync_mode: 'sync' }]];
        if (sql.includes('SELECT * FROM mail_writebacks WHERE id')) return [[op]];
        if (sql.includes('SELECT o.id FROM mail_remote_occurrences')) return [[{ id: 'source' }]];
        if (sql.includes('SELECT * FROM mail_operation_attempts WHERE id')) return [[{ id: 'attempt' }]];
        if (sql.startsWith('INSERT INTO mail_operation_attempts')) return [{ affectedRows: 1 }];
        if (sql.includes('UPDATE mail_writebacks SET state =')) { op.dispatched = 1; op.attempts++; op.state = 'executing'; return [{ affectedRows: 1 }]; }
        if (sql.includes('UPDATE mail_writebacks SET state=?')) { op.state = args[0]; op.status = args[1]; return [{ affectedRows: 1 }]; }
        assert(!sql.startsWith('UPDATE emails'), 'An uncertain reply must never confirm local mail state');
        return [{ affectedRows: 1 }];
      } };
    setDb({ execute: cx.execute, getConnection: async () => cx });
    let reads = 0;
    transport.selectMailbox = async () => ({ uidvalidity: 9, capabilities: { condstore: false } });
    transport.fetchMetadataWindow = async () => { reads++; return { items: [{ uid: 12, flags: [], modseq: null }] }; };
    const lost = async (_conn, _input, { beforeDispatch }) => {
      await beforeDispatch();
      assert(trace.includes('commit'), 'Dispatch journal must commit before any mutation bytes');
      try { await f.connection.search(['UID', 12], {}); }
      catch (error) { assert.equal(error.code, 'MAIL_IMAP_TIMEOUT'); }
      return { transmission: 'possible', completion: 'lost', mapping: null, mappingStatus: 'missing' };
    };
    transport.setFlag = lost; transport.nativeMove = lost;
    const result = action === 'move'
      ? await operations.applyMove(op, f.connection, 1, undefined, 'worker', 'job')
      : await operations.applyFlag(op, f.connection, 1, undefined, 'worker', 'job');
    assert.equal(result.connectionFailed, true); assert.equal(op.state, 'reconciling');
    assert.equal(op.status, 'pending'); assert.equal(op.attempts, 1); assert.equal(f.destroyed, 1);
    assert.equal(reads, 1, 'Lost acknowledgement cannot trigger a confirming readback');
    const before = trace.length; f.reply(null, '77'); await tick(); assert.equal(trace.length, before);
    assert.equal(trace.filter(sql => sql.startsWith('INSERT INTO mail_operation_attempts')).length, 1);
  });
}

test('each command gets a fresh deadline; completing many commands has no global sync cutoff', async () => {
  const f = fixture({ timeoutMs: 100 });
  for (let i = 0; i < 5; i++) {
    const wait = f.connection.search(['ALL'], {});
    f.reply(null, [i]); assert.deepEqual(await wait, [i]);
  }
  assert.equal(f.destroyed, 0);
  f.connection.end(); assert.equal(f.destroyed, 1);
});
