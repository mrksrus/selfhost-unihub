const test = require('node:test');
const assert = require('node:assert/strict');
const { pauseMailRestore, restoreMailEngineEvidence } = require('../src/services/backup-mail-engine');
const { TABLE_POLICIES, SECTION_POLICIES } = require('../src/services/backup-catalog');
const { normalizeBackupPayload, BACKUP_VERSION } = require('../src/services/backup-format');

function executor() {
  const calls = [];
  return { calls, async execute(sql, params = []) {
    calls.push({ sql, params });
    assert.equal((sql.match(/\?/g) || []).length, params.length, `Parameter count: ${sql}`);
    if (sql.startsWith('SELECT mail_account_id FROM emails')) return [[{ mail_account_id: 'target-account' }]];
    return [[]];
  } };
}
const options = () => ({ accountIds: new Map([['source-account', 'target-account']]),
  emailIds: new Map([['source-email', 'target-email']]), writtenEmailIds: new Set(), restoredPaths: new Map(),
  checkCancelled: async () => {}, warnings: [] });
const operation = { id: 'old-operation', user_id: 'untrusted-owner', mail_account_id: 'source-account', email_id: 'source-email',
  action: 'move', target_value: 'Archive', base_value: 'INBOX', target_folder: 'archive', remote_folder: 'INBOX',
  remote_uid: 42, remote_uidvalidity: 7, status: 'pending', state: 'reconciling', dispatched: true, attempts: 1, intent_revision: '3' };

test('v4 explicitly exports operations, attempts, receipts and remote evidence in the mail section', () => {
  assert.equal(BACKUP_VERSION, 4);
  for (const name of ['mail_writebacks','mail_operation_attempts','mail_command_receipts','mail_remote_occurrences','mail_engine_quarantine']) {
    assert.ok(SECTION_POLICIES.mail.tables.includes(name));
    assert.equal(TABLE_POLICIES[name].fieldPolicies.user_id, 'quarantine_provider_evidence');
  }
  const input = { app: 'unihub', version: 4, data: { mail_writebacks: [operation] }, files: [] };
  const result = normalizeBackupPayload(input);
  assert.deepEqual(result.data.mail_writebacks, [operation]);
  assert.notEqual(result.data.mail_writebacks[0], input.data.mail_writebacks[0]);
});

test('restore pauses dispatch and preserves installation intent journal instead of deleting it', async () => {
  const db = executor(); await pauseMailRestore(db, 'owner');
  assert.ok(db.calls.every(call => !/DELETE\s+FROM/i.test(call.sql)));
  assert.ok(db.calls.every(call => call.params.at(-1) === 'owner'));
  assert.match(db.calls[0].sql, /is_active = FALSE/);
  assert.match(db.calls[1].sql, /generation = generation \+ 1/);
  assert.match(db.calls.at(-1).sql, /restore_requires_revalidation/);
  assert.match(db.calls.at(-1).sql, /is_current = FALSE/);
  // Additive migration leaves pre-classification operations with state=NULL;
  // SQL NOT IN alone silently excludes those accepted destination intents.
  assert.match(db.calls.at(-1).sql, /state IS NULL OR state NOT IN/);
});

test('unknown MOVE is restored as review evidence, never executable work or a confirmed success', async () => {
  const db = executor(), opts = options();
  await restoreMailEngineEvidence(db, 'owner', { mail_writebacks: [operation] }, opts);
  const write = db.calls.find(call => call.sql.startsWith('INSERT INTO mail_writebacks'));
  assert.ok(write); assert.notEqual(write.params[0], operation.id);
  assert.equal(write.params[1], 'owner'); assert.equal(write.params[2], 'target-account');
  assert.equal(write.params[3], 'target-email'); assert.equal(write.params[11], 'conflict');
  assert.equal(write.params[13], 1); assert.equal(write.params[16], 'needs_attention');
  assert.match(write.sql, /FALSE/); // No active overlay or runnable job.
  assert.ok(db.calls.every(call => !/INSERT INTO mail_engine_jobs/.test(call.sql)));
  assert.ok(opts.warnings.some(message => /never blindly replayed/.test(message)));
});

test('confirmed operations preserve completion and original provenance', async () => {
  const db = executor();
  await restoreMailEngineEvidence(db, 'owner', { mail_writebacks: [{ ...operation, status: 'done', state: 'confirmed' }] }, options());
  const write = db.calls.find(call => call.sql.startsWith('INSERT INTO mail_writebacks'));
  assert.equal(write.params[11], 'done'); assert.equal(write.params[16], 'confirmed');
  assert.equal(JSON.parse(write.params.at(-1)).archive_operation_id, operation.id);
});

test('restored mapping and attempt IDs cannot collide across owners or authorize live occurrences', async () => {
  const db = executor();
  const row = { id: 'same-old-id', user_id: 'another-owner', mail_account_id: 'source-account', email_id: 'source-email', uid: 42, uidvalidity: 7, presence: 'present' };
  await restoreMailEngineEvidence(db, 'owner', { mail_remote_occurrences: [row] }, options());
  const write = db.calls.find(call => call.sql.startsWith('INSERT INTO mail_engine_quarantine'));
  assert.notEqual(write.params[1], row.id); assert.equal(write.params[2], 'owner');
  const evidence = JSON.parse(write.params[4]);
  assert.equal(evidence.archive.id, row.id); assert.equal(evidence.archive.user_id, undefined);
  assert.ok(db.calls.every(call => !call.sql.startsWith('INSERT INTO mail_remote_occurrences')));
});

test('idempotency receipt is retained and remapped; no restored request silently becomes replayable', async () => {
  const db = executor();
  await restoreMailEngineEvidence(db, 'owner', { mail_writebacks: [operation], mail_command_receipts: [{
    client_key: 'client-request', request_hash: 'a'.repeat(64), response_json: { sync_pending: true, operation_ids: [operation.id] },
  }] }, options());
  const write = db.calls.find(call => call.sql.startsWith('INSERT INTO mail_writebacks'));
  const receipt = db.calls.find(call => call.sql.startsWith('INSERT INTO mail_command_receipts'));
  const response = JSON.parse(receipt.params[3]);
  assert.equal(response.recovery_required, true); assert.deepEqual(response.operation_ids, [write.params[0]]);
});

test('restore fails on a conflicting existing idempotency key instead of overwriting it', async () => {
  const db = executor(), original = db.execute.bind(db);
  db.execute = async (sql, params) => sql.startsWith('SELECT request_hash') ? [[{ request_hash: 'b'.repeat(64) }]] : original(sql, params);
  await assert.rejects(restoreMailEngineEvidence(db, 'owner', { mail_command_receipts: [{
    client_key: 'same-key', request_hash: 'a'.repeat(64), response_json: { operation_ids: [] },
  }] }, options()), /conflicts with an existing/);
});
