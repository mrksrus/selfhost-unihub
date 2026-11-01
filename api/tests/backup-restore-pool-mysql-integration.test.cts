import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// A restore's transaction holds the rows it writes. Requests admitted before
// it started can wait for those rows with every other connection of the main
// pool; the restore's progress writes and cancellation checks must still get
// a connection, or nothing moves until the requests' lock waits time out.
test('a restore whose rows requests wait for with every other connection still finishes', { skip: !process.env.MYSQL_TEST_HOST, timeout: 90000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const settings = { host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD };
  const POOL = 5, WAITERS = POOL - 1;
  const pool = mysql.createPool({ ...settings, connectionLimit: POOL, timezone: '+00:00' });
  // Watches and, on failure, interrupts the waiting requests; not a pool connection.
  const monitor = await mysql.createConnection(settings);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-restore-pool-'));
  const getConnection = pool.getConnection.bind(pool);
  let server: FixtureValue, owned = false, runtime: FixtureValue, jobId: string | null = null;
  const waitingRequests = async () => (await monitor.query<RowDataPacket[]>(
    "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%FROM contacts c WHERE c.id =%FOR UPDATE' AND ID <> CONNECTION_ID()"))[0];
  const jobStatus = async () => (await monitor.query<RowDataPacket[]>('SELECT status, error FROM backup_restore_jobs WHERE id = ?', [jobId]))[0][0];
  async function until<T>(ms: number, read: () => Promise<T>, done: (value: T) => boolean) {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value) || Date.now() > deadline) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    runtime = createBackupRuntime(directory, 'restore-pool-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    const password = 'restore-pool-fixture-password-2026';
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)',
      [crypto.randomUUID(), 'restorer@example.test', await require('bcryptjs').hash(password, 10), 'Restorer']);
    const { handleRequest } = runtime('request-handler');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const cookies = new Map<string, string>(); let csrf: string | undefined;
    const call = async (method: string, route: string, body?: FixtureValue, binary = false) => {
      const response = await fetch(base + route, { method, headers: {
        ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' }),
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
      if (result.csrfToken) csrf = result.csrfToken;
      return { status: response.status, body: result };
    };
    await call('POST', '/auth/signin', { email: 'restorer@example.test', password });
    const contact = (await call('POST', '/contacts', { first_name: 'Archived', last_name: 'Person' })).body.contact;
    const exported = (await call('POST', '/backup/jobs', { sections: ['contacts'], encrypt: false })).body.job;
    assert.equal((await until(15000, async () => (await call('GET', `/backup/jobs/${exported.id}`)).body.job.status, status => status === 'ready')), 'ready');
    const archive = (await call('GET', `/backup/jobs/${exported.id}/download`, undefined, true)).body;
    jobId = (await call('POST', '/backup/import?sections=contacts&conflict_mode=replace', archive)).body.job.id as string;
    assert.equal((await until(15000, async () => (await jobStatus()).status, status => status === 'validated')), 'validated');

    // The requests are admitted now, before the restore starts, and take
    // their connections once the restore has written their contact.
    let admitted = 0, expired = false;
    let releaseRequests!: () => void; const restoreWrote = new Promise<void>(resolve => { releaseRequests = resolve; });
    let parked!: () => void; const allParked = new Promise<void>(resolve => { parked = resolve; });
    (pool as FixtureValue).getConnection = async () => {
      if (admitted < WAITERS) {
        if (++admitted === WAITERS) parked();
        await restoreWrote;
        return getConnection();
      }
      // The restore's own connection: once it holds the contact's row, the
      // requests wait for that row with every other connection.
      const connection = await getConnection(); const execute = connection.execute.bind(connection);
      (connection as FixtureValue).execute = async (sql: string, params?: FixtureValue) => {
        const result = await execute(sql, params);
        if (String(sql).startsWith('UPDATE contacts SET version = version + 1')) {
          (connection as FixtureValue).execute = execute;
          releaseRequests();
          expired = (await until(10000, waitingRequests, rows => rows.length >= WAITERS)).length < WAITERS;
        }
        return result;
      };
      return connection;
    };
    const edits = Array.from({ length: WAITERS }, (_, index) => call('PUT', `/contacts/${contact.id}`, { first_name: `Edited ${index}` }));
    await allParked;
    assert.equal((await call('POST', `/backup/restore-jobs/${jobId}/start`, {})).status, 202);
    const settled = await until(15000, jobStatus, job => ['completed', 'failed'].includes(job.status));
    assert.ok(!expired, 'the requests waited for the restore\'s row with every other connection');
    assert.equal(settled.status, 'completed', `the restore finished while requests waited for its rows (${settled.status}${settled.error ? `: ${settled.error}` : ''})`);
    const answers = await Promise.all(edits);
    assert.deepEqual(answers.map(answer => answer.status), Array(WAITERS).fill(200));
  } finally {
    (pool as FixtureValue).getConnection = getConnection;
    // A stuck restore moves again once the waiting requests are interrupted.
    for (const row of await waitingRequests().catch(() => [])) await monitor.query(`KILL QUERY ${Number(row.ID)}`).catch(() => {});
    if (jobId) await until(20000, jobStatus, job => !job || !['queued', 'running', 'cancelling'].includes(job.status)).catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) { await monitor.query('SET FOREIGN_KEY_CHECKS=0'); for (const row of (await monitor.query<RowDataPacket[]>('SHOW TABLES'))[0]) await monitor.query('DROP TABLE ??', [Object.values(row)[0]]); }
    if (runtime) await runtime('services/side-pools').endSidePools(pool);
    await pool.end(); await monitor.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});
