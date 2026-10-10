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

test('authenticated HTTP encrypted backup download, upload and restore work after re-enabling', { skip: !process.env.MYSQL_TEST_HOST, timeout: 60000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-http-recovery-'));
  let server: FixtureValue; let owned = false;
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    const runtime = createBackupRuntime(directory, 'http-recovery-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    await runtime('services/notifications').ensureNotificationSchema();
    await runtime('services/data-inventory').verifyDatabaseInventory(pool);
    const password = 'http-fixture-password-2026';
    const passwordHash = await require('bcryptjs').hash(password, 10);
    for (const name of ['source', 'destination']) await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [crypto.randomUUID(), `${name}@example.test`, passwordHash, name]);
    const { handleRequest } = runtime('request-handler');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function session() {
      const cookies = new Map(); let csrf: FixtureValue;
      const request = async (method: string, route: FixtureValue, body?: FixtureValue, expected = 200, binary = false) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' }),
          ...(cookies.size ? { Cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; ') } : {}),
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body as NonNullable<Parameters<typeof fetch>[1]>['body'] : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const separator = pair.indexOf('='); cookies.set(pair.slice(0,separator),pair.slice(separator+1)); }
        const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
        assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
        if (result.csrfToken) csrf = result.csrfToken;
        return result;
      };
      request.get = (route: FixtureValue, headers = {}) => fetch(base + '/api' + route, { headers: {
        Cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; '), ...headers }, signal: AbortSignal.timeout(15000) });
      return request;
    }
    async function wait(read: FixtureValue, status: FixtureValue) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) { const value = await read(); assert.notEqual(value.job.status, 'failed', value.job.error); if (value.job.status === status) return value.job; await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.fail(`Job never reached ${status}`);
    }
    const source = session(), destination = session();
    for (const [request,name] of [[source,'source'],[destination,'destination']] as const) { await request('POST','/auth/signin',{email:`${name}@example.test`,password}); await request('GET','/auth/me'); }
    assert.equal((await source('GET','/backup/capabilities')).enabled,true);
    await source('POST','/backup/jobs',{sections:['unknown-module']},400);
    const contact = await source('POST','/contacts',{first_name:'Grüße',last_name:'Recovery',email:'saved@example.test'});
    await destination('GET', '/contacts').then(result => assert.equal(result.contacts.length, 0));
    await source('PUT', '/modules', { modules: { recordings: { enabled: false }, mail: { visible: false, background: false } } });
    await source('PUT', '/modules', { order: ['contacts', 'mail', 'calendar'] }, 400);
    const ordered = await source('PUT', '/modules', { order: ['contacts', 'recordings', 'mail', 'calendar'] });
    assert.deepEqual(ordered.modules.map((module: FixtureValue) => module.id), ['contacts', 'recordings', 'mail', 'calendar']);
    await source('GET', '/recordings', undefined, 403);
    const created = await source('POST','/backup/jobs',{sections:['contacts','settings'],encrypt:true},202);
    const id = created.job.id;
    await wait(() => source('GET',`/backup/jobs/${id}`),'ready');
    await destination('GET',`/backup/jobs/${id}/download`,undefined,404);
    const key = await source('POST',`/backup/jobs/${id}/recovery-password/reveal`,{});
    const archive = await source('GET',`/backup/jobs/${id}/download`,undefined,200,true);
    // An interrupted download resumes only while the file is unchanged.
    const first = await source.get(`/backup/jobs/${id}/download`);
    const etag = first.headers.get('etag'); await first.arrayBuffer();
    assert.match((etag as string), /^"[0-9a-f]+-[0-9a-f]+"$/); assert.ok(first.headers.get('last-modified'));
    const resumed = await source.get(`/backup/jobs/${id}/download`, { Range: 'bytes=10-', 'If-Range': etag });
    assert.equal(resumed.status, 206); assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), archive.subarray(10));
    const replaced = await source.get(`/backup/jobs/${id}/download`, { Range: 'bytes=10-', 'If-Range': '"0-0"' });
    assert.equal(replaced.status, 200); assert.deepEqual(Buffer.from(await replaced.arrayBuffer()), archive);
    const imported = await destination('POST','/backup/import?sections=contacts,settings',archive,202);
    const restoreId = imported.job.id;
    await destination('POST',`/backup/restore-jobs/${restoreId}/unlock`,{password:'wrong-password'},400);
    await destination('POST',`/backup/restore-jobs/${restoreId}/unlock`,{password:key.recovery_password},202);
    await wait(() => destination('GET',`/backup/restore-jobs/${restoreId}`),'validated');
    await destination('POST',`/backup/restore-jobs/${restoreId}/start`,{},202);
    await wait(() => destination('GET',`/backup/restore-jobs/${restoreId}`),'completed');
    const contacts = (await destination('GET','/contacts')).contacts;
    assert.equal(contacts.length,1); assert.equal(contacts[0].first_name,'Grüße'); assert.notEqual(contacts[0].id,contact.contact.id);
    const prefs = await destination('GET', '/modules');
    assert.deepEqual(prefs.modules.map((module: FixtureValue) => module.id), ['contacts', 'recordings', 'mail', 'calendar'], 'Module order restored');
    assert.equal(prefs.modules.find((module: FixtureValue) => module.id === 'recordings').enabled, false, 'Disabled module preference restored');
    await destination('GET', '/recordings', undefined, 403);
    await destination('PUT', '/modules', { modules: { recordings: { enabled: true } } });
    await destination('GET', '/recordings');
    await destination('GET', '/notes', undefined, 404);

  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for(const row of tables) await connection.query('DROP TABLE ??',[Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end(); await fs.rm(directory,{recursive:true,force:true});
  }
});
