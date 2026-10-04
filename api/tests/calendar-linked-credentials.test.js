const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');

function stub(path, exports) { require.cache[path] = { id: path, filename: path, loaded: true, exports }; }

test('a mail login change or disconnect reaches the linked calendar only while Calendar is on and not being restored', async t => {
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
  stub(paths[2], { syncCalendarAccountInBackground: id => syncs.push(id), deleteCalendarAccount: async () => {}, MAIL_DISCONNECTED_MESSAGE: 'disconnected' });
  delete require.cache[paths[3]];
  setDb({ execute: async (sql, params) => {
    if (sql.startsWith('SELECT id, email_address')) return [[{ id: 'mail', email_address: 'owner@example.test', username: 'owner', encrypted_password: 'enc', is_active: 1 }]];
    if (sql.startsWith('SELECT id FROM calendar_accounts')) return [[{ id: 'calendar-account' }]];
    if (sql.startsWith('UPDATE calendar_accounts')) { writes.push(params); return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected SQL ${sql}`);
  } });
  const { updateLinkedCalendarCredentials, pauseLinkedCalendar } = require('../src/services/calendar-accounts');

  for (const change of [updateLinkedCalendarCredentials, pauseLinkedCalendar]) {
    state.calendar = false; state.restoring = false;
    await change('owner', 'mail');
    state.calendar = true; state.restoring = true;
    await change('owner', 'mail');
  }
  assert.deepEqual(writes, []); assert.deepEqual(syncs, []);

  state.restoring = false;
  await updateLinkedCalendarCredentials('owner', 'mail');
  assert.equal(writes.length, 1); assert.deepEqual(syncs, ['calendar-account']);
  await pauseLinkedCalendar('owner', 'mail');
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], ['disconnected', 'calendar-account']);
});

test('calendar sync rechecks the linked mail account under its lock and pauses instead of logging in', async t => {
  const paths = ['../src/services/module-settings', '../src/services/restore-locks', '../src/services/caldav', '../src/services/calendar-sync']
    .map(path => require.resolve(path));
  const saved = paths.map(path => require.cache[path]);
  const savedDb = getDb();
  t.after(() => {
    setDb(savedDb);
    paths.forEach((path, index) => { if (saved[index]) require.cache[path] = saved[index]; else delete require.cache[path]; });
  });
  stub(paths[0], { isModuleEnabled: async () => true, isModuleBackgroundEnabled: async () => true });
  stub(paths[1], { isSectionRestoreActive: async () => false });
  stub(paths[2], new Proxy({}, { get: (_target, name) => () => assert.fail(`CalDAV ${String(name)} must not be called`) }));
  delete require.cache[paths[3]];
  const order = [];
  const execute = async (sql, params) => {
    if (sql.startsWith('SELECT * FROM calendar_accounts')) {
      order.push('load');
      return [[{ id: 'calendar-account', user_id: 'owner', provider: 'caldav', mail_account_id: 'mail', is_active: 1, encrypted_password: 'copied' }]];
    }
    if (sql.includes('GET_LOCK')) { order.push('lock'); return [[{ acquired: 1 }]]; }
    if (sql.includes('RELEASE_LOCK')) return [[{}]];
    if (sql.startsWith('SELECT is_active, disconnected_at')) {
      order.push('mail');
      return [[{ is_active: 0, disconnected_at: '2026-10-04 12:00:00', encrypted_password: null }]];
    }
    if (sql.startsWith('UPDATE calendar_accounts SET is_active = FALSE')) { order.push(['pause', params]); return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected SQL ${sql}`);
  };
  setDb({ execute, getConnection: async () => ({ execute, release() {} }) });
  const { syncCalendarAccount, MAIL_DISCONNECTED_MESSAGE } = require('../src/services/calendar-sync');

  assert.deepEqual(await syncCalendarAccount('calendar-account', { userId: 'owner' }), { skipped: true, reason: 'mail-disconnected' });
  assert.deepEqual(order, ['load', 'lock', 'load', 'mail', ['pause', [MAIL_DISCONNECTED_MESSAGE, 'calendar-account', 'owner']]]);
});
