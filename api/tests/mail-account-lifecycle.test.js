const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');

function fixture(t, settings = {}) {
  const savedDb = getDb();
  const servicePath = require.resolve('../src/services/mail');
  const lifecyclePath = require.resolve('../src/services/mail-account-lifecycle');
  const savedService = require.cache[servicePath], savedLifecycle = require.cache[lifecyclePath];
  const calls = [], cancellations = [];
  const state = { owned: true, active: false, unresolved: 0, recovered: 0, ...settings };
  const execute = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM backup_restore_jobs')) return [[]];
    if (sql.startsWith('SELECT id') && sql.includes('FROM mail_accounts')) {
      return [state.owned && params[1] === 'owner' ? [{ id: 'account', is_active: state.active ? 1 : 0 }] : []];
    }
    if (sql.startsWith('SELECT COUNT(*) AS email_count')) return [[{ email_count: 2, raw_count: 0, recovered_elsewhere: state.recovered }]];
    if (sql.startsWith('SELECT COUNT(*) AS attachment_count')) return [[{ attachment_count: 0 }]];
    if (sql.startsWith('SELECT COUNT(*) AS unresolved_operations')) return [[{ unresolved_operations: state.unresolved }]];
    if (sql.startsWith('SELECT id, raw_storage_path FROM emails')) return [[{ id: 'message', raw_storage_path: null }]];
    if (sql.startsWith('SELECT a.storage_path')) return [[]];
    if (sql.startsWith('UPDATE mail_accounts')) { state.active = false; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE mail_server_messages') || sql.startsWith('DELETE FROM mail_accounts') || sql.startsWith('DELETE FROM mail_engine_quarantine')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  };
  const connection = { execute, beginTransaction: async () => calls.push({ sql: 'BEGIN' }), commit: async () => calls.push({ sql: 'COMMIT' }),
    rollback: async () => calls.push({ sql: 'ROLLBACK' }), release() {} };
  setDb({ execute, getConnection: async () => connection });
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    stopMailAccountWork: async id => cancellations.push(id),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  } };
  delete require.cache[lifecyclePath];
  const api = require('../src/services/mail-account-lifecycle');
  t.after(() => {
    setDb(savedDb);
    if (savedService) require.cache[servicePath] = savedService; else delete require.cache[servicePath];
    if (savedLifecycle) require.cache[lifecyclePath] = savedLifecycle; else delete require.cache[lifecyclePath];
  });
  return { api, calls, cancellations, state };
}

test('disconnect clears credentials and deletion policy but retains every mail/operation row', async t => {
  const { api, calls, cancellations } = fixture(t, { active: true, unresolved: 1 });
  const result = await api.disconnectAccount('owner', 'account');
  assert.equal(result.retained_mail, true); assert.equal(result.disconnected, true);
  assert.deepEqual(cancellations, ['account']);
  assert.ok(calls.every(call => !/DELETE FROM/.test(call.sql)));
  assert.match(calls.find(call => call.sql.startsWith('UPDATE mail_accounts')).sql, /encrypted_password = NULL/);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('another owner cannot inspect or disconnect an account', async t => {
  const { api, calls, cancellations } = fixture(t);
  await assert.rejects(api.purgePreview('foreign-owner', 'account'), error => error.status === 404);
  await assert.rejects(api.disconnectAccount('foreign-owner', 'account'), error => error.status === 404);
  await assert.rejects(api.purgeAccount('foreign-owner', 'account', 'account'), error => error.status === 404);
  assert.deepEqual(cancellations, []);
  assert.ok(calls.every(call => !/^(UPDATE|DELETE)/.test(call.sql)));
});

test('purge needs explicit matching confirmation before any cancellation or deletion', async t => {
  const { api, calls, cancellations } = fixture(t);
  await assert.rejects(api.purgeAccount('owner', 'account', 'another-account'), error => error.status === 400);
  assert.deepEqual(calls, []); assert.deepEqual(cancellations, []);
});

test('purge is blocked for a still connected account', async t => {
  const { api, calls } = fixture(t, { active: true });
  const preview = await api.purgePreview('owner', 'account');
  assert.equal(preview.blocked, true); assert.match(preview.reason, /Disconnect/);
  await assert.rejects(api.purgeAccount('owner', 'account', 'account'), error => error.status === 409);
  assert.ok(calls.every(call => !call.sql.startsWith('DELETE FROM')));
});

test('purge protects unresolved provider effects and original source of recovered mail', async t => {
  const { api, calls, state } = fixture(t, { unresolved: 1 });
  assert.equal((await api.purgePreview('owner', 'account')).unresolved_operations, 1);
  await assert.rejects(api.purgeAccount('owner', 'account', 'account'), /unresolved outcome/);
  state.unresolved = 0; state.recovered = 1;
  await assert.rejects(api.purgeAccount('owner', 'account', 'account'), /source of mail retained/);
  assert.ok(calls.every(call => !call.sql.startsWith('DELETE FROM')));
});

test('explicit eligible purge deletes only the owned disconnected account after final locked preview', async t => {
  const { api, calls } = fixture(t);
  const result = await api.purgeAccount('owner', 'account', 'account');
  assert.equal(result.purged, true);
  const removes = calls.filter(call => call.sql.startsWith('DELETE FROM'));
  assert.equal(removes.length, 2);
  assert.match(removes[0].sql, /mail_engine_quarantine/);
  assert.match(removes[1].sql, /mail_accounts/);
  for (const removal of removes) assert.deepEqual(removal.params, ['account', 'owner']);
  assert.ok(calls.findIndex(call => call.sql.includes('FROM emails') && call.sql.includes('FOR UPDATE')) < calls.indexOf(removes[0]));
  assert.match(result.message, /Provider mail was not changed/);
});
