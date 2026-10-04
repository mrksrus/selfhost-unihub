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
    if (sql.includes('SET ca.is_active = FALSE')) { order.push(['pause', params]); return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected SQL ${sql}`);
  };
  setDb({ execute, getConnection: async () => ({ execute, release() {} }) });
  const { syncCalendarAccount, MAIL_DISCONNECTED_MESSAGE } = require('../src/services/calendar-sync');

  assert.deepEqual(await syncCalendarAccount('calendar-account', { userId: 'owner' }), { skipped: true, reason: 'mail-disconnected' });
  assert.deepEqual(order, ['load', 'lock', 'load', 'mail', ['pause', [MAIL_DISCONNECTED_MESSAGE, 'calendar-account', 'owner']]]);
});

test('a calendar writeback refuses and pauses the account when its mail account is disconnected', async t => {
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
  const pauses = [];
  setDb({ execute: async (sql, params) => {
    if (sql.includes('FROM calendar_calendars c JOIN calendar_accounts a')) return [[{ calendar_row_id: 'calendar', account_id: 'calendar-account', read_only: 0 }]];
    if (sql.startsWith('SELECT * FROM calendar_accounts')) return [[{ id: 'calendar-account', user_id: 'owner', provider: 'caldav', mail_account_id: 'mail', is_active: 1, encrypted_password: 'copied' }]];
    if (sql.startsWith('SELECT is_active, disconnected_at')) return [[{ is_active: 0, disconnected_at: '2026-10-04 12:00:00', encrypted_password: null }]];
    if (sql.includes('SET ca.is_active = FALSE')) { pauses.push(params); return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected SQL ${sql}`);
  } });
  const { pushCreatedEvent } = require('../src/services/calendar-sync');
  await assert.rejects(pushCreatedEvent({ userId: 'owner', event: { id: 'event', calendar_id: 'calendar', title: 'Meeting' } }),
    error => error.status === 409 && error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  assert.equal(pauses.length, 1);
});

function calendarSyncFixture(t, { modules = () => true, mailConnected = false, active = false } = {}) {
  const paths = ['../src/services/module-settings', '../src/services/restore-locks', '../src/services/caldav', '../src/services/calendar-sync']
    .map(path => require.resolve(path));
  const saved = paths.map(path => require.cache[path]);
  const savedDb = getDb();
  t.after(() => {
    setDb(savedDb);
    paths.forEach((path, index) => { if (saved[index]) require.cache[path] = saved[index]; else delete require.cache[path]; });
  });
  stub(paths[0], { isModuleEnabled: async userId => modules(userId), isModuleBackgroundEnabled: async userId => modules(userId) });
  stub(paths[1], { isSectionRestoreActive: async () => false });
  stub(paths[2], new Proxy({}, { get: (_target, name) => () => assert.fail(`CalDAV ${String(name)} must not be called`) }));
  delete require.cache[paths[3]];
  const calls = [];
  const execute = async (sql, params) => {
    calls.push(sql);
    if (sql.includes('FROM calendar_calendars c JOIN calendar_accounts a')) return [[{ calendar_row_id: params[0], account_id: `${params[0]}-account`, read_only: 0 }]];
    if (sql.startsWith('SELECT * FROM calendar_accounts')) return [[{ id: params[0], user_id: 'owner', provider: 'caldav', mail_account_id: 'mail', is_active: active ? 1 : 0, encrypted_password: 'copied' }]];
    if (sql.includes('FROM calendar_event_external_refs r JOIN calendar_remote_objects')) return [[{ object_id: 'object', href: '/a.ics', etag: '"1"', ics: 'BEGIN:VEVENT\r\nEND:VEVENT' }]];
    if (sql.startsWith('SELECT is_active, disconnected_at')) return [[mailConnected ? { is_active: 1, disconnected_at: null, encrypted_password: 'mail' } : { is_active: 0, disconnected_at: '2026-10-04 12:00:00', encrypted_password: null }]];
    if (sql.startsWith('SELECT DISTINCT ca.user_id')) return [[{ user_id: 'calendar-off' }, { user_id: 'calendar-on' }]];
    if (sql.startsWith('SELECT ca.id, ca.user_id')) return [[{ id: `stale-${params[0] === 'calendar-on' ? 'on' : 'off'}`, user_id: params[0], provider: 'caldav', mail_account_id: 'mail' }]];
    if (sql.includes('SET ca.is_active = FALSE')) return [{ affectedRows: 1, params }];
    if (sql.startsWith('SELECT id, user_id FROM calendar_accounts')) return [[]];
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{}]];
    throw new Error(`Unexpected SQL ${sql}`);
  };
  setDb({ execute, getConnection: async () => ({ execute, release() {} }) });
  return { sync: require('../src/services/calendar-sync'), calls };
}

test('an inactive linked calendar loses the password of a disconnected mail account when it is synced', async t => {
  const { sync, calls } = calendarSyncFixture(t);
  assert.deepEqual(await sync.syncCalendarAccount('linked', { userId: 'owner' }), { skipped: true, reason: 'mail-disconnected' });
  assert.ok(calls.some(sql => sql.includes('SET ca.is_active = FALSE')));
});

test('each calendar pass clears copied passwords of disconnected mail only for users with Calendar available', async t => {
  const executed = [];
  const { sync } = calendarSyncFixture(t, { modules: userId => userId === 'calendar-on' });
  const realDb = getDb();
  setDb({ ...realDb, execute: async (sql, params) => { executed.push([sql, params]); return realDb.execute(sql, params); } });
  await sync.runCalendarSyncPass();
  const pauses = executed.filter(([sql]) => sql.includes('SET ca.is_active = FALSE')).map(([, params]) => params[1]);
  assert.deepEqual(pauses, ['stale-on']);
});

test('moving an event out of a calendar whose mail is disconnected is refused before the target is touched', async t => {
  const { sync, calls } = calendarSyncFixture(t, { active: true });
  await assert.rejects(sync.pushEventMove({ userId: 'owner', event: { id: 'event', calendar_id: 'source', title: 'Meeting' }, targetCalendarId: 'target', changes: {} }),
    error => error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  assert.ok(calls.every(sql => !/calendar_event_external_refs WHERE event_id|INSERT INTO/.test(sql)), 'no link removed or object created');
});

test('a mail disconnect stops a linked calendar sync that is already talking to the server', async t => {
  const paths = ['../src/services/module-settings', '../src/services/restore-locks', '../src/services/caldav', '../src/services/calendar-sync', '../src/security/encryption']
    .map(path => require.resolve(path));
  const saved = paths.map(path => require.cache[path]);
  const savedDb = getDb();
  t.after(() => {
    setDb(savedDb);
    paths.forEach((path, index) => { if (saved[index]) require.cache[path] = saved[index]; else delete require.cache[path]; });
  });
  stub(paths[0], { isModuleEnabled: async () => true, isModuleBackgroundEnabled: async () => true });
  stub(paths[1], { isSectionRestoreActive: async () => false });
  let reached;
  const listing = new Promise(resolve => { reached = resolve; });
  stub(paths[2], { accountCredentialScope: () => null, listCalendars: ({ signal }) => {
    reached(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  stub(paths[4], { decrypt: value => value, encrypt: value => value });
  delete require.cache[paths[3]];
  const statusWrites = [];
  const execute = async (sql, params) => {
    if (sql.startsWith('SELECT * FROM calendar_accounts')) return [[{ id: 'linked', user_id: 'owner', provider: 'caldav', mail_account_id: 'mail', is_active: 1, encrypted_password: 'copied', base_url: 'https://dav.example.test/', last_synced_at: '2026-10-01 00:00:00', sync_status: 'ok' }]];
    if (sql.startsWith('SELECT is_active, disconnected_at')) return [[{ is_active: 1, disconnected_at: null, encrypted_password: 'mail' }]];
    if (sql.startsWith('SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ?')) return [[{ id: 'linked' }]];
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{}]];
    if (sql.startsWith('UPDATE calendar_accounts SET sync_status')) { statusWrites.push(params); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT timezone') || sql.includes('FROM users')) return [[{ timezone: 'UTC' }]];
    return [[]];
  };
  setDb({ execute, getConnection: async () => ({ execute, release() {} }) });
  const sync = require('../src/services/calendar-sync');

  const run = sync.syncCalendarAccount('linked', { userId: 'owner' });
  const signal = await listing;
  assert.equal(signal.aborted, false);
  await sync.stopLinkedCalendarWork('owner', 'mail');
  assert.equal(signal.aborted, true);
  await assert.rejects(run, error => error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  assert.ok(statusWrites.every(params => !String(params[0]).includes('aborted')), 'A stopped run does not report a sync error');
});
