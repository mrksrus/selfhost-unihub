const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');

function stub(path, exports) { require.cache[path] = { id: path, filename: path, loaded: true, exports }; }

test('a mail login change reaches the linked calendar only while Calendar is on and not being restored', async t => {
  const paths = ['../src/services/module-settings', '../src/services/restore-locks', '../src/services/calendar-sync', '../src/services/calendar-accounts']
    .map(path => require.resolve(path));
  const saved = paths.map(path => require.cache[path]);
  const savedDb = getDb();
  t.after(() => {
    setDb(savedDb);
    paths.forEach((path, index) => { if (saved[index]) require.cache[path] = saved[index]; else delete require.cache[path]; });
  });
  const state = { calendar: true, restoring: false }, writes = [], syncs = [];
  stub(paths[0], { isModuleEnabled: async (_userId, id) => id !== 'calendar' || state.calendar });
  stub(paths[1], { isSectionRestoreActive: async (_userId, section) => section === 'calendar' && state.restoring });
  stub(paths[2], { syncCalendarAccountInBackground: id => syncs.push(id), deleteCalendarAccount: async () => {} });
  delete require.cache[paths[3]];
  setDb({ execute: async (sql, params) => {
    if (sql.startsWith('SELECT id, email_address')) return [[{ id: 'mail', email_address: 'owner@example.test', username: 'owner', encrypted_password: 'enc', is_active: 1 }]];
    if (sql.startsWith('SELECT id FROM calendar_accounts')) return [[{ id: 'calendar-account' }]];
    if (sql.startsWith('UPDATE calendar_accounts')) { writes.push(params); return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected SQL ${sql}`);
  } });
  const { updateLinkedCalendarCredentials } = require('../src/services/calendar-accounts');

  state.calendar = false;
  await updateLinkedCalendarCredentials('owner', 'mail');
  state.calendar = true; state.restoring = true;
  await updateLinkedCalendarCredentials('owner', 'mail');
  assert.deepEqual(writes, []); assert.deepEqual(syncs, []);

  state.restoring = false;
  await updateLinkedCalendarCredentials('owner', 'mail');
  assert.equal(writes.length, 1); assert.deepEqual(syncs, ['calendar-account']);
});
