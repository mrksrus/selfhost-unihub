const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');

function fixture(t, settings = {}) {
  const savedDb = getDb();
  const servicePath = require.resolve('../src/services/mail');
  const lifecyclePath = require.resolve('../src/services/mail-account-lifecycle');
  const modulesPath = require.resolve('../src/services/module-settings');
  const savedService = require.cache[servicePath], savedLifecycle = require.cache[lifecyclePath], savedModules = require.cache[modulesPath];
  const calls = [], cancellations = [];
  const state = { owned: true, active: false, unresolved: 0, recovered: 0, calendars: 0, calendarEnabled: true, restoring: [], unresolvedAfterDisconnect: 0, ...settings };
  const execute = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM backup_restore_jobs')) return [state.restoring.length ? [{ requested_sections: JSON.stringify(state.restoring) }] : []];
    if (sql.startsWith('SELECT COUNT(DISTINCT ca.id)')) return [[{ calendar_accounts: state.calendars, calendar_events: state.calendars * 3 }]];
    if (sql.startsWith('SELECT id') && sql.includes('FROM mail_accounts')) {
      return [state.owned && params[1] === 'owner' ? [{ id: 'account', is_active: state.active ? 1 : 0 }] : []];
    }
    if (sql.startsWith('SELECT COUNT(*) AS email_count')) return [[{ email_count: 2, raw_count: 0, recovered_elsewhere: state.recovered }]];
    if (sql.startsWith('SELECT COUNT(*) AS attachment_count')) return [[{ attachment_count: 0 }]];
    if (sql.startsWith('SELECT COUNT(*) AS unresolved_operations')) return [[{ unresolved_operations: state.unresolved }]];
    if (sql.startsWith('SELECT id, raw_storage_path FROM emails')) return [[{ id: 'message', raw_storage_path: null }]];
    if (sql.startsWith('SELECT a.storage_path')) return [[]];
    if (sql.startsWith('SELECT id FROM calendar_accounts')) return [Array.from({ length: state.calendars }, (_, index) => ({ id: `calendar-account-${index}` }))];
    if (sql.startsWith('SELECT id FROM calendar_calendars')) return [state.calendars ? [{ id: 'calendar' }] : []];
    if (/^DELETE FROM calendar_(events|calendars|accounts)/.test(sql)) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE mail_accounts')) { state.active = false; state.unresolved += state.unresolvedAfterDisconnect; return [{ affectedRows: 1 }]; }
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
  require.cache[modulesPath] = { id: modulesPath, filename: modulesPath, loaded: true, exports: {
    isModuleEnabled: async (_userId, id) => id !== 'calendar' || state.calendarEnabled,
  } };
  delete require.cache[lifecyclePath];
  const api = require('../src/services/mail-account-lifecycle');
  t.after(() => {
    setDb(savedDb);
    if (savedService) require.cache[servicePath] = savedService; else delete require.cache[servicePath];
    if (savedLifecycle) require.cache[lifecyclePath] = savedLifecycle; else delete require.cache[lifecyclePath];
    if (savedModules) require.cache[modulesPath] = savedModules; else delete require.cache[modulesPath];
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
  const commit = calls.findIndex(call => call.sql === 'COMMIT');
  assert.ok(commit >= 0 && calls.every((call, index) => index < commit || !/^(UPDATE|DELETE|INSERT)/.test(call.sql)), 'Every write is inside the commit');
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
  assert.match(result.message, /Provider mail and events were not changed/);
});

test('preview counts the linked calendar that a purge removes', async t => {
  const { api } = fixture(t, { calendars: 1 });
  const preview = await api.purgePreview('owner', 'account');
  assert.equal(preview.calendar_accounts, 1); assert.equal(preview.calendar_events, 3); assert.equal(preview.blocked, false);
});

test('purge waits for a calendar restore only when a linked calendar would be removed', async t => {
  const { api, calls, state } = fixture(t, { calendars: 1, restoring: ['calendar'] });
  assert.match((await api.purgePreview('owner', 'account')).reason, /Calendar restore/);
  await assert.rejects(api.purgeAccount('owner', 'account', 'account'), /Calendar restore/);
  assert.ok(calls.every(call => !call.sql.startsWith('DELETE FROM')));
  state.calendars = 0;
  assert.equal((await api.purgePreview('owner', 'account')).blocked, false);
});

test('disconnect and delete removes a connected account in one confirmed step', async t => {
  const { api, calls, cancellations } = fixture(t, { active: true });
  assert.equal((await api.purgePreview('owner', 'account', undefined, { disconnecting: true })).blocked, false);
  const result = await api.disconnectAndPurgeAccount('owner', 'account', 'account');
  assert.equal(result.purged, true);
  const disconnect = calls.findIndex(call => call.sql.startsWith('UPDATE mail_accounts'));
  const remove = calls.findIndex(call => call.sql.startsWith('DELETE FROM mail_accounts'));
  assert.ok(disconnect >= 0 && disconnect < remove);
  assert.deepEqual(cancellations, ['account', 'account']);
});

test('disconnect and delete changes nothing without confirmation or when the purge is blocked', async t => {
  const { api, calls, cancellations, state } = fixture(t, { active: true });
  await assert.rejects(api.disconnectAndPurgeAccount('owner', 'account', 'other'), error => error.status === 400);
  state.unresolved = 1;
  await assert.rejects(api.disconnectAndPurgeAccount('owner', 'account', 'account'), /unresolved outcome/);
  assert.equal(state.active, true); assert.deepEqual(cancellations, []);
  assert.ok(calls.every(call => !/^(UPDATE|DELETE)/.test(call.sql)));
});

test('disconnect and delete reports a disconnected account when the final purge check refuses', async t => {
  const { api, calls, state } = fixture(t, { active: true, unresolvedAfterDisconnect: 1 });
  await assert.rejects(api.disconnectAndPurgeAccount('owner', 'account', 'account'), error =>
    error.disconnected === true && /disconnected and its local mail kept/.test(error.message));
  assert.equal(state.active, false);
  assert.ok(calls.every(call => !call.sql.startsWith('DELETE FROM')));
});

test('purge refuses to remove a linked calendar while Calendar is turned off', async t => {
  const { api, calls, cancellations } = fixture(t, { active: true, calendars: 1, calendarEnabled: false });
  assert.match((await api.purgePreview('owner', 'account', undefined, { disconnecting: true })).reason, /Calendar is turned off/);
  await assert.rejects(api.disconnectAndPurgeAccount('owner', 'account', 'account'), /Calendar is turned off/);
  assert.deepEqual(cancellations, []);
  assert.ok(calls.every(call => !/^(UPDATE|DELETE)/.test(call.sql)));
});

test('purge removes the linked calendar in the same transaction as the account', async t => {
  const { api, calls } = fixture(t, { calendars: 1 });
  await api.purgeAccount('owner', 'account', 'account');
  const order = sql => calls.findIndex(call => call.sql.startsWith(sql));
  assert.ok(order('DELETE FROM calendar_events') > order('BEGIN'));
  assert.ok(order('DELETE FROM calendar_accounts') < order('DELETE FROM mail_accounts'));
  assert.ok(order('DELETE FROM mail_accounts') < order('COMMIT'));
});

test('disconnect stops linked calendar work only after the disconnect is committed', async t => {
  const { api, calls } = fixture(t, { active: true, calendars: 1 });
  await api.disconnectAccount('owner', 'account');
  const commit = calls.findIndex(call => call.sql === 'COMMIT');
  const stop = calls.findIndex(call => call.sql.startsWith('SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ?'));
  assert.ok(commit >= 0 && stop > commit);
});
