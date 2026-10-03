const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');

test('global search queries only enabled domains and keeps results owner-scoped', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  const queries = [];
  setDb({ async execute(sql, params) {
    queries.push(sql);
    assert.equal(params[0], 'owner');
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { enabled: false }, calendar: { enabled: false }, recordings: { enabled: false } }) }]];
    if (sql.includes('FROM contacts')) {
      assert.match(sql, /user_id = \?/);
      return [[{ id: 'owned-contact', first_name: 'Research', last_name: 'Example', email: 'research@example.test' }]];
    }
    throw new Error('Unexpected domain query: ' + sql);
  } });
  const routes = require('../src/routes/search');
  const result = await routes['GET /api/search']({ url: '/api/search?q=research', headers: { host: 'localhost' } }, 'owner');
  assert.equal(result.error, undefined);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].type, 'contact');
  assert.ok(!queries.some(sql => /FROM (emails|calendar_events|recordings)\b/.test(sql)));
});

test('dashboard statistics omit disabled modules without reading their rows', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  setDb({ async execute(sql) {
    assert.match(sql, /FROM user_settings/);
    return [[{ setting_value: JSON.stringify({ mail: { enabled: false }, contacts: { enabled: false }, calendar: { enabled: false } }) }]];
  } });
  const result = await require('../src/routes/system')['GET /api/stats']({}, 'owner');
  assert.deepEqual(result, { contacts: 0, upcomingEvents: 0, unreadEmails: 0 });
});
