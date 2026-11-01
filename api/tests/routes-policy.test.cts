import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const { PassThrough } = (require('node:stream') as typeof import('node:stream'));
process.env.JWT_SECRET ||= 'routes-policy-test-only-secret';

// The production route table through the real request boundary. Only the
// session lookup is replaced; the database answers the role lookup and refuses
// everything else, so a handler that is reached shows up as a failure.
const routes = require('../dist/src/routes') as typeof import('../src/routes');
const auth = require('../dist/src/auth') as typeof import('../src/auth');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');
const { handleRequest } = require('../dist/src/request-handler') as typeof import('../src/request-handler');
const { MODULE_CATALOG } = require('../dist/src/services/module-catalog') as typeof import('../src/services/module-catalog');
const { defineRoutes, mergeRouteTables, assertRouteTable, destructivePolicies, routePolicies } = require('../dist/src/http/route') as typeof import('../src/http/route');
const { POLICIES } = require('../dist/src/services/settings') as typeof import('../src/services/settings');

const csrf = 'c'.repeat(64);
const samplePath = (pattern: string) => pattern.replace(/:(\w+)/g, (_, name) => `sample-${name}`);

function boundary(t: import('node:test').TestContext, { userId, role = 'user' }: { userId: string | null; role?: string }) {
  const queries: string[] = [];
  const previous = getDb();
  t.after(() => setDb(previous));
  setDb({ async execute(sql: string) {
    queries.push(sql);
    if (sql.startsWith('SELECT role FROM users WHERE id = ?')) return [[{ role }]];
    throw new Error(`Unexpected query in policy test: ${sql}`);
  } } as FixtureValue);
  t.mock.method(auth, 'verifyToken', async () => userId);
  async function run(key: string) {
    const [method, pattern] = key.split(' ');
    const req = new PassThrough();
    Object.assign(req, { method, url: samplePath(pattern), headers: {
      host: 'localhost', 'content-type': 'application/json', cookie: `csrf-token=${csrf}`, 'x-csrf-token': csrf,
    } });
    const res: FixtureValue = new EventEmitter(); const headers = new Map();
    res.setHeader = (name: string, value: FixtureValue) => headers.set(name.toLowerCase(), value);
    res.getHeader = (name: string) => headers.get(name.toLowerCase());
    res.writeHead = (status: number, values = {}) => { res.status = status; res.headersSent = true; Object.entries(values).forEach(([name, value]) => res.setHeader(name, value)); };
    res.end = (value: FixtureValue) => { res.body = value === undefined ? undefined : JSON.parse(String(value)); };
    const running = handleRequest(req as FixtureValue, res);
    setImmediate(() => req.end(method === 'GET' ? '' : '{}'));
    await running;
    return { status: res.status as number, body: res.body };
  }
  return { run, queries };
}

test('every route that is not public answers 401 without a session and never reaches its handler', async (t) => {
  const { run, queries } = boundary(t, { userId: null });
  const keys = Object.keys(routes).filter(key => routes[key].auth !== 'public');
  assert.ok(keys.length > 100, 'the complete production table');
  for (const key of keys) {
    const result = await run(key);
    assert.deepEqual([result.status, result.body], [401, { error: 'Unauthorized', status: 401 }], key);
  }
  assert.deepEqual(queries, [], 'no handler and no gate touched the database');
});

test('every route under /api/admin/ answers 403 to a signed-in user without the admin role, with no other query', async (t) => {
  const { run, queries } = boundary(t, { userId: 'plain-user', role: 'user' });
  const adminKeys = Object.keys(routes).filter(key => key.split(' ')[1].startsWith('/api/admin/'));
  assert.ok(adminKeys.length >= 9, `${adminKeys.length} admin routes`);
  for (const key of adminKeys) {
    const result = await run(key);
    assert.deepEqual([result.status, result.body.error], [403, 'Forbidden'], key);
  }
  assert.ok(queries.every(sql => sql.startsWith('SELECT role FROM users WHERE id = ?')), `only the role lookup ran: ${queries.join(' | ')}`);
  assert.equal(queries.length, adminKeys.length);
});

test('the two live streams and the vCard export are the only routes that own their response', () => {
  const streaming = Object.keys(routes).filter(key => routes[key].response === 'stream').sort();
  assert.deepEqual(streaming, ['GET /api/contacts/export', 'GET /api/events', 'GET /api/notifications/android/stream', 'POST /api/contacts/export']);
});

test('the public routes are exactly the ones a client needs before signing in, and the download ticket', () => {
  const publicKeys = Object.keys(routes).filter(key => routes[key].auth === 'public').sort();
  assert.deepEqual(publicKeys, [
    'GET /api/auth/signup-mode', 'GET /api/backup/export', 'GET /api/files/tickets/:token', 'GET /api/version', 'GET /health',
    'POST /api/auth/2fa/login', 'POST /api/auth/signin', 'POST /api/auth/signup',
  ]);
});

test('the production table passes the whole-table invariants, and a table that breaks one is refused', () => {
  const moduleIds = MODULE_CATALOG.map(module => module.id);
  assert.doesNotThrow(() => assertRouteTable(routes, { moduleIds }));
  const handler = async () => ({});
  assert.throws(() => assertRouteTable(defineRoutes({ 'POST /api/contacts/x': { auth: 'user', module: null, restoreSection: 'contacts', handler } }), { moduleIds }),
    /must declare module "contacts"/);
  assert.throws(() => assertRouteTable(defineRoutes({ 'POST /api/things': { auth: 'user', module: null, handler } }), { moduleIds }),
    /must declare restoreSection/);
  assert.throws(() => assertRouteTable(defineRoutes({ 'GET /api/admin/things': { auth: 'user', module: null, handler } }), { moduleIds }),
    /must declare auth "admin"/);
  assert.doesNotThrow(() => assertRouteTable(defineRoutes({ 'POST /api/things': { auth: 'user', module: null, restoreSection: null, handler } }), { moduleIds }));
  assert.throws(() => assertRouteTable(defineRoutes({ 'GET /api/things/:id': { auth: 'user', handler }, 'GET /api/things/:other': { auth: 'user', handler } }), { moduleIds }),
    /does not resolve/);
  assert.throws(() => defineRoutes({ 'PATCH /api/things': { auth: 'user', handler } } as FixtureValue), /key must be "METHOD \/path"/);
  assert.throws(() => defineRoutes({ 'GET /api/things': { auth: 'owner', handler } } as FixtureValue), /unknown auth/);
  assert.throws(() => defineRoutes({ 'GET /api/things': { auth: 'user', body: { limit: 0 }, handler } }), /body.limit/);
});

test('restore sections: every section has a write route, destructive settings lock their module, backup and account deletion are declared', () => {
  const { getRestoreSectionForWrite } = require('../dist/src/routes/restore-sections') as typeof import('../src/routes/restore-sections');
  const { SECTION_POLICIES } = require('../dist/src/services/backup-catalog') as typeof import('../src/services/backup-catalog');
  for (const section of Object.keys(SECTION_POLICIES)) assert.ok(Object.values(routes).some(spec => spec.restoreSection === section), section);
  for (const [key, section] of [
    ['PUT /api/contacts/:id', 'contacts'], ['POST /api/calendar/events', 'calendar'], ['POST /api/mail/emails/bulk-update', 'mail'], ['PUT /api/recordings/:id', 'recordings'],
    ['POST /api/settings/clear-contacts', 'contacts'], ['POST /api/settings/clear-calendar', 'calendar'], ['POST /api/settings/clear-mail-accounts', 'mail'],
    ['POST /api/settings/clear-recordings', 'recordings'], ['PUT /api/settings/preferences', 'settings'], ['PUT /api/auth/profile', 'settings'],
    ['PUT /api/modules', 'settings'], ['DELETE /api/settings/account', '*'], ['POST /api/backup/restore-jobs/:id/cancel', null], ['POST /api/notifications/test', null],
  ] as const) assert.equal(routes[key].restoreSection, section, key);
  assert.equal(getRestoreSectionForWrite('PUT', '/api/contacts/c1'), 'contacts');
  assert.equal(getRestoreSectionForWrite('POST', '/api/settings/clear-mail-accounts'), 'mail');
  assert.equal(getRestoreSectionForWrite('DELETE', '/api/settings/account'), '*');
  assert.equal(getRestoreSectionForWrite('GET', '/api/contacts'), null);
  assert.equal(getRestoreSectionForWrite('POST', '/api/contacts-unrelated'), null);
  const { MODULE_CATALOG } = require('../dist/src/services/module-catalog') as typeof import('../src/services/module-catalog');
  const handler = async () => ({});
  assert.throws(() => assertRouteTable(defineRoutes({ 'POST /api/things': { auth: 'user', module: null, restoreSection: 'settings', handler } }),
    { moduleIds: MODULE_CATALOG.map(module => module.id), sections: ['settings', 'contacts'] }), /no route writes section contacts/);
});

test('CSRF: sign-in and sign-up need no token, exactly the service-worker routes accept the background header', () => {
  const none = Object.keys(routes).filter(key => routes[key].csrf === 'none').sort();
  assert.deepEqual(none, ['POST /api/auth/signin', 'POST /api/auth/signup']);
  const header = Object.keys(routes).filter(key => routes[key].csrf === 'background-header').sort();
  assert.deepEqual(header, ['DELETE /api/recordings/uploads/:id', 'POST /api/mail/sync/background', 'POST /api/recordings/uploads/:id/chunk',
    'POST /api/recordings/uploads/:id/complete', 'POST /api/recordings/uploads/start']);
});

// F13: every route that removes or resets data names the data-safety
// policies the boundary checks before it acts, or is on this list with the
// reason it removes nothing a policy protects. A data-removing route is any
// DELETE, and any POST whose path names a removal; a new one fails here until
// it is declared or listed. The real refusals are walked in
// policies-mysql-integration.
const NOT_DESTRUCTIVE: Readonly<Record<string, string>> = {
  'DELETE /api/auth/sessions/:id': 'signs a device out; no data',
  'DELETE /api/notifications/subscription': 'a device\'s push channel',
  'DELETE /api/calendar/events/:id/move': 'cancels a task\'s pending move between lists',
  'DELETE /api/calendar/events/:id/subtasks/:subtaskId': 'editing a task',
  'DELETE /api/mail/drafts/:id': 'editing: a draft',
  'DELETE /api/mail/drafts/:id/schedule': 'cancels a scheduled send; the draft stays',
  'DELETE /api/mail/emails/:id/snooze': 'ends a snooze',
  'DELETE /api/mail/sender-rules/:id': 'editing: a sorting rule',
  'DELETE /api/mail/templates/:id': 'editing: a template',
  'DELETE /api/mail/folders/:slug': 'mail-client editing: a local folder\'s mail returns to Inbox; with server=true the provider\'s folder goes, as in any mail client',
  'POST /api/mail/emails/bulk-delete': 'moves messages to Trash',
  'DELETE /api/recordings/uploads/:id': 'cancels an unfinished upload',
  'POST /api/contacts/merges': 'the merged-away contacts go to the bin; the undo restores them',
  'POST /api/contacts/merges/auto': 'the same merge for several groups',
  'POST /api/contacts/merges/:id/undo': 'restores merged contacts',
  'DELETE /api/admin/users/:id': 'admin path: role, password and activity log; a person\'s policy never stops an administrator',
  'POST /api/admin/users/:id/2fa/reset': 'admin path, as above',
};
const removesData = (key: string) => {
  const [method, path] = key.split(' ');
  return method === 'DELETE' || (method === 'POST' && /delete|clear|purge|reset|remove|empty|merge/.test(path));
};
const DESTRUCTIVE = [
  'DELETE /api/backup/jobs/:id', 'DELETE /api/backup/restore-jobs/:id', 'DELETE /api/calendar/accounts/:id', 'DELETE /api/calendar/calendars/:id',
  'DELETE /api/calendar/events/:id', 'DELETE /api/contacts/:id', 'DELETE /api/contacts/:id/photo', 'DELETE /api/mail/accounts/:id',
  'DELETE /api/recordings/:id', 'DELETE /api/settings/account', 'POST /api/contacts/bulk-delete', 'POST /api/settings/clear-calendar',
  'POST /api/settings/clear-contacts', 'POST /api/settings/clear-mail-accounts', 'POST /api/settings/clear-recordings',
];

test('every route that removes data declares its policies or is on the reasoned list, and the declared set is pinned', () => {
  for (const key of Object.keys(routes).filter(removesData)) {
    assert.ok(routes[key].destructive || NOT_DESTRUCTIVE[key], `${key} removes data: declare its destructive policies or list why not`);
    assert.ok(!(routes[key].destructive && NOT_DESTRUCTIVE[key]), `${key} is both declared and listed`);
  }
  for (const key of Object.keys(NOT_DESTRUCTIVE)) assert.ok(key in routes, `${key} is listed but has no route`);
  assert.deepEqual(Object.keys(routes).filter(key => routes[key].destructive).sort(), DESTRUCTIVE);
  assert.deepEqual(Object.keys(routes).filter(key => routes[key].requires).sort(), [
    'POST /api/backup/import', 'POST /api/backup/jobs', 'POST /api/backup/jobs/:id/restore', 'POST /api/backup/restore-jobs/:id/start',
    'POST /api/calendar/accounts', 'POST /api/mail/accounts', 'POST /api/mail/accounts/:id/backup-export',
  ]);
});

test('each destructive route names the policies of what it removes', () => {
  const none = new URLSearchParams();
  const expected: Record<string, string[]> = {
    'DELETE /api/backup/jobs/:id': ['backup.delete'], 'DELETE /api/backup/restore-jobs/:id': ['backup.delete'],
    'DELETE /api/calendar/accounts/:id': ['accounts.remove'],
    // Deleting for good until 0.28 moves these items to the bin; a photo is
    // removed for good even then.
    'DELETE /api/calendar/calendars/:id': ['bin.delete'], 'DELETE /api/calendar/events/:id': ['bin.delete'], 'DELETE /api/recordings/:id': ['bin.delete'],
    'DELETE /api/contacts/:id': ['bin.delete'], 'POST /api/contacts/bulk-delete': ['bin.delete'], 'DELETE /api/contacts/:id/photo': ['bin.delete'],
    'DELETE /api/settings/account': ['account.delete'],
    'POST /api/settings/clear-contacts': ['data.clear'], 'POST /api/settings/clear-recordings': ['data.clear'],
    // Clearing calendar or mail removes the module's accounts too.
    'POST /api/settings/clear-calendar': ['data.clear', 'accounts.remove'],
    'POST /api/settings/clear-mail-accounts': ['data.clear', 'accounts.remove', 'accounts.reset'],
    'DELETE /api/mail/accounts/:id': ['accounts.remove'],
  };
  for (const key of DESTRUCTIVE) assert.deepEqual(routePolicies(routes[key], none), expected[key], key);
  // Removing a mail account, and deleting UniHub's copy of its mail only when asked.
  const remove = routes['DELETE /api/mail/accounts/:id'];
  assert.deepEqual(destructivePolicies(remove, new URLSearchParams('purge=true&confirm_purge=x')), ['accounts.remove', 'accounts.reset'], 'purge a disconnected account');
  assert.deepEqual(destructivePolicies(remove, new URLSearchParams('purge=true&disconnect=true')), ['accounts.remove', 'accounts.reset'], 'disconnect and purge');
  assert.deepEqual(destructivePolicies(remove, new URLSearchParams('purge=false')), ['accounts.remove']);
  assert.deepEqual(routePolicies(routes['POST /api/mail/accounts'], none), ['accounts.add']);
  assert.deepEqual(routePolicies(routes['POST /api/backup/import'], none), ['backup.restore']);
});

test('a route declares only keys that can refuse, only on a mutating user route, with named query values', () => {
  const handler = async () => ({});
  const moduleIds = MODULE_CATALOG.map(module => module.id);
  const policyKeys = Object.entries(POLICIES).filter(([, entry]) => entry.refuses.length).map(([key]) => key);
  for (const key of [...DESTRUCTIVE, 'POST /api/mail/accounts']) {
    for (const policy of routePolicies(routes[key], new URLSearchParams('purge=true'))) assert.ok(POLICIES[policy].refuses.length, `${key}: ${policy}`);
  }
  assert.ok(!policyKeys.includes('backup.server_retention_days') && !policyKeys.includes('accounts.admin_manage'));
  assert.throws(() => defineRoutes({ 'GET /api/things': { auth: 'user', destructive: ['accounts.remove'], handler } }), /only a mutating route/);
  assert.throws(() => defineRoutes({ 'POST /api/things': { auth: 'public', requires: ['accounts.add'], handler } }), /only a user route/);
  assert.throws(() => defineRoutes({ 'DELETE /api/admin/things': { auth: 'admin', permission: 'users.manage', destructive: ['accounts.remove'], handler } }), /only a user route/);
  assert.throws(() => defineRoutes({ 'DELETE /api/things': { auth: 'user', destructive: [], handler } }), /lists at least one policy/);
  assert.throws(() => defineRoutes({ 'DELETE /api/things': { auth: 'user', destructive: [{ policy: 'accounts.reset', query: {} }], handler } }), /names its query values/);
  assert.throws(() => assertRouteTable(defineRoutes({ 'DELETE /api/things': { auth: 'user', restoreSection: null, destructive: ['things.remove'], handler } } as FixtureValue), { moduleIds, policyKeys }),
    /unknown policy things.remove/);
  assert.throws(() => assertRouteTable(defineRoutes({ 'POST /api/things': { auth: 'user', restoreSection: null, requires: ['accounts.admin_manage'], handler } }), { moduleIds, policyKeys }),
    /unknown policy accounts.admin_manage/);
});

// Limits declared by converted route files; the derived ones are pinned by route-spec.test.cts.
test('credential routes keep their explicit body limits in the production table', () => {
  for (const key of ['PUT /api/admin/users/:id/password', 'POST /api/auth/signin', 'POST /api/auth/signup', 'PUT /api/auth/password']) {
    assert.equal(routes[key].body?.limit, 4096, key);
  }
});

test('a route key declared in two files is refused instead of one file silently winning', () => {
  const handler = async () => ({});
  const first = defineRoutes({ 'GET /api/things': { auth: 'user', handler } });
  const second = defineRoutes({ 'GET /api/things': { auth: 'public', handler } });
  assert.throws(() => mergeRouteTables(first, second), /Duplicate route GET \/api\/things/);
  assert.equal(Object.keys(mergeRouteTables(first, defineRoutes({ 'GET /api/other': { auth: 'user', handler } }))).length, 2);
});
