import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');

test('global search queries only enabled domains and keeps results owner-scoped', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  const queries: FixtureValue[] = [];
  setDb({ async execute(sql: string, params: FixtureValue) {
    queries.push(sql);
    assert.equal(params[0], 'owner');
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { enabled: false }, calendar: { enabled: false }, recordings: { enabled: false } }) }]];
    if (sql.includes('FROM contacts')) {
      assert.match(sql, /user_id = \?/);
      return [[{ id: 'owned-contact', first_name: 'Research', last_name: 'Example', email: 'research@example.test' }]];
    }
    throw new Error('Unexpected domain query: ' + sql);
  } } as FixtureValue);
  const routes = require('../dist/src/routes/search') as typeof import('../src/routes/search');
  const result = await routes['GET /api/search']({ url: '/api/search?q=research', headers: { host: 'localhost' } } as FixtureValue, 'owner');
  assert.equal(result.error, undefined);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].type, 'contact');
  assert.ok(!queries.some(sql => /FROM (emails|calendar_events|recordings)\b/.test(sql)));
});

test('dashboard statistics omit disabled modules without reading their rows', async t => {
  const previous = getDb(); t.after(() => setDb(previous));
  setDb({ async execute(sql: string) {
    assert.match(sql, /FROM user_settings/);
    return [[{ setting_value: JSON.stringify({ mail: { enabled: false }, contacts: { enabled: false }, calendar: { enabled: false } }) }]];
  } } as FixtureValue);
  const result = await (require('../dist/src/routes/system') as typeof import('../src/routes/system'))['GET /api/stats']({} as FixtureValue, 'owner');
  assert.deepEqual(result, { contacts: 0, upcomingEvents: 0, unreadEmails: 0 });
});
