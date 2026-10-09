import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { getDb, setDb } = require('../dist/src/state');
const account = { id: 'account', user_id: 'owner', sync_mode: 'sync' };
const job = { id: 'job', operation_id: 'op', mail_account_id: 'account', user_id: 'owner',
  lease_owner: 'worker', worker_generation: 9, kind: 'reconcile' };
const source = { id: 'src', remote_name: 'INBOX', slug: 'inbox', uidvalidity: 123 };
const destination = { id: 'dst', remote_name: 'Archive', slug: 'archive', uidvalidity: 456 };
const base = { id: 'op', user_id: 'owner', mail_account_id: 'account', email_id: 'email',
  action: 'move', state: 'reconciling', dispatched: 1, remote_folder: 'INBOX', remote_uid: 8,
  remote_uidvalidity: 123, target_value: 'Archive' };

test('recovered MOVE delegates fenced outcome check without a second mutation', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  const op = { ...base, evidence_json: JSON.stringify({ kind: 'move_outcome', completion: 'ok', mappingStatus: 'valid',
    mapping: { uidvalidity: 456, sourceUids: [8], destinationUids: [22] } }) };
  setDb({ async execute(sql: string, params: FixtureValue) {
    if (sql.includes('SELECT * FROM mail_writebacks')) return [[op]];
    if (sql.includes('FROM mail_remote_mailboxes')) return [[source, destination]];
    if (sql.includes('SELECT state FROM mail_writebacks')) return [[{ state: op.state }]];
    assert.fail(sql);
  } });
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const operations = require('../dist/src/services/mail-engine/operations');
  const transport = require('../dist/src/services/mail-engine/transport');
  const checked: FixtureValue[] = [], queued: FixtureValue[] = [];
  t.mock.method(runtime, 'assertFence', async () => {});
  t.mock.method(runtime, 'enqueueJob', async (input: FixtureValue) => { queued.push(input); });
  t.mock.method(transport, 'nativeMove', async () => assert.fail('recovery must never MOVE'));
  t.mock.method(transport, 'setFlag', async () => assert.fail('recovery must never STORE'));
  t.mock.method(operations, 'applyMove', async (...args: FixtureValue[]) => { checked.push(args); op.state = 'confirmed'; });
  const { runRecoveredReconcileJob } = require('../dist/src/services/mail');
  const result = await runRecoveredReconcileJob({ job, account, connection: {}, signal: new AbortController().signal,
    report() {} });
  assert.equal(result.success, true);
  assert.equal(result.more, undefined);
  assert.equal(checked.length, 1);
  assert.equal(checked[0][0], op);
  assert.deepEqual(checked[0].slice(2, 3), [9]);
  assert.deepEqual(queued.map(x => x.kind), ['sync']);
});

test('missing COPYUID delegates bounded attention transition without guessed destination', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  const op = { ...base, evidence_json: JSON.stringify({ kind: 'move_outcome', mappingStatus: 'missing' }) };
  setDb({ async execute(sql: string) {
    if (sql.includes('SELECT * FROM mail_writebacks')) return [[op]];
    if (sql.includes('FROM mail_remote_mailboxes')) return [[source, destination]];
    if (sql.includes('SELECT state FROM mail_writebacks')) return [[{ state: 'reconciling' }]];
    assert.fail(sql);
  } });
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const operations = require('../dist/src/services/mail-engine/operations');
  const checked = [], queued: FixtureValue[] = [];
  t.mock.method(runtime, 'assertFence', async () => {});
  t.mock.method(runtime, 'enqueueJob', async (input: FixtureValue) => { queued.push(input); });
  t.mock.method(operations, 'applyMove', async (...args: FixtureValue[]) => { checked.push(args); op.state = 'needs_attention'; });
  const { runRecoveredReconcileJob } = require('../dist/src/services/mail');
  const result = await runRecoveredReconcileJob({ job, account, connection: {}, signal: new AbortController().signal,
    report() {} });
  assert.equal(checked.length, 1);
  assert.equal(result.success, true); assert.equal(result.more, undefined);
  assert.deepEqual(queued, []);
});

test('recovered flag readback settles only exact converged desired bit without STORE', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  const op = { ...base, action: 'star', target_value: '1' };
  setDb({ async execute(sql: string) {
    if (sql.includes('SELECT * FROM mail_writebacks')) return [[op]];
    if (sql.includes('FROM mail_remote_mailboxes')) return [[source]];
    if (sql.includes('SELECT observation_revision')) return [[{ observation_revision: 5 }]];
    assert.fail(sql);
  } });
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const transport = require('../dist/src/services/mail-engine/transport');
  const reconciliation = require('../dist/src/services/mail-engine/reconciliation');
  const settled: FixtureValue[] = [];
  t.mock.method(runtime, 'assertFence', async () => {});
  t.mock.method(transport, 'selectMailbox', async (_cx: FixtureValue, opts: FixtureValue) => {
    assert.equal(opts.readOnly, true); return { uidvalidity: 123 };
  });
  t.mock.method(transport, 'fetchMetadataWindow', async (_cx: FixtureValue, opts: FixtureValue) => ({ complete: true,
    uidvalidity: 123, startUid: opts.startUid, endUid: opts.endUid,
    items: [{ uid: 8, flags: ['\\Flagged'], modseq: '9007199254740993' }] }));
  t.mock.method(transport, 'setFlag', async () => assert.fail('no flag mutation in recovered readback'));
  t.mock.method(reconciliation, 'settleFlagObservation', async (input: FixtureValue) => (settled.push(input), { settled: true }));
  const { runRecoveredReconcileJob } = require('../dist/src/services/mail');
  const result = await runRecoveredReconcileJob({ job, account, connection: {}, signal: new AbortController().signal,
    report() {} });
  assert.equal(result.success, true); assert.equal(result.more, undefined);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].modseq, '9007199254740993');
  assert.equal(settled[0].observationRevision, 5);
  assert.equal(settled[0].workerGeneration, 9);
});
