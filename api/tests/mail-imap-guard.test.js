const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardImapConnection, runGuardedImap, closeImapConnection } = require('../dist/src/services/mail-imap-guard');
const { withMailAccountLock } = require('../dist/src/services/mail-account-lock');
const operations = require('../dist/src/services/mail-engine/operations');
const transport = require('../dist/src/services/mail-engine/transport');
const { getDb, setDb } = require('../dist/src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Stands in for an ImapFlow client: close() is its synchronous hard close
// (socket and parser destroyed, 'close' emitted); commands are promises.
function fixture(options = {}) {
  const connection = new EventEmitter();
  let destroyed = 0, commands = 0, reply;
  Object.assign(connection, { usable: true, isClosed: false });
  connection.close = () => {
    destroyed++;
    if (connection.isClosed) return;
    Object.assign(connection, { usable: false, isClosed: true });
    connection.emit('close');
  };
  connection.search = () => { commands++; return new Promise(resolve => { reply = (_error, value) => resolve(value); }); };
  connection.mailboxOpen = async () => ({ uidValidity: 9n });
  guardImapConnection(connection, options);
  const command = name => runGuardedImap(connection, () => connection[name]());
  return { connection, command, get destroyed() { return destroyed; },
    get commands() { return commands; }, reply: (...args) => reply(...args) };
}

test('command timeout destroys transport, rejects stalled promises and ignores late success', async () => {
  const f = fixture({ timeoutMs: 10 });
  let continued = false;
  const wait = f.command('search').then(() => { continued = true; });
  await assert.rejects(wait, { code: 'MAIL_IMAP_TIMEOUT' });
  assert.equal(f.destroyed, 1);
  assert.equal(f.connection.isClosed, true);
  f.reply(null, []); await tick();
  assert.equal(continued, false);
  await assert.rejects(f.command('mailboxOpen'), { code: 'MAIL_IMAP_TIMEOUT' });
  assert.equal(f.commands, 1);
});

test('a command may set its own deadline; the connection keeps its default for others', async () => {
  const f = fixture({ timeoutMs: 10 });
  const slow = runGuardedImap(f.connection, () => f.connection.search(), { timeoutMs: 200 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.destroyed, 0, 'the longer deadline outlives the connection default');
  f.reply(null, ['done']);
  assert.deepEqual(await slow, ['done']);
  await assert.rejects(f.command('search'), { code: 'MAIL_IMAP_TIMEOUT' });
  assert.equal(f.destroyed, 1);
  for (const timeoutMs of [0, 300001, 1.5]) {
    assert.throws(() => runGuardedImap(f.connection, () => {}, { timeoutMs }), /Invalid IMAP command deadline/);
  }
});

for (const event of ['error', 'close']) test(`client ${event} settles a wait even if the command never settles`, async () => {
  const f = fixture();
  const wait = f.command('search');
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
    try { await f.command('search'); mutated = true; }
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
  await assert.rejects(f.command('search'), { code: 'MAIL_SYNC_CANCELLED' });
  assert.equal(f.commands, 0); assert.equal(f.destroyed, 1);
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
      try { await f.command('search'); }
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
    const wait = f.command('search');
    f.reply(null, [i]); assert.deepEqual(await wait, [i]);
  }
  assert.equal(f.destroyed, 0);
  closeImapConnection(f.connection); assert.equal(f.destroyed, 1);
  closeImapConnection(f.connection); assert.equal(f.destroyed, 1, 'closing is idempotent');
});
