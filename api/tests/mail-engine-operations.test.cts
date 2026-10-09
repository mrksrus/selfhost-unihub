import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { setDb } = require('../dist/src/state');
const writes = require('../dist/src/services/mail-writebacks');
const settle = require('../dist/src/services/mail-engine/reconciliation');
const ops = require('../dist/src/services/mail-engine/operations');

function model() {
  const userId = 'owner', accountId = 'account';
  const op = { id: 'op1', user_id: userId, mail_account_id: accountId, email_id: 'item', action: 'move',
    target_value: 'Filed', target_folder: 'filed', remote_folder: 'INBOX', remote_uid: 12,
    remote_uidvalidity: 9, source_occurrence_id: 'source', intent_revision: 1, state: 'reconciling',
    status: 'pending', dispatched: 1 };
  const mailbox = { id: 'box', user_id: userId, mail_account_id: accountId, state: 'active', remote_name: 'Filed', uidvalidity: 10 };
  const destination = { id: 'dest', email_id: 'item', user_id: userId, mail_account_id: accountId,
    mailbox_id: 'box', uid: 77, uidvalidity: 10, presence: 'present' };
  const source = { id: 'source', email_id: 'item', presence: 'present' };
  const email = { id: 'item', user_id: userId, mail_account_id: accountId, remote_folder: 'INBOX', remote_uid: 12 };
  const commands: FixtureValue[] = [];
  const cx: FixtureValue = { execute: async (sql: string, args: FixtureValue) => {
    commands.push({ sql, args });
    if (sql.includes('SELECT * FROM mail_writebacks WHERE id=')) return [[args[0] === op.id && args[1] === userId && args[2] === accountId ? op : null].filter(Boolean)];
    if (sql.includes('SELECT * FROM mail_remote_mailboxes WHERE id=')) return [[args[0] === 'box' && args[1] === userId ? mailbox : null].filter(Boolean)];
    if (sql.includes('SELECT * FROM mail_remote_occurrences WHERE mailbox_id=')) return [[args[0] === 'box' && Number(args[4]) === 77 ? destination : null].filter(Boolean)];
    if (sql.includes('SELECT presence FROM mail_remote_occurrences')) return [[source]];
    if (sql.includes('SELECT c.mailbox_id FROM mail_remote_mailboxes')) return [[]];
    if (sql.includes('SELECT id FROM mail_operation_attempts')) return [[]];
    if (sql.includes('SELECT * FROM emails WHERE id=')) return [[email]];
    if (sql.includes('SELECT id FROM mail_writebacks WHERE email_id=')) return [[]];
    if (sql.includes("UPDATE mail_remote_occurrences SET presence='absent'")) source.presence = 'absent';
    if (sql.includes('UPDATE emails SET folder=')) { email.remote_folder = args[1]; email.remote_uid = args[2]; }
    if (sql.includes("UPDATE mail_writebacks SET state='confirmed'")) { op.state = 'confirmed'; op.status = 'done'; }
    return [{ affectedRows: 1 }];
  } };
  return { op, mailbox, destination, source, email, cx, commands };
}
const destination = { mailboxId: 'box', folder: 'Filed', uidvalidity: 10, uid: 77 };
const mapping = { uidvalidity: 10, sourceUids: [12], destinationUids: [77] };

test('COPYUID settlement is correlated, atomic and duplicate-safe; no raw-hash identity guess', async () => {
  const f = model();
  assert.equal(settle.validMapping(mapping, f.op, destination), true);
  assert.equal(settle.validMapping({ ...mapping, sourceUids: [13] }, f.op, destination), false);
  assert.equal((await settle.settleMoveEvidence({ operationId: f.op.id, userId: 'owner', accountId: 'account',
    mapping: { ...mapping, sourceUids: [13] }, destination, evidence: { verified: false }, executor: f.cx })).reason, 'identity_ambiguous');
  assert.equal(f.op.state, 'reconciling'); assert.equal(f.email.remote_folder, 'INBOX');
  const result = await settle.settleMoveEvidence({ operationId: f.op.id, userId: 'owner', accountId: 'account',
    mapping, destination, evidence: { verified: true }, executor: f.cx });
  assert.equal(result.settled, true); assert.equal(f.op.state, 'confirmed'); assert.equal(f.email.remote_folder, 'Filed');
  assert.equal(f.source.presence, 'absent');
  assert.deepEqual(await settle.settleMoveEvidence({ operationId: f.op.id, userId: 'owner', accountId: 'account',
    mapping, destination, executor: f.cx }), { settled: true, duplicate: true });
  assert.equal(f.commands.filter(x => x.sql.includes('UPDATE emails SET folder=')).length, 1);
});
test('scan-first prior conflict reconciles only when source absence is evidenced', async () => {
  const f = model(); f.op.state = 'needs_attention';
  const call = (extra: FixtureValue) => settle.settleMoveEvidence({ operationId: f.op.id, userId: 'owner', accountId: 'account',
    destination, source: { absent: false }, evidence: { verified: true, unique: true }, ...extra, executor: f.cx });
  assert.equal((await call({})).reason, 'identity_ambiguous');
  f.source.presence = 'absent';
  assert.equal((await call({})).settled, true);
});
test('legacy rebinding requires covered source epoch and affirmative unique identity proof', async () => {
  const f: FixtureValue = model(); f.op.source_occurrence_id = null; f.op.state = 'needs_attention'; f.op.created_at = new Date(0);
  let covered = false;
  const execute = f.cx.execute;
  f.cx.execute = async (sql: string, args: FixtureValue) => {
    if (sql.includes('SELECT c.mailbox_id FROM mail_remote_mailboxes')) return [covered ? [{ mailbox_id: 'old-box' }] : []];
    if (sql.includes('SELECT presence FROM mail_remote_occurrences') && sql.includes('mailbox_id=')) return [[]];
    return execute(sql, args);
  };
  const probe = (unique: FixtureValue) => settle.settleMoveEvidence({ operationId: 'op1', userId: 'owner', accountId: 'account',
    destination, source: { absent: false }, evidence: { verified: true, unique }, executor: f.cx });
  assert.equal((await probe(true)).reason, 'identity_ambiguous');
  covered = true;
  assert.equal((await probe(false)).reason, 'identity_ambiguous');
  assert.equal((await probe(true)).settled, true);
});
test('scan settlement closes the original unresolved attempt, not a new mutation', async () => {
  const f = model(); f.source.presence = 'absent';
  const events: FixtureValue[] = [], original = f.cx.execute;
  f.cx.execute = async (sql: string, args: FixtureValue) => {
    if (sql.includes('SELECT id FROM mail_operation_attempts')) return [[{ id: 'attempt-before-crash' }]];
    if (sql.includes('UPDATE mail_operation_attempts SET outcome=')) { events.push(args); return [{ affectedRows: 1 }]; }
    return original(sql, args);
  };
  assert.equal((await settle.settleMoveEvidence({ operationId: 'op1', userId: 'owner', accountId: 'account',
    destination, source: { absent: true }, evidence: { verified: true, unique: true }, executor: f.cx })).settled, true);
  assert.equal(events.length, 1); assert.equal(events[0][0], 'confirmed');
  assert.equal(events[0][2], 'attempt-before-crash');
});
test('another item occupying the target or another owner never settles', async () => {
  const f = model(); f.destination.email_id = 'independent-copy';
  assert.equal((await settle.settleMoveEvidence({ operationId: f.op.id, userId: 'owner', accountId: 'account',
    mapping, destination, executor: f.cx })).reason, 'destination_unverified_or_occupied');
  assert.equal((await settle.settleMoveEvidence({ operationId: f.op.id, userId: 'stranger', accountId: 'account',
    mapping, destination, executor: f.cx })).reason, 'stale_or_missing');
  assert.equal(f.op.state, 'reconciling');
});
test('verified COPYUID adopts a scan-first placeholder and retains its raw archive and stable source ID', async () => {
  const f = model(); f.destination.email_id = 'scan-first';
  const archive: FixtureValue = { id: 'scan-first', raw_path: 'preserved.eml', raw_verified: 1, remote_folder: 'Filed', remote_missing: 0 };
  const original = f.cx.execute;
  f.cx.execute = async (sql: string, args: FixtureValue) => {
    if (sql.includes('SELECT * FROM emails WHERE id=') && args[0] === archive.id) return [[archive]];
    if (sql.includes('SELECT id FROM mail_remote_occurrences WHERE email_id=')) return [[]];
    if (sql.includes('SELECT id FROM mail_writebacks WHERE email_id=?')) return [[]];
    if (sql.includes('UPDATE emails SET remote_missing=TRUE')) {
      archive.remote_missing = 1; archive.remote_folder = null; return [{ affectedRows: 1 }];
    }
    if (sql.includes('UPDATE mail_remote_occurrences SET email_id=')) {
      assert.equal(args[0], 'item'); assert.equal(args[4], 'scan-first');
      f.destination.email_id = 'item'; return [{ affectedRows: 1 }];
    }
    return original(sql, args);
  };
  assert.equal((await settle.settleMoveEvidence({ operationId: 'op1', userId: 'owner', accountId: 'account',
    mapping, destination, evidence: { verified: true }, executor: f.cx })).settled, true);
  assert.equal(f.op.state, 'confirmed'); assert.equal(f.email.id, 'item');
  assert.equal(f.destination.email_id, 'item'); assert.equal(f.source.presence, 'absent');
  assert.deepEqual([archive.id, archive.raw_path, archive.raw_verified, archive.remote_missing, archive.remote_folder],
    ['scan-first', 'preserved.eml', 1, 1, null]);
  assert(!f.commands.some(item => item.sql.startsWith('DELETE FROM emails')));
});
test('COPYUID collision with placeholder intents or second occurrence does not steal or drop history', async () => {
  for (const kind of ['intents', 'other']) {
    const f = model(); f.destination.email_id = 'scan-first';
    const original = f.cx.execute;
    f.cx.execute = async (sql: string, args: FixtureValue) => {
      if (sql.includes('SELECT * FROM emails WHERE id=') && args[0] === 'scan-first') return [[{ id: 'scan-first', raw_path: 'preserved.eml' }]];
      if (sql.includes('SELECT id FROM mail_remote_occurrences WHERE email_id=')) return [kind === 'other' ? [{ id: 'other-occurrence' }] : []];
      if (sql.includes('SELECT id FROM mail_writebacks WHERE email_id=?')) return [kind === 'intents' ? [{ id: 'accepted-intent' }] : []];
      return original(sql, args);
    };
    const result = await settle.settleMoveEvidence({ operationId: 'op1', userId: 'owner', accountId: 'account',
      mapping, destination, evidence: { verified: true }, executor: f.cx });
    assert.equal(result.reason, 'placeholder_has_other_identity_or_intents');
    assert.equal(f.destination.email_id, 'scan-first'); assert.equal(f.op.state, 'reconciling');
    assert(!f.commands.some(item => item.sql.includes('UPDATE emails SET folder=')));
  }
});
test('acknowledgment-first verified COPYUID settles a destination that scanner inserted before readback', async t => {
  const f: FixtureValue = model(); f.destination.email_id = 'scan-first';
  f.cx.beginTransaction = async () => {}; f.cx.commit = async () => {};
  f.cx.rollback = async () => {}; f.cx.release = () => {};
  f.op.state = 'queued'; f.op.is_current = 1; f.op.dispatched = 0;
  f.email.remote_uidvalidity = 9;
  const transport = require('../dist/src/services/mail-engine/transport');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const repository = require('../dist/src/services/mail-engine/repository');
  const history: FixtureValue[] = [];
  const original = f.cx.execute;
  f.cx.execute = async (sql: string, args: FixtureValue[] = []) => {
    history.push(sql);
    if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
    if (sql.includes('SELECT id,state FROM mail_writebacks WHERE user_id=')) return [[]];
    if (sql.includes('SELECT remote_folder,remote_uid,remote_uidvalidity FROM emails')) return [[f.email]];
    if (sql.includes('SELECT observation_revision FROM emails')) return [[{ observation_revision: 0 }]];
    if (sql.includes('SELECT e.generation, a.is_active')) return [[{ generation: 1, is_active: 1, sync_mode: 'sync' }]];
    if (sql.includes('SELECT generation FROM mail_engine_accounts')) return [[{ generation: 1 }]];
    if (sql.includes('SELECT id FROM mail_remote_occurrences') && sql.includes('mailbox_id=?')) return [[{ id: 'dest' }]];
    if (sql.includes('SELECT * FROM emails WHERE id=') && args[0] === 'scan-first') return [[{ id: 'scan-first', raw_path: 'preserved.eml' }]];
    if (sql.includes('SELECT id FROM mail_remote_occurrences WHERE email_id=')) return [[]];
    if (sql.includes('SELECT id FROM mail_writebacks WHERE email_id=?')) return [[]];
    if (sql.includes('UPDATE mail_remote_occurrences SET email_id=')) {
      f.destination.email_id = 'item'; return [{ affectedRows: 1 }];
    }
    return original(sql, args);
  };
  setDb({ execute: f.cx.execute, getConnection: async () => f.cx });
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  t.mock.method(runtime, 'beginOperationAttempt', async () => {
    f.op.dispatched = 1; f.op.state = 'executing'; return { id: 'attempt' };
  });
  t.mock.method(repository, 'ensureMailbox', async () => f.mailbox);
  t.mock.method(repository, 'upsertOccurrence', () => assert.fail('must not upsert over scanner tuple'));
  t.mock.method(transport, 'selectMailbox', async (_: FixtureValue, { folder }: FixtureValue) => ({
    uidvalidity: folder === 'INBOX' ? 9 : 10, capabilities: { condstore: false } }));
  t.mock.method(transport, 'fetchMetadataWindow', async (_: FixtureValue, request: FixtureValue) => ({
    items: [{ uid: request.startUid, flags: [], modseq: null }] }));
  t.mock.method(transport, 'nativeMove', async (_: FixtureValue, __: FixtureValue, { beforeDispatch }: FixtureValue) => {
    await beforeDispatch(); return { transmission: 'possible', completion: 'ok', mappingStatus: 'valid', mapping };
  });
  const outcome = await ops.applyMove(f.op, {}, 1, null, 'worker', 'job');
  assert.equal(outcome.connectionFailed, undefined, JSON.stringify(history));
  assert.equal(outcome.needsSync, true);
  assert.equal(f.op.state, 'confirmed'); assert.equal(f.destination.email_id, 'item');
  assert.equal(f.email.remote_folder, 'Filed');
  assert(history.some(sql => sql.includes('UPDATE emails SET remote_missing=TRUE')));
});
test('idempotency key syntax, canonical payload, bounded backoff and no dispatch without a lease', async () => {
  assert.equal(writes.canonicalRequest(['b','a'], { star: 1, read: true }),
    writes.canonicalRequest(['a','b'], { read: 1, star: true }));
  assert.notEqual(writes.canonicalRequest(['a'], { move: 'Filed' }), writes.canonicalRequest(['a'], { move: 'Archive' }));
  for (const key of ['', '\n', ' ', 'x'.repeat(129)]) assert.throws(() => writes.keyCheck(key), { status: 400 });
  assert.equal(writes.keyCheck('safe-key_1'), 'safe-key_1');
  assert(ops.retryDelay(5) > ops.retryDelay(2)); assert(ops.retryDelay(500) <= 3600);
  await assert.rejects(ops.processDueOperations({ id: 'a', user_id: 'u' }, {}, {}), { code: 'MAIL_WORKER_FENCED' });
});
test('receipt readback is owner-scoped and replays the original admission response', async () => {
  const response = { message: 'Provider changes queued', operation_ids: ['one'], accepted_revision: 1, sync_pending: true };
  setDb({ execute: async (sql: string, args: FixtureValue) => {
    if (sql.includes('mail_command_receipts')) return [[args[0] === 'owner' ? { response_json: JSON.stringify(response) } : null].filter(Boolean)];
    if (sql.includes('mail_writebacks')) return [[{ id: 'one', is_current: 1, action: 'move', dispatched: 1, state: 'reconciling' }]];
    throw new Error(`Unexpected ${sql}`);
  } });
  assert.deepEqual(await writes.getOperationReceipt('stranger', 'key'), { found: false, response: null, operations: [] });
  const found = await writes.getOperationReceipt('owner', 'key');
  assert.equal(found.found, true); assert.deepEqual(found.response, response);
  assert.equal(found.operations[0].retry_action, 'check_outcome');
});
test('restored receipt warns instead of promising provider acceptance; default list retains unresolved history', async () => {
  const queries: FixtureValue[] = [];
  setDb({ execute: async (sql: string, args: FixtureValue) => {
    queries.push({ sql, args });
    if (sql.includes('mail_command_receipts')) return [[{ response_json: JSON.stringify({
      message: 'Provider changes queued', operation_ids: ['old'], sync_pending: true, recovery_required: true }) }]];
    return [[{ id: 'old', state: 'needs_attention', status: 'conflict', is_current: 0,
      action: 'move', dispatched: 1 }]];
  } });
  const receipt = await writes.getOperationReceipt('owner', 'restored-key');
  assert.equal(receipt.found, true); assert.equal(receipt.response.recovery_required, true);
  assert.equal(receipt.response.sync_pending, false); assert.match(receipt.response.message, /revalidation/);
  const recent = await writes.listWritebacks('owner', { accountId: 'account' });
  assert.equal(recent.operations[0].retry_action, 'check_outcome');
  assert.match(queries.at(-1).sql, /is_current=TRUE OR state IN/);
  assert.deepEqual(queries.at(-1).args, ['owner', 'account', '100']);
  await writes.listWritebacks('owner', { includeHistory: true, limit: 999 });
  assert.doesNotMatch(queries.at(-1).sql, /is_current=TRUE OR state IN/);
  assert.deepEqual(queries.at(-1).args, ['owner', '200']);
});
test('admission commits receipt, intent and job together; exact replay never appends', async t => {
  const receipts = new Map(), admitted: FixtureValue[] = [], jobs: FixtureValue[] = [], history: FixtureValue[] = [], nudged: FixtureValue[] = [];
  t.mock.method(require('../dist/src/services/mail'), 'runMailOperationsNow', async (id: FixtureValue, options: FixtureValue) => { nudged.push([id, options]); return true; });
  const email = { id: 'item', user_id: 'owner', mail_account_id: 'account', sync_mode: 'sync', is_active: 1,
    remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, is_read: 0 };
  const cx: FixtureValue = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql: string, args: FixtureValue[] = []) => {
      history.push(sql);
      if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
      if (sql.startsWith('SELECT request_hash,response_json FROM mail_command_receipts')) return [[receipts.get(`${args[0]}:${args[1]}`)].filter(Boolean)];
      if (sql.startsWith('INSERT INTO mail_command_receipts')) {
        if (receipts.has(`${args[0]}:${args[1]}`)) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
        receipts.set(`${args[0]}:${args[1]}`, { request_hash: args[2], response_json: args[3] }); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE mail_command_receipts')) {
        receipts.get(`${args[1]}:${args[2]}`).response_json = args[0]; return [{ affectedRows: 1 }]; }
      if (sql.includes('SELECT e.*,a.sync_mode,a.is_active')) return [[email]];
      if (sql.includes('SELECT * FROM mail_writebacks WHERE user_id=')) return [[...admitted].reverse().slice(0, 1)];
      if (sql.includes('SELECT o.id FROM mail_remote_occurrences')) return [[]];
      if (sql.startsWith('UPDATE mail_writebacks SET is_current=')) {
        const old = admitted.find(op => op.id === args[2]); Object.assign(old, { is_current: 0, state: args[0] });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO mail_writebacks')) {
        admitted.push({ id: args[0], user_id: args[1], email_id: args[3], action: args[4], target_value: args[5],
          intent_revision: args[11], is_current: 1, state: 'queued', dispatched: 0 });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT id FROM mail_accounts WHERE id')) return [[{ id: 'account' }]];
      if (sql.startsWith('SELECT paused_reason FROM mail_engine_accounts')) return [[{ paused_reason: null }]];
      if (sql.includes('SELECT id FROM mail_writebacks WHERE id')) return [[{ id: admitted.at(-1).id }]];
      if (sql.includes('SELECT * FROM mail_engine_jobs')) return [[]];
      if (sql.startsWith('INSERT INTO mail_engine_jobs')) { jobs.push(args[4]); return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  setDb({ execute: cx.execute, getConnection: async () => cx });
  const first = await writes.mutateMessages('owner', ['item'], { read: true }, async () => {}, { idempotencyKey: 'request-1' });
  assert.equal(first.operation_ids.length, 1); assert.deepEqual(jobs, first.operation_ids);
  const second = await writes.mutateMessages('owner', ['item'], { read: 1 }, async () => {}, { idempotencyKey: 'request-1' });
  assert.deepEqual(second, first); assert.equal(admitted.length, 1);
  await assert.rejects(writes.mutateMessages('owner', ['item'], { read: false }, async () => {}, { idempotencyKey: 'request-1' }), { status: 409 });
  assert.equal(admitted.length, 1);
  const reversed = await writes.mutateMessages('owner', ['item'], { read: false }, async () => {}, { idempotencyKey: 'request-2' });
  assert.notEqual(reversed.operation_ids[0], first.operation_ids[0]); assert.equal(admitted.length, 2);
  assert.equal(admitted[0].is_current, 0); assert.equal(admitted[1].is_current, 1);
  assert(history.some(sql => sql.includes('FOR UPDATE')));
  await new Promise(resolve => setImmediate(resolve));
  // Each admission that queued a change starts it; a replay or refused key does not.
  assert.deepEqual(nudged, [['account', { foreground: true }], ['account', { foreground: true }]]);
});
test('dispatch attempt is committed before mutation and stale lease cannot fence another write', async () => {
  const steps: FixtureValue[] = [], op = { id: 'op', user_id: 'owner', mail_account_id: 'account', email_id: 'item', state: 'queued',
    remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9,
    is_current: 1, dispatched: 0 }, engine = { generation: 1, is_active: 1, sync_mode: 'sync', disconnected_at: null };
  let leaseActive = true;
  const cx: FixtureValue = { beginTransaction: async () => { steps.push('begin'); }, commit: async () => { steps.push('commit'); },
    rollback: async () => { steps.push('rollback'); }, release() {},
    execute: async (sql: string, args: FixtureValue) => {
      steps.push(sql);
      if (sql.includes('SELECT * FROM mail_writebacks WHERE id')) return [[op]];
      if (sql.includes('SELECT o.id FROM mail_remote_occurrences o')) return [[{ id: 'source' }]];
      if (sql.includes('FROM mail_engine_accounts a') && sql.includes('lease_owner')) return [leaseActive ? [{ generation: 1 }] : []];
      if (sql.includes('SELECT e.generation, a.is_active')) return [[engine]];
      if (sql.includes('SELECT * FROM mail_operation_attempts WHERE id')) return [[{ id: args[0] }]];
      return [{ affectedRows: 1 }];
    } };
  setDb({ execute: cx.execute, getConnection: async () => cx });
  const id = await ops.beginDispatch(op, 1, '9007199254740993123', 'worker', 'job');
  assert.match(id, /^[0-9a-f-]{36}$/);
  const journal = steps.findIndex(s => s.startsWith('INSERT INTO mail_operation_attempts'));
  const fence = steps.findIndex(s => s.startsWith('UPDATE mail_writebacks SET state ='));
  const commit = steps.lastIndexOf('commit');
  assert(journal > 0 && fence > journal && commit > fence);
  leaseActive = false;
  await assert.rejects(ops.beginDispatch(op, 1, '9007199254740993123', 'worker', 'job'), { code: 'STALE_FENCE' });
  assert.equal(steps.filter(s => s.startsWith('INSERT INTO mail_operation_attempts')).length, 1);
});
test('no-COPYUID after crash performs only bounded reads, records ambiguity and never repeats MOVE', async t => {
  const transport = require('../dist/src/services/mail-engine/transport');
  const calls: FixtureValue[] = [];
  t.mock.method(transport, 'nativeMove', () => { assert.fail('second MOVE must not run'); });
  t.mock.method(transport, 'selectMailbox', async (_: FixtureValue, { folder, readOnly }: FixtureValue) => {
    calls.push(['select', folder, readOnly]);
    return { uidvalidity: folder === 'INBOX' ? 9 : 10, uidnext: 400 };
  });
  t.mock.method(transport, 'fetchMetadataWindow', async (_: FixtureValue, request: FixtureValue) => {
    calls.push(['fetch', request.folder, request.startUid, request.endUid]);
    return { items: [], complete: true };
  });
  let state = 'executing', recorded, attemptNeedsAttention = false;
  const op = { id: 'op', user_id: 'owner', mail_account_id: 'account', email_id: 'item', action: 'move',
    state, status: 'pending', is_current: 1, dispatched: 1, attempts: 1, available_at: null,
    remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, target_value: 'Filed' };
  const cx: FixtureValue = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql: string, args: FixtureValue) => {
      if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
      if (sql.includes('FROM mail_engine_accounts a') && sql.includes('lease_owner')) return [[{ generation: 1 }]];
      if (sql.includes('SELECT e.generation, a.is_active')) return [[{ generation: 1, is_active: 1, sync_mode: 'sync' }]];
      if (sql.includes('SELECT observation_revision FROM emails')) return [[{ observation_revision: 0 }]];
      if (sql.includes('SELECT * FROM mail_writebacks WHERE mail_account_id=')) return [[op]];
      if (sql.includes('SELECT * FROM mail_writebacks WHERE id')) return [[op]];
      if (sql.startsWith('UPDATE mail_writebacks SET state=')) {
        state = 'needs_attention'; recorded = JSON.parse(args[3]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("UPDATE mail_operation_attempts SET outcome='needs_attention'")) {
        assert.deepEqual(args, ['op', 'owner', 'account']);
        attemptNeedsAttention = true; return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL ${sql}`);
    } };
  setDb({ execute: cx.execute, getConnection: async () => cx });
  assert.deepEqual(await ops.processDueOperations({ id: 'account', user_id: 'owner' }, {},
    { workerId: 'worker', workerGeneration: 1, jobId: 'job' }), { needsSync: false, connectionFailed: false });
  assert.equal(state, 'needs_attention');
  assert.equal(attemptNeedsAttention, true, 'Unresolved attempt must not remain falsely reconciling after its bounded check');
  assert.deepEqual(recorded, { kind: 'bounded_move_check', sourceEpochValid: true, sourcePresent: false,
    destinationEpoch: 10, destinationWindow: [272, 399], destinationCount: 0, mapping: null, prior: null });
  assert.deepEqual(calls, [['select', 'INBOX', true], ['fetch', 'INBOX', 12, 12],
    ['select', 'Filed', true], ['fetch', 'Filed', 272, 399]]);
});
test('cancellation or lease loss between SELECT and FETCH prevents every subsequent provider command', async t => {
  const transport = require('../dist/src/services/mail-engine/transport');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const op = { id: 'flag', user_id: 'owner', mail_account_id: 'account', email_id: 'item',
    action: 'read', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 };
  let fence = 'valid', commands = 0;
  t.mock.method(runtime, 'assertFence', async () => {
    if (fence === 'lost') throw Object.assign(new Error('expired'), { code: 'MAIL_WORKER_FENCED' });
    return { cancellationRequested: fence === 'cancelled' };
  });
  t.mock.method(transport, 'selectMailbox', async () => {
    commands++;
    fence = fence === 'valid' ? 'cancelled' : 'lost';
    return { uidvalidity: 9 };
  });
  t.mock.method(transport, 'fetchMetadataWindow', () => assert.fail('FETCH after cancellation/fence loss'));
  t.mock.method(transport, 'setFlag', () => assert.fail('STORE after cancellation/fence loss'));
  setDb({ execute: async (sql: string) => {
    if (sql.includes('SELECT observation_revision FROM emails')) return [[{ observation_revision: 0 }]];
    if (sql.includes('backup_restore_jobs') || sql.includes('user_settings')) return [[]];
    throw new Error(`Unexpected SQL ${sql}`);
  } });
  await assert.rejects(ops.applyFlag(op, {}, 1, null, 'worker', 'job'), { code: 'MAIL_WORKER_FENCED' });
  assert.equal(commands, 1);
  fence = 'lost';
  await assert.rejects(ops.applyFlag(op, {}, 1, null, 'worker', 'job'), { code: 'MAIL_WORKER_FENCED' });
  assert.equal(commands, 1, 'lease loss before SELECT makes zero further commands');
});
test('stale scan revision cannot repaint a confirmed flag after overlay retires', async () => {
  const f: FixtureValue = model(); f.op.action = 'read'; f.op.target_value = '1'; f.op.state = 'verifying';
  f.email.observation_revision = 7;
  const result = await settle.settleFlagObservation({ operationId: 'op1', userId: 'owner', accountId: 'account',
    source: { folder: 'INBOX', uid: 12, uidvalidity: 9 }, flags: ['\\Seen', '$custom'],
    modseq: '9007199254740993123', observationRevision: 6, executor: f.cx });
  assert.deepEqual(result, { settled: false, reason: 'stale_observation' });
  assert(!f.commands.some((item: FixtureValue) => item.sql.includes('UPDATE emails SET is_read=')));
});
