const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { compileRouteMatcher } = require('../dist/src/http/route-matcher') as typeof import('../src/http/route-matcher');
const routes = require('../dist/src/routes') as Record<string, unknown>;

const match = compileRouteMatcher(Object.keys(routes));
const resolve = (method: string, path: string) => match(method, path)?.key ?? null;

test('every route key resolves from a concrete sample path with its parameters filled in', () => {
  const keys = Object.keys(routes);
  assert.ok(keys.length > 100, 'The route table should be the complete production table');
  for (const key of keys) {
    const [method, pattern] = key.split(' ');
    const names = [...pattern.matchAll(/:(\w+)/g)].map(found => found[1]);
    const path = pattern.replace(/:(\w+)/g, (_, name) => `sample-${name}`);
    const result = match(method, path);
    assert.ok(result, `${key} should resolve from ${path}`);
    assert.equal(result.key, key, `${path} resolved to ${result.key}`);
    assert.deepEqual(result.params, Object.fromEntries(names.map(name => [name, `sample-${name}`])), key);
  }
});

test('every explicit body limit names a key in the route table, so none is silently unused', () => {
  const { BODY_LIMIT_BY_ROUTE } = require('../dist/src/routes/legacy-spec') as typeof import('../src/routes/legacy-spec');
  for (const key of Object.keys(BODY_LIMIT_BY_ROUTE)) {
    assert.ok(key in routes, `${key} has a body limit but no handler`);
  }
});

test('exact keys win over parameters, and the most literal pattern wins among parameterized keys', () => {
  assert.equal(resolve('POST', '/api/mail/emails/bulk-update'), 'POST /api/mail/emails/bulk-update');
  assert.equal(resolve('POST', '/api/mail/emails/bulk-delete'), 'POST /api/mail/emails/bulk-delete');
  assert.equal(resolve('POST', '/api/mail/sender-rules/backfill'), 'POST /api/mail/sender-rules/backfill');
  assert.equal(resolve('POST', '/api/recordings/uploads/start'), 'POST /api/recordings/uploads/start');
  assert.equal(resolve('POST', '/api/contacts/merge-duplicates/preview'), 'POST /api/contacts/merge-duplicates/preview');
  assert.deepEqual(match('POST', '/api/calendar/events/e1/subtasks/reorder'), { key: 'POST /api/calendar/events/:id/subtasks/reorder', params: { id: 'e1' } });
  assert.deepEqual(match('PUT', '/api/calendar/events/e1/subtasks/s1'), { key: 'PUT /api/calendar/events/:id/subtasks/:subtaskId', params: { id: 'e1', subtaskId: 's1' } });
  // Two patterns with equally many literals: the literal segment nearest the
  // start decides, as the old branch order did for recording uploads.
  assert.deepEqual(match('GET', '/api/recordings/uploads/file'), { key: 'GET /api/recordings/uploads/:id', params: { id: 'file' } });
  assert.deepEqual(match('GET', '/api/recordings/r1/file'), { key: 'GET /api/recordings/:id/file', params: { id: 'r1' } });
});

test('parameters are whole non-empty segments, decoded; malformed encoding is a 400', () => {
  assert.deepEqual(match('PUT', '/api/mail/folders/caf%C3%A9%20list'), { key: 'PUT /api/mail/folders/:slug', params: { slug: 'café list' } });
  assert.throws(() => match('PUT', '/api/mail/folders/%E0%A4%A'), (error: Error & { status?: number }) => error.status === 400);
  assert.equal(resolve('PUT', '/api/contacts//favorite'), null);
  assert.equal(resolve('DELETE', '/api/contacts/'), null);
  assert.equal(resolve('DELETE', '/api/contacts/c1/'), null);
  assert.equal(resolve('PUT', '/api/contacts/a/b/c'), null);
  assert.equal(resolve('GET', '/api/mail/emails'), 'GET /api/mail/emails');
  assert.equal(resolve('GET', '/health'), 'GET /health');
  assert.equal(resolve('GET', '/nothing/here'), null);
});
