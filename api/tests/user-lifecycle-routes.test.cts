import type { FixtureValue, RouteTable } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

process.env.JWT_SECRET ||= 'user-lifecycle-routes-test-secret';

// Both deletion routes hand the work to services/user-lifecycle; these cases
// pin what each route still decides itself before calling it, and that a
// refusal thrown by the service reaches the client with its status.
function stubModules(t: FixtureValue, stubs: Record<string, FixtureValue>, reload: string[]) {
  const saved = new Map<string, NodeJS.Module | undefined>();
  for (const name of [...Object.keys(stubs), ...reload]) {
    const resolved = require.resolve(name);
    saved.set(resolved, require.cache[resolved]);
    delete require.cache[resolved];
  }
  for (const [name, exports] of Object.entries(stubs)) {
    const resolved = require.resolve(name);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeJS.Module;
  }
  t.after(() => {
    for (const [resolved, original] of saved) {
      if (original) require.cache[resolved] = original;
      else delete require.cache[resolved];
    }
  });
}

function lifecycleStub(fail?: FixtureValue) {
  const calls: FixtureValue[] = [];
  return { calls, deleteUser: async (userId: string, options: FixtureValue) => { calls.push([userId, options]); if (fail) throw fail; return { files: { removed: 0, failed: 0 } }; } };
}

test('admin user deletion keeps its own checks and reports the service refusal', async (t) => {
  const { hashPassword } = require('../dist/src/auth') as typeof import('../src/auth');
  const adminHash = await hashPassword('synthetic-route-admin-password');
  // The route takes a person's id only as a UUID (admin-path.ts personFromParam).
  const [admin1, admin2, user1] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000001'];
  const users: Record<string, { role: string; is_active: number }> = {
    [admin1]: { role: 'admin', is_active: 1 }, [admin2]: { role: 'admin', is_active: 1 }, [user1]: { role: 'user', is_active: 1 },
  };
  let activeAdmins = 2;
  const lifecycle = lifecycleStub();
  stubModules(t, {
    '../dist/src/state': { db: { execute: async (sql: string, params: FixtureValue[]) => {
      // The stored spelling of the id (the database compares ids without case).
      if (sql === 'SELECT id FROM users WHERE id = ?') { const id = Object.keys(users).find(key => key === String(params[0]).toLowerCase()); return [id ? [{ id }] : []]; }
      if (sql.startsWith('SELECT id, email, role, is_active')) { const user = users[params[0]]; return [user ? [{ id: params[0], email: `${params[0]}@example.test`, ...user }] : []]; }
      if (sql.includes('COUNT(*)')) return [[{ count: activeAdmins }]];
      if (sql.startsWith('SELECT password_hash FROM users')) return [[{ password_hash: adminHash }]];
      throw new Error(`Unexpected query: ${sql}`);
    } } },
    '../dist/src/services/user-lifecycle': lifecycle,
  }, ['../dist/src/routes/admin', '../dist/src/services/admin-path']);
  const routes = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
  // The boundary admits only admins to these routes (routes-policy.test.cts);
  // the admin confirms with their own password (two-factor-mysql-integration).
  const confirmed = { current_password: 'synthetic-route-admin-password' } as FixtureValue;
  const remove = (actor: string, target: string) => routes['DELETE /api/admin/users/:id'].handler({ url: `/api/admin/users/${target}`, headers: {}, params: { id: target } } as FixtureValue, actor, confirmed, null as FixtureValue);

  assert.equal((await remove(admin1, admin1)).status, 400, 'an admin cannot delete themselves here');
  assert.equal((await remove(admin1, admin1.toUpperCase())).status, 400, 'however their id is spelled');
  assert.equal((await remove(admin1, 'missing')).status, 400, 'an id that is no UUID is refused');
  assert.equal((await remove(admin1, '00000000-0000-4000-8000-0000000000ff')).status, 404);
  activeAdmins = 1;
  assert.equal((await remove(admin1, admin2)).status, 400, 'the last active admin stays');
  assert.deepEqual(lifecycle.calls, [], 'no refusal reached the service');

  assert.deepEqual(await remove(admin1, user1.toUpperCase()), { message: 'User deleted' });
  assert.equal(lifecycle.calls.length, 1);
  const [deleted, options] = lifecycle.calls[0] as FixtureValue;
  assert.deepEqual([deleted, options.actor, options.actorId], [user1, 'admin', admin1], 'the stored id, and the acting admin is recorded');

  const { conflict } = require('../dist/src/http/errors') as typeof import('../src/http/errors');
  const refused = lifecycleStub(conflict('RESTORE_IN_PROGRESS', 'Restore in progress.'));
  stubModules(t, { '../dist/src/services/user-lifecycle': refused }, ['../dist/src/routes/admin', '../dist/src/services/admin-path']);
  const reloaded = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
  const result = await reloaded['DELETE /api/admin/users/:id'].handler({ url: `/api/admin/users/${user1}`, headers: {}, params: { id: user1 } } as FixtureValue, admin1, confirmed, null as FixtureValue);
  assert.deepEqual([result.status, result.code], [409, 'RESTORE_IN_PROGRESS']);

  const failed = lifecycleStub(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'));
  stubModules(t, { '../dist/src/services/user-lifecycle': failed }, ['../dist/src/routes/admin', '../dist/src/services/admin-path']);
  const failing = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
  t.mock.method(console, 'error', () => {});
  const internal = await failing['DELETE /api/admin/users/:id'].handler({ url: `/api/admin/users/${user1}`, headers: {}, params: { id: user1 } } as FixtureValue, admin1, confirmed, null as FixtureValue);
  assert.deepEqual(internal, { error: 'Failed to delete user', status: 500 }, 'database text stays in the log');
});

test('self deletion asks for the password, calls the service as the owner and clears cookies only after it succeeded', async (t) => {
  const cleared: string[] = [];
  const lifecycle = lifecycleStub();
  // The password check itself runs against the database in policies-admin-mysql-integration.test.cts.
  const reauthentication = { OWN_CODES: {}, confirmPassword: async (userId: string, password: unknown) => password === 'right-password' ? null
    : { error: 'Current password is incorrect', code: 'PASSWORD_INCORRECT', status: 403 } };
  stubModules(t, {
    '../dist/src/state': { db: { execute: async (sql: string) => { throw new Error(`Unexpected query: ${sql}`); } } },
    '../dist/src/auth': { clearAuthCookie: () => cleared.push('auth'), clearCsrfCookie: () => cleared.push('csrf') },
    '../dist/src/services/user-lifecycle': lifecycle,
    '../dist/src/security/reauthentication': reauthentication,
  }, ['../dist/src/routes/settings']);
  const routes = require('../dist/src/routes/settings') as RouteTable<typeof import('../src/routes/settings')>;
  const req = { url: '/api/settings/account', headers: {} } as FixtureValue;

  assert.equal((await routes['DELETE /api/settings/account'].handler(req, 'user-1', {}, {} as FixtureValue)).status, 403);
  assert.deepEqual([lifecycle.calls, cleared], [[], []], 'nothing happens without the password');
  const confirmed = { current_password: 'right-password' };
  assert.deepEqual(await routes['DELETE /api/settings/account'].handler(req, 'user-1', confirmed, {} as FixtureValue), { deleted: true });
  assert.deepEqual(lifecycle.calls, [['user-1', { actor: 'self', actorId: 'user-1', req }]]);
  assert.deepEqual(cleared, ['auth', 'csrf']);

  const { conflict } = require('../dist/src/http/errors') as typeof import('../src/http/errors');
  stubModules(t, { '../dist/src/services/user-lifecycle': lifecycleStub(conflict('RESTORE_IN_PROGRESS', 'Restore in progress.')) }, ['../dist/src/routes/settings']);
  const reloaded = require('../dist/src/routes/settings') as RouteTable<typeof import('../src/routes/settings')>;
  const refused = await reloaded['DELETE /api/settings/account'].handler(req, 'user-1', confirmed, {} as FixtureValue);
  assert.deepEqual([refused.status, refused.code], [409, 'RESTORE_IN_PROGRESS']);
  assert.deepEqual(cleared, ['auth', 'csrf'], 'a refused deletion keeps the session');
});
