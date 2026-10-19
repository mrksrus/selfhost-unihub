import type { TestContext } from 'node:test';
import type { Pool, RowDataPacket } from 'mysql2/promise';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = require('node:http') as typeof import('node:http');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

// The disposable MariaDB of the *-mysql-integration tests (scripts/local-db.sh
// test, or CI). Refuses a database that is not named *_test or is not empty,
// makes its pool the app's database, migrates it like a fresh install
// (BOOTSTRAP_ADMIN_* create the first admin), and afterwards drops every
// table and puts the previous database back.
async function withTestDatabase(t: TestContext, { migrate = true } = {}): Promise<Pool> {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Only an isolated disposable schema is allowed');
  process.env.JWT_SECRET ||= 'disposable-database-test-only-secret';
  // A fresh install refuses to start without its first admin.
  process.env.BOOTSTRAP_ADMIN_EMAIL ||= 'test-bootstrap-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD ||= 'synthetic-test-bootstrap-password';
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 5 });
  const state = require('../../dist/src/state') as typeof import('../../src/state');
  const previous = state.getDb();
  let owned = false;
  t.after(async () => {
    try {
      if (owned) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const row of (await cx.query<RowDataPacket[]>('SHOW TABLES'))[0]) await cx.query('DROP TABLE ??', [Object.values(row)[0]]);
          await cx.query('SET FOREIGN_KEY_CHECKS = 1');
        } finally { cx.release(); }
      }
    } finally { state.setDb(previous); await pool.end(); }
  });
  assert.equal((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0].length, 0, 'Refuse to touch a populated schema');
  owned = true;
  state.setDb(pool);
  if (migrate) await (require('../../dist/src/services/database') as typeof import('../../src/services/database')).ensureSchema();
  return pool;
}

interface ApiReply { status: number; body: Record<string, unknown> & { error?: string }; headers: import('node:http').IncomingHttpHeaders }

// The real request handler on a loopback port, as the browser reaches it:
// each client keeps its own cookies and sends the CSRF token it was given.
async function startTestApi(t: TestContext) {
  const { handleRequest } = require('../../dist/src/request-handler') as typeof import('../../src/request-handler');
  const server = http.createServer((req, res) => { handleRequest(req, res).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

  function client() {
    const cookies = new Map<string, string>();
    let csrfToken: string | null = null;
    async function request(method: string, path: string, body?: unknown): Promise<ApiReply> {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
          ...(csrfToken && method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (value && !/Expires=Thu, 01 Jan 1970/.test(line)) cookies.set(name, value); else cookies.delete(name);
      }
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (typeof parsed?.csrfToken === 'string') csrfToken = parsed.csrfToken;
      return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) };
    }
    return { request, get signedIn() { return cookies.has('auth-token'); } };
  }
  return { origin, client };
}

export type TestDatabaseHelpers = { withTestDatabase: typeof withTestDatabase; startTestApi: typeof startTestApi };
module.exports = { withTestDatabase, startTestApi };
