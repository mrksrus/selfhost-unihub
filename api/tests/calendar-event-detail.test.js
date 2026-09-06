const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');
const routes = require('../src/routes/calendar');

test('calendar detail resolves one owned event with its children and hides other accounts', async (t) => {
  const original = getDb();
  t.after(() => setDb(original));
  const calls = [];
  setDb({ async execute(sql, params) {
    calls.push({ sql, params });
    assert.match(sql, /WHERE (id|event_id) = \? AND user_id = \?/);
    const owned = params[0] === 'target' && params[1] === 'owner';
    if (!owned) return [[]];
    if (sql.includes('FROM calendar_events ')) return [[{ id: 'target', user_id: 'owner', title: 'Selected event', reminders: '[0]' }]];
    if (sql.includes('FROM calendar_event_subtasks ')) return [[{ id: 'child', event_id: 'target', user_id: 'owner', title: 'Selected subtask' }]];
    if (sql.includes('FROM calendar_event_attendees ')) return [[{ event_id: 'target', user_id: 'owner', email: 'guest@example.test' }]];
    throw new Error(sql);
  } });
  const request = { url: '/api/calendar/events/target?background=1', headers: { host: 'localhost' } };
  const route = routes['GET /api/calendar/events/:id'];
  assert.equal((await route(request, null)).status, 401);
  assert.equal(calls.length, 0);
  const own = await route(request, 'owner');
  assert.equal(own.event.id, 'target');
  assert.equal(own.event.subtasks[0].id, 'child');
  assert.equal(own.event.attendees[0].email, 'guest@example.test');
  const previous = calls.length;
  assert.equal((await route(request, 'other')).status, 404);
  assert.equal(calls.length, previous + 1, 'an inaccessible event cannot load child data');
  assert.equal(calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)), false);
});
