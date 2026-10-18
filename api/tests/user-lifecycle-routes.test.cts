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
  const users: Record<string, { role: string; is_active: number }> = {
    'admin-1': { role: 'admin', is_active: 1 }, 'admin-2': { role: 'admin', is_active: 1 }, 'user-1': { role: 'user', is_active: 1 },
  };
  let activeAdmins = 2;
  const lifecycle = lifecycleStub();
  stubModules(t, {
    '../dist/src/state': { db: { execute: async (sql: string, params: FixtureValue[]) => {
      if (sql.startsWith('SELECT id, email, role, is_active')) { const user = users[params[0]]; return [user ? [{ id: params[0], email: `${params[0]}@example.test`, ...user }] : []]; }
      if (sql.includes('COUNT(*)')) return [[{ count: activeAdmins }]];
      throw new Error(`Unexpected query: ${sql}`);
    } } },
    '../dist/src/services/user-lifecycle': lifecycle,
  }, ['../dist/src/routes/admin']);
  const routes = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
  // The boundary admits only admins to these routes (routes-policy.test.cts).
  const remove = (actor: string, target: string) => routes['DELETE /api/admin/users/:id'].handler({ url: `/api/admin/users/${target}`, headers: {}, params: { id: target } } as FixtureValue, actor);

  assert.equal((await remove('admin-1', 'admin-1')).status, 400, 'an admin cannot delete themselves here');
  assert.equal((await remove('admin-1', 'missing')).status, 404);
  activeAdmins = 1;
  assert.equal((await remove('admin-1', 'admin-2')).status, 400, 'the last active admin stays');
  assert.deepEqual(lifecycle.calls, [], 'no refusal reached the service');

  assert.deepEqual(await remove('admin-1', 'user-1'), { message: 'User deleted' });
  assert.deepEqual(lifecycle.calls, [['user-1', { actor: 'admin' }]]);

  const { conflict } = require('../dist/src/http/errors') as typeof import('../src/http/errors');
  const refused = lifecycleStub(conflict('RESTORE_IN_PROGRESS', 'Restore in progress.'));
  stubModules(t, { '../dist/src/services/user-lifecycle': refused }, ['../dist/src/routes/admin']);
  const reloaded = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
  const result = await reloaded['DELETE /api/admin/users/:id'].handler({ url: '/api/admin/users/user-1', headers: {}, params: { id: 'user-1' } } as FixtureValue, 'admin-1');
  assert.deepEqual([result.status, result.code], [409, 'RESTORE_IN_PROGRESS']);

  const failed = lifecycleStub(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'));
  stubModules(t, { '../dist/src/services/user-lifecycle': failed }, ['../dist/src/routes/admin']);
  const failing = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
  t.mock.method(console, 'error', () => {});
  const internal = await failing['DELETE /api/admin/users/:id'].handler({ url: '/api/admin/users/user-1', headers: {}, params: { id: 'user-1' } } as FixtureValue, 'admin-1');
  assert.deepEqual(internal, { error: 'Failed to delete user', status: 500 }, 'database text stays in the log');
});

test('self deletion calls the service as the owner and clears cookies only after it succeeded', async (t) => {
  const cleared: string[] = [];
  const lifecycle = lifecycleStub();
  stubModules(t, {
    '../dist/src/state': { db: { execute: async (sql: string) => { throw new Error(`Unexpected query: ${sql}`); } } },
    '../dist/src/auth': { clearAuthCookie: () => cleared.push('auth'), clearCsrfCookie: () => cleared.push('csrf') },
    '../dist/src/services/user-lifecycle': lifecycle,
  }, ['../dist/src/routes/settings']);
  const routes = require('../dist/src/routes/settings') as RouteTable<typeof import('../src/routes/settings')>;
  const req = { url: '/api/settings/account', headers: {} } as FixtureValue;

  assert.deepEqual(await routes['DELETE /api/settings/account'].handler(req, 'user-1', {}, {} as FixtureValue), { deleted: true });
  assert.deepEqual(lifecycle.calls, [['user-1', { actor: 'self' }]]);
  assert.deepEqual(cleared, ['auth', 'csrf']);

  const { conflict } = require('../dist/src/http/errors') as typeof import('../src/http/errors');
  stubModules(t, { '../dist/src/services/user-lifecycle': lifecycleStub(conflict('RESTORE_IN_PROGRESS', 'Restore in progress.')) }, ['../dist/src/routes/settings']);
  const reloaded = require('../dist/src/routes/settings') as RouteTable<typeof import('../src/routes/settings')>;
  const refused = await reloaded['DELETE /api/settings/account'].handler(req, 'user-1', {}, {} as FixtureValue);
  assert.deepEqual([refused.status, refused.code], [409, 'RESTORE_IN_PROGRESS']);
  assert.deepEqual(cleared, ['auth', 'csrf'], 'a refused deletion keeps the session');
});
