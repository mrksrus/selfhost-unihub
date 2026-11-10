import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const net = (require('node:net') as typeof import('node:net'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// Deleting a mail folder at the provider, through the real request handler,
// MariaDB and ImapFlow talking to a synthetic IMAP server on loopback: the
// copies the person was shown carry their generation (UIDVALIDITY, MAILBOXID
// with OBJECTID), a folder created again under the same name is never
// deleted, absence counts only with the NONEXISTENT code, wildcard names are
// literal, and only the owner's own accounts are reached.

// uids: the messages a sync can read in it (EXAMINE and UID FETCH).
interface Box { uidvalidity: number; mailboxId?: string; uids?: number[] }
// deleteReply: a tagged answer, or 'DROP' to close the connection without one.
// statusItems: the STATUS item list a server sends instead of the right one.
interface Login { boxes: Map<string, Box>; objectId: boolean; deleteReply?: (name: string) => string | null; list?: string; statusItems?: (name: string) => string | null }

// One IMAP server for every test account, keyed by login. It records every
// command per login; a command it does not expect fails the test.
async function folderServer() {
  const logins = new Map<string, Login>(), commands: string[] = [], errors: string[] = [], sockets = new Set<import('node:net').Socket>();
  const quoted = (value: string) => `"${value.replace(/["\\]/g, match => `\\${match}`)}"`;
  // A mailbox argument: a quoted string or an atom, then the rest of the line.
  const mailbox = (text: string): [string, string] => {
    const string = /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(text);
    if (string) return [string[1].replace(/\\(.)/g, '$1'), string[2]];
    const atom = /^(\S+)(.*)$/.exec(text);
    if (!atom) throw new Error(`No mailbox in: ${text}`);
    return [atom[1], atom[2]];
  };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK synthetic IMAP folder server\r\n');
    let input = '', chain = Promise.resolve(), login = '', state: Login | undefined, selected: Box | undefined;
    const send = (value: string) => { if (!socket.destroyed) socket.write(value); };
    socket.on('data', chunk => {
      input += chunk.toString('latin1');
      let index;
      while ((index = input.indexOf('\r\n')) !== -1) {
        const line = input.slice(0, index); input = input.slice(index + 2);
        const match = /^([0-9A-Z.]+) (.*)$/.exec(line);
        if (!match) { errors.push(`unrecognized request: ${line.slice(0, 60)}`); socket.destroy(); break; }
        const [, tag, cmd] = match;
        chain = chain.then(async () => {
          commands.push(`${login || '-'} ${cmd}`);
          const ok = (text = 'done') => send(`${tag} OK ${text}\r\n`);
          // OBJECTID is advertised once logged in, for a login that has it.
          const capabilities = () => `IMAP4rev1${state?.objectId ? ' OBJECTID' : ''}`;
          if (cmd === 'CAPABILITY') { send(`* CAPABILITY ${capabilities()}\r\n`); ok(); return; }
          if (cmd.startsWith('LOGIN ')) {
            login = mailbox(cmd.slice(6))[0];
            state = logins.get(login);
            if (!state) { send(`${tag} NO [AUTHENTICATIONFAILED] unknown login\r\n`); return; }
            ok(`[CAPABILITY ${capabilities()}] logged in`); return;
          }
          if (cmd === 'LOGOUT') { send('* BYE bye\r\n'); ok(); return; }
          if (!state) throw new Error(`${cmd} before LOGIN`);
          // ImapFlow's question for the hierarchy delimiter after login: no namespace prefix.
          if (cmd === 'LIST "" ""') { send('* LIST (\\Noselect) "/" ""\r\n'); ok(); return; }
          if (cmd.startsWith('LIST ') || cmd.startsWith('LSUB ')) {
            // As configured (a listing that leaves folders out), else every mailbox.
            send(cmd.startsWith('LSUB ') ? '' : state.list ?? [...state.boxes.keys()].map(name => `* LIST (\\HasNoChildren) "/" ${quoted(name)}\r\n`).join(''));
            ok(); return;
          }
          if (cmd.startsWith('STATUS ')) {
            const [name, rest] = mailbox(cmd.slice(7));
            const box = state.boxes.get(name);
            if (!box) { send(`${tag} NO [NONEXISTENT] Mailbox doesn't exist\r\n`); return; }
            const mailboxId = /MAILBOXID/.test(rest) && box.mailboxId ? ` MAILBOXID (${box.mailboxId})` : '';
            send(`* STATUS ${quoted(name)} (${state.statusItems?.(name) ?? `UIDVALIDITY ${box.uidvalidity}${mailboxId}`})\r\n`); ok(); return;
          }
          if (cmd.startsWith('EXAMINE ')) {
            const [name] = mailbox(cmd.slice(8));
            const box = state.boxes.get(name);
            if (!box) { send(`${tag} NO [NONEXISTENT] Mailbox doesn't exist\r\n`); return; }
            selected = box;
            const uids = box.uids ?? [];
            send(`* FLAGS (\\Seen)\r\n* ${uids.length} EXISTS\r\n* OK [UIDVALIDITY ${box.uidvalidity}] valid\r\n* OK [UIDNEXT ${Math.max(0, ...uids) + 1}] next\r\n`
              + (state.objectId && box.mailboxId ? `* OK [MAILBOXID (${box.mailboxId})] id\r\n` : ''));
            ok('[READ-ONLY] examined'); return;
          }
          // ImapFlow also asks for EMAILID when the server has OBJECTID.
          const fetch = /^UID FETCH (\d+):(\d+) \(UID FLAGS INTERNALDATE( EMAILID)?\)$/.exec(cmd);
          if (fetch && selected) {
            const [low, high] = [Number(fetch[1]), Number(fetch[2])];
            (selected.uids ?? []).forEach((uid, index) => {
              if (uid >= low && uid <= high) send(`* ${index + 1} FETCH (UID ${uid} FLAGS () INTERNALDATE "01-Nov-2026 09:00:00 +0000"${fetch[3] ? ` EMAILID (M${uid})` : ''})\r\n`);
            });
            ok(); return;
          }
          if (cmd.startsWith('DELETE ')) {
            const [name] = mailbox(cmd.slice(7));
            const reply = state.deleteReply?.(name);
            if (reply === 'DROP') { state.boxes.delete(name); socket.destroy(); return; }
            if (reply) { send(`${tag} ${reply}\r\n`); return; }
            if (!state.boxes.delete(name)) { send(`${tag} NO [NONEXISTENT] Mailbox doesn't exist\r\n`); return; }
            ok(); return;
          }
          throw new Error(`Unexpected IMAP command: ${cmd}`);
        }).catch(error => { errors.push(error.message); socket.destroy(); });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    commands, errors, port,
    account(login: string, boxes: Record<string, Box>, objectId = false) { logins.set(login, { boxes: new Map(Object.entries(boxes)), objectId }); return logins.get(login)!; },
    login(login: string) { return logins.get(login)!; },
    /** The folder commands one login sent (STATUS, DELETE, LIST), with the mailbox name as the server read it. */
    sent(login: string) {
      return commands.filter(command => command.startsWith(`${login} `)).map(command => command.slice(login.length + 1)).filter(command => /^(STATUS|DELETE|LIST) /.test(command))
        .filter(command => command !== 'LIST "" ""')
        .map(command => { const verb = command.split(' ')[0]; if (verb === 'LIST') return command; const [name, rest] = mailbox(command.slice(verb.length + 1)); return `${verb} ${name}${rest}`; });
    },
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

test('deleting a mail folder at the provider deletes only the copy shown, of the generation shown, of the owner\'s accounts', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-folder-delete-'));
  const imap = await folderServer();
  let server: FixtureValue; let owned = false;
  t.after(async () => {
    try {
      await imap.close();
      if (server) await new Promise(resolve => server.close(resolve));
      if (owned) {
        const connection = await pool.getConnection();
        try {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
          const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
          for (const row of tables) {
            const table = Object.values(row)[0];
            assert.match((table as string), /^[a-z_]+$/);
            await connection.execute('DROP TABLE `' + table + '`');
          }
          await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
        } finally { connection.release(); }
      }
    } finally {
      await pool.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
  const runtime = createBackupRuntime(directory, 'folder-delete-synthetic-key', pool);
  await runtime('services/database').ensureSchema();

  const password = 'folder-delete-fixture-password';
  const passwordHash = await require('bcryptjs').hash(password, 10);
  const users: Record<string, string> = {};
  for (const name of ['owner', 'stranger']) {
    users[name] = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }

  // Every connection goes to the synthetic server, logged in as the account's address; which accounts were reached is recorded.
  const { connectImap } = runtime('services/mail-imap-client');
  const { guardImapConnection } = runtime('services/mail-imap-guard');
  const reached: string[] = [];
  const service = runtime('services/mail-folder-delete'), deleteMailFolder = service.deleteMailFolder;
  service.deleteMailFolder = (request: FixtureValue, options: FixtureValue = {}) => deleteMailFolder(request, { ...options, connect: async (account: FixtureValue) => {
    reached.push(account.email_address);
    return guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: imap.port, user: account.email_address, password: 'fixture',
      tls: false, keepalive: false, connTimeout: 2000, authTimeout: 2000, socketTimeout: 3000 } }), { timeoutMs: 5000 });
  } });
  t.after(() => { service.deleteMailFolder = deleteMailFolder; });

  const { handleRequest } = runtime('request-handler');
  server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  function session() {
    const cookies = new Map<string, string>(); let csrf: string | undefined;
    return async (method: string, route: string, body?: unknown, expected = 200) => {
      const response = await fetch(base + '/api' + route, { method, headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const separator = pair.indexOf('='); cookies.set(pair.slice(0, separator), pair.slice(separator + 1)); }
      const result = await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
      if (result.csrfToken) csrf = result.csrfToken;
      return result;
    };
  }
  const signIn = async (name: string) => {
    const request = session();
    await request('POST', '/auth/signin', { email: `${name}@example.test`, password });
    await request('GET', '/auth/me');
    return request;
  };
  const owner = await signIn('owner');
  const stranger = await signIn('stranger');

  const repository = runtime('services/mail-engine/repository');
  async function account(userId: string, address: string, { active = true, mode = 'sync' } = {}) {
    const id = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active,disconnected_at)
      VALUES (?,?,?,'custom',?,?,?)`, [id, userId, address, mode, active, active ? null : '2026-11-01 00:00:00']);
    return id;
  }
  // A folder UniHub knows on each account, at the generation its last read saw, with one message whose only copy is there.
  async function folder(userId: string, slug: string, name: string, copies: [string, number, string?][]) {
    const id = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,?,?,FALSE,?)',
      [id, userId, slug, name, copies.length === 1 ? copies[0][0] : null]);
    const mail: string[] = [];
    for (const [accountId, epoch, providerMailboxId] of copies) {
      await pool.execute<ResultSetHeader>('INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,?)', [id, accountId, name]);
      const box = await repository.withTransaction((cx: FixtureValue) => repository.ensureMailbox({ userId, accountId, folderName: name, epoch,
        metadata: providerMailboxId ? { providerMailboxId } : {} }, cx), pool);
      const email = crypto.randomUUID();
      await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,message_id,is_read,is_starred,is_draft,remote_folder,remote_uid,remote_uidvalidity)
        VALUES (?,?,?,'fixture@example.test','[]',?,?,FALSE,FALSE,FALSE,?,5,?)`, [email, userId, accountId, slug, `${email}@example.test`, name, epoch]);
      await repository.withTransaction((cx: FixtureValue) => repository.upsertOccurrence({ userId, accountId, mailboxId: box.id, epoch, uid: 5, emailId: email }, cx), pool);
      mail.push(email);
    }
    return { id, mail };
  }
  const count = async (sql: string, params: unknown[]) => Number((await pool.query<RowDataPacket[]>(sql, params))[0][0].count);
  const folderExists = (id: string) => count('SELECT COUNT(*) AS count FROM mail_folders WHERE id = ?', [id]);
  const mailExists = (ids: string[]) => count(`SELECT COUNT(*) AS count FROM emails WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const linked = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT mail_account_id FROM mail_folder_remote_boxes WHERE folder_id = ? ORDER BY mail_account_id', [id]))[0].map(row => row.mail_account_id);
  // The copies of a folder as the person's folder list shows them.
  const shown = async (request: FixtureValue, slug: string) => (await request('GET', '/mail/folders')).folders.find((item: FixtureValue) => item.slug === slug)?.server_copies;
  const remove = (request: FixtureValue, slug: string, copies: unknown, expected = 200) =>
    request('DELETE', `/mail/folders/${slug}?server=1`, copies === undefined ? undefined : { copies }, expected);

  const ownerMail = await account(users.owner, 'owner-mail@example.test');
  const ownerWork = await account(users.owner, 'owner-work@example.test');
  const ownerOld = await account(users.owner, 'owner-old@example.test', { active: false });
  const strangerMail = await account(users.stranger, 'stranger-mail@example.test');
  imap.account('owner-mail@example.test', { INBOX: { uidvalidity: 1 } });
  imap.account('owner-work@example.test', { INBOX: { uidvalidity: 1 } });
  imap.account('owner-old@example.test', { INBOX: { uidvalidity: 1 } });
  imap.account('stranger-mail@example.test', { INBOX: { uidvalidity: 1 } });

  await t.test('a folder created again under the same name is not deleted, whether UniHub has read it again or not', async () => {
    const projects = await folder(users.owner, 'projects', 'Projects', [[ownerMail, 17]]);
    imap.login('owner-mail@example.test').boxes.set('Projects', { uidvalidity: 17 });
    const before = await shown(owner, 'projects');
    assert.deepEqual(before, [{ account_id: ownerMail, remote_name: 'Projects', uidvalidity: '17', mailbox_id: null }]);
    // Another mail client deleted Projects and created it again: the server's new Projects is another folder.
    imap.login('owner-mail@example.test').boxes.set('Projects', { uidvalidity: 18 });
    const refused = await remove(owner, 'projects', before, 409);
    assert.equal(refused.code, 'FOLDER_CHANGED');
    assert.deepEqual(imap.sent('owner-mail@example.test'), ['STATUS Projects (UIDVALIDITY)'], 'its generation read; no DELETE');
    assert.ok(imap.login('owner-mail@example.test').boxes.has('Projects'), 'the new Projects is still there');
    assert.equal(await folderExists(projects.id), 1);
    assert.equal(await mailExists(projects.mail), 1);
    // A sync has read the new Projects since: a request with the old generation (a second one queued, a retry) is refused before any connection.
    await repository.withTransaction((cx: FixtureValue) => repository.ensureMailbox({ userId: users.owner, accountId: ownerMail, folderName: 'Projects', epoch: 18 }, cx), pool);
    reached.length = 0;
    assert.equal((await remove(owner, 'projects', before, 409)).code, 'FOLDER_CHANGED');
    assert.deepEqual(reached, [], 'no server reached');
    // Shown again, the new Projects is the one deleted.
    const now = await shown(owner, 'projects');
    assert.equal(now[0].uidvalidity, '18');
    imap.commands.length = 0;
    const deleted = await remove(owner, 'projects', now);
    assert.deepEqual(deleted.server.map((item: FixtureValue) => item.remoteName), ['Projects']);
    assert.deepEqual(imap.sent('owner-mail@example.test'), ['STATUS Projects (UIDVALIDITY)', 'STATUS Projects (UIDVALIDITY)', 'DELETE Projects']);
    assert.ok(!imap.login('owner-mail@example.test').boxes.has('Projects'));
    assert.equal(await folderExists(projects.id), 0);
    // A retry of the same request finds nothing to delete.
    assert.equal((await remove(owner, 'projects', now, 404)).error, 'Folder not found');
  });

  await t.test('a DELETE answered "does not exist" without NONEXISTENT, beside a listing without the folder, settles nothing', async () => {
    const notes = await folder(users.owner, 'notes', 'Notes', [[ownerMail, 5]]);
    const login = imap.login('owner-mail@example.test');
    login.boxes.set('Notes', { uidvalidity: 5 });
    // The server says the folder is missing, without the code, while STATUS still finds it; its LIST leaves it out.
    login.deleteReply = name => name === 'Notes' ? 'NO Mailbox does not exist' : null;
    login.list = '* LIST (\\HasNoChildren) "/" INBOX\r\n';
    imap.commands.length = 0;
    const refused = await remove(owner, 'notes', await shown(owner, 'notes'), 409);
    assert.equal(refused.code, 'FOLDER_CHANGED');
    assert.match(refused.error, /does not exist, but without confirming it.*Sync the account, then refresh the folders and try again/);
    assert.deepEqual(imap.sent('owner-mail@example.test'), ['STATUS Notes (UIDVALIDITY)', 'STATUS Notes (UIDVALIDITY)', 'DELETE Notes'], 'no LIST taken as proof');
    assert.equal(await folderExists(notes.id), 1);
    assert.equal(await mailExists(notes.mail), 1);
    assert.equal(await count("SELECT COUNT(*) AS count FROM mail_remote_mailboxes WHERE mail_account_id = ? AND remote_name = 'Notes' AND state = 'active'", [ownerMail]), 1);
    // The server's own word that it is gone (NONEXISTENT to STATUS) settles it, with no DELETE sent.
    login.deleteReply = undefined; login.list = undefined;
    login.boxes.delete('Notes');
    imap.commands.length = 0;
    await remove(owner, 'notes', await shown(owner, 'notes'));
    assert.deepEqual(imap.sent('owner-mail@example.test'), ['STATUS Notes (UIDVALIDITY)', 'STATUS Notes (UIDVALIDITY)']);
    assert.equal(await folderExists(notes.id), 0);
    assert.equal(await mailExists(notes.mail), 0, 'its only copy was there');
  });

  await t.test('a wildcard name is read and deleted literally; its siblings stay', async () => {
    const wild = await folder(users.owner, 'archive-any', 'Archive/%', [[ownerMail, 30]]);
    const login = imap.login('owner-mail@example.test');
    login.boxes.set('Archive/%', { uidvalidity: 31 }); // created again under the name
    login.boxes.set('Archive/2026', { uidvalidity: 40 });
    imap.commands.length = 0;
    const before = await shown(owner, 'archive-any');
    assert.equal((await remove(owner, 'archive-any', before, 409)).code, 'FOLDER_CHANGED');
    assert.deepEqual(imap.sent('owner-mail@example.test'), ['STATUS Archive/% (UIDVALIDITY)']);
    assert.equal(await folderExists(wild.id), 1);
    // Read again by a sync, then deleted: only Archive/% goes.
    await repository.withTransaction((cx: FixtureValue) => repository.ensureMailbox({ userId: users.owner, accountId: ownerMail, folderName: 'Archive/%', epoch: 31 }, cx), pool);
    imap.commands.length = 0;
    await remove(owner, 'archive-any', await shown(owner, 'archive-any'));
    assert.deepEqual(imap.sent('owner-mail@example.test'), ['STATUS Archive/% (UIDVALIDITY)', 'STATUS Archive/% (UIDVALIDITY)', 'DELETE Archive/%']);
    // A quoted string on the wire, never a pattern.
    assert.ok(imap.commands.includes('owner-mail@example.test DELETE "Archive/%"'));
    assert.deepEqual([...login.boxes.keys()].filter(name => name.startsWith('Archive')), ['Archive/2026']);
    assert.equal(await folderExists(wild.id), 0);
  });

  await t.test('with OBJECTID, the same UIDVALIDITY under another MAILBOXID is another folder', async () => {
    imap.account('owner-objectid@example.test', { INBOX: { uidvalidity: 1 }, Receipts: { uidvalidity: 50, mailboxId: 'F-receipts-new' } }, true);
    const objectAccount = await account(users.owner, 'owner-objectid@example.test');
    const receipts = await folder(users.owner, 'receipts', 'Receipts', [[objectAccount, 50, 'F-receipts-old']]);
    const before = await shown(owner, 'receipts');
    assert.deepEqual(before, [{ account_id: objectAccount, remote_name: 'Receipts', uidvalidity: '50', mailbox_id: 'F-receipts-old' }]);
    assert.equal((await remove(owner, 'receipts', before, 409)).code, 'FOLDER_CHANGED');
    assert.deepEqual(imap.sent('owner-objectid@example.test'), ['STATUS Receipts (UIDVALIDITY MAILBOXID)']);
    assert.equal(await folderExists(receipts.id), 1);
    // The server's MAILBOXID as the person saw it: deleted.
    imap.login('owner-objectid@example.test').boxes.set('Receipts', { uidvalidity: 50, mailboxId: 'F-receipts-old' });
    await remove(owner, 'receipts', before);
    assert.equal(await folderExists(receipts.id), 0);
  });

  await t.test('on two servers: one created again deletes nothing anywhere; one failing after the other leaves a result for each', async () => {
    const shared = await folder(users.owner, 'shared', 'Shared', [[ownerMail, 4], [ownerWork, 9]]);
    const [first, second] = [ownerMail, ownerWork].sort() as [string, string];
    const address = (id: string) => id === ownerMail ? 'owner-mail@example.test' : 'owner-work@example.test';
    imap.login('owner-mail@example.test').boxes.set('Shared', { uidvalidity: 4 });
    imap.login('owner-work@example.test').boxes.set('Shared', { uidvalidity: 9 });
    const before = await shown(owner, 'shared');
    assert.equal(before.length, 2);
    // The second server's Shared was created again: no DELETE goes to either.
    imap.login(address(second)).boxes.set('Shared', { uidvalidity: second === ownerMail ? 5 : 10 });
    imap.commands.length = 0;
    const refused = await remove(owner, 'shared', before, 409);
    assert.equal(refused.code, 'FOLDER_CHANGED');
    assert.deepEqual(refused.details, { changed_on: [address(second)] });
    for (const id of [first, second]) assert.ok(!imap.sent(address(id)).some(command => command.startsWith('DELETE')), 'no DELETE anywhere');
    assert.deepEqual(await linked(shared.id), [ownerMail, ownerWork].sort());
    // As shown, but the second server fails its DELETE after the first deleted its copy.
    imap.login(address(second)).boxes.set('Shared', { uidvalidity: second === ownerMail ? 4 : 9 });
    imap.login(address(second)).deleteReply = () => 'NO [SERVERBUG] Synthetic failure';
    const partly = await remove(owner, 'shared', before, 409);
    assert.equal(partly.code, 'FOLDER_PARTLY_DELETED');
    assert.deepEqual(partly.details, { deleted_on: [address(first)], remaining_on: [address(second)], settled: true, copies: [
      { account_id: first, email_address: address(first), outcome: 'deleted' }, { account_id: second, email_address: address(second), outcome: 'failed' }] });
    assert.doesNotMatch(partly.error, /Synthetic failure/, 'the server\'s own text stays in the log');
    assert.deepEqual(await linked(shared.id), [second], 'the deleted copy settled; the folder stays for the other');
    // The list now shows only the copy left; deleting it again finishes the folder.
    imap.login(address(second)).deleteReply = undefined;
    const left = await shown(owner, 'shared');
    assert.deepEqual(left.map((copy: FixtureValue) => copy.account_id), [second]);
    await remove(owner, 'shared', left);
    assert.equal(await folderExists(shared.id), 0);
    assert.equal(await mailExists(shared.mail), 0);
  });

  // A provider's identity UniHub learns after the list was read, or never stored, is no consent.
  await t.test('a list read before UniHub learned the MAILBOXID, or a MAILBOXID UniHub never read, deletes nothing', async () => {
    imap.account('owner-ids@example.test', { INBOX: { uidvalidity: 1 }, Ledger: { uidvalidity: 90, mailboxId: 'F-ledger-new' }, Unread: { uidvalidity: 92, mailboxId: 'F-unread' } }, true);
    const ids = await account(users.owner, 'owner-ids@example.test');
    const ledger = await folder(users.owner, 'ledger', 'Ledger', [[ids, 90]]);
    const before = await shown(owner, 'ledger');
    assert.deepEqual(before, [{ account_id: ids, remote_name: 'Ledger', uidvalidity: '90', mailbox_id: null }]);
    // A sync reads the folder now and stores its MAILBOXID: the open dialog's list is not that snapshot.
    await repository.withTransaction((cx: FixtureValue) => repository.ensureMailbox({ userId: users.owner, accountId: ids, folderName: 'Ledger', epoch: 90,
      metadata: { providerMailboxId: 'F-ledger-new' } }, cx), pool);
    reached.length = 0;
    assert.equal((await remove(owner, 'ledger', before, 409)).code, 'FOLDER_CHANGED');
    assert.deepEqual(reached, [], 'refused before any server is reached');
    assert.ok(imap.login('owner-ids@example.test').boxes.has('Ledger'));
    // Shown again, with its id, it is deleted.
    await remove(owner, 'ledger', await shown(owner, 'ledger'));
    assert.equal(await folderExists(ledger.id), 0);
    // The server has an id UniHub never stored for this folder: refused until a sync has read it.
    const unread = await folder(users.owner, 'unread', 'Unread', [[ids, 92]]);
    imap.commands.length = 0;
    const refused = await remove(owner, 'unread', await shown(owner, 'unread'), 409);
    assert.equal(refused.code, 'FOLDER_CHANGED');
    assert.match(refused.error, /not read this folder's identity/);
    assert.ok(!imap.sent('owner-ids@example.test').some(command => command.startsWith('DELETE')), 'no DELETE');
    assert.equal(await folderExists(unread.id), 1);
  });

  await t.test('a STATUS without the MAILBOXID asked for, or with UIDVALIDITY twice, deletes nothing', async () => {
    imap.account('owner-status@example.test', { INBOX: { uidvalidity: 1 }, Audit: { uidvalidity: 77, mailboxId: 'F-audit-new' } }, true);
    imap.account('owner-twice@example.test', { INBOX: { uidvalidity: 1 }, Audit: { uidvalidity: 78 } });
    const withIds = await account(users.owner, 'owner-status@example.test'), plain = await account(users.owner, 'owner-twice@example.test');
    const audit = await folder(users.owner, 'audit', 'Audit', [[withIds, 77, 'F-audit-old']]);
    const twice = await folder(users.owner, 'audit-twice', 'Audit', [[plain, 77]]);
    // The server holds a replacement (F-audit-new) but leaves MAILBOXID out of its answer.
    imap.login('owner-status@example.test').statusItems = () => 'UIDVALIDITY 77';
    const missing = await remove(owner, 'audit', await shown(owner, 'audit'), 502);
    assert.equal(missing.code, 'MAIL_SERVER_ERROR');
    assert.ok(imap.login('owner-status@example.test').boxes.has('Audit'), 'the replacement stays');
    assert.equal(await folderExists(audit.id), 1);
    assert.equal(await mailExists(audit.mail), 1);
    // The server holds 78 and answers both 78 and the 77 the person saw.
    imap.login('owner-twice@example.test').statusItems = () => 'UIDVALIDITY 78 UIDVALIDITY 77';
    assert.equal((await remove(owner, 'audit-twice', await shown(owner, 'audit-twice'), 502)).code, 'MAIL_SERVER_ERROR');
    assert.ok(imap.login('owner-twice@example.test').boxes.has('Audit'));
    assert.equal(await mailExists(twice.mail), 1);
    for (const login of ['owner-status@example.test', 'owner-twice@example.test'])
      assert.ok(!imap.sent(login).some(command => command.startsWith('DELETE')), `no DELETE to ${login}`);
  });

  await t.test('a sync that reads a new MAILBOXID under the same UIDVALIDITY keeps the old folder\'s Download mail when the new one is deleted', async () => {
    imap.account('owner-download@example.test', { INBOX: { uidvalidity: 1 }, Kept: { uidvalidity: 91, mailboxId: 'F-kept-new' } }, true);
    const download = await account(users.owner, 'owner-download@example.test', { mode: 'download' });
    const kept = await folder(users.owner, 'kept', 'Kept', [[download, 91, 'F-kept-old']]);
    // Another program replaced Kept; the provider kept UIDVALIDITY 91, only MAILBOXID tells. A sync reads it.
    await repository.withTransaction((cx: FixtureValue) => repository.ensureMailbox({ userId: users.owner, accountId: download, folderName: 'Kept', epoch: 91,
      metadata: { providerMailboxId: 'F-kept-new' } }, cx), pool);
    const [[occurrence]] = await pool.query<RowDataPacket[]>('SELECT presence FROM mail_remote_occurrences WHERE email_id = ?', [kept.mail[0]]);
    assert.equal(occurrence.presence, 'quarantined', 'the old folder\'s copy no longer counts as the new folder\'s');
    const copies = await shown(owner, 'kept');
    assert.equal(copies[0].mailbox_id, 'F-kept-new');
    const deleted = await remove(owner, 'kept', copies);
    assert.equal(deleted.deletedMessages, 0, 'the old folder\'s message is not deleted with the new folder');
    assert.equal(await mailExists(kept.mail), 1);
    assert.ok(!imap.login('owner-download@example.test').boxes.has('Kept'));
  });

  // The provider gives the new folder's messages UIDs the old one had used. A
  // UID of the new folder never stands for an old message: the sync reads it as
  // new mail, whether the old copy was still there or already gone, and deleting
  // the new folder keeps the old folder's Download mail.
  const { scanMailboxSlice } = runtime('services/mail-engine/sync');
  const { closeImapConnection } = runtime('services/mail-imap-guard');
  async function scan(address: string, accountId: string, slug: string, name: string) {
    const connection = guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: imap.port, user: address, password: 'fixture',
      tls: false, keepalive: false, connTimeout: 2000, authTimeout: 2000, socketTimeout: 3000 } }), { timeoutMs: 5000 });
    try {
      return await scanMailboxSlice({ db: pool, connection, account: { id: accountId, user_id: users.owner, sync_mode: 'download' },
        folder: { folderName: name, dbFolderName: slug }, stream: 'recent' });
    } finally { closeImapConnection(connection); }
  }
  for (const [label, uid, before] of [['present', 5, 'present'], ['absent', 5, 'absent'], ['present, another UID', 6, 'present']] as const) {
    await t.test(`a new MAILBOXID under the same UIDVALIDITY, the old copy ${label}: a sync reads its UID ${uid} as new mail, and deleting it keeps the old`, async () => {
      const address = `owner-reuse-${uid}-${before}@example.test`, slug = `reuse-${uid}-${before}`, name = `Reused-${uid}-${before}`;
      imap.account(address, { INBOX: { uidvalidity: 1 }, [name]: { uidvalidity: 91, mailboxId: 'F-reused-new', uids: [uid] } }, true);
      const download = await account(users.owner, address, { mode: 'download' });
      const old = await folder(users.owner, slug, name, [[download, 91, 'F-reused-old']]);
      if (before === 'absent') await pool.execute("UPDATE mail_remote_occurrences SET presence = 'absent', absent_at = UTC_TIMESTAMP() WHERE email_id = ?", [old.mail[0]]);

      const scanned = await scan(address, download, slug, name);
      assert.equal(scanned.inserted, 1, 'the new folder\'s message is read as a message of its own');
      const [bound] = await pool.query<RowDataPacket[]>(`SELECT o.email_id, o.presence FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id
        WHERE m.mail_account_id = ? AND BINARY m.remote_name = BINARY ? AND o.uid = ?`, [download, name, uid]);
      assert.equal(bound.length, 1);
      assert.notEqual(bound[0].email_id, old.mail[0], 'the old message is not bound to the new folder\'s UID');
      assert.equal(bound[0].presence, 'present');
      const [[kept]] = await pool.query<RowDataPacket[]>('SELECT presence FROM mail_remote_occurrences WHERE email_id = ?', [old.mail[0]]);
      assert.equal(kept.presence, before === 'present' ? 'quarantined' : 'absent', 'the old copy keeps what UniHub knew of it');

      const deleted = await remove(owner, slug, await shown(owner, slug));
      assert.equal(deleted.deletedMessages, 1, 'only the new folder\'s message goes with it');
      assert.equal(await mailExists(old.mail), 1, 'the old folder\'s Download mail is kept');
      assert.equal(await mailExists([bound[0].email_id]), 0);
      assert.ok(!imap.login(address).boxes.has(name));
    });
  }

  // A MOVE into Destination that UniHub could not settle keeps the server's
  // COPYUID (UIDVALIDITY 91, UID 5). Destination is then replaced; the new one
  // gives out UID 5 again. That COPYUID describes the old folder: neither a
  // sync nor the recovered MOVE check may bind the new UID 5 to the moved
  // message or count the MOVE as done. A new UIDVALIDITY was already safe (the
  // COPYUID names its UIDVALIDITY); the reset now takes such a COPYUID out of
  // use for both.
  const engine = runtime('services/mail-engine/runtime');
  const { runRecoveredReconcileJob } = runtime('services/mail-durable-jobs');
  async function incomingMove(label: string, { occupied, state }: { occupied: boolean; state: 'needs_attention' | 'reconciling' }) {
    const address = `owner-incoming-${label}@example.test`;
    const login = imap.account(address, { INBOX: { uidvalidity: 1 }, Source: { uidvalidity: 90, mailboxId: 'F-source' },
      Destination: { uidvalidity: 91, mailboxId: 'F-dest-old', uids: [5] } }, true);
    const accountId = await account(users.owner, address);
    const source = await folder(users.owner, `incoming-source-${label}`, 'Source', [[accountId, 90, 'F-source']]);
    const destination = occupied ? await folder(users.owner, `incoming-destination-${label}`, 'Destination', [[accountId, 91, 'F-dest-old']])
      : await folder(users.owner, `incoming-destination-${label}`, 'Destination', []);
    if (!occupied) {
      await pool.execute<ResultSetHeader>('INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,?)', [destination.id, accountId, 'Destination']);
      await repository.ensureMailbox({ userId: users.owner, accountId, folderName: 'Destination', epoch: 91, metadata: { providerMailboxId: 'F-dest-old' } }, pool);
    } else {
      // The old Destination's UID 5 is a message with another copy, so the MOVE could not adopt it.
      const other = await repository.ensureMailbox({ userId: users.owner, accountId, folderName: 'Other', epoch: 92 }, pool);
      await repository.upsertOccurrence({ userId: users.owner, accountId, mailboxId: other.id, epoch: 92, uid: 8, emailId: destination.mail[0] }, pool);
    }
    const [[from]] = await pool.query<RowDataPacket[]>('SELECT id FROM mail_remote_occurrences WHERE email_id = ?', [source.mail[0]]);
    await pool.execute('UPDATE mail_remote_occurrences SET presence = \'absent\', absent_at = UTC_TIMESTAMP() WHERE id = ?', [from.id]);
    await pool.execute("UPDATE emails SET subject = 'The moved message', body_text = 'Moved message body.', import_complete = TRUE, content_state = 'complete' WHERE id = ?", [source.mail[0]]);
    const operation = crypto.randomUUID(), mapping = { uidvalidity: 91, sourceUids: [5], destinationUids: [5] };
    await pool.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,target_folder,remote_folder,remote_uid,remote_uidvalidity,
        source_occurrence_id,status,state,is_current,dispatched,intent_revision,evidence_json)
      VALUES (?,?,?,?,'move','Destination','Source',?,'Source',5,90,?,?,?,TRUE,TRUE,1,?)`,
    [operation, users.owner, accountId, source.mail[0], `incoming-destination-${label}`, from.id, state === 'reconciling' ? 'pending' : 'conflict', state,
      JSON.stringify({ kind: 'move_outcome', completion: 'ok', mappingStatus: 'valid', mapping })]);
    return { address, login, accountId, source, destination, operation };
  }
  // What UID 5 of the live Destination is bound to, and the MOVE's state.
  async function incomingOutcome(move: Awaited<ReturnType<typeof incomingMove>>) {
    const [[bound]] = await pool.query<RowDataPacket[]>(`SELECT o.email_id, e.import_complete FROM mail_remote_occurrences o
      JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id JOIN emails e ON e.id = o.email_id
      WHERE m.mail_account_id = ? AND BINARY m.remote_name = 'Destination' AND o.uid = 5`, [move.accountId]);
    const [[operation]] = await pool.query<RowDataPacket[]>('SELECT state, status, evidence_json FROM mail_writebacks WHERE id = ?', [move.operation]);
    const evidence = typeof operation.evidence_json === 'string' ? JSON.parse(operation.evidence_json) : operation.evidence_json;
    return { bound, operation, evidence };
  }
  for (const [label, replacement] of [['mailboxid', { uidvalidity: 91, mailboxId: 'F-dest-new' }], ['uidvalidity', { uidvalidity: 92, mailboxId: 'F-dest-old' }]] as const) {
    await t.test(`a sync of a Destination replaced with another ${label === 'mailboxid' ? 'MAILBOXID' : 'UIDVALIDITY'} does not bind a saved COPYUID to its reused UID`, async () => {
      const move = await incomingMove(`scan-${label}`, { occupied: true, state: 'needs_attention' });
      move.login.boxes.set('Destination', { ...replacement, uids: [5] });
      const connection = guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: imap.port, user: move.address, password: 'fixture',
        tls: false, keepalive: false, connTimeout: 2000, authTimeout: 2000, socketTimeout: 3000 } }), { timeoutMs: 5000 });
      try {
        const scanned = await scanMailboxSlice({ db: pool, connection, account: { id: move.accountId, user_id: users.owner, sync_mode: 'sync' },
          folder: { folderName: 'Destination', dbFolderName: `incoming-destination-scan-${label}` }, stream: 'recent' });
        assert.equal(scanned.inserted, 1, 'the new folder\'s UID 5 is read as a new message');
      } finally { closeImapConnection(connection); }
      const { bound, operation, evidence } = await incomingOutcome(move);
      assert.notEqual(bound.email_id, move.source.mail[0], 'the moved message is not bound to the new folder\'s UID 5');
      assert.equal(Number(bound.import_complete), 0, 'the new message is downloaded, not shown with the moved message\'s content');
      assert.deepEqual([operation.state, operation.status], ['needs_attention', 'conflict'], 'the MOVE is not proven by an unrelated message');
      assert.deepEqual(evidence.mapping, { uidvalidity: 91, sourceUids: [5], destinationUids: [5] }, 'the COPYUID is kept as evidence');
      assert.equal(await mailExists([move.source.mail[0], move.destination.mail[0]]), 2);
    });
  }
  await t.test('the recovered MOVE check does not settle a saved COPYUID in a Destination replaced since', async () => {
    const move = await incomingMove('recovered', { occupied: false, state: 'reconciling' });
    move.login.boxes.set('Destination', { uidvalidity: 91, mailboxId: 'F-dest-new', uids: [5] });
    const queued = await engine.enqueueJob({ userId: users.owner, accountId: move.accountId, operationId: move.operation, kind: 'reconcile', priority: 0 }, pool);
    const job = await engine.claimDueJob({ workerId: 'incoming-recovered', kinds: ['reconcile'] }, pool);
    assert.equal(job.id, queued.id);
    const connection = guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: imap.port, user: move.address, password: 'fixture',
      tls: false, keepalive: false, connTimeout: 2000, authTimeout: 2000, socketTimeout: 3000 } }), { timeoutMs: 5000 });
    try {
      assert.equal((await runRecoveredReconcileJob({ job, account: { id: move.accountId, user_id: users.owner, sync_mode: 'sync' }, connection,
        signal: new AbortController().signal, report() {} })).success, true);
    } finally { closeImapConnection(connection); }
    const { bound, operation, evidence } = await incomingOutcome(move);
    assert.equal(bound, undefined, 'the moved message is not bound to the new folder\'s UID 5');
    assert.deepEqual([operation.state, operation.status], ['needs_attention', 'conflict'], 'the MOVE is not proven by an unrelated message');
    assert.deepEqual(evidence.mapping, { uidvalidity: 91, sourceUids: [5], destinationUids: [5] }, 'the COPYUID is kept as evidence');
    await engine.completeJob({ jobId: job.id, accountId: move.accountId, workerId: 'incoming-recovered', generation: Number(job.worker_generation) }, pool);
  });

  await t.test('a DELETE whose answer never comes is reported as unknown, not as refused', async () => {
    imap.account('owner-lost-a@example.test', { INBOX: { uidvalidity: 1 }, Pending: { uidvalidity: 5 } });
    imap.account('owner-lost-b@example.test', { INBOX: { uidvalidity: 1 }, Pending: { uidvalidity: 6 } });
    const lostA = await account(users.owner, 'owner-lost-a@example.test'), lostB = await account(users.owner, 'owner-lost-b@example.test');
    const [first, second] = [lostA, lostB].sort();
    const address = (id: string) => id === lostA ? 'owner-lost-a@example.test' : 'owner-lost-b@example.test';
    const pending = await folder(users.owner, 'pending', 'Pending', [[lostA, 5], [lostB, 6]]);
    // The second server takes the DELETE and closes the connection before it answers.
    imap.login(address(second)).deleteReply = () => 'DROP';
    const partly = await remove(owner, 'pending', await shown(owner, 'pending'), 409);
    assert.equal(partly.code, 'FOLDER_PARTLY_DELETED');
    assert.deepEqual(partly.details.copies, [{ account_id: first, email_address: address(first), outcome: 'deleted' },
      { account_id: second, email_address: address(second), outcome: 'unknown' }]);
    assert.match(partly.error, /did not answer whether it deleted the folder/);
    assert.deepEqual(await linked(pending.id), [second], 'the unanswered copy is not settled');
    // A single copy whose DELETE goes unanswered: nothing confirmed, the answer still says so.
    imap.login(address(second)).deleteReply = () => 'DROP';
    imap.login(address(second)).boxes.set('Pending', { uidvalidity: second === lostA ? 5 : 6 });
    const alone = await remove(owner, 'pending', await shown(owner, 'pending'), 502);
    assert.deepEqual(alone.details?.copies, [{ account_id: second, email_address: address(second), outcome: 'unknown' }]);
    assert.equal(await folderExists(pending.id), 1);
  });

  await t.test('only the owner\'s own, connected accounts are reached; a request without copies is refused', async () => {
    const team = await folder(users.owner, 'team', 'Team', [[ownerMail, 7]]);
    const old = await folder(users.owner, 'old-team', 'Old', [[ownerOld, 8]]);
    const theirs = await folder(users.stranger, 'team', 'Team', [[strangerMail, 3]]);
    imap.login('owner-mail@example.test').boxes.set('Team', { uidvalidity: 7 });
    imap.login('owner-old@example.test').boxes.set('Old', { uidvalidity: 8 });
    imap.login('stranger-mail@example.test').boxes.set('Team', { uidvalidity: 3 });
    const ownersCopies = await shown(owner, 'team'), strangersCopies = await shown(stranger, 'team');
    // Each person's list shows their own copies only.
    assert.deepEqual(ownersCopies.map((copy: FixtureValue) => copy.account_id), [ownerMail]);
    assert.deepEqual(strangersCopies.map((copy: FixtureValue) => copy.account_id), [strangerMail]);
    reached.length = 0;
    // The stranger names the owner's copy: their own Team is not it, and the owner's server is never reached.
    assert.equal((await remove(stranger, 'team', ownersCopies, 409)).code, 'FOLDER_CHANGED');
    // The stranger cannot reach a folder only the owner has.
    assert.equal((await remove(stranger, 'old-team', await shown(owner, 'old-team'), 404)).error, 'Folder not found');
    // The owner names the stranger's account (a foreign account): refused.
    assert.equal((await remove(owner, 'team', [...ownersCopies, ...strangersCopies], 409)).code, 'FOLDER_CHANGED');
    assert.equal((await remove(owner, 'team', strangersCopies, 409)).code, 'FOLDER_CHANGED');
    // A disconnected (revoked) account of the owner is not reached either.
    const refused = await remove(owner, 'old-team', await shown(owner, 'old-team'), 409);
    assert.match(refused.error, /disconnected/);
    // A page from before the copies were shown sends none: refused, never deleted by name.
    assert.equal((await remove(owner, 'team', undefined, 400)).code, 'FOLDER_COPIES_REQUIRED');
    assert.deepEqual(reached, [], 'no server reached by any of these');
    assert.equal(await folderExists(team.id), 1);
    assert.equal(await folderExists(old.id), 1);
    assert.equal(await folderExists(theirs.id), 1);
    assert.ok(imap.login('stranger-mail@example.test').boxes.has('Team'));
    assert.ok(imap.login('owner-old@example.test').boxes.has('Old'));
    // The owner, with the copy shown: deleted, and only there.
    await remove(owner, 'team', ownersCopies);
    assert.deepEqual(reached, ['owner-mail@example.test']);
    assert.equal(await folderExists(team.id), 0);
    assert.equal(await folderExists(theirs.id), 1);
    assert.ok(imap.login('stranger-mail@example.test').boxes.has('Team'));
  });

  assert.deepEqual(imap.errors, []);
});
