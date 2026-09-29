const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardImapConnection } = require('../src/services/mail-imap-guard');
const { withMailAccountLock } = require('../src/services/mail-account-lock');
const { executeOperation, processPending } = require('../src/services/mail-writebacks');
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

for (const [action, attempts, expectedStatus] of [['read', 0, 'pending'], ['star', 1, 'failed'], ['move', 0, 'conflict']]) {
  test(`timed-out ${action} retains durable ${expectedStatus} safety and cannot confirm mail state`, async t => {
    const old = getDb(); t.after(() => setDb(old));
    const op = { id: 'op', email_id: 'email', user_id: 'owner', mail_account_id: 'account', action, attempts,
      remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, target_value: action === 'move' ? 'Filed' : '1', base_value: '0' };
    let status = 'pending', dispatchPersisted = false, reply, destroyed = 0, updates = 0;
    setDb({ execute: async (sql, args) => {
      if (sql.includes('SELECT * FROM mail_writebacks')) return [[{ ...op }]];
      if (sql.includes('FROM user_settings') || sql.includes('FROM backup_restore_jobs')) return [[]];
      if (sql.includes('SELECT e.*')) return [[{ ...op, id: 'email', sync_mode: 'sync', is_active: 1 }]];
      assert(!sql.startsWith('UPDATE emails'), 'An uncertain reply must never confirm local mail state');
      if (sql.includes('SET dispatched = TRUE')) dispatchPersisted = true;
      if (sql.includes('SET status = ?')) status = args[0];
      updates++; return [{ affectedRows: 1 }];
    } });
    const connection = new EventEmitter();
    connection.openBox = async () => ({ uidvalidity: 9 });
    connection.search = async () => [{ attributes: { uid: 12, flags: [] } }];
    const hang = (...args) => { assert.equal(dispatchPersisted, true, 'Persist uncertainty before sending'); reply = args.at(-1); };
    connection.imap = { destroy() { destroyed++; }, serverSupports: () => true, addFlags: hang, move: hang };
    const result = await processPending({ id: 'account', user_id: 'owner' }, guardImapConnection(connection, { timeoutMs: 10 }));
    assert.equal(result.connectionFailed, true); assert.equal(status, expectedStatus); assert.equal(destroyed, 1);
    const before = updates; reply(null, '77'); await tick(); assert.equal(updates, before);
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
