import type { FixtureValue } from './helpers/test-types.cts';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// An administrator's change of another person (password, role, status,
// deletion) through the real request handler and MariaDB, held after the
// administrator's password was checked: what happens meanwhile counts when
// it acts. Two administrators removing each other leave one; an
// administrator signed out or demoted meanwhile changes nothing.
test('an administrator\'s change of a person counts the administrators and the caller as they are when it acts', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  // Only the administrators this test makes count.
  await pool.query("UPDATE users SET role = 'user'");

  const password = 'synthetic-admin-races-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  async function person(name: string, role: 'owner' | 'admin' | 'user') {
    const id = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [id, `${name}@example.test`, passwordHash, name, role]);
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return { id, client };
  }
  const row = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT role, is_active, password_hash FROM users WHERE id = ?', [id]))[0][0];
  const activeAdmins = async () => Number((await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM users WHERE role IN ('owner', 'admin') AND is_active = TRUE"))[0][0].count);

  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const within = async <T,>(promise: Promise<T>) => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the change never reached its pause')), 20000); })]); }
    finally { clearTimeout(timer); }
  };
  const settlesSoon = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true, () => true), new Promise<boolean>(done => setTimeout(() => done(false), ms))]);
  // Holds the first app statement containing `marker`, on the pool or on a
  // connection taken from it, once it has answered, until release().
  function pauseAfter(marker: string) {
    const reached = deferred(), released = deferred();
    let seen = false;
    type Execute = (this: unknown, sql: unknown, ...args: unknown[]) => Promise<unknown>;
    const holding = (original: Execute): Execute => async function (sql, ...args) {
      const result = await original.call(this, sql, ...args);
      if (!seen && String((sql as { sql?: string })?.sql ?? sql).includes(marker)) { seen = true; reached.resolve(); await released.promise; }
      return result;
    };
    const execute = pool.execute, getConnection = pool.getConnection;
    pool.execute = holding(execute as unknown as Execute) as unknown as typeof pool.execute;
    pool.getConnection = async function (this: typeof pool) {
      const cx = await getConnection.call(this) as PoolConnection;
      const own = cx.execute, release = cx.release;
      cx.execute = holding(own as unknown as Execute) as unknown as typeof cx.execute;
      cx.release = function (this: PoolConnection) { cx.execute = own; cx.release = release; return release.call(this); };
      return cx;
    } as typeof pool.getConnection;
    return {
      reached: () => within(reached.promise),
      release: () => released.resolve(),
      restore: () => { released.resolve(); pool.execute = execute; pool.getConnection = getConnection; },
    };
  }

  // Two administrators, each removing the other while the first one's change
  // waits after its count: the second change goes through, the first then
  // finds its caller or the last administrator, and one stays. (Demoting is
  // the owner's alone since 0.30, and the owner cannot be demoted.)
  for (const [change, request] of [
    ['deactivate', (target: string) => ({ method: 'PUT', url: `/api/admin/users/${target}/activate`, body: { is_active: false, current_password: password } })],
    ['delete', (target: string) => ({ method: 'DELETE', url: `/api/admin/users/${target}`, body: { current_password: password } })],
  ] as const) {
    await t.test(`two administrators who ${change} each other leave one`, async () => {
      const a = await person(`${change}-a`, 'admin'), b = await person(`${change}-b`, 'admin');
      const pause = pauseAfter("role IN ('owner', 'admin') AND is_active = TRUE");
      const first = request(b.id), second = request(a.id);
      const pending = a.client.request(first.method, first.url, first.body);
      let other: Promise<FixtureValue> | undefined;
      try {
        await pause.reached();
        other = b.client.request(second.method, second.url, second.body);
        // Before the fix it went through at once; now it waits for the first one's locks.
        await settlesSoon(other, 1000);
        pause.release();
        const replies = [await pending, await other];
        assert.equal(await activeAdmins(), 1, `one administrator stays: ${JSON.stringify(replies.map(reply => [reply.status, reply.body.code]))}`);
        const [done, refused] = replies.map(reply => reply.status).sort();
        assert.equal(done, 200, 'one change went through');
        assert.ok([400, 401, 403].includes(refused), 'the other is refused');
      } finally {
        pause.restore(); await pending.catch(() => {}); await other?.catch(() => {});
        await pool.execute('DELETE FROM users WHERE id IN (?, ?)', [a.id, b.id]);
      }
    });
  }

  // Changes of another person held after the administrator's password was
  // checked; meanwhile the administrator is signed out, or demoted. The
  // change is refused and the person stays as they were.
  for (const meanwhile of ['signed out', 'demoted'] as const) {
    await t.test(`an administrator ${meanwhile} while their change waits changes nothing`, async () => {
      for (const [change, request] of [
        ['password', (target: string) => ({ method: 'PUT', url: `/api/admin/users/${target}/password`, body: { new_password: 'synthetic-replaced-password', current_password: password } })],
        ['role', (target: string) => ({ method: 'PUT', url: `/api/admin/users/${target}/role`, body: { role: 'admin', current_password: password } })],
        ['deactivate', (target: string) => ({ method: 'PUT', url: `/api/admin/users/${target}/activate`, body: { is_active: false, current_password: password } })],
        ['delete', (target: string) => ({ method: 'DELETE', url: `/api/admin/users/${target}`, body: { current_password: password } })],
      ] as const) {
        const name = `${change}-${meanwhile.replace(' ', '-')}`;
        const keeper = await person(`${name}-keeper`, 'admin');
        // A role only the owner changes.
        const a = await person(`${name}-admin`, change === 'role' ? 'owner' : 'admin'), target = await person(`${name}-person`, 'user');
        const before = await row(target.id);
        const pause = pauseAfter('SELECT password_hash FROM users WHERE id = ?');
        const { method, url, body } = request(target.id);
        const pending = a.client.request(method, url, body);
        try {
          await pause.reached();
          if (meanwhile === 'signed out') await pool.execute('DELETE FROM sessions WHERE user_id = ?', [a.id]);
          else await pool.execute("UPDATE users SET role = 'user' WHERE id = ?", [a.id]);
          pause.release();
          const reply = await pending;
          assert.deepEqual([reply.status, reply.body.code], meanwhile === 'signed out' ? [401, 'SESSION_ENDED'] : [403, 'ADMIN_REQUIRED'], `${change}: ${JSON.stringify(reply.body)}`);
          assert.deepEqual(await row(target.id), before, `${change}: the person stays as they were`);
        } finally {
          pause.restore(); await pending.catch(() => {});
          await pool.execute('DELETE FROM users WHERE id IN (?, ?, ?)', [keeper.id, a.id, target.id]);
        }
      }
    });
  }

  // The only administrator deleting their own account in Settings.
  await t.test('the only administrator cannot delete their own account', async () => {
    const only = await person('only-admin', 'admin');
    try {
      const reply = await only.client.request('DELETE', '/api/settings/account', { current_password: password });
      assert.deepEqual([reply.status, reply.body.code], [400, 'LAST_ADMIN'], JSON.stringify(reply.body));
      assert.equal((await row(only.id))?.role, 'admin');
      const second = await person('second-admin', 'admin');
      assert.equal((await only.client.request('DELETE', '/api/settings/account', { current_password: password })).status, 200, 'with another administrator it goes');
      await pool.execute('DELETE FROM users WHERE id = ?', [second.id]);
    } finally { await pool.execute('DELETE FROM users WHERE id = ?', [only.id]); }
  });
});
