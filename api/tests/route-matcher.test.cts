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

test('the old contacts branch: only PUT and DELETE are parameterized, GET and POST stay exact', () => {
  assert.deepEqual(match('PUT', '/api/contacts/c1/favorite'), { key: 'PUT /api/contacts/:id/favorite', params: { id: 'c1' } });
  assert.deepEqual(match('DELETE', '/api/contacts/c1'), { key: 'DELETE /api/contacts/:id', params: { id: 'c1' } });
  assert.deepEqual(match('PUT', '/api/contacts/export'), { key: 'PUT /api/contacts/:id', params: { id: 'export' } });
  assert.equal(resolve('GET', '/api/contacts/export'), 'GET /api/contacts/export');
  assert.equal(resolve('GET', '/api/contacts/c1'), null);
  assert.equal(resolve('POST', '/api/contacts/c1'), null);
  assert.equal(resolve('DELETE', '/api/contacts/c1/favorite'), null);
});

test('the old mail branches: sender rules, folders, drafts, accounts, attachments and writebacks', () => {
  assert.deepEqual(match('DELETE', '/api/mail/sender-rules/r1'), { key: 'DELETE /api/mail/sender-rules/:id', params: { id: 'r1' } });
  assert.equal(resolve('POST', '/api/mail/sender-rules/r1/backfill'), null);
  assert.deepEqual(match('PUT', '/api/mail/folders/work'), { key: 'PUT /api/mail/folders/:slug', params: { slug: 'work' } });
  assert.deepEqual(match('POST', '/api/mail/drafts/d1/send'), { key: 'POST /api/mail/drafts/:id/send', params: { id: 'd1' } });
  assert.deepEqual(match('PUT', '/api/mail/drafts/d1'), { key: 'PUT /api/mail/drafts/:id', params: { id: 'd1' } });
  for (const suffix of ['', '/purge-preview', '/mode-impact', '/calendar']) {
    assert.deepEqual(match('GET', `/api/mail/accounts/a1${suffix}`), { key: `GET /api/mail/accounts/:id${suffix}`, params: { id: 'a1' } });
  }
  for (const suffix of ['/confirm-sync-policy', '/backup-export']) {
    assert.deepEqual(match('POST', `/api/mail/accounts/a1${suffix}`), { key: `POST /api/mail/accounts/:id${suffix}`, params: { id: 'a1' } });
  }
  assert.equal(resolve('GET', '/api/mail/accounts/a1/unknown'), null);
  assert.equal(resolve('POST', '/api/mail/accounts/a1/calendar'), null);
  assert.deepEqual(match('GET', '/api/mail/attachments/att1'), { key: 'GET /api/mail/attachments/:id', params: { id: 'att1' } });
  for (const action of ['retry', 'cancel', 'accept-server-state']) {
    assert.deepEqual(match('POST', `/api/mail/writebacks/w1/${action}`), { key: `POST /api/mail/writebacks/:id/${action}`, params: { id: 'w1' } });
  }
  assert.equal(resolve('POST', '/api/mail/writebacks/w1/delete'), null);
  assert.equal(resolve('POST', '/api/mail/writebacks/w1'), null);
  assert.deepEqual(match('PUT', '/api/mail/emails/e1/read'), { key: 'PUT /api/mail/emails/:id/read', params: { id: 'e1' } });
  assert.deepEqual(match('PUT', '/api/mail/emails/e1/star'), { key: 'PUT /api/mail/emails/:id/star', params: { id: 'e1' } });
  assert.deepEqual(match('GET', '/api/mail/emails/e1'), { key: 'GET /api/mail/emails/:id', params: { id: 'e1' } });
  // The old substring checks took any id containing "read" or "star" for the flag routes.
  assert.deepEqual(match('GET', '/api/mail/emails/starfish'), { key: 'GET /api/mail/emails/:id', params: { id: 'starfish' } });
  assert.equal(resolve('PUT', '/api/mail/emails/readme'), null);
});

test('the old recordings, backup and admin branches', () => {
  assert.deepEqual(match('POST', '/api/recordings/uploads/u1/chunk'), { key: 'POST /api/recordings/uploads/:id/chunk', params: { id: 'u1' } });
  assert.deepEqual(match('POST', '/api/recordings/uploads/u1/complete'), { key: 'POST /api/recordings/uploads/:id/complete', params: { id: 'u1' } });
  assert.deepEqual(match('DELETE', '/api/recordings/uploads/u1'), { key: 'DELETE /api/recordings/uploads/:id', params: { id: 'u1' } });
  assert.equal(resolve('PUT', '/api/recordings/uploads/u1'), null, 'the old chain left other upload methods unnormalized');
  assert.deepEqual(match('PUT', '/api/recordings/uploads'), { key: 'PUT /api/recordings/:id', params: { id: 'uploads' } });
  assert.deepEqual(match('DELETE', '/api/recordings/r1'), { key: 'DELETE /api/recordings/:id', params: { id: 'r1' } });
  for (const action of ['unlock', 'start', 'cancel']) {
    assert.deepEqual(match('POST', `/api/backup/restore-jobs/j1/${action}`), { key: `POST /api/backup/restore-jobs/:id/${action}`, params: { id: 'j1' } });
  }
  assert.deepEqual(match('GET', '/api/backup/jobs/j1/download'), { key: 'GET /api/backup/jobs/:id/download', params: { id: 'j1' } });
  assert.deepEqual(match('POST', '/api/backup/jobs/j1/recovery-password/reveal'), { key: 'POST /api/backup/jobs/:id/recovery-password/reveal', params: { id: 'j1' } });
  assert.deepEqual(match('DELETE', '/api/backup/jobs/j1'), { key: 'DELETE /api/backup/jobs/:id', params: { id: 'j1' } });
  assert.deepEqual(match('POST', '/api/admin/users/u2/2fa/reset'), { key: 'POST /api/admin/users/:id/2fa/reset', params: { id: 'u2' } });
  for (const action of ['password', 'role', 'activate']) {
    assert.deepEqual(match('PUT', `/api/admin/users/u2/${action}`), { key: `PUT /api/admin/users/:id/${action}`, params: { id: 'u2' } });
  }
  assert.deepEqual(match('DELETE', '/api/admin/users/u2'), { key: 'DELETE /api/admin/users/:id', params: { id: 'u2' } });
  assert.equal(resolve('GET', '/api/calendar/events/e1/todo-status'), null);
  assert.deepEqual(match('POST', '/api/calendar/accounts/a1/sync'), { key: 'POST /api/calendar/accounts/:id/sync', params: { id: 'a1' } });
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

test('route keys must be well-formed', () => {
  assert.throws(() => compileRouteMatcher(['GET api/contacts']), /Invalid route key/);
  assert.throws(() => compileRouteMatcher(['GET /api/contacts/:']), /Invalid route key/);
  assert.throws(() => compileRouteMatcher(['GET /api//:id']), /Invalid route key/);
});
