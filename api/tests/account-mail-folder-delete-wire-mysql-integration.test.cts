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

interface Box { uidvalidity: number; mailboxId?: string }
interface Login { boxes: Map<string, Box>; objectId: boolean; deleteReply?: (name: string) => string | null; list?: string }

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
    let input = '', chain = Promise.resolve(), login = '', state: Login | undefined;
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
            send(`* STATUS ${quoted(name)} (UIDVALIDITY ${box.uidvalidity}${mailboxId})\r\n`); ok(); return;
          }
          if (cmd.startsWith('DELETE ')) {
            const [name] = mailbox(cmd.slice(7));
            const reply = state.deleteReply?.(name);
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
  async function account(userId: string, address: string, { active = true } = {}) {
    const id = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active,disconnected_at)
      VALUES (?,?,?,'custom','sync',?,?)`, [id, userId, address, active, active ? null : '2026-11-01 00:00:00']);
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
