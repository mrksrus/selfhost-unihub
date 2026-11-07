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

// Download tickets (F9, services/file-tickets.ts) through the real request
// handler and database: the page asks with its session, the Android app
// fetches without one. A ticket answers once (a backup archive's opens a
// grant), for its owner's file, while its session is live, its user active,
// the module on and no restore of the section runs; it is never stored as the
// token itself.
// Building the fresh schema (every upgrade step) takes most of the time: about
// 100 s on a slow disk against some 15 s for the checks themselves, so the
// bound is the one of the other tests that build it.
test('file tickets: one use without a cookie, owner-bound, refused when expired, revoked, module off or restoring', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-file-tickets-'));
  let server: FixtureValue; let owned = false;
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    const runtime = createBackupRuntime(directory, 'file-tickets-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    await runtime('services/data-inventory').verifyDatabaseInventory(pool);
    const password = 'file-tickets-fixture-password';
    const passwordHash = await require('bcryptjs').hash(password, 10);
    const ids: Record<string, string> = {};
    for (const name of ['owner', 'stranger']) {
      ids[name] = crypto.randomUUID();
      await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [ids[name], `${name}@example.test`, passwordHash, name]);
    }
    const { handleRequest } = runtime('request-handler');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    function session() {
      const cookies = new Map<string, string>(); let csrf: string | undefined;
      const request = async (method: string, route: string, body?: unknown, expected = 200, { withCsrf = true } = {}) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
          ...(withCsrf && csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const separator = pair.indexOf('='); cookies.set(pair.slice(0, separator), pair.slice(separator + 1)); }
        const result = await response.json();
        assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
        if (result.csrfToken) csrf = result.csrfToken;
        return result;
      };
      // The Cookie header an Android app before 0.28 adds to a ticket URL.
      return Object.assign(request, { cookie: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') });
    }
    // What the Android app does with the URL: a plain GET, no cookie.
    const fetchTicket = async (url: string, headers: Record<string, string> = {}) => {
      const response = await fetch(base + url, { headers, signal: AbortSignal.timeout(15000) });
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
    };
    const signIn = async (name: string) => {
      const request = session();
      await request('POST', '/auth/signin', { email: `${name}@example.test`, password });
      await request('GET', '/auth/me');
      return request;
    };

    // A mailed PDF of the owner, stored like synced mail.
    const accountId = crypto.randomUUID(), emailId = crypto.randomUUID(), attachmentId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO mail_accounts (id, user_id, email_address, provider) VALUES (?, ?, 'owner@mail.example.test', 'imap')", [accountId, ids.owner]);
    await pool.execute<ResultSetHeader>("INSERT INTO emails (id, user_id, mail_account_id, subject, from_address, to_addresses, folder) VALUES (?, ?, ?, 'Report', 'sam@example.org', '[]', 'inbox')", [emailId, ids.owner, accountId]);
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic report\n'), crypto.randomBytes(4096)]);
    const stored = path.join(directory, 'attachments', ids.owner, `${attachmentId}.pdf`);
    await fs.mkdir(path.dirname(stored), { recursive: true });
    await fs.writeFile(stored, bytes);
    await pool.execute<ResultSetHeader>(`INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path)
      VALUES (?, ?, ?, 'Quarterly "report"\r\n.pdf', 'application/octet-stream', ?, ?)`, [attachmentId, emailId, ids.owner, bytes.length, stored]);
    const forAttachment = { kind: 'mail-attachment', id: attachmentId };

    const owner = await signIn('owner');
    const stranger = await signIn('stranger');

    // Issued only with the session and its CSRF token, for one's own known file.
    await session()('POST', '/files/tickets', forAttachment, 401);
    await owner('POST', '/files/tickets', forAttachment, 403, { withCsrf: false });
    await owner('POST', '/files/tickets', { kind: 'backup', id: attachmentId }, 400);
    await owner('POST', '/files/tickets', { kind: 'mail-attachment', id: '../etc/passwd' }, 400);
    await stranger('POST', '/files/tickets', forAttachment, 404);
    await owner('POST', '/files/tickets', { kind: 'mail-attachment', id: crypto.randomUUID() }, 404);

    // One use, without a cookie: the whole file as a download with a safe name, the type the extension says.
    const ticket = await owner('POST', '/files/tickets', forAttachment);
    assert.match(ticket.url, /^\/api\/files\/tickets\/[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([ticket.filename, ticket.content_type, ticket.size], ['Quarterly "report"\r\n.pdf', 'application/pdf', bytes.length]);
    assert.ok(Date.parse(ticket.expires_at) - Date.now() <= 61_000, 'the ticket lives about a minute');
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT token_hash, user_id FROM file_tickets');
    const token = ticket.url.split('/').pop();
    assert.equal(row.user_id, ids.owner);
    assert.notEqual(row.token_hash, token);
    assert.notEqual(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'), 'keyed, not a plain hash');
    // A range request still gets the whole file: a resume would be a second use.
    const first = await fetchTicket(ticket.url, { Range: 'bytes=10-20' });
    assert.equal(first.status, 200);
    assert.ok(first.body.equals(bytes), 'the stored bytes');
    assert.equal(first.headers.get('content-type'), 'application/pdf');
    assert.equal(first.headers.get('content-disposition'), `attachment; filename="Quarterly _report_  .pdf"; filename*=UTF-8''${encodeURIComponent('Quarterly "report"  .pdf')}`);
    assert.equal(first.headers.get('accept-ranges'), 'none');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetchTicket(ticket.url)).status, 410, 'a second use is refused');
    assert.equal((await fetchTicket('/api/files/tickets/not-a-ticket')).status, 410);
    assert.equal((await fetchTicket(`/api/files/tickets/${crypto.randomBytes(32).toString('base64url')}`)).status, 410);

    // An app before 0.28 adds its session cookie to the ticket URL: the ticket
    // still decides, and a cookie whose session has ended is no refusal.
    const withCookie = await owner('POST', '/files/tickets', forAttachment);
    const oldApp = await fetchTicket(withCookie.url, { Cookie: owner.cookie() });
    assert.equal(oldApp.status, 200);
    assert.ok(oldApp.body.equals(bytes), 'the stored bytes, with the session cookie');
    const ended = await signIn('owner');
    const endedCookie = ended.cookie();
    await ended('POST', '/auth/signout', {});
    const afterSignOut = await owner('POST', '/files/tickets', forAttachment);
    const staleCookie = await fetchTicket(afterSignOut.url, { Cookie: endedCookie });
    assert.equal(staleCookie.status, 200, 'a signed-out session\'s cookie does not refuse the ticket');
    assert.ok(staleCookie.body.equals(bytes));

    // Two requests at once: only one gets the file.
    const racing = await owner('POST', '/files/tickets', forAttachment);
    const statuses = (await Promise.all([fetchTicket(racing.url), fetchTicket(racing.url)])).map(answer => answer.status).sort();
    assert.deepEqual(statuses, [200, 410]);

    // Expired: refused, and gone.
    const late = await owner('POST', '/files/tickets', forAttachment);
    await pool.execute('UPDATE file_tickets SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND');
    assert.equal((await fetchTicket(late.url)).status, 410);
    assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM file_tickets'))[0][0].n, 0);

    // The module turned off, or a restore of Mail running: refused at issue and at use.
    const beforeOff = await owner('POST', '/files/tickets', forAttachment);
    await owner('PUT', '/modules', { modules: { mail: { enabled: false } } });
    assert.equal((await owner('POST', '/files/tickets', forAttachment, 403)).code, 'MODULE_DISABLED');
    const off = await fetchTicket(beforeOff.url);
    assert.equal(off.status, 403);
    assert.equal(JSON.parse(off.body.toString()).code, 'MODULE_DISABLED');
    await owner('PUT', '/modules', { modules: { mail: { enabled: true } } });
    const beforeRestore = await owner('POST', '/files/tickets', forAttachment);
    const restoreId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"mail\"]')", [restoreId, ids.owner]);
    assert.equal((await owner('POST', '/files/tickets', forAttachment, 409)).code, 'RESTORE_IN_PROGRESS');
    assert.equal((await fetchTicket(beforeRestore.url)).status, 409);
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);

    // The file gone from disk: nothing to send.
    const missing = await owner('POST', '/files/tickets', forAttachment);
    await fs.rename(stored, `${stored}.moved`);
    assert.equal((await fetchTicket(missing.url)).status, 404);
    await fs.rename(`${stored}.moved`, stored);

    // A backup archive: a real encrypted export of the owner's. Its ticket is
    // issued once the recovery password was seen; the first use opens a grant
    // in which the same URL answers again, with Range, while the session lives.
    const created = await owner('POST', '/backup/jobs', { sections: 'contacts', encrypt: false }, 202);
    const backupId = created.job.id;
    let job = created.job;
    for (let attempt = 0; job.status !== 'ready' && attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      job = (await owner('GET', `/backup/jobs/${backupId}`)).job;
    }
    assert.equal(job.status, 'ready');
    assert.equal(job.encryption_enabled, true, 'encrypted although the client asked otherwise');
    const forBackup = { kind: 'backup-archive', id: backupId };
    assert.equal((await owner('POST', '/files/tickets', forBackup, 409)).code, 'BACKUP_PASSWORD_UNSEEN');
    await owner('POST', `/backup/jobs/${backupId}/recovery-password/reveal`, {});
    await stranger('POST', '/files/tickets', forBackup, 404);
    const backupTicket = await owner('POST', '/files/tickets', forBackup);
    assert.equal(backupTicket.content_type, 'application/zip');
    const whole = await fetchTicket(backupTicket.url);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.length, backupTicket.size);
    assert.equal(crypto.createHash('sha256').update(whole.body).digest('hex'), job.file_sha256, 'the stored archive');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    const etag = whole.headers.get('etag');
    assert.ok(etag);
    const [[grant]] = await pool.query<RowDataPacket[]>("SELECT redeemed_at, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), expires_at) AS minutes FROM file_tickets WHERE kind = 'backup-archive'");
    assert.ok(grant.redeemed_at && grant.minutes >= 58 && grant.minutes <= 60, 'the grant runs for an hour from the first use');
    const resumed = await fetchTicket(backupTicket.url, { Range: 'bytes=10-20', 'If-Range': etag! });
    assert.equal(resumed.status, 206);
    assert.ok(resumed.body.equals(whole.body.subarray(10, 21)), 'the resumed bytes');
    // An app before 0.28 resumes with its session cookie as well.
    const resumedWithCookie = await fetchTicket(backupTicket.url, { Range: 'bytes=0-9', 'If-Range': etag!, Cookie: owner.cookie() });
    assert.equal(resumedWithCookie.status, 206);
    assert.ok(resumedWithCookie.body.equals(whole.body.subarray(0, 10)));
    assert.notEqual((await pool.query<RowDataPacket[]>('SELECT downloaded_at FROM data_export_jobs WHERE id = ?', [backupId]))[0][0].downloaded_at, null);
    // The grant is for this archive and this session only, and ends with it.
    const strangerJob = crypto.randomUUID();
    await pool.execute("INSERT INTO data_export_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'ready', '[\"contacts\"]')", [strangerJob, ids.stranger]);
    await owner('POST', '/files/tickets', { kind: 'backup-archive', id: strangerJob }, 404);
    await pool.execute("UPDATE file_tickets SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE kind = 'backup-archive'");
    assert.equal((await fetchTicket(backupTicket.url)).status, 410, 'an expired grant is refused');
    const unused = await owner('POST', '/files/tickets', forBackup);
    await pool.execute("UPDATE file_tickets SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE kind = 'backup-archive'");
    assert.equal((await fetchTicket(unused.url)).status, 410, 'a grant opens only within the first minute');
    const revoked = await owner('POST', '/files/tickets', forBackup);
    assert.equal((await fetchTicket(revoked.url)).status, 200);
    const [[grantSession]] = await pool.query<RowDataPacket[]>("SELECT session_id FROM file_tickets WHERE kind = 'backup-archive'");
    await pool.execute('UPDATE sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?', [grantSession.session_id]);
    assert.equal((await fetchTicket(revoked.url, { Range: 'bytes=0-9' })).status, 410, 'an ended session ends its grant');
    await pool.execute('UPDATE sessions SET expires_at = UTC_TIMESTAMP() + INTERVAL 1 DAY WHERE id = ?', [grantSession.session_id]);
    await pool.execute("DELETE FROM file_tickets WHERE kind = 'backup-archive'");

    // A deactivated user, an expired session, and signing out (the tickets go with the session).
    const deactivated = await owner('POST', '/files/tickets', forAttachment);
    await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [ids.owner]);
    assert.equal((await fetchTicket(deactivated.url)).status, 410);
    await pool.execute('UPDATE users SET is_active = TRUE WHERE id = ?', [ids.owner]);
    const expiring = await owner('POST', '/files/tickets', forAttachment);
    const [[liveSession]] = await pool.query<RowDataPacket[]>('SELECT session_id FROM file_tickets');
    await pool.execute('UPDATE sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?', [liveSession.session_id]);
    assert.equal((await fetchTicket(expiring.url)).status, 410);
    await pool.execute('UPDATE sessions SET expires_at = UTC_TIMESTAMP() + INTERVAL 1 DAY WHERE id = ?', [liveSession.session_id]);
    const outstanding = await owner('POST', '/files/tickets', forAttachment);
    await owner('POST', '/auth/signout', {});
    assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM file_tickets'))[0][0].n, 0, 'signing out removes the session\'s tickets');
    assert.equal((await fetchTicket(outstanding.url)).status, 410);

    // A bounded number of unused tickets per session.
    const again = await signIn('owner');
    for (let index = 0; index < 20; index++) await again('POST', '/files/tickets', forAttachment);
    assert.equal((await again('POST', '/files/tickets', forAttachment, 429)).code, 'TICKET_LIMIT');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
