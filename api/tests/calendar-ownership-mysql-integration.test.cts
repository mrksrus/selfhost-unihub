import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// A calendar's change of owner through the real request handler with the
// shared people: Blair offers her calendar to Alex, who declines and then
// accepts; Alex as manager of Support hands over at once only a calendar
// Support reads; administrators hand over and archive (an administrator's
// calendar only the installation owner); and the deprovision choices
// before Deactivate and Delete, each one call of the administrator's route.
test('calendar ownership: offers, a manager\'s hand-over, the administrator\'s hand-over and archive, deprovision', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, api, password } = await seedPeople(t, pool);
  const { admin: ada, manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const row = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
  const owners = async (calendarId: string) => [...new Set((await rows(`SELECT user_id FROM calendar_calendars WHERE id = ?
    UNION ALL SELECT user_id FROM calendar_events WHERE calendar_id = ?
    UNION ALL SELECT s.user_id FROM calendar_event_subtasks s JOIN calendar_events e ON e.id = s.event_id WHERE e.calendar_id = ?
    UNION ALL SELECT user_id FROM bin_items WHERE calendar_id = ?`, [calendarId, calendarId, calendarId, calendarId])).map(found => found.user_id))];
  const grants = async (calendarId: string) => (await rows("SELECT principal_id, permission FROM grants WHERE resource_kind = 'calendar' AND resource_id = ? ORDER BY permission, principal_id",
    [calendarId])).map(found => [found.principal_id, found.permission]).sort((a, b) => `${a[1]}${a[0]}`.localeCompare(`${b[1]}${b[0]}`));
  const notices = async (userId: string) => (await rows("SELECT payload FROM notification_events WHERE kind = 'calendar-ownership' AND user_id = ? ORDER BY created_at",
    [userId])).map(found => { const payload = typeof found.payload === 'string' ? JSON.parse(found.payload) : found.payload; return `${payload.title}: ${payload.body}`; });
  const ev = (id: string, rest = '') => `/api/calendar/events/${id}${rest}`;
  const hand = (id: string) => `/api/calendar/calendars/${id}/hand-over`;
  const adminHand = (id: string) => `/api/admin/calendars/${id}/hand-over`;

  // A second administrator, who is not the installation owner.
  const ariId = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash, full_name, role, email_verified) SELECT ?, 'ari.admin@example.test', password_hash, 'Ari Admin', 'admin', TRUE FROM users WHERE id = ?",
    [ariId, ids.member]);
  const signIn = async (email: string) => {
    const client = api.client();
    await call(client, 'POST', '/api/auth/signin', { email, password, device: { key: crypto.randomBytes(32).toString('base64url'), kind: 'web' } });
    return client;
  };
  const ari = await signIn('ari.admin@example.test');
  for (const [name, client] of [['alex', alex], ['blair', blair]] as const) {
    const ecdh = crypto.createECDH('prime256v1');
    await call(client, 'POST', '/api/notifications/subscription', { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/ownership-${name}`,
      keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });
  }

  const accountOf = async (client: Client) => (await call(client, 'GET', '/api/calendar/calendars')).calendars[0].account_id;
  const blairAccount = await accountOf(blair);
  const blairDefault = (await call(blair, 'GET', '/api/calendar/calendars')).calendars[0].id;
  const alexAccount = await accountOf(alex);
  const newCalendar = async (client: Client, account: string, name: string, shares: [FixtureValue, string][] = []) => {
    const created = (await call(client, 'POST', '/api/calendar/calendars', { account_id: account, name })).calendar;
    for (const [principal, permission] of shares) await call(client, 'PUT', `/api/calendar/calendars/${created.id}/shares`, { principal, permission });
    const event = (await call(client, 'POST', '/api/calendar/events', { title: `${name} meeting`, start_time: '2031-05-06T09:00:00Z', end_time: '2031-05-06T10:00:00Z',
      calendar_id: created.id, reminders: [15] })).event;
    await call(client, 'POST', ev(event.id, '/subtasks'), { title: `${name} point` });
    const old = (await call(client, 'POST', '/api/calendar/events', { title: `${name} old`, is_todo_only: true, calendar_id: created.id })).event;
    await call(client, 'DELETE', ev(old.id));
    return { id: String(created.id), event: String(event.id) };
  };
  const support = { kind: 'group', id: groups.support };
  const alexPrincipal = { kind: 'user', id: ids.manager };

  // ── Blair offers her calendar to Alex: declined and withdrawn change nothing, accepted moves every row ──
  const team = await newCalendar(blair, blairAccount, 'Team', [[support, 'read'], [alexPrincipal, 'edit']]);
  await call(blair, 'PUT', `/api/settings/values/calendars/${team.id}`, { values: { notify_enabled: false } });
  await call(alex, 'PUT', ev(team.event), { reminders: [5] });
  assert.deepEqual(await refused(blair, 'POST', hand(team.id), { to: ids.stranger }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'POST', hand(team.id), { to: ids.revoked }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'POST', hand(team.id), { to: ids.member }), [400, 'OFFER_INVALID']);
  assert.deepEqual(await refused(casey, 'POST', hand(team.id), { to: ids.stranger }), [404, 'CALENDAR_NOT_FOUND']);
  const offered = (await call(blair, 'POST', hand(team.id), { to: ids.manager })).offer;
  assert.deepEqual([offered.to.id, offered.by.id], [ids.manager, ids.member]);
  assert.deepEqual((await call(alex, 'GET', '/api/calendar/calendars')).calendars.find((found: FixtureValue) => found.id === team.id).offer.to.id, ids.manager);
  assert.deepEqual(await notices(ids.manager), ['Calendar offered to you: Blair Member offers you Team']);
  assert.deepEqual(await refused(blair, 'POST', hand(team.id), { to: ids.admin }), [409, 'OFFER_PENDING']);
  assert.deepEqual(await refused(casey, 'POST', `${hand(team.id)}/accept`), [404, 'OFFER_NOT_FOUND']);
  assert.deepEqual(await refused(casey, 'DELETE', hand(team.id)), [404, 'OFFER_NOT_FOUND']);
  assert.deepEqual(await call(alex, 'DELETE', hand(team.id)), { withdrawn: true }, 'Alex declines');
  await call(blair, 'POST', hand(team.id), { to: ids.manager });
  await call(blair, 'DELETE', hand(team.id));
  assert.deepEqual(await refused(alex, 'POST', `${hand(team.id)}/accept`), [404, 'OFFER_NOT_FOUND'], 'a withdrawn offer cannot be accepted');
  assert.deepEqual([await owners(team.id), (await row('SELECT offer_to FROM calendar_calendars WHERE id = ?', [team.id])).offer_to], [[ids.member], null]);

  await call(blair, 'POST', hand(team.id), { to: ids.manager });
  assert.deepEqual(await call(alex, 'POST', `${hand(team.id)}/accept`), { calendar_id: team.id });
  assert.deepEqual(await owners(team.id), [ids.manager], 'the calendar, its events, points and bin items are Alex\'s');
  assert.equal((await row('SELECT account_id FROM calendar_calendars WHERE id = ?', [team.id])).account_id, alexAccount);
  assert.deepEqual((await rows('SELECT user_id FROM calendar_settings WHERE calendar_id = ?', [team.id])).map(found => found.user_id), [ids.manager]);
  assert.deepEqual(await grants(team.id), [[ids.member, 'edit'], [groups.support, 'read']], 'Blair keeps edit, Support keeps read, Alex\'s share went');
  assert.deepEqual([(await call(blair, 'GET', ev(team.event))).event.reminders, (await call(alex, 'GET', ev(team.event))).event.reminders], [[15], [5]],
    'both keep their reminders');
  assert.deepEqual(await notices(ids.member), ['Calendar handed over: Team now belongs to Alex Manager']);
  assert.equal((await call(blair, 'PUT', ev(team.event), { title: 'Team meeting 2031' })).event.title, 'Team meeting 2031', 'Blair edits');
  const backup = require('../dist/src/services/backup') as typeof import('../src/services/backup');
  const exported = (await backup.buildBackupForUser(ids.manager, { sections: ['calendar'], includeFileData: false })).data as FixtureValue;
  assert.ok(exported.calendar_calendars.some((found: FixtureValue) => found.id === team.id) && exported.calendar_events.some((found: FixtureValue) => found.id === team.event),
    'Alex\'s personal backup holds the calendar');

  // ── Alex as manager of Support hands over at once only a calendar Support reads, never an administrator's ──
  const rota = await newCalendar(blair, blairAccount, 'Rota', [[support, 'read']]);
  const direct = await newCalendar(blair, blairAccount, 'Direct', [[alexPrincipal, 'read']]);
  const busy = await newCalendar(blair, blairAccount, 'Busy', [[support, 'freebusy']]);
  const ariAccount = await accountOf(ari);
  const ariCalendar = await newCalendar(ari, ariAccount, 'Ari', [[support, 'edit']]);
  for (const id of [direct.id, busy.id, ariCalendar.id]) assert.deepEqual(await refused(alex, 'POST', hand(id), { to: ids.manager, now: true }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual(await refused(alex, 'POST', hand(blairDefault), { to: ids.manager, now: true }),
    [404, 'CALENDAR_NOT_FOUND'], 'a calendar not shared with him');
  assert.deepEqual(await refused(alex, 'POST', hand(rota.id), { to: ids.stranger, now: true }), [403, 'CALENDAR_FORBIDDEN'], 'only to a member of Support');
  assert.deepEqual(await call(alex, 'POST', hand(rota.id), { to: ids.manager, now: true }), { offer: null });
  assert.deepEqual([await owners(rota.id), await grants(rota.id)], [[ids.manager], [[ids.member, 'edit'], [groups.support, 'read']]]);
  assert.ok(await row("SELECT 1 FROM audit_log WHERE action = 'calendar.handed_over' AND actor_id = ? AND target_user_id = ?", [ids.manager, ids.member]));
  assert.ok((await notices(ids.member)).includes('Calendar handed over: Rota now belongs to Alex Manager'));

  // ── Administrators: the password, the list, an administrator's calendar only for the owner ──
  assert.equal((await casey.request('POST', adminHand(team.id), { to: 'organisation', current_password: password })).status, 403);
  assert.deepEqual(await refused(ari, 'POST', adminHand(team.id), { to: 'organisation' }), [400, 'ADMIN_PASSWORD_REQUIRED']);
  assert.deepEqual(await refused(ari, 'POST', adminHand(blairDefault), { to: 'organisation', current_password: password }),
    [404, 'CALENDAR_NOT_FOUND'], 'an unshared calendar is not on the list');
  const adaAccount = await accountOf(ada);
  const adaCalendar = await newCalendar(ada, adaAccount, 'Ada', [[support, 'read']]);
  assert.deepEqual(await refused(ari, 'PUT', `/api/admin/calendars/${adaCalendar.id}/archive`, { archived: true, current_password: password }), [403, 'ADMINS_OWNER_ONLY']);
  assert.ok((await call(ada, 'PUT', `/api/admin/calendars/${ariCalendar.id}/archive`, { archived: true, current_password: password })).calendar.archived_at);
  await call(ada, 'PUT', `/api/admin/calendars/${ariCalendar.id}/archive`, { archived: false, current_password: password });

  // ── An archived calendar: every write refused, the owner's too; reads go on ──
  const archived = (await call(ari, 'PUT', `/api/admin/calendars/${team.id}/archive`, { archived: true, current_password: password })).calendar;
  assert.ok(archived.archived_at);
  assert.ok((await notices(ids.manager)).includes('Calendar archived: Team is read-only now'));
  const alexDefault = (await call(alex, 'GET', '/api/calendar/calendars')).calendars.find((found: FixtureValue) => found.user_id === ids.manager && found.id !== team.id && found.id !== rota.id).id;
  const alexOwn = (await call(alex, 'POST', '/api/calendar/events', { title: 'Own', start_time: '2031-05-07T09:00:00Z', end_time: '2031-05-07T10:00:00Z', calendar_id: alexDefault })).event;
  for (const [client, method, url, body] of [
    [alex, 'PUT', ev(team.event), { title: 'Archived' }], [blair, 'PUT', ev(team.event), { title: 'Archived' }], [alex, 'POST', ev(team.event, '/subtasks'), { title: 'Archived' }],
    [alex, 'DELETE', ev(team.event)], [alex, 'PUT', `/api/calendar/calendars/${team.id}/shares`, { principal: { kind: 'user', id: ids.member }, permission: null }],
    [alex, 'POST', hand(team.id), { to: ids.member }], [alex, 'PUT', ev(team.event, '/rsvp'), { response_status: 'accepted', email: 'alex@example.test' }],
    [alex, 'PUT', ev(team.event), { calendar_id: alexDefault }], [alex, 'POST', ev(team.event, '/move'), { calendar_id: alexDefault }],
    [alex, 'POST', ev(alexOwn.id, '/move'), { calendar_id: team.id }],
  ] as const) {
    assert.deepEqual(await refused(client, method, url, body), [403, 'CALENDAR_FORBIDDEN'], `archived: ${method} ${url}`);
  }
  assert.equal((await call(blair, 'GET', ev(team.event))).event.title, 'Team meeting 2031', 'reads go on');
  assert.equal((await call(alex, 'GET', ev(alexOwn.id))).event.calendar_id, alexDefault);
  await call(ari, 'PUT', `/api/admin/calendars/${team.id}/archive`, { archived: false, current_password: password });
  await call(alex, 'PUT', ev(team.event), { title: 'Team meeting' });
  assert.deepEqual((await rows("SELECT action FROM audit_log WHERE action IN ('admin.calendar_archived', 'admin.calendar_unarchived') ORDER BY action")).map(found => found.action),
    ['admin.calendar_archived', 'admin.calendar_archived', 'admin.calendar_unarchived', 'admin.calendar_unarchived']);

  // ── An administrator hands over at once: to the organisation, then to a person ──
  await call(ari, 'POST', adminHand(rota.id), { to: 'organisation', current_password: password });
  assert.deepEqual([await owners(rota.id), await rows('SELECT 1 FROM calendar_settings WHERE calendar_id = ?', [rota.id])], [[null], []]);
  assert.deepEqual(await grants(rota.id), [[ids.manager, 'edit'], [ids.member, 'edit']].sort((a, b) => a[0].localeCompare(b[0])).concat([[groups.support, 'read']]), 'Alex keeps edit');
  assert.ok((await notices(ids.manager)).includes('Calendar handed over: Rota now belongs to the organisation'));
  assert.deepEqual(await refused(ari, 'POST', adminHand(rota.id), { to: 'organisation', current_password: password }), [400, 'OFFER_INVALID']);
  assert.equal((await call(ari, 'POST', adminHand(rota.id), { to: ids.member, current_password: password })).calendar.owner.id, ids.member);
  assert.deepEqual([await owners(rota.id), (await row('SELECT account_id FROM calendar_calendars WHERE id = ?', [rota.id])).account_id], [[ids.member], blairAccount]);

  // ── Deprovision before Deactivate: leave it, a colleague, the organisation, the bin ──
  const leave = await newCalendar(blair, blairAccount, 'Leave', [[support, 'read']]);
  const colleague = await newCalendar(blair, blairAccount, 'Colleague', [[support, 'read']]);
  const organisation = await newCalendar(blair, blairAccount, 'Organisation', [[support, 'read']]);
  const binned = await newCalendar(blair, blairAccount, 'Binned', [[support, 'read']]);
  const listed = (await call(ari, 'GET', `/api/admin/users/${ids.member}/accounts`)).shared_calendars;
  assert.deepEqual(listed.map((found: FixtureValue) => found.name).sort(), ['Binned', 'Busy', 'Colleague', 'Direct', 'Leave', 'Organisation', 'Rota']);
  assert.deepEqual([listed.find((found: FixtureValue) => found.id === leave.id).share_count, listed.find((found: FixtureValue) => found.id === leave.id).event_count], [1, 1]);
  await call(blair, 'POST', hand(leave.id), { to: ids.manager });
  await call(ari, 'POST', adminHand(colleague.id), { to: ids.manager, current_password: password });
  await call(ari, 'POST', adminHand(organisation.id), { to: 'organisation', current_password: password });
  assert.deepEqual(await call(ari, 'POST', adminHand(binned.id), { to: 'bin', current_password: password }), { calendar: null });
  await call(ari, 'PUT', `/api/admin/users/${ids.member}/activate`, { is_active: false, current_password: password });
  assert.deepEqual([await owners(leave.id), (await row('SELECT offer_to FROM calendar_calendars WHERE id = ?', [leave.id])).offer_to], [[ids.member], null],
    'left as it is; the offer is withdrawn');
  assert.ok((await call(alex, 'GET', '/api/calendar/events')).events.some((found: FixtureValue) => found.id === leave.event), 'Support still reads it');
  assert.deepEqual([await owners(colleague.id), await owners(organisation.id)], [[ids.manager], [null]]);
  assert.deepEqual([await row('SELECT 1 FROM calendar_calendars WHERE id = ?', [binned.id]), await grants(binned.id)], [undefined, []]);
  assert.deepEqual((await rows("SELECT item_type FROM bin_items WHERE user_id = ? AND (item_id = ? OR item_id = ?) ORDER BY item_type", [ids.member, binned.id, binned.event]))
    .map(found => found.item_type), ['calendar', 'event'], 'the calendar and its events in Blair\'s bin');
  assert.deepEqual(await refused(ari, 'POST', adminHand(organisation.id), { to: ids.member, current_password: password }), [400, 'OFFER_INVALID'], 'not to an inactive person');
  assert.deepEqual(await audits(), [['admin.calendar_binned', ids.member], ['admin.calendar_handed_over', ids.member]]);

  // ── Deprovision before Delete: a colleague, the organisation, the bin (nothing sent) ──
  await call(ari, 'PUT', `/api/admin/users/${ids.member}/activate`, { is_active: true });
  const back = await signIn('blair@example.test');
  const toColleague = await newCalendar(back, blairAccount, 'To colleague', [[support, 'read']]);
  const toOrganisation = await newCalendar(back, blairAccount, 'To organisation', [[support, 'read']]);
  const goes = await newCalendar(back, blairAccount, 'Goes', [[support, 'read']]);
  await call(ari, 'POST', adminHand(toColleague.id), { to: ids.manager, current_password: password });
  await call(ari, 'POST', adminHand(toOrganisation.id), { to: 'organisation', current_password: password });
  await call(ari, 'DELETE', `/api/admin/users/${ids.member}`, { current_password: password });
  assert.deepEqual([await owners(toColleague.id), await owners(toOrganisation.id), await owners(organisation.id)], [[ids.manager], [null], [null]],
    'the colleague\'s and the organisation calendars stay whole');
  assert.ok((await call(alex, 'GET', '/api/calendar/events')).events.some((found: FixtureValue) => found.id === toOrganisation.event));
  for (const gone of [goes.id, leave.id]) assert.deepEqual([await row('SELECT 1 FROM calendar_calendars WHERE id = ?', [gone]), await grants(gone)], [undefined, []]);

  async function audits() {
    return (await rows("SELECT action, target_user_id FROM audit_log WHERE action IN ('admin.calendar_binned', 'admin.calendar_handed_over') AND target_user_id = ? GROUP BY action, target_user_id ORDER BY action",
      [ids.member])).map(found => [found.action, found.target_user_id]);
  }
});
