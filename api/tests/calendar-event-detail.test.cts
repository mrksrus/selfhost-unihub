import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');
const routes = require('../dist/src/routes/calendar') as typeof import('../src/routes/calendar');

test('calendar detail resolves one owned event with its children and hides other accounts', async (t) => {
  const original = getDb();
  t.after(() => setDb(original));
  const calls: FixtureValue[] = [];
  setDb({ async execute(sql: string, params: FixtureValue) {
    calls.push({ sql, params });
    assert.match(sql, /WHERE (id|event_id) = \? AND user_id = \?/);
    const owned = params[0] === 'target' && params[1] === 'owner';
    if (!owned) return [[]];
    if (sql.includes('FROM calendar_events ')) return [[{ id: 'target', user_id: 'owner', title: 'Selected event', reminders: '[0]' }]];
    if (sql.includes('FROM calendar_event_subtasks ')) return [[{ id: 'child', event_id: 'target', user_id: 'owner', title: 'Selected subtask' }]];
    if (sql.includes('FROM calendar_event_attendees ')) return [[{ event_id: 'target', user_id: 'owner', email: 'guest@example.test' }]];
    throw new Error(sql);
  } } as FixtureValue);
  const request = { url: '/api/calendar/events/target?background=1', headers: { host: 'localhost' } };
  const route = routes['GET /api/calendar/events/:id'];
  assert.equal((await route(request as FixtureValue, null)).status, 401);
  assert.equal(calls.length, 0);
  const own = await route(request as FixtureValue, 'owner');
  assert.equal(own.event!.id, 'target');
  assert.equal(own.event!.subtasks[0].id, 'child');
  assert.equal(own.event!.attendees[0].email, 'guest@example.test');
  const previous = calls.length;
  assert.equal((await route(request as FixtureValue, 'other')).status, 404);
  assert.equal(calls.length, previous + 1, 'an inaccessible event cannot load child data');
  assert.equal(calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)), false);
});

// The central request handler around the real calendar route, with the
// session, module settings and restore locks replaced by synthetic data.
function eventUpdateHarness(t: import('node:test').TestContext, execute: (sql: string, params: FixtureValue) => Promise<FixtureValue>) {
  const paths = ['../dist/src/request-handler', '../dist/src/auth', '../dist/src/routes', '../dist/src/services/module-settings', '../dist/src/services/restore-locks'].map(name => require.resolve(name));
  const previous = paths.map(name => require.cache[name]);
  const originalDb = getDb();
  t.after(() => {
    setDb(originalDb);
    paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; });
  });
  const stub = (name: FixtureValue, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  delete require.cache[paths[0]];
  stub(paths[1], { verifyToken: async () => 'owner', validateCsrfToken: () => true, refreshSessionCookies: () => {} });
  stub(paths[2], { 'PUT /api/calendar/events/:id': routes['PUT /api/calendar/events/:id'] });
  stub(paths[3], { isModuleEnabled: async () => true });
  stub(paths[4], { getActiveRestoreSections: async () => new Set<FixtureValue>() });
  const connection = { execute, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  setDb({ execute, getConnection: async () => connection } as FixtureValue);
  const { handleRequest } = require(paths[0]) as typeof import('../src/request-handler');
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const { PassThrough } = require('node:stream') as typeof import('node:stream');
  return async function put(url: string, body: FixtureValue) {
    const req = new PassThrough();
    Object.assign(req, { method: 'PUT', url, headers: { host: 'localhost', 'content-type': 'application/json' } });
    const res: FixtureValue = new EventEmitter();
    res.setHeader = () => {}; res.getHeader = () => undefined;
    res.writeHead = (status: number) => { res.status = status; res.headersSent = true; };
    res.end = (value: FixtureValue) => { res.body = JSON.parse(String(value)); };
    const running = handleRequest(req as FixtureValue, res);
    setImmediate(() => req.end(JSON.stringify(body)));
    await running;
    return { status: res.status as number, body: res.body };
  };
}

test('removing the calendar of a synced event is refused; a local event can still be detached', async (t) => {
  const state = { linked: true, calendar_id: 'cal' as string | null };
  const writes: { sql: string; params: FixtureValue }[] = [];
  const put = eventUpdateHarness(t, async (sql, params) => {
    if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) {
      writes.push({ sql, params });
      if (sql.includes('calendar_id = NULL')) state.calendar_id = null;
      return [{ affectedRows: 1 }];
    }
    assert.match(sql, /WHERE (id|event_id|c\.id) = \? AND (c\.)?user_id = \?/);
    if (params[1] !== 'owner') return [[]];
    if (sql.includes('FROM calendar_events')) return [[{ id: 'target', user_id: 'owner', calendar_id: state.calendar_id, title: 'Synced', start_time: '2026-10-20 10:00:00', end_time: '2026-10-20 11:00:00' }]];
    if (sql.includes('FROM calendar_calendars c')) return [[{ id: 'cal', read_only: 0, provider: 'caldav', is_active: 1 }]];
    if (sql.includes('FROM calendar_event_external_refs')) return [state.linked ? [{ id: 'ref' }] : []];
    if (sql.includes('FROM calendar_event_subtasks') || sql.includes('FROM calendar_event_attendees')) return [[]];
    throw new Error(sql);
  });

  const refused = await put('/api/calendar/events/target', { calendar_id: null });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /synced with a calendar server/);
  assert.equal(writes.length, 0, 'a refused detach writes nothing');
  assert.equal((await put('/api/calendar/events/target', { calendar_id: '' })).status, 400);

  state.linked = false;
  const detached = await put('/api/calendar/events/target', { calendar_id: null });
  assert.equal(detached.status, 200);
  assert.equal(detached.body.event.id, 'target');
  assert.equal(detached.body.event.calendar_id, null);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE calendar_events SET calendar_id = NULL WHERE id = \? AND user_id = \?/);
  assert.deepEqual(writes[0].params, ['target', 'owner']);
});

test('a database failure while updating an event answers the route fallback, never the driver message', async (t) => {
  const put = eventUpdateHarness(t, async (sql) => {
    if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) throw Object.assign(new Error("Data too long for column 'title' at row 1"), { code: 'ER_DATA_TOO_LONG', errno: 1406 });
    if (sql.includes('FROM calendar_events')) return [[{ id: 'target', user_id: 'owner', calendar_id: null, title: 'Local', start_time: '2026-10-20 10:00:00', end_time: '2026-10-20 11:00:00' }]];
    return [[]];
  });
  t.mock.method(console, 'error', () => {});
  const result = await put('/api/calendar/events/target', { title: 'Renamed' });
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'Failed to update event');
});
