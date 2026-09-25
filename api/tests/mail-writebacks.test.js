const test = require('node:test');
const assert = require('node:assert/strict');
const { executeOperation, queueChanges, remoteEligible } = require('../src/services/mail-writebacks');
const base = { action: 'read', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, target_value: '1', base_value: '0', dispatched: false };
function fixture({ flags = [], conditional = true, move = true, lostReply = false, race = false, version = '100' } = {}) {
  const current = new Set(flags), calls = []; let modseq = version, saved;
  const imap = { _box: {}, serverSupports: c => c === 'CONDSTORE' ? conditional : c === 'MOVE' ? move : false };
  for (const method of ['addFlags', 'delFlags', 'addFlagsSince', 'delFlagsSince']) {
    imap[method] = (...args) => {
      const cb = args.pop(); calls.push([method, ...args]);
      if (!race) { if (method.startsWith('add')) current.add(args[1]); else current.delete(args[1]); modseq = '101'; }
      cb(lostReply ? new Error('Connection lost') : null);
    };
  }
  imap.move = (uid, folder, cb) => { calls.push(['move', uid, folder]); cb(null, '77'); };
  return { calls, current, imap, connection: { imap }, get saved() { return saved; },
    options: { read: async () => ({ flags: [...current], modseq }), markDispatched: async m => { saved = m; } } };
}
test('read and unread change only Seen; flags and large string MODSEQ stay intact', async () => {
  const f = fixture({ flags: ['\\Flagged', '$custom'], version: '9007199254740993123' });
  assert.deepEqual(await executeOperation(f.connection, base, f.options), { value: 1 });
  assert.deepEqual(f.calls, [['addFlagsSince', 12, '\\Seen', '9007199254740993123']]);
  assert.equal(f.saved, '9007199254740993123'); assert(f.current.has('$custom')); assert(f.current.has('\\Flagged'));
  await executeOperation(f.connection, { ...base, target_value: '0', base_value: '1' }, f.options);
  assert.equal(f.calls[1][0], 'delFlagsSince'); assert(!f.current.has('\\Seen'));
});
test('star uses Flagged and never changes read state', async () => {
  const f = fixture({ flags: ['\\Seen'] });
  await executeOperation(f.connection, { ...base, action: 'star' }, f.options);
  assert.deepEqual([...f.current].sort(), ['\\Flagged', '\\Seen']);
});
test('already-applied operation after lost reply completes without a second write', async () => {
  const f = fixture({ lostReply: true });
  await assert.rejects(executeOperation(f.connection, base, f.options), /lost/);
  await executeOperation(f.connection, { ...base, dispatched: true, dispatch_modseq: f.saved }, f.options);
  assert.equal(f.calls.length, 1);
});
test('uncertain operation cannot overwrite a newer provider action', async () => {
  const f = fixture();
  await assert.rejects(executeOperation(f.connection, { ...base, dispatched: true, dispatch_modseq: '99' }, f.options), /state changed/);
  assert.equal(f.calls.length, 0);
});
test('one retry with unchanged saved version applies a request that did not reach server', async () => {
  const f = fixture();
  await executeOperation(f.connection, { ...base, dispatched: true, dispatch_modseq: '100' }, f.options);
  assert.equal(f.calls.length, 1);
});
test('conditional STORE rejection is discovered by read-back and never forced', async () => {
  const f = fixture({ race: true });
  await assert.rejects(executeOperation(f.connection, base, f.options), /Server changed/);
  assert.equal(f.calls.length, 1);
});
test('without CONDSTORE first command is a delta; uncertain retry does not write', async () => {
  const f = fixture({ conditional: false });
  await executeOperation(f.connection, base, f.options); assert.equal(f.calls[0][0], 'addFlags');
  const retry = fixture({ conditional: false });
  await assert.rejects(executeOperation(retry.connection, { ...base, dispatched: true }, retry.options), /state changed/);
  assert.equal(retry.calls.length, 0);
});
test('native MOVE is used once; unsupported or uncertain moves cannot use COPY/EXPUNGE', async () => {
  const op = { ...base, action: 'move', target_value: 'Filed' }, f = fixture();
  assert.deepEqual(await executeOperation(f.connection, op, f.options), { moved: true, destinationUid: 77 });
  for (const [options, operation] of [[{ move: false }, op], [{}, { ...op, dispatched: true }]]) {
    const x = fixture(options); await assert.rejects(executeOperation(x.connection, operation, x.options), { status: 409 });
    assert.equal(x.calls.length, 0);
  }
});
test('UIDVALIDITY mismatch and absent source prevent any write', async () => {
  for (const missing of [false, true]) {
    const f = fixture(); f.connection.openBox = async () => ({ uidvalidity: missing ? 9 : 10 });
    f.connection.search = async () => [];
    await assert.rejects(executeOperation(f.connection, base, { markDispatched: f.options.markDispatched }), { status: 409 });
    assert.equal(f.calls.length, 0);
  }
});
test('Download, drafts, Legacy and retained missing mail remain local', async () => {
  const email = { id: 'e', user_id: 'u', mail_account_id: 'a', filing_account_id: 'a', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 };
  for (const override of [{ sync_mode: 'download' }, { is_draft: 1 }, { is_legacy: 1 }, { remote_missing: 1 }, { filing_account_id: 'other' }]) {
    const calls = [], row = { ...email, ...override };
    assert.equal(remoteEligible(row), false);
    assert.equal((await queueChanges({ execute: async (...args) => { calls.push(args); return [[]]; } }, 'u', [row], { read: true })).size, 0);
    assert.equal(calls.length, 1); assert.match(calls[0][0], /UPDATE emails SET is_read/);
  }
});
test('queue records explicit new intent, normalizes boolean and does not mark local mail read prematurely', async () => {
  const queries = [], db = { execute: async (sql, args) => { queries.push({ sql, args }); return [[]]; } };
  await queueChanges(db, 'owner', [{ id: 'email', mail_account_id: 'account', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, is_read: 0 }], { read: true });
  const insert = queries.find(q => q.sql.includes('INSERT INTO'));
  assert.equal(insert.args[5], '1'); assert.equal(insert.args[6], '0'); assert.equal(insert.args[1], 'owner');
  assert(!queries.some(q => q.sql.includes('UPDATE emails')));
});

test('restart after the second attempt cannot dispatch a third write, but can confirm success', async () => {
  const f = fixture();
  await assert.rejects(executeOperation(f.connection, { ...base, attempts: 2 }, f.options), /retry limit/);
  assert.equal(f.calls.length, 0);
  f.current.add('\\Seen');
  assert.deepEqual(await executeOperation(f.connection, { ...base, attempts: 2 }, f.options), {value: 1});
});
