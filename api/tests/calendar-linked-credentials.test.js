const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');

function stub(path, exports) { require.cache[path] = { id: path, filename: path, loaded: true, exports }; }

const MAIL_LOGIN = { username: 'owner@example.test', encrypted_password: 'mail-login' };

// calendar-sync with a database fake. account: the calendar_accounts row;
// mail: the connected mail login, or null while it is disconnected.
function calendarFixture(t, { account = {}, mail = MAIL_LOGIN, caldav = {} } = {}) {
  const paths = ['../src/services/module-settings', '../src/services/restore-locks', '../src/services/caldav', '../src/services/calendar-sync',
    '../src/security/encryption', '../src/services/calendar-accounts'].map(path => require.resolve(path));
  const saved = paths.map(path => require.cache[path]);
  const savedDb = getDb();
  t.after(() => {
    setDb(savedDb);
    paths.forEach((path, index) => { if (saved[index]) require.cache[path] = saved[index]; else delete require.cache[path]; });
  });
  const state = { mail, relinked: [] };
  stub(paths[0], { isModuleEnabled: async () => true, isModuleBackgroundEnabled: async () => true });
  stub(paths[1], { isSectionRestoreActive: async () => false });
  stub(paths[2], new Proxy({ accountCredentialScope: () => null, ...caldav }, {
    get: (target, name) => name in target ? target[name] : () => assert.fail(`CalDAV ${String(name)} must not be called`),
  }));
  stub(paths[4], { decrypt: value => value, encrypt: value => value });
  stub(paths[5], { relinkRestoredCalendar: async row => { state.relinked.push(row.id); return state.relinkTo || null; } });
  delete require.cache[paths[3]];
  const row = { id: 'linked', user_id: 'owner', provider: 'caldav', mail_account_id: 'mail', is_active: 1, encrypted_password: null,
    username: 'stale-user', base_url: 'https://dav.example.test/', last_synced_at: '2026-10-01 00:00:00', sync_status: 'ok', ...account };
  const writes = [];
  const execute = async (sql, params) => {
    if (sql.includes('FROM calendar_calendars c JOIN calendar_accounts a')) return [[{ calendar_row_id: params[0], account_id: 'linked', read_only: 0, url: 'https://dav.example.test/cal/' }]];
    if (sql.startsWith('SELECT * FROM calendar_accounts')) return [[row]];
    if (sql.startsWith('SELECT id FROM calendar_accounts')) return [[{ id: row.id }]];
    if (sql.includes('FROM mail_accounts m WHERE m.id = ?')) return [state.mail ? [{ ...state.mail }] : []];
    if (sql.includes('FROM calendar_event_external_refs r JOIN calendar_remote_objects')) return [[{ object_id: 'object', href: '/a.ics', etag: '"1"', ics: 'BEGIN:VEVENT\r\nEND:VEVENT' }]];
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{}]];
    // The missing-login note applies only while the mail account is disconnected.
    if (sql.includes("ca.sync_status = 'paused'")) { if (state.mail) return [{ affectedRows: 0 }]; writes.push([sql, params]); return [{ affectedRows: 1 }]; }
    if (/^(UPDATE|DELETE|INSERT)/.test(sql.trim())) { writes.push([sql, params]); return [{ affectedRows: 1 }]; }
    return [[]];
  };
  setDb({ execute, getConnection: async () => ({ execute, release() {} }) });
  return { sync: require('../src/services/calendar-sync'), writes, state };
}

const event = { id: 'event', calendar_id: 'calendar', title: 'Meeting', start_time: '2026-10-05 10:00:00', end_time: '2026-10-05 11:00:00' };
const stop = Object.assign(new Error('stop here'), { code: 'TEST_STOP' });

test('a linked calendar syncs and writes with the mail login as stored at that moment', async t => {
  const logins = [];
  const { sync, state } = calendarFixture(t, { caldav: {
    listCalendars: async ({ username, password }) => { logins.push(['sync', username, password]); return []; },
    putCalendarObject: async ({ username, password }) => { logins.push(['write', username, password]); throw stop; },
  } });
  await sync.syncCalendarAccount('linked', { userId: 'owner' });
  state.mail = { username: 'owner@example.test', encrypted_password: 'changed-login' };
  await assert.rejects(sync.pushCreatedEvent({ userId: 'owner', event }), error => error === stop);
  assert.deepEqual(logins, [['sync', 'owner@example.test', 'mail-login'], ['write', 'owner@example.test', 'changed-login']]);
});

test('a linked calendar waits while its mail account is disconnected and changes nothing at the provider', async t => {
  const { sync, writes } = calendarFixture(t, { mail: null });
  assert.deepEqual(await sync.syncCalendarAccount('linked', { userId: 'owner' }), { skipped: true, reason: 'mail-disconnected' });
  const noted = writes.filter(([sql]) => sql.includes("sync_status = 'paused'"));
  assert.equal(noted.length, 1);
  assert.match(noted[0][0], /AND ca.is_active = TRUE/, 'A pause of the user keeps its status');
  assert.equal(noted[0][1][0], sync.MAIL_DISCONNECTED_MESSAGE);
  assert.ok(writes.every(([sql]) => !/encrypted_password\s*=|is_active\s*=\s*FALSE/.test(sql)), 'No login or switch of the calendar is changed');

  await assert.rejects(sync.pushCreatedEvent({ userId: 'owner', event }), error => error.status === 409 && error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  await assert.rejects(sync.pushEventMove({ userId: 'owner', event: { ...event, calendar_id: 'source' }, targetCalendarId: 'target', changes: {} }),
    error => error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  assert.ok(writes.every(([sql]) => !/calendar_event_external_refs|INSERT INTO/.test(sql)), 'The move is refused before the target is touched');
});

test('a calendar without a login of its own is not synced, and a restored mail calendar finds its mail account first', async t => {
  const { sync, state } = calendarFixture(t, { account: { mail_account_id: null, encrypted_password: null } });
  assert.deepEqual(await sync.syncCalendarAccount('linked', { userId: 'owner' }), { skipped: true, reason: 'no-password' });
  assert.deepEqual(state.relinked, ['linked']);
});

test('a restored mail calendar that finds its mail account uses that login', async t => {
  const logins = [];
  const { sync, state } = calendarFixture(t, {
    account: { mail_account_id: null, encrypted_password: null },
    caldav: { listCalendars: async ({ username, password }) => { logins.push([username, password]); return []; } },
  });
  state.relinkTo = 'mail';
  await sync.syncCalendarAccount('linked', { userId: 'owner' });
  assert.deepEqual(logins, [['owner@example.test', 'mail-login']]);
});

test('a calendar with its own password does not look for a mail account', async t => {
  const logins = [];
  const { sync, state } = calendarFixture(t, {
    account: { mail_account_id: null, encrypted_password: 'own-password', username: 'own-user' },
    caldav: { listCalendars: async ({ username, password }) => { logins.push([username, password]); return []; } },
  });
  await sync.syncCalendarAccount('linked', { userId: 'owner' });
  assert.deepEqual(logins, [['own-user', 'own-password']]);
  assert.deepEqual(state.relinked, []);
});

test('a mail disconnect stops a linked calendar sync that is already talking to the server', async t => {
  let reached;
  const listing = new Promise(resolve => { reached = resolve; });
  const { sync, writes, state } = calendarFixture(t, { caldav: { listCalendars: ({ signal }) => {
    reached(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } } });
  const run = sync.syncCalendarAccount('linked', { userId: 'owner' });
  const signal = await listing;
  assert.equal(signal.aborted, false);
  state.mail = null;
  await sync.stopLinkedCalendarWork('owner', 'mail');
  assert.equal(signal.aborted, true);
  await assert.rejects(run, error => error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  const statuses = writes.filter(([sql]) => sql.includes('sync_status')).map(([, params]) => params[0]);
  assert.equal(statuses.at(-1), sync.MAIL_DISCONNECTED_MESSAGE, 'The stopped run notes the disconnect, not a sync error');
  assert.ok(statuses.every(value => !String(value).includes('aborted')));
  assert.equal(sync.runningCalendarWorkCount(), 0);
});

test('a mail account reconnected while its stopped sync unwinds is not noted as disconnected and syncs again', async t => {
  let calls = 0, reached;
  const listing = new Promise(resolve => { reached = resolve; });
  let followed;
  const followUp = new Promise(resolve => { followed = resolve; });
  const { sync, writes, state } = calendarFixture(t, { caldav: { listCalendars: ({ signal }) => {
    calls += 1;
    if (calls > 1) { followed(); return Promise.resolve([]); }
    reached(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } } });
  const run = sync.syncCalendarAccount('linked', { userId: 'owner' });
  await listing;
  await sync.stopLinkedCalendarWork('owner', 'mail');
  // The reconnect lands before the stopped run notes the disconnect, and its
  // own sync request joins that run.
  const joined = sync.syncCalendarAccount('linked', { userId: 'owner' });
  assert.equal(joined, run);
  await assert.rejects(run, error => error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  assert.ok(writes.every(([sql]) => !sql.includes("ca.sync_status = 'paused'")), 'No disconnect is noted');
  assert.ok(writes.some(([sql]) => sql.includes("sync_status = 'pending', next_sync_at = NULL")));
  await followUp;
  assert.equal(calls, 2, 'A new sync runs after the stopped one');
});

test('a finished calendar sync releases its stop switch', async t => {
  let sync, running;
  ({ sync } = calendarFixture(t, { caldav: { listCalendars: async () => { running = sync.runningCalendarWorkCount(); return []; } } }));
  await sync.syncCalendarAccount('linked', { userId: 'owner' });
  assert.equal(running, 1);
  assert.equal(sync.runningCalendarWorkCount(), 0, 'No entry is kept after the run');
});

test('a mail disconnect after the last server response keeps the sync from reporting success', async t => {
  let sync, writes, state;
  ({ sync, writes, state } = calendarFixture(t, { caldav: { listCalendars: async () => {
    state.mail = null;
    await sync.stopLinkedCalendarWork('owner', 'mail');
    return [];
  } } }));
  await assert.rejects(sync.syncCalendarAccount('linked', { userId: 'owner' }), error => error.code === 'MAIL_ACCOUNT_DISCONNECTED');
  const statuses = writes.filter(([sql]) => /sync_status = \?/.test(sql)).map(([, params]) => params[0]);
  assert.ok(statuses.every(value => !['ok', 'error'].includes(value)), 'No success or error status');
});

test('a linked calendar is listed as paused while its mail account is disconnected', () => {
  const { serializeCalendarAccount, MAIL_DISCONNECTED_MESSAGE } = require('../src/services/calendar');
  const row = { id: 'linked', provider: 'caldav', mail_account_id: 'mail', is_active: 1, sync_status: 'ok', sync_error: null };
  const view = extra => { const { sync_status: status, sync_error: error } = serializeCalendarAccount({ ...row, ...extra }); return [status, error]; };
  assert.deepEqual(view({ mail_connected: 0 }), ['paused', MAIL_DISCONNECTED_MESSAGE]);
  assert.deepEqual(view({ mail_connected: 1 }), ['ok', null]);
  assert.deepEqual(view({ mail_connected: 1, sync_status: 'paused', sync_error: MAIL_DISCONNECTED_MESSAGE }), ['pending', null], 'A noted pause ends with the reconnect');
  assert.deepEqual(view({ mail_connected: 0, is_active: 0, sync_status: 'paused' }), ['paused', null], 'A pause of the user is shown as it is');
  assert.deepEqual(view({}), ['ok', null], 'Read without the mail account: stored status');
});
