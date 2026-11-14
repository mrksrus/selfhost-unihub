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

// `answer` may answer further queries (the gates before the app lock's); anything else is refused.
function boundary(t: import('node:test').TestContext, { userId, role = 'user', answer }: { userId: string | null; role?: string; answer?: (sql: string) => unknown[] | undefined }) {
  const queries: string[] = [];
  const previous = getDb();
  t.after(() => setDb(previous));
  setDb({ async execute(sql: string) {
    queries.push(sql);
    if (sql.startsWith('SELECT role FROM users WHERE id = ?')) return [[{ role }]];
    const rows = answer?.(sql);
    if (rows) return [rows];
    throw new Error(`Unexpected query in policy test: ${sql}`);
  } } as FixtureValue);
  t.mock.method(auth, 'verifyToken', async () => userId);
  async function run(key: string, extraHeaders: Record<string, string> = {}) {
    const [method, pattern] = key.split(' ');
    const req = new PassThrough();
    Object.assign(req, { method, url: samplePath(pattern), headers: {
      host: 'localhost', 'content-type': 'application/json', cookie: `csrf-token=${csrf}`, 'x-csrf-token': csrf, ...extraHeaders,
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
    'POST /api/auth/2fa/login', 'POST /api/auth/invite/accept', 'POST /api/auth/invite/check', 'POST /api/auth/signin', 'POST /api/auth/signup',
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
  assert.deepEqual(none, ['POST /api/auth/invite/accept', 'POST /api/auth/invite/check', 'POST /api/auth/signin', 'POST /api/auth/signup']);
  const header = Object.keys(routes).filter(key => routes[key].csrf === 'background-header').sort();
  assert.deepEqual(header, ['DELETE /api/recordings/uploads/:id', 'POST /api/mail/sync/background', 'POST /api/recordings/uploads/:id/chunk',
    'POST /api/recordings/uploads/:id/complete', 'POST /api/recordings/uploads/start']);
});

// The app lock (0.29): the routes a device short of a required lock keeps,
// each with its reason. Everything else is refused with APP_LOCK_REQUIRED
// while the whole app is required, a module's routes while that module is,
// and the routes of no module while anything is.
const APP_LOCK_EXEMPT: Readonly<Record<string, string>> = {
  'GET /api/auth/me': 'who is signed in; the page needs it to show the prompt',
  'POST /api/auth/signout': 'signing out never needs the lock',
  'GET /api/auth/sessions': 'the sign-ins of pages from before 0.29',
  'DELETE /api/auth/sessions/:id': 'signing a lost device out, from pages from before 0.29',
  'PUT /api/auth/password': 'a password change protects the account; it shows no data',
  'PUT /api/auth/profile': 'name and email of the account, as auth/me shows them',
  'GET /api/auth/2fa/status': 'two-factor sign-in protects the account',
  'POST /api/auth/2fa/setup/start': 'as above',
  'POST /api/auth/2fa/setup/confirm': 'as above',
  'POST /api/auth/2fa/disable': 'as above',
  'POST /api/auth/2fa/recovery-codes/regenerate': 'as above',
  'GET /api/devices': 'the person\'s devices, where the lock is set up and a lost one is found',
  'DELETE /api/devices/:id': 'signing a lost device out must stay possible from any device',
  'GET /api/devices/current': 'what this device must lock, and whether it does',
  'POST /api/devices/current/key': 'names this device',
  'PUT /api/devices/current/lock': 'reports the lock: how a device starts to comply',
  'POST /api/devices/current/lock-state': 'reports open, background or locked',
  'GET /api/settings/values': 'the person\'s settings; they show no module data',
  'PUT /api/settings/values': 'as above',
  'GET /api/settings/values/device': 'this device\'s app lock settings',
  'PUT /api/settings/values/device': 'turning the lock on',
  'GET /api/settings/preferences': 'theme and pages, which the shell needs to show the prompt',
  'PUT /api/settings/preferences': 'as above',
  'GET /api/policies/effective': 'the rules, with the reason the lock is required',
  'POST /api/policies/acknowledge': 'confirming the rules notice, which comes before the prompt',
  'GET /api/modules': 'which pages the shell shows',
  'GET /api/events': 'live hints carry ids and counts only (F7); a device needs them to hear of a policy change or a sign-out',
  'GET /api/notifications/config': 'push set-up; a device short of the lock gets notifications without their content',
  'GET /api/notifications/status': 'as above',
  'POST /api/notifications/subscription': 'as above',
  'DELETE /api/notifications/subscription': 'as above',
  'POST /api/notifications/unsubscribe': 'as above',
  'POST /api/notifications/test': 'a test notification shows no data',
  'POST /api/notifications/android/devices': 'the Android app\'s push channel',
  'POST /api/notifications/android/ack': 'as above',
  'GET /api/notifications/android/stream': 'as above',
  'POST /api/recordings/uploads/start': 'a recording that exists only on the device must reach the server',
  'POST /api/recordings/uploads/:id/chunk': 'as above',
  'POST /api/recordings/uploads/:id/complete': 'as above',
  'DELETE /api/recordings/uploads/:id': 'cancels an unfinished upload',
};
// Open only to the Android app's own contacts sync (X-Background-Sync: 1):
// the apps in the support window read a 403 other than MODULE_DISABLED as a
// refused change and skip the contact. The page never sends the header here.
const APP_LOCK_BACKGROUND_SYNC = [
  'DELETE /api/contacts/:id', 'DELETE /api/contacts/:id/photo', 'GET /api/contacts', 'GET /api/contacts/:id/photo', 'POST /api/contacts',
  'PUT /api/contacts/:id', 'PUT /api/contacts/:id/photo',
];

test('the app lock: the exempt routes are pinned with their reasons, and so are the contacts-sync routes', () => {
  assert.deepEqual(Object.keys(routes).filter(key => routes[key].appLock === 'exempt').sort(), Object.keys(APP_LOCK_EXEMPT).sort());
  assert.deepEqual(Object.keys(routes).filter(key => routes[key].appLock === 'background-sync').sort(), APP_LOCK_BACKGROUND_SYNC);
  const handler = async () => ({});
  assert.throws(() => defineRoutes({ 'GET /api/things': { auth: 'user', appLock: 'open', handler } } as FixtureValue), /unknown appLock open/);
  assert.throws(() => defineRoutes({ 'GET /api/things': { auth: 'public', appLock: 'exempt', handler } } as FixtureValue), /only a signed-in route declares appLock/);
});

// The gates before the app lock's, answered for a person with every module on and no restore running.
const openGates = (required: string[]) => (sql: string) => {
  if (sql.startsWith('SELECT setting_value FROM user_settings')) return [];
  if (sql.includes('FROM backup_restore_jobs')) return [];
  if (sql.startsWith('SELECT target_kind, setting_key, setting_value, locked FROM setting_policies')) {
    return [{ target_kind: 'installation', setting_key: 'policy.app_lock.required', setting_value: JSON.stringify(required), locked: 0 }];
  }
  return undefined;
};

test('with the whole app required, every signed-in route that is not exempt refuses a device without the lock before its handler', async (t) => {
  const { run, queries } = boundary(t, { userId: 'alex', role: 'owner', answer: openGates(['app']) });
  const keys = Object.keys(routes).filter(key => routes[key].auth !== 'public' && routes[key].appLock !== 'exempt');
  assert.ok(keys.length > 100, `${keys.length} locked routes`);
  for (const key of keys) {
    const result = await run(key);
    assert.deepEqual([result.status, result.body.code, result.body.error], [403, 'APP_LOCK_REQUIRED', 'Your administrator requires the app lock for the whole app.'], key);
    assert.deepEqual(result.body.details, { required: ['app'], max_background: null, reason: 'Your administrator requires the app lock for the whole app.' }, key);
  }
  assert.ok(queries.every(sql => /^SELECT (role FROM users|setting_value FROM user_settings|requested_sections|target_kind, setting_key, setting_value, locked FROM setting_policies)/.test(sql.trim())), 'no handler ran');
  // The gates (module, data safety, app lock) share one read of the person's rules (R2).
  assert.equal(queries.filter(sql => sql.includes('FROM setting_policies')).length, keys.length, 'one policy read per request');
});

test('with Mail required, a device without the lock loses the Mail routes and the routes of no module, and keeps the other modules', async (t) => {
  const { run } = boundary(t, { userId: 'alex', role: 'owner', answer: openGates(['mail']) });
  const locked = (key: string) => routes[key].auth !== 'public' && routes[key].appLock !== 'exempt' && (routes[key].module === 'mail' || !routes[key].module);
  for (const key of Object.keys(routes).filter(locked)) {
    const result = await run(key);
    assert.deepEqual([result.status, result.body.code, result.body.error], [403, 'APP_LOCK_REQUIRED', 'Your administrator requires the app lock for Mail.'], key);
  }
});

test('a route that shows another module\'s data is locked with that module: a mail account\'s calendar with Calendar required', async (t) => {
  const { run } = boundary(t, { userId: 'alex', answer: openGates(['calendar']) });
  const declared = Object.keys(routes).filter(key => routes[key].appLockModules).sort();
  assert.deepEqual(declared, ['GET /api/mail/accounts/:id/calendar', 'PUT /api/mail/accounts/:id/calendar']);
  for (const key of declared) {
    assert.deepEqual(routes[key].appLockModules, ['calendar']);
    assert.equal((await run(key)).body.code, 'APP_LOCK_REQUIRED', key);
  }
  const handler = async () => ({});
  assert.throws(() => assertRouteTable(defineRoutes({ 'GET /api/mail/x': { auth: 'user', module: 'mail', appLockModules: ['notes'], handler } }), { moduleIds: MODULE_CATALOG.map(module => module.id) }),
    /unknown module notes/);
});

test('the contacts-sync routes are open to the Android app\'s own sync only', async (t) => {
  const { run } = boundary(t, { userId: 'alex', answer: openGates(['contacts']) });
  assert.equal((await run('GET /api/contacts')).body.code, 'APP_LOCK_REQUIRED');
  const native = await run('GET /api/contacts', { 'x-background-sync': '1' });
  assert.notEqual(native.body?.code, 'APP_LOCK_REQUIRED');
  assert.equal((await run('GET /api/contacts/:id', { 'x-background-sync': '1' })).body.code, 'APP_LOCK_REQUIRED', 'only the routes the sync uses');
});

// F13: every route that removes or resets data names the data-safety
// policies the boundary checks before it acts, or is on this list with the
// reason it removes nothing a policy protects. A data-removing route is any
// DELETE, and any POST whose path names a removal; a new one fails here until
// it is declared or listed. The limit: a PUT, or a POST named otherwise, that
// removes data, or a removal chosen by the body (the provider-deletion switch
// of a mail account, its mode, a mail account's linked calendar), is not
// found by name; review and the service checks carry those
// (mail-account-mode.ts, calendar-accounts.ts setMailCalendar). The real refusals are walked in
// policies-mysql-integration.
const NOT_DESTRUCTIVE: Readonly<Record<string, string>> = {
  'DELETE /api/auth/sessions/:id': 'signs a device out; no data',
  // A policy that forbade it would keep a lost phone signed in.
  'DELETE /api/devices/:id': 'signs a device out; its lock settings are installation state, no user data',
  'DELETE /api/notifications/subscription': 'a device\'s push channel',
  'DELETE /api/calendar/events/:id/move': 'cancels a task\'s pending move between lists',
  'DELETE /api/calendar/events/:id/subtasks/:subtaskId': 'editing a task',
  'DELETE /api/mail/drafts/:id': 'editing: a draft',
  'DELETE /api/mail/drafts/:id/schedule': 'cancels a scheduled send; the draft stays',
  'DELETE /api/mail/emails/:id/snooze': 'ends a snooze',
  'DELETE /api/mail/sender-rules/:id': 'editing: a sorting rule',
  'DELETE /api/mail/templates/:id': 'editing: a template',
  'POST /api/mail/emails/bulk-delete': 'moves messages to Trash',
  'DELETE /api/recordings/uploads/:id': 'cancels an unfinished upload',
  'POST /api/contacts/merges': 'the merged-away contacts go to the bin; the undo restores them',
  'POST /api/contacts/merges/auto': 'the same merge for several groups',
  'POST /api/contacts/merges/:id/undo': 'restores merged contacts',
  'DELETE /api/contacts/:id': 'moves the contact to the bin',
  'POST /api/contacts/bulk-delete': 'moves the contacts to the bin',
  'DELETE /api/calendar/events/:id': 'moves the event or task to the bin (a synced one is deleted at its server and kept there); one date of a repeating server event is removed at the server for good, which its service checks against bin.delete first',
  'DELETE /api/calendar/calendars/:id': 'moves a UniHub list with its events to the bin; a server calendar is refused (it is removed with its account)',
  'DELETE /api/recordings/:id': 'moves the recording to the bin',
  'DELETE /api/admin/users/:id': 'admin path: role, password and activity log; a person\'s policy never stops an administrator',
  'POST /api/admin/users/:id/2fa/reset': 'admin path, as above',
  // The administrator's path for a person (routes/admin-people.ts): what a
  // policy forbids the person; password and activity log, the person's
  // module switch and restore lock checked in the service.
  'DELETE /api/admin/users/:id/mail-accounts/:accountId': 'admin path, as above',
  'DELETE /api/admin/users/:id/calendar-accounts/:accountId': 'admin path, as above',
  'DELETE /api/admin/users/:id/backups/:jobId': 'admin path, as above; also before backup.server_retention_days',
  'DELETE /api/admin/users/:id/bin/:itemId': 'admin path, as above',
  'POST /api/admin/users/:id/bin/empty': 'admin path, as above',
  'POST /api/admin/users/:id/clear/:module': 'admin path, as above',
  // The organisation (0.30): sign-ins, links and memberships, no person's data.
  'DELETE /api/admin/users/:id/setup-link': 'revokes a sign-up link; no data',
  'DELETE /api/admin/users/:id/devices/:deviceId': 'admin path: signs devices out; no data',
  'DELETE /api/admin/users/:id/devices': 'admin path: signs devices out; no data',
  'DELETE /api/admin/groups/:id': 'admin path: a group, its memberships and its policies; no person\'s data',
  'DELETE /api/groups/:id/members/:userId': 'a membership; no data',
};
const removesData = (key: string) => {
  const [method, path] = key.split(' ');
  return method === 'DELETE' || (method === 'POST' && /delete|clear|purge|reset|remove|empty|merge/.test(path));
};
const DESTRUCTIVE = [
  'DELETE /api/backup/jobs/:id', 'DELETE /api/backup/restore-jobs/:id', 'DELETE /api/bin/:id', 'DELETE /api/calendar/accounts/:id',
  'DELETE /api/contacts/:id/photo', 'DELETE /api/mail/accounts/:id', 'DELETE /api/mail/folders/:slug', 'DELETE /api/settings/account', 'POST /api/bin/empty',
  'POST /api/settings/clear-calendar', 'POST /api/settings/clear-contacts', 'POST /api/settings/clear-mail-accounts', 'POST /api/settings/clear-recordings',
];

test('every route that removes data declares its policies or is on the reasoned list, and the declared set is pinned', () => {
  for (const key of Object.keys(routes).filter(removesData)) {
    assert.ok(routes[key].destructive || NOT_DESTRUCTIVE[key], `${key} removes data: declare its destructive policies or list why not`);
    assert.ok(!(routes[key].destructive && NOT_DESTRUCTIVE[key]), `${key} is both declared and listed`);
  }
  for (const key of Object.keys(NOT_DESTRUCTIVE)) assert.ok(key in routes, `${key} is listed but has no route`);
  assert.deepEqual(Object.keys(routes).filter(key => routes[key].destructive).sort(), DESTRUCTIVE);
  assert.deepEqual(Object.keys(routes).filter(key => routes[key].requires).sort(), [
    'GET /api/offline/snapshot', 'POST /api/backup/import', 'POST /api/backup/jobs', 'POST /api/backup/jobs/:id/restore', 'POST /api/backup/restore-jobs/:id/start',
    'POST /api/calendar/accounts', 'POST /api/mail/accounts', 'POST /api/mail/accounts/:id/backup-export',
  ]);
});

test('each destructive route names the policies of what it removes', () => {
  const none = new URLSearchParams();
  const expected: Record<string, string[]> = {
    'DELETE /api/backup/jobs/:id': ['backup.delete'], 'DELETE /api/backup/restore-jobs/:id': ['backup.delete'],
    'DELETE /api/calendar/accounts/:id': ['accounts.remove'],
    // Deleting from the bin for good and emptying it; a contact's photo is
    // removed for good, not kept in the bin.
    'DELETE /api/bin/:id': ['bin.delete'], 'POST /api/bin/empty': ['bin.delete'], 'DELETE /api/contacts/:id/photo': ['bin.delete'],
    'DELETE /api/settings/account': ['account.delete'],
    'POST /api/settings/clear-contacts': ['data.clear'], 'POST /api/settings/clear-recordings': ['data.clear'],
    // Clearing calendar or mail removes the module's accounts too.
    'POST /api/settings/clear-calendar': ['data.clear', 'accounts.remove'],
    'POST /api/settings/clear-mail-accounts': ['data.clear', 'accounts.remove', 'accounts.reset'],
    'DELETE /api/mail/accounts/:id': ['accounts.remove'],
    // A folder only UniHub has returns its mail to Inbox.
    'DELETE /api/mail/folders/:slug': [],
  };
  for (const key of DESTRUCTIVE) assert.deepEqual(routePolicies(routes[key], none), expected[key], key);
  // Removing a mail account, and deleting UniHub's copy of its mail only when asked.
  const remove = routes['DELETE /api/mail/accounts/:id'];
  assert.deepEqual(destructivePolicies(remove, new URLSearchParams('purge=true&confirm_purge=x')), ['accounts.remove', 'accounts.reset'], 'purge a disconnected account');
  assert.deepEqual(destructivePolicies(remove, new URLSearchParams('purge=true&disconnect=true')), ['accounts.remove', 'accounts.reset'], 'disconnect and purge');
  assert.deepEqual(destructivePolicies(remove, new URLSearchParams('purge=false')), ['accounts.remove']);
  // Deleting a folder at the provider too, for each value the route reads as
  // "server" (its first value, decoded), and for none it reads as local.
  const { SERVER_DELETE_VALUES } = require('../dist/src/services/mail-folder-delete') as typeof import('../src/services/mail-folder-delete');
  assert.deepEqual([...SERVER_DELETE_VALUES].sort(), ['1', 'true']);
  const folder = routes['DELETE /api/mail/folders/:slug'];
  for (const query of ['server=true', 'server=1', 'server=%74rue', 'server=1&server=0', 'x=1&server=true']) {
    assert.deepEqual(destructivePolicies(folder, new URLSearchParams(query)), ['mail.provider_delete'], query);
  }
  for (const query of ['', 'server=false', 'server=0', 'server=TRUE', 'server=', 'server=0&server=1', 'servers=1']) {
    assert.deepEqual(destructivePolicies(folder, new URLSearchParams(query)), [], query);
  }
  assert.deepEqual(routePolicies(routes['POST /api/mail/accounts'], none), ['accounts.add']);
  assert.deepEqual(routePolicies(routes['POST /api/backup/import'], none), ['backup.restore']);
});

test('a route declares only keys that can refuse, only on a user route (destructive ones on a mutating route), with named query values', () => {
  const handler = async () => ({});
  const moduleIds = MODULE_CATALOG.map(module => module.id);
  const policyKeys = Object.entries(POLICIES).filter(([, entry]) => entry.refuses.length).map(([key]) => key);
  for (const key of [...DESTRUCTIVE, 'POST /api/mail/accounts']) {
    for (const policy of routePolicies(routes[key], new URLSearchParams('purge=true&server=true'))) assert.ok(POLICIES[policy].refuses.length, `${key}: ${policy}`);
  }
  assert.ok(!policyKeys.includes('backup.server_retention_days') && !policyKeys.includes('accounts.admin_manage'));
  assert.throws(() => defineRoutes({ 'GET /api/things': { auth: 'user', destructive: ['accounts.remove'], handler } }), /only a mutating route/);
  assert.throws(() => defineRoutes({ 'POST /api/things': { auth: 'public', requires: ['accounts.add'], handler } }), /only a user route/);
  assert.throws(() => defineRoutes({ 'DELETE /api/admin/things': { auth: 'admin', permission: 'users.manage', destructive: ['accounts.remove'], handler } }), /only a user route/);
  assert.throws(() => defineRoutes({ 'DELETE /api/things': { auth: 'user', destructive: [], handler } }), /lists at least one policy/);
  assert.throws(() => defineRoutes({ 'DELETE /api/things': { auth: 'user', destructive: [{ policy: 'accounts.reset', query: {} }], handler } }), /names its query values/);
  assert.throws(() => defineRoutes({ 'DELETE /api/things': { auth: 'user', destructive: [{ policy: 'accounts.reset', query: { purge: [] } }], handler } }), /names its query values/);
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
