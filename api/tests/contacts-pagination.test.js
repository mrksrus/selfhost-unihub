const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb, getDb } = require('../src/state');
const routes = require('../src/routes/contacts');

test('contacts pagination returns more than 2,000 contacts without truncation and has a stable tie-breaker', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const all = Array.from({ length: 2105 }, (_, i) => ({ id: `contact-${String(i).padStart(5, '0')}`, user_id: 'u1', first_name: 'Same', last_name: 'Name' }));
  const calls = [];
  setDb({ async execute(sql, params) {
    calls.push({ sql, params });
    assert.deepEqual(params, ['u1']);
    assert.match(sql, /WHERE user_id = \?/);
    assert.match(sql, /ORDER BY is_favorite DESC, first_name ASC, last_name ASC, id ASC/);
    const [, count, offset] = sql.match(/LIMIT (\d+) OFFSET (\d+)/);
    return [all.slice(Number(offset), Number(offset) + Number(count))];
  } });
  const req = url => ({ url, headers: { host: 'localhost' } });
  const first = await routes['GET /api/contacts'](req('/api/contacts?limit=2000'), 'u1');
  const second = await routes['GET /api/contacts'](req('/api/contacts?limit=2000&offset=2000'), 'u1');
  assert.equal(first.contacts.length, 2000); assert.equal(first.has_more, true);
  assert.equal(second.contacts.length, 105); assert.equal(second.has_more, false); assert.equal(second.offset, 2000);
  assert.equal(new Set([...first.contacts, ...second.contacts].map(row => row.id)).size, 2105);
  all.splice(0, 1);
  const refreshed = await routes['GET /api/contacts'](req('/api/contacts?limit=2000&offset=0'), 'u1');
  assert.equal(refreshed.contacts[0].id, 'contact-00001');
  assert.equal(calls.length, 3);
});

test('contacts filters keep user scope and pagination integers bounded; unauthenticated reads do no SQL', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const calls = [];
  setDb({ async execute(sql, params) { calls.push({ sql, params }); return [[]]; } });
  const req = url => ({ url, headers: { host: 'localhost' } });
  assert.equal((await routes['GET /api/contacts'](req('/api/contacts'), null)).status, 401);
  assert.equal(calls.length, 0);
  await routes['GET /api/contacts'](req('/api/contacts?group=name_only&q=%25_&limit=99999&offset=-3'), 'u1');
  assert.equal(calls[0].params[0], 'u1');
  assert.ok(calls[0].params.slice(1).every(value => value === '%\\%\\_%'));
  assert.match(calls[0].sql, /LIMIT 2001 OFFSET 0$/);
  assert.match(calls[0].sql, /TRIM\(COALESCE\(first_name/);
});
