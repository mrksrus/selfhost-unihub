import type { FixtureValue } from './helpers/test-types.cts';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');

// The file roots are read when the services load.
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-policy-races-'));
// Also when the test is skipped without a database.
process.on('exit', () => fs.rmSync(storage, { recursive: true, force: true }));
const ROOTS = { raw: 'mail-raw', attachments: 'attachments', backups: 'backups', recordings: 'recordings', photos: 'photos', spool: 'spool' } as const;
const root = (name: keyof typeof ROOTS) => path.join(storage, ROOTS[name]);
Object.assign(process.env, { MAIL_RAW_STORAGE_ROOT: root('raw'), MAIL_ATTACHMENT_UPLOAD_ROOT: root('attachments'), BACKUP_ARCHIVES_ROOT: root('backups'),
  RECORDINGS_ROOT: root('recordings'), CONTACT_PHOTOS_ROOT: root('photos'), UPLOAD_SPOOL_ROOT: root('spool') });
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Data-safety rules an administrator changes while a destructive step is
// under way (0.28 C2, review r1), through the real request handler and
// MariaDB, with the administrator, alex (whose data is at stake) and blair.
// Each case holds the step at the point where it waited before (a file
// check, a row lock, a read), commits the administrator's change there and
// lets the step go on: the step acts on the rules in force when it acts.
// The other cases: an activity-log entry that cannot be written stops the
// administrator's deletion; Calendar's restore lock and a refused calendar
// change leave the calendar as it was. Each case starts with every policy
// at its default, so one that fails leaves the others their own evidence.
test('a destructive step follows the rules in force when it acts, with an owner, a stranger and an administrator', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);

  const password = 'synthetic-policy-races-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const [name, role] of [['admin', 'admin'], ['alex', 'user'], ['blair', 'user']] as const) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name, role]);
  }
  async function signIn(name: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return client;
  }
  type Client = Awaited<ReturnType<typeof signIn>>;
  const admin = await signIn('admin'), alex = await signIn('alex'), blair = await signIn('blair');
  async function call(client: Client, method: string, url: string, body: unknown = {}, status = 200) {
    let timer: NodeJS.Timeout | undefined;
    const reply = await Promise.race([client.request(method, url, method === 'GET' ? undefined : body),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} ${url} did not answer: queued behind a held change?`)), 30000); })])
      .finally(() => clearTimeout(timer));
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 500)}`);
    return reply.body as FixtureValue;
  }
  const count = async (sql: string, params: unknown[] = []) => Number(((await pool.query<RowDataPacket[]>(sql, params))[0][0]).count);
  const setPolicies = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    call(admin, 'PUT', '/api/admin/policies', { values, current_password: password, ...extra });

  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const within = async <T,>(promise: Promise<T>) => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the step never reached its pause')), 20000); })]); }
    finally { clearTimeout(timer); }
  };
  // Holds the app's statement containing `marker` (the first, or the
  // `occurrence`-th), on the pool or on a connection taken from it (only
  // there with `onConnection`: a transaction's), once it has answered,
  // until `release()`.
  function pauseAfter(marker: string, { occurrence = 1, onConnection = false } = {}) {
    const reached = deferred(), released = deferred();
    let seen = 0;
    type Execute = (this: unknown, sql: unknown, ...args: unknown[]) => Promise<unknown>;
    const holding = (original: Execute): Execute => async function (sql, ...args) {
      const result = await original.call(this, sql, ...args);
      if (seen < occurrence && String((sql as { sql?: string })?.sql ?? sql).includes(marker) && ++seen === occurrence) { reached.resolve(); await released.promise; }
      return result;
    };
    const execute = pool.execute, getConnection = pool.getConnection;
    if (!onConnection) pool.execute = holding(execute as unknown as Execute) as unknown as typeof pool.execute;
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
  // A file under a root, for a row that names it.
  function write(file: string, bytes: Buffer | string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }
  const encrypt = (text: string) => (require('../dist/src/security/encryption') as typeof import('../src/security/encryption')).encrypt(text);
  // A synthetic mail server's folders: its LIST. A fake connection spreads
  // it and adds its own DELETE.
  const folderServer = (folders: Record<string, number> = { Shared: 1 }) => ({
    list: async () => ['INBOX', ...Object.keys(folders)].map(path => ({ path, flags: new Set() })),
  });
  // A DELETE of a folder the server no longer has, answered as Dovecot does.
  const nonexistent = (name: string) => Object.assign(new Error(`Mailbox doesn't exist: ${name}`), { responseStatus: 'NO', serverResponseCode: 'NONEXISTENT' });
  // Each case starts with every policy at its default and no restore, whatever an earlier one left.
  const fromDefaults = (name: string, body: () => Promise<void>) => t.test(name, async () => {
    await pool.query("DELETE FROM setting_policies WHERE target_kind = 'installation'");
    await pool.query('DELETE FROM backup_restore_jobs');
    await body();
  });

  await fromDefaults('R4: rules shown with a revision are that revision\'s, while an administrator saves between the reads', async () => {
    const before = await call(alex, 'GET', '/api/policies/effective');
    const pause = pauseAfter("setting_key LIKE 'policy.%'");
    const pending = alex.request('GET', '/api/policies/effective');
    try {
      await pause.reached();
      await setPolicies({ 'bin.delete': 'forbidden' });
      pause.release();
      const shown = (await pending).body as FixtureValue;
      assert.deepEqual([shown.revision, shown.rules], [before.revision, before.rules], 'the rules and the revision of one moment');
      await call(alex, 'POST', '/api/policies/acknowledge', { revision: shown.revision });
      const next = await call(alex, 'GET', '/api/policies/effective');
      assert.notDeepEqual(next.rules, shown.rules);
      assert.ok(next.acknowledged_revision < next.revision, 'the new rules are still to be confirmed');
    } finally { pause.restore(); await pending; }
    await setPolicies({ 'bin.delete': 'allowed' });
  });

  await fromDefaults('R2: the purge keeps an item whose minimum was raised to forever while the purge waited for its row', async () => {
    const { purgeBin } = require('../dist/src/services/bin') as typeof import('../src/services/bin');
    await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '7' } });
    await setPolicies({ 'bin.delete': 'forbidden' }, { bin_min_retention: '30' });
    const item = crypto.randomUUID();
    await pool.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after)
      VALUES (?, ?, 'contacts', 'contact', ?, 'Synthetic contact', 'deleted', '{}', UTC_TIMESTAMP() - INTERVAL 40 DAY, UTC_TIMESTAMP() - INTERVAL 33 DAY)`, [item, users.alex, crypto.randomUUID()]);
    // Another writer holds the item's row; the purge waits at its lock.
    const blocker = await pool.getConnection();
    await blocker.beginTransaction();
    await blocker.execute('SELECT id FROM bin_items WHERE id = ? FOR UPDATE', [item]);
    const waiting = deferred();
    const getConnection = pool.getConnection;
    pool.getConnection = async function (this: typeof pool) {
      const cx = await getConnection.call(this) as PoolConnection;
      const execute = cx.execute, release = cx.release;
      cx.execute = function (this: PoolConnection, sql: unknown, ...args: unknown[]) {
        const answer = (execute as (...all: unknown[]) => Promise<unknown>).call(this, sql, ...args);
        if (String(sql).includes('SELECT * FROM bin_items FORCE INDEX')) waiting.resolve();
        return answer;
      } as typeof cx.execute;
      cx.release = function (this: PoolConnection) { cx.execute = execute; cx.release = release; return release.call(this); };
      return cx;
    } as typeof pool.getConnection;
    let held = true;
    const purge = purgeBin();
    try {
      await within(waiting.promise);
      await setPolicies({}, { bin_min_retention: 'forever' });
      await blocker.commit();
      blocker.release();
      held = false;
      await purge;
      assert.equal(await count('SELECT COUNT(*) AS count FROM bin_items WHERE id = ?', [item]), 1, 'forever keeps it');
    } finally {
      pool.getConnection = getConnection;
      if (held) { await blocker.rollback().catch(() => undefined); blocker.release(); }
      await purge.catch(() => undefined);
    }
    // Once the minimum allows it, the same purge takes it.
    await setPolicies({}, { bin_min_retention: '30' });
    await purgeBin();
    assert.equal(await count('SELECT COUNT(*) AS count FROM bin_items WHERE id = ?', [item]), 0);
    await setPolicies({ 'bin.delete': 'allowed' }, { bin_min_retention: 'forever' });
    await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '30' } });
  });

  await fromDefaults('R3: a backup that becomes ready between the minimum-age check and the delete stays', async () => {
    await setPolicies({ 'backup.server_retention_days': 30 });
    const job = crypto.randomUUID();
    const file = write(path.join(root('backups'), users.alex, `${job}.unihub-backup`), 'synthetic encrypted archive');
    await pool.execute("INSERT INTO data_export_jobs (id, user_id, status, phase, created_at, file_path) VALUES (?, ?, 'running', 'collecting', UTC_TIMESTAMP(), ?)", [job, users.alex, file]);
    const pause = pauseAfter('AS deletable_from');
    const pending = alex.request('DELETE', `/api/backup/jobs/${job}`);
    try {
      await pause.reached();
      await pool.execute("UPDATE data_export_jobs SET status = 'ready', phase = 'complete', completed_at = UTC_TIMESTAMP() WHERE id = ?", [job]);
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [403, 'POLICY_FORBIDS', 'backup.server_retention_days']);
    } finally { pause.restore(); await pending; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE id = ?', [job]), 1);
    assert.ok(fs.existsSync(file), 'its archive stays');
    // A failed job holds no backup: it goes at once, a stranger's request finds nothing.
    const failed = crypto.randomUUID();
    await pool.execute("INSERT INTO data_export_jobs (id, user_id, status, phase, created_at) VALUES (?, ?, 'failed', 'failed', UTC_TIMESTAMP())", [failed, users.alex]);
    await call(blair, 'DELETE', `/api/backup/jobs/${failed}`, {}, 404);
    await call(alex, 'DELETE', `/api/backup/jobs/${failed}`);
    await setPolicies({ 'backup.server_retention_days': null });
    await pool.execute('DELETE FROM data_export_jobs WHERE id = ?', [job]);
  });

  // Provider deletion: one Download account of alex's that deletes there, its mail archived exactly.
  const content = require('../dist/src/services/mail-engine/content') as typeof import('../src/services/mail-engine/content');
  const host = require('../dist/src/services/mail-host-policy') as typeof import('../src/services/mail-host-policy');
  const worker = require('../dist/src/services/mail-server-delete') as typeof import('../src/services/mail-server-delete');
  const account = crypto.randomUUID();
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, delete_emails_on_server, server_delete_grace_until)
    VALUES (?, ?, 'archive@example.test', 'custom', 'download', TRUE, TRUE, UTC_TIMESTAMP() - INTERVAL 1 HOUR)`, [account, users.alex]);
  async function archived(uid: number) {
    const id = crypto.randomUUID();
    const raw = Buffer.from(`From: sender@example.test\r\nSubject: Synthetic ${uid}\r\n\r\nBody\r\n`);
    const file = write(path.join(root('raw'), users.alex, `${id}.eml`), raw);
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, remote_folder, remote_uid, remote_uidvalidity,
        raw_storage_path, raw_sha256, raw_bytes, raw_format, raw_verified, import_complete)
      VALUES (?, ?, ?, 'sender@example.test', '[]', 'inbox', 'INBOX', ?, 1, ?, ?, ?, 'exact_octets', TRUE, TRUE)`, [id, users.alex, account, uid, file, sha, raw.length]);
    return { id, file, sha, bytes: raw.length };
  }

  await fromDefaults('R1: provider deletion forbidden during the archive check queues nothing', async () => {
    const queued = await archived(6);
    const verifyArchive = content.verifyArchive;
    const checking = deferred(), checked = deferred();
    content.verifyArchive = async (...args: Parameters<typeof verifyArchive>) => { const result = await verifyArchive(...args); checking.resolve(); await checked.promise; return result; };
    const admission = worker.recordMailServerMessageForDeletion({ connection: pool, userId: users.alex, accountId: account, emailId: queued.id, sourceFolder: 'INBOX',
      imapUid: 6, imapUidValidity: 1, rawStoragePath: queued.file, rawSha256: queued.sha, rawBytes: queued.bytes, rawFormat: 'exact_octets', rawVerified: true });
    try {
      await within(checking.promise);
      await setPolicies({ 'mail.provider_delete': 'forbidden' });
      checked.resolve();
      assert.equal(await admission, false);
    } finally { checked.resolve(); content.verifyArchive = verifyArchive; await admission.catch(() => undefined); }
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_server_messages WHERE email_id = ?', [queued.id]), 0, 'nothing queued');
  });

  await fromDefaults('R1: provider deletion forbidden, or the account changed, during the worker\'s last archive check erases nothing at the provider', async () => {
    // On a real IMAP connection to a local peer. Each late change in turn:
    // the policy (review r1), and the account itself changed by another
    // request (r6: the pass's account snapshot, account-identity.ts).
    for (const [late, uid] of [['policy', 7], ['account', 9]] as const) {
      const message = await archived(uid);
      const queue = crypto.randomUUID();
      await pool.execute(`INSERT INTO mail_server_messages (id, user_id, mail_account_id, email_id, source_folder, imap_uid, imap_uidvalidity, delete_status)
        VALUES (?, ?, ?, ?, 'INBOX', ?, 1, 'pending')`, [queue, users.alex, account, message.id, uid]);
      const commands: string[] = [];
      const sockets = new Set<import('node:net').Socket>();
      const peer = (require('node:net') as typeof import('node:net')).createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        socket.write('* OK synthetic IMAP peer\r\n');
        let input = '';
        socket.on('data', data => {
          input += data.toString();
          for (let end = input.indexOf('\r\n'); end >= 0; end = input.indexOf('\r\n')) {
            const line = input.slice(0, end);
            input = input.slice(end + 2);
            const match = /^(\S+) (.*)$/.exec(line);
            if (!match) continue;
            const [, tag, command] = match;
            commands.push(command);
            const ok = (text = 'done') => socket.write(`${tag} OK ${text}\r\n`);
            if (command === 'CAPABILITY') { socket.write('* CAPABILITY IMAP4rev1 UIDPLUS\r\n'); ok(); }
            else if (command.startsWith('LOGIN ') || command.startsWith('LSUB ') || command.startsWith('UID STORE ')) ok();
            else if (command.startsWith('LIST ')) { socket.write('* LIST (\\Noselect) "/" ""\r\n'); ok(); }
            else if (/^(SELECT|EXAMINE) /.test(command)) { socket.write(`* FLAGS (\\Seen \\Deleted)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT ${uid + 1}] next\r\n`); ok('[READ-WRITE] selected'); }
            else if (command.startsWith('UID SEARCH ')) { socket.write(`* SEARCH ${uid}\r\n`); ok(); }
            else if (command.startsWith('UID EXPUNGE ')) { socket.write('* 1 EXPUNGE\r\n'); ok(); }
            else if (command === 'LOGOUT') { socket.write('* BYE\r\n'); ok(); }
            else socket.write(`${tag} BAD unsupported\r\n`);
          }
        });
      });
      await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
      const buildImapConnectionConfig = host.buildImapConnectionConfig, eligible = content.eligibleForProviderErasure;
      // Only the destination is the local peer's (plain text on loopback); the worker, ImapFlow and the database are the real ones.
      (host as { buildImapConnectionConfig: unknown }).buildImapConnectionConfig = async () => ({ imap: { host: '127.0.0.1', port: (peer.address() as import('node:net').AddressInfo).port,
        tls: false, user: 'synthetic', password: 'synthetic', connTimeout: 3000, authTimeout: 3000, socketTimeout: 5000, keepalive: false } });
      let calls = 0;
      const lastCheck = deferred(), goOn = deferred();
      content.eligibleForProviderErasure = async (...args: Parameters<typeof eligible>) => {
        const result = await eligible(...args);
        if (++calls === 2) { lastCheck.resolve(); await goOn.promise; }
        return result;
      };
      const pass = worker.processMailServerDeletionForAccount(account);
      try {
        await within(lastCheck.promise);
        if (late === 'policy') await setPolicies({ 'mail.provider_delete': 'forbidden' });
        else await pool.execute("UPDATE mail_accounts SET username = 'changed-meanwhile' WHERE id = ?", [account]);
        goOn.resolve();
        const result = await pass as FixtureValue;
        assert.deepEqual([late, result.deleted, result.stopped], [late, 0, true], JSON.stringify(result));
        assert.deepEqual(commands.filter(command => /^UID (STORE|EXPUNGE)/.test(command)), [], `${late}: no erase was sent`);
      } finally {
        goOn.resolve();
        await pass.catch(() => undefined);
        (host as { buildImapConnectionConfig: unknown }).buildImapConnectionConfig = buildImapConnectionConfig;
        content.eligibleForProviderErasure = eligible;
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => peer.close(resolve));
      }
      assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT delete_status FROM mail_server_messages WHERE id = ?', [queue]))[0].map(row => row.delete_status), ['pending'], `${late}: it waits`);
      await pool.execute('DELETE FROM mail_server_messages WHERE id = ?', [queue]);
      await pool.execute('UPDATE mail_accounts SET username = NULL WHERE id = ?', [account]);
      if (late === 'policy') await setPolicies({ 'mail.provider_delete': 'user_choice' });
    }
  });

  await fromDefaults('S1: a Download import queues provider deletion on its own transaction, without a second connection', async () => {
    // The real import and the real queueing helper: the policy is read on the
    // import's connection (the pool guard fails this file on a second one).
    const { persistImportedMessage } = require('../dist/src/services/mail-import') as typeof import('../src/services/mail-import');
    const raw = Buffer.from('From: sender@example.test\r\nSubject: Synthetic import\r\n\r\nBody\r\n');
    let emailId = '';
    await persistImportedMessage({ db: pool, account: { user_id: users.alex, sync_mode: 'download' } as FixtureValue, accountId: account, folderName: 'INBOX', uid: 8, uidValidity: 1,
      messageId: '<synthetic-import@example.test>', fullEmail: raw, parsed: { subject: 'Synthetic import', text: 'Body', attachments: [] },
      fromAddress: 'sender@example.test', fromName: null, toAddresses: ['alex@example.test'], folder: 'inbox', isRead: false,
      archiveRaw: async ({ emailId: id }) => {
        emailId = id;
        const file = write(path.join(root('raw'), users.alex, `${id}.eml`), raw);
        return { rawStoragePath: file, rawSha256: crypto.createHash('sha256').update(raw).digest('hex'), rawBytes: raw.length, rawFormat: 'exact_octets', rawVerified: true };
      },
      enqueueDeletion: worker.recordMailServerMessageForDeletion });
    assert.equal(await count('SELECT COUNT(*) AS count FROM emails WHERE id = ?', [emailId]), 1, 'the message is stored');
    assert.equal(await count("SELECT COUNT(*) AS count FROM mail_server_messages WHERE email_id = ? AND delete_status = 'pending'", [emailId]), 1, 'and queued for deletion at the provider');
  });

  await fromDefaults('R5: the administrator\'s deletion for a person does not happen without its activity-log entry', async () => {
    const reject = async (action: string) => pool.query(`CREATE TRIGGER policy_races_audit BEFORE INSERT ON audit_log FOR EACH ROW
      BEGIN IF NEW.action = '${action}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic audit outage'; END IF; END`);
    const item = crypto.randomUUID();
    await pool.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after)
      VALUES (?, ?, 'contacts', 'contact', ?, 'Synthetic contact', 'deleted', '{}', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY)`, [item, users.alex, crypto.randomUUID()]);
    // In the deletion's transaction: no entry, no deletion.
    await reject('admin.bin_item_deleted');
    try {
      await call(admin, 'DELETE', `/api/admin/users/${users.alex}/bin/${item}`, { current_password: password }, 500);
      await call(admin, 'POST', `/api/admin/users/${users.alex}/bin/empty`, { current_password: password });
    } finally { await pool.query('DROP TRIGGER policy_races_audit'); }
    assert.equal(await count('SELECT COUNT(*) AS count FROM bin_items WHERE id = ?', [item]), 0, 'emptying, with its own entry, took it');
    assert.equal(await count("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'admin.bin_emptied' AND target_user_id = ?", [users.alex]), 1);
    // A backup's row and entry go in one transaction too.
    const job = crypto.randomUUID();
    await pool.execute("INSERT INTO data_export_jobs (id, user_id, status, phase, progress, created_at) VALUES (?, ?, 'ready', 'complete', 100, UTC_TIMESTAMP())", [job, users.alex]);
    await reject('admin.backup_deleted');
    try {
      await call(admin, 'DELETE', `/api/admin/users/${users.alex}/backups/${job}`, { current_password: password }, 500);
    } finally { await pool.query('DROP TRIGGER policy_races_audit'); }
    assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE id = ?', [job]), 1);
    await call(admin, 'DELETE', `/api/admin/users/${users.alex}/backups/${job}`, { current_password: password });
    const [[entry]] = await pool.query<RowDataPacket[]>("SELECT actor_id, target_user_id, details FROM audit_log WHERE action = 'admin.backup_deleted'");
    const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
    assert.deepEqual([entry.actor_id, entry.target_user_id, details], [users.admin, users.alex, { backup_job: job }]);
  });

  // A mail account of alex's with a calendar connected from it.
  async function mailWithCalendar(address: string) {
    const mail = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, ?, 'custom', 'download', FALSE)", [mail, users.alex, address]);
    return mail;
  }

  await fromDefaults('R6: clearing mail, which unlinks a connected calendar, waits for Calendar\'s restore', async () => {
    const mail = await mailWithCalendar('linked@example.test');
    const linked = crypto.randomUUID(), restore = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, mail_account_id, provider_config) VALUES (?, ?, 'caldav', 'linked@example.test', ?, '{"mailLinked":true}')`, [linked, users.alex, mail]);
    await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restore, users.alex]);
    // Refused for the person and for the administrator.
    assert.equal((await call(alex, 'POST', '/api/settings/clear-mail-accounts', {}, 409)).code, 'RESTORE_IN_PROGRESS');
    assert.equal((await call(admin, 'POST', `/api/admin/users/${users.alex}/clear/mail-accounts`, { current_password: password }, 409)).code, 'RESTORE_IN_PROGRESS');
    assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT mail_account_id FROM calendar_accounts WHERE id = ?', [linked]))[0].map(row => row.mail_account_id), [mail]);
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE id = ?', [mail]), 1);
    // After the restore, the administrator's clear goes through and unlinks it.
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    const accounts = await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE user_id = ?', [users.alex]);
    assert.equal((await call(admin, 'POST', `/api/admin/users/${users.alex}/clear/mail-accounts`, { current_password: password })).deleted, accounts);
    assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT mail_account_id FROM calendar_accounts WHERE id = ?', [linked]))[0].map(row => row.mail_account_id), [null]);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [linked]);
  });

  await fromDefaults('R7: a refused calendar-off leaves a restored calendar unlinked with its password', async () => {
    // A restored calendar of the mail account's address, not linked yet, with its own password.
    const mail = await mailWithCalendar('restored@example.test');
    const restored = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, encrypted_password, provider_config) VALUES (?, ?, 'caldav', 'restored@example.test', ?, '{"mailLinked":true}')`,
      [restored, users.alex, secret]);
    await setPolicies({ 'accounts.remove': 'forbidden' });
    const refused = await call(alex, 'PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: false }, 403);
    assert.deepEqual([refused.code, refused.details?.policy], ['POLICY_FORBIDS', 'accounts.remove']);
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password FROM calendar_accounts WHERE id = ?', [restored]);
    assert.deepEqual([row.mail_account_id, row.encrypted_password], [null, secret]);
    await call(blair, 'PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: false }, 404);
    // Allowed again, the same request removes it.
    await setPolicies({ 'accounts.remove': 'allowed' });
    assert.equal((await call(alex, 'PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: false })).calendar.enabled, false);
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_accounts WHERE id = ?', [restored]), 0);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('Q1: the person\'s delete for good and emptying the bin stop when bin.delete is forbidden while they run', async () => {
    const binned = async () => {
      const id = crypto.randomUUID();
      await pool.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after)
        VALUES (?, ?, 'contacts', 'contact', ?, 'Synthetic contact', 'deleted', '{}', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY)`, [id, users.alex, crypto.randomUUID()]);
      return id;
    };
    // Each request is held after its first read of the bin, past the request boundary.
    for (const [what, request] of [
      ['delete for good', (id: string) => alex.request('DELETE', `/api/bin/${id}`)],
      ['empty the bin', () => alex.request('POST', '/api/bin/empty', { module: 'contacts' })],
    ] as const) {
      const item = await binned();
      const pause = pauseAfter('SELECT * FROM bin_items WHERE user_id');
      const pending = request(item);
      try {
        await pause.reached();
        await setPolicies({ 'bin.delete': 'forbidden' });
        pause.release();
        const reply = await pending;
        assert.deepEqual([what, reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [what, 403, 'POLICY_FORBIDS', 'bin.delete']);
      } finally { pause.restore(); await pending; }
      assert.equal(await count('SELECT COUNT(*) AS count FROM bin_items WHERE id = ?', [item]), 1, `${what}: the item stays`);
      await setPolicies({ 'bin.delete': 'allowed' });
      await pool.execute('DELETE FROM bin_items WHERE id = ?', [item]);
    }
  });

  await fromDefaults('Q2: a backup minimum raised while the person\'s delete runs keeps the backup and its archive', async () => {
    await setPolicies({ 'backup.server_retention_days': 30 });
    const job = crypto.randomUUID();
    const file = write(path.join(root('backups'), users.alex, `${job}.unihub-backup`), 'synthetic encrypted archive');
    await pool.execute("INSERT INTO data_export_jobs (id, user_id, status, phase, progress, created_at, completed_at, file_path) VALUES (?, ?, 'ready', 'complete', 100, UTC_TIMESTAMP() - INTERVAL 40 DAY, UTC_TIMESTAMP() - INTERVAL 40 DAY, ?)", [job, users.alex, file]);
    // Old enough for 30 days when it is first checked; 90 days are committed before it goes.
    const pause = pauseAfter('AS deletable_from');
    const pending = alex.request('DELETE', `/api/backup/jobs/${job}`);
    try {
      await pause.reached();
      await setPolicies({ 'backup.server_retention_days': 90 });
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [403, 'POLICY_FORBIDS', 'backup.server_retention_days']);
    } finally { pause.restore(); await pending; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE id = ?', [job]), 1);
    assert.ok(fs.existsSync(file), 'its archive stays');
    // The administrator's path may still delete it.
    await call(admin, 'DELETE', `/api/admin/users/${users.alex}/backups/${job}`, { current_password: password });
    assert.equal(fs.existsSync(file), false);
  });

  await fromDefaults('S2: resuming a restored calendar while its mail account is disconnected is refused and changes nothing', async () => {
    const secret = encrypt('synthetic-calendar-password');
    // The person's mail link, the person's own calendar route and the administrator's path.
    for (const route of ['mail link', 'calendar account', 'administrator'] as const) {
      const address = `resume-${route.replace(/ /g, '-')}@example.test`;
      const mail = crypto.randomUUID(), calendar = crypto.randomUUID();
      await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, 'custom', 'download', FALSE, NULL)", [mail, users.alex, address]);
      await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, provider_config) VALUES (?, ?, 'caldav', ?, FALSE, ?, '{"mailLinked":true}')`,
        [calendar, users.alex, address, secret]);
      const reply = route === 'mail link' ? await alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true })
        : route === 'calendar account' ? await alex.request('PUT', `/api/calendar/accounts/${calendar}`, { is_active: true })
          : await admin.request('PUT', `/api/admin/users/${users.alex}/calendar-accounts/${calendar}`, { is_active: true, current_password: password });
      assert.deepEqual([route, reply.status, reply.body.code], [route, 409, 'MAIL_ACCOUNT_DISCONNECTED'], JSON.stringify(reply.body));
      const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password, is_active FROM calendar_accounts WHERE id = ?', [calendar]);
      assert.deepEqual([route, row.mail_account_id, row.encrypted_password, Number(row.is_active)], [route, null, secret, 0], 'still unlinked, with its password');
      if (route === 'administrator') {
        // A refusal is recorded as its answer, not as proof that nothing changed.
        const [[entry]] = await pool.query<RowDataPacket[]>("SELECT details FROM audit_log WHERE action = 'admin.calendar_account_changed' AND target_user_id = ? ORDER BY created_at DESC LIMIT 1", [users.alex]);
        const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
        assert.deepEqual([details.outcome, details.status, details.code], ['unknown', 409, 'MAIL_ACCOUNT_DISCONNECTED']);
      }
      await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [calendar]);
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
  });

  await fromDefaults('Q3: clearing mail waits for a Mail restore that starts while it stops the accounts\' work', async () => {
    for (const caller of ['person', 'administrator'] as const) {
      const mail = crypto.randomUUID(), restore = crypto.randomUUID();
      await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, 'clear@example.test', 'custom', 'download', FALSE)", [mail, users.alex]);
      const pause = pauseAfter('SELECT id FROM mail_accounts WHERE user_id = ? ORDER BY id');
      const pending = caller === 'person' ? alex.request('POST', '/api/settings/clear-mail-accounts', {})
        : admin.request('POST', `/api/admin/users/${users.alex}/clear/mail-accounts`, { current_password: password });
      try {
        await pause.reached();
        await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["mail"]')`, [restore, users.alex]);
        pause.release();
        const reply = await pending;
        assert.deepEqual([caller, reply.status, reply.body.code], [caller, 409, 'RESTORE_IN_PROGRESS'], JSON.stringify(reply.body));
      } finally { pause.restore(); await pending; }
      assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE id = ?', [mail]), 1, `${caller}: the account stays`);
      await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
  });

  // A restored CalDAV calendar of a mail account's address, not linked yet,
  // with its own saved password, while that mail account is disconnected:
  // every server write is refused, and a refusal must leave it as it is.
  async function restoredServerCalendar(address: string) {
    const mail = crypto.randomUUID(), account = crypto.randomUUID(), calendar = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, 'custom', 'download', FALSE, NULL)", [mail, users.alex, address]);
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, base_url, provider_config)
      VALUES (?, ?, 'caldav', ?, TRUE, ?, 'https://caldav.example.test/', '{"mailLinked":true}')`, [account, users.alex, address, secret]);
    await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, ?, ?, 'Restored', 'https://caldav.example.test/calendars/restored/', '#2563eb', TRUE, FALSE, FALSE, TRUE)`, [calendar, users.alex, account]);
    return {
      calendar,
      unchanged: async (what: string) => {
        const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password FROM calendar_accounts WHERE id = ?', [account]);
        assert.deepEqual([what, row.mail_account_id, row.encrypted_password], [what, null, secret], 'still unlinked, with its password');
      },
      remove: async () => {
        await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
        await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
      },
    };
  }

  await fromDefaults('S2b: a refused bin restore to a restored calendar leaves the calendar as it was', async () => {
    const restored = await restoredServerCalendar('bin-restore@example.test');
    const item = crypto.randomUUID(), uid = `${crypto.randomUUID()}@example.test`;
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20300115T100000Z\r\nDTEND:20300115T110000Z\r\nSUMMARY:Synthetic\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const payload = { provider: 'caldav', origin: null, event: { title: 'Synthetic', start_time: '2030-01-15 10:00:00', end_time: '2030-01-15 11:00:00' }, subtasks: [], attendees: [], task_order: [],
      calendar: { id: restored.calendar, account_id: null, external_id: 'https://caldav.example.test/calendars/restored/', name: 'Restored' },
      object: { href: 'https://caldav.example.test/calendars/restored/synthetic.ics', uid, ics }, occurrences: [] };
    await pool.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after)
      VALUES (?, ?, 'calendar', 'event', ?, 'Synthetic', 'deleted', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY)`, [item, users.alex, crypto.randomUUID(), JSON.stringify(payload)]);
    const reply = await alex.request('POST', `/api/bin/${item}/restore`, {});
    assert.deepEqual([reply.status, reply.body.code], [409, 'MAIL_ACCOUNT_DISCONNECTED'], JSON.stringify(reply.body));
    await restored.unchanged('bin restore');
    assert.equal(await count('SELECT COUNT(*) AS count FROM bin_items WHERE id = ? AND restored_at IS NULL', [item]), 1, 'it stays in the bin');
    await pool.execute('DELETE FROM bin_items WHERE id = ?', [item]);
    await restored.remove();
  });

  await fromDefaults('S2c: a refused move to a restored calendar leaves the calendar and the event as they were', async () => {
    const restored = await restoredServerCalendar('move@example.test');
    const local = crypto.randomUUID(), list = crypto.randomUUID(), event = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name) VALUES (?, ?, 'local', 'UniHub')", [local, users.alex]);
    await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, ?, ?, 'Errands', 'local-errands', '#2563eb', TRUE, FALSE, FALSE, FALSE)`, [list, users.alex, local]);
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Synthetic', '2030-01-15 10:00:00', '2030-01-15 11:00:00')", [event, users.alex, list]);
    const reply = await alex.request('POST', `/api/calendar/events/${event}/move`, { calendar_id: restored.calendar });
    assert.deepEqual([reply.status, reply.body.code], [409, 'MAIL_ACCOUNT_DISCONNECTED'], JSON.stringify(reply.body));
    await restored.unchanged('move');
    assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT calendar_id FROM calendar_events WHERE id = ?', [event]))[0].map(row => row.calendar_id), [list], 'the event stays');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [local]);
    await restored.remove();
  });

  // Over one batch (200) of contacts in alex's bin.
  async function fillBin(items: number) {
    const ids = Array.from({ length: items }, () => crypto.randomUUID());
    await pool.query(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after) VALUES ?`,
      [ids.map((id, index) => [id, users.alex, 'contacts', 'contact', crypto.randomUUID(), 'Synthetic contact', 'deleted', '{}', new Date(Date.UTC(2030, 0, 1, 0, 0, index)), new Date(Date.UTC(2030, 1, 1))])]);
    return ids;
  }
  const binLeft = () => count("SELECT COUNT(*) AS count FROM bin_items WHERE user_id = ? AND module = 'contacts'", [users.alex]);

  await fromDefaults('Q1b: emptying the bin refused between batches answers how many items it already deleted', async () => {
    await pool.execute("DELETE FROM bin_items WHERE user_id = ?", [users.alex]);
    await fillBin(250);
    // Held after the second batch's read, once the first batch is gone.
    const pause = pauseAfter('SELECT * FROM bin_items WHERE user_id = ? AND restored_at IS NULL AND module IN', { occurrence: 2 });
    const pending = alex.request('POST', '/api/bin/empty', { module: 'contacts' });
    try {
      await pause.reached();
      await setPolicies({ 'bin.delete': 'forbidden' });
      pause.release();
      const reply = await pending;
      const details = reply.body.details as FixtureValue;
      assert.deepEqual([reply.status, reply.body.code, details?.policy, details?.deleted], [403, 'POLICY_FORBIDS', 'bin.delete', 200]);
    } finally { pause.restore(); await pending; }
    assert.equal(await binLeft(), 50, 'the second batch stays');
    await setPolicies({ 'bin.delete': 'allowed' });
    await pool.execute("DELETE FROM bin_items WHERE user_id = ?", [users.alex]);
  });

  await fromDefaults('Q1b: the administrator\'s emptying records each batch, so a failure on the second leaves the first one\'s count', async () => {
    await pool.execute("DELETE FROM bin_items WHERE user_id = ?", [users.alex]);
    await pool.execute("DELETE FROM audit_log WHERE action = 'admin.bin_emptied'");
    await fillBin(250);
    // The second batch's entry cannot be written: that batch rolls back.
    await pool.query(`CREATE TRIGGER policy_races_second_batch BEFORE INSERT ON audit_log FOR EACH ROW
      BEGIN IF NEW.action = 'admin.bin_emptied' AND (SELECT COUNT(*) FROM audit_log WHERE action = 'admin.bin_emptied') >= 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic audit outage'; END IF; END`);
    try {
      await call(admin, 'POST', `/api/admin/users/${users.alex}/bin/empty`, { module: 'contacts', current_password: password }, 500);
    } finally { await pool.query('DROP TRIGGER policy_races_second_batch'); }
    const [rows] = await pool.query<RowDataPacket[]>("SELECT details FROM audit_log WHERE action = 'admin.bin_emptied' AND target_user_id = ?", [users.alex]);
    const details = rows.map(row => typeof row.details === 'string' ? JSON.parse(row.details) : row.details);
    assert.deepEqual([rows.length, details[0]?.deleted, await binLeft()], [1, 200, 50], 'the entry names what was deleted, and only that');
    await pool.execute("DELETE FROM bin_items WHERE user_id = ?", [users.alex]);
  });

  // Review r3: each destructive step checks again in its final transaction,
  // with current reads, and a restore's admission locks what that check
  // reads (services/final-step.ts, docs/AUTH_ADMIN_SETTINGS.md "Lock order").

  // The restore worker is held after its scan, so a started restore stays
  // queued while the case looks at it; `settle` lets it go on to nothing.
  function holdRestoreWorker() {
    const hold = pauseAfter("WHERE status IN ('uploaded', 'queued')");
    return { restore: hold.restore };
  }
  async function readyBackup() {
    const job = crypto.randomUUID();
    const file = write(path.join(root('backups'), users.alex, `${job}.unihub-backup`), 'synthetic encrypted archive');
    await pool.execute(`INSERT INTO data_export_jobs (id, user_id, status, phase, progress, created_at, completed_at, file_path)
      VALUES (?, ?, 'ready', 'complete', 100, UTC_TIMESTAMP() - INTERVAL 40 DAY, UTC_TIMESTAMP() - INTERVAL 40 DAY, ?)`, [job, users.alex, file]);
    return { job, file };
  }

  await fromDefaults('S1: a restore started from a backup while its deletion runs keeps its source, and the deletion answers 409', async () => {
    // The minimum makes the deletion read the backup again in its transaction (its snapshot then).
    await setPolicies({ 'backup.server_retention_days': 30 });
    const { job, file } = await readyBackup();
    const restore = crypto.randomUUID();
    await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, source_type, source_export_job_id, status, operation, phase, requested_sections, archive_path, validation_result)
      VALUES (?, ?, 'generated', ?, 'failed', 'restore', 'failed', '["contacts"]', ?, '{"valid":true,"errors":[]}')`, [restore, users.alex, job, file]);
    const worker = holdRestoreWorker();
    const pause = pauseAfter('AS deletable_from', { onConnection: true });
    const pending = alex.request('DELETE', `/api/backup/jobs/${job}`);
    try {
      await pause.reached();
      // Retrying the failed restore, committed while the deletion holds the backup's row.
      const started = await alex.request('POST', `/api/backup/restore-jobs/${restore}/start`, {});
      assert.equal(started.status, 202, JSON.stringify(started.body));
      pause.release();
      const reply = await pending;
      assert.equal(reply.status, 409, JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; }
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT status, source_export_job_id, archive_path FROM backup_restore_jobs WHERE id = ?', [restore]);
    assert.deepEqual([row.status, row.source_export_job_id, row.archive_path], ['queued', job, file], 'the restore keeps its source');
    assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE id = ?', [job]), 1);
    assert.ok(fs.existsSync(file), 'and its archive');
    await pool.execute("UPDATE backup_restore_jobs SET status = 'failed' WHERE id = ?", [restore]);
    worker.restore();
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await pool.execute('DELETE FROM data_export_jobs WHERE id = ?', [job]);
    await setPolicies({ 'backup.server_retention_days': null });
  });

  await fromDefaults('S1: a restore created from a backup while its deletion runs waits, then finds the backup gone', async () => {
    await setPolicies({ 'backup.server_retention_days': 30 });
    const { job, file } = await readyBackup();
    const worker = holdRestoreWorker();
    const pause = pauseAfter('AS deletable_from', { onConnection: true });
    const pending = alex.request('DELETE', `/api/backup/jobs/${job}`);
    let created: ReturnType<typeof alex.request> | undefined;
    try {
      await pause.reached();
      created = alex.request('POST', `/api/backup/jobs/${job}/restore`, {});
      // Long enough for an admission that does not wait for the backup's row to commit.
      await new Promise(resolve => setTimeout(resolve, 500));
      pause.release();
      const [deletion, restore] = await Promise.all([pending, created]);
      assert.deepEqual([deletion.status, restore.status], [200, 404], JSON.stringify([deletion.body, restore.body]));
    } finally { pause.restore(); await pending; await created; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM backup_restore_jobs WHERE user_id = ?', [users.alex]), 0, 'no restore without its source');
    assert.equal(fs.existsSync(file), false);
    worker.restore();
    await setPolicies({ 'backup.server_retention_days': null });
  });

  await fromDefaults('Q2: backup.delete forbidden while the person\'s delete runs keeps the backup', async () => {
    await setPolicies({ 'backup.server_retention_days': 30 });
    const { job, file } = await readyBackup();
    // Past the boundary and the early check, before the transaction.
    const pause = pauseAfter('AS deletable_from');
    const pending = alex.request('DELETE', `/api/backup/jobs/${job}`);
    try {
      await pause.reached();
      await setPolicies({ 'backup.delete': 'forbidden' });
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [403, 'POLICY_FORBIDS', 'backup.delete'], JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE id = ?', [job]), 1);
    assert.ok(fs.existsSync(file), 'its archive stays');
    await setPolicies({ 'backup.delete': 'allowed', 'backup.server_retention_days': null });
    await pool.execute('DELETE FROM data_export_jobs WHERE id = ?', [job]);
  });

  await fromDefaults('Q3: a policy of clearing mail forbidden while the clear stops the accounts\' work keeps the accounts', async () => {
    const mail = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, 'clear-policy@example.test', 'custom', 'download', FALSE)", [mail, users.alex]);
    const pause = pauseAfter('SELECT id FROM mail_accounts WHERE user_id = ? ORDER BY id');
    const pending = alex.request('POST', '/api/settings/clear-mail-accounts', {});
    try {
      await pause.reached();
      await setPolicies({ 'accounts.reset': 'forbidden' });
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [403, 'POLICY_FORBIDS', 'accounts.reset'], JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE id = ?', [mail]), 1, 'the account stays');
    await setPolicies({ 'accounts.reset': 'allowed' });
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S2: clearing mail sees a Mail restore committed after its transaction first read', async () => {
    const mail = crypto.randomUUID(), restore = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, 'clear-snapshot@example.test', 'custom', 'download', FALSE)", [mail, users.alex]);
    // In the clear's transaction, once it has read the module switches.
    const pause = pauseAfter('FROM user_settings WHERE user_id = ? AND setting_key = ?', { onConnection: true });
    const pending = alex.request('POST', '/api/settings/clear-mail-accounts', {});
    try {
      await pause.reached();
      await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["mail"]')`, [restore, users.alex]);
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [409, 'RESTORE_IN_PROGRESS'], JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE id = ?', [mail]), 1, 'the account stays');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('Q1: a mail calendar\'s restored account removed meanwhile is not replaced by another restored one', async () => {
    const mail = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, 'two-restored@example.test', 'custom', 'download', FALSE)", [mail, users.alex]);
    for (const [id, created] of [[first, '2030-01-01 00:00:00'], [second, '2030-01-02 00:00:00']]) {
      await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, provider_config, created_at)
        VALUES (?, ?, 'caldav', 'two-restored@example.test', TRUE, ?, '{"mailLinked":true}', ?)`, [id, users.alex, secret, created]);
    }
    // After the request saw the first one, it is removed.
    const pause = pauseAfter('AND LOWER(account_email) = LOWER(?)');
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true });
    try {
      await pause.reached();
      await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [first]);
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [409, 'MAIL_CALENDAR_CHANGED'], JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; }
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password FROM calendar_accounts WHERE id = ?', [second]);
    assert.deepEqual([row.mail_account_id, row.encrypted_password], [null, secret], 'the other one stays unlinked, with its password');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [second]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('Q4: a move\'s version check of a restored calendar\'s event links nothing when it fails or refuses', async () => {
    const caldav = require('../dist/src/services/caldav') as typeof import('../src/services/caldav');
    const calendarSync = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');
    // A connected mail account, and a restored calendar account of its address (not linked yet, its own password).
    const mail = crypto.randomUUID(), account = crypto.randomUUID(), calendar = crypto.randomUUID();
    const local = crypto.randomUUID(), list = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, 'move-etag@example.test', 'custom', 'download', TRUE, ?)",
      [mail, users.alex, encrypt('synthetic-mail-password')]);
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, base_url, provider_config)
      VALUES (?, ?, 'caldav', 'move-etag@example.test', TRUE, ?, 'https://caldav.example.test/', '{"mailLinked":true}')`, [account, users.alex, secret]);
    await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, ?, ?, 'Restored', 'https://caldav.example.test/calendars/restored/', '#2563eb', TRUE, FALSE, FALSE, TRUE)`, [calendar, users.alex, account]);
    await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name) VALUES (?, ?, 'local', 'UniHub')", [local, users.alex]);
    await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, ?, ?, 'Errands', 'local-errands-q4', '#2563eb', TRUE, FALSE, FALSE, FALSE)`, [list, users.alex, local]);
    // One event of it, stored without an ETag.
    const event = crypto.randomUUID(), object = crypto.randomUUID(), uid = `${crypto.randomUUID()}@example.test`;
    const href = '/calendars/restored/synthetic-q4.ics';
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20300115T100000Z\r\nDTEND:20300115T110000Z\r\nSUMMARY:Synthetic\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Synthetic', '2030-01-15 10:00:00', '2030-01-15 11:00:00')", [event, users.alex, calendar]);
    await pool.execute(`INSERT INTO calendar_remote_objects (id, user_id, account_id, calendar_id, href, href_hash, etag, uid, ics) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [object, users.alex, account, calendar, href, crypto.createHash('sha256').update(href).digest('hex'), uid, ics]);
    await pool.execute(`INSERT INTO calendar_event_external_refs (user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, remote_object_id)
      VALUES (?, ?, ?, ?, 'caldav', ?, NULL, ?)`, [users.alex, event, calendar, account, uid, object]);
    const getCalendarObject = caldav.getCalendarObject, inBackground = calendarSync.syncCalendarAccountInBackground;
    (calendarSync as { syncCalendarAccountInBackground: unknown }).syncCalendarAccountInBackground = () => undefined;
    try {
      for (const [what, answer, status, code] of [
        ['the server cannot be read', async () => { throw new Error('synthetic upstream failure'); }, 500, undefined],
        ['the server reports no version', async () => ({ etag: null, ics }), 409, 'CALDAV_CONFLICT'],
      ] as const) {
        (caldav as { getCalendarObject: unknown }).getCalendarObject = answer;
        const reply = await alex.request('POST', `/api/calendar/events/${event}/move`, { calendar_id: list });
        assert.deepEqual([what, reply.status, reply.body.code], [what, status, code], JSON.stringify(reply.body));
        const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password FROM calendar_accounts WHERE id = ?', [account]);
        assert.deepEqual([what, row.mail_account_id, row.encrypted_password], [what, null, secret], 'still unlinked, with its password');
        assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT calendar_id FROM calendar_events WHERE id = ?', [event]))[0].map(entry => entry.calendar_id), [calendar], 'the event stays');
      }
    } finally {
      (caldav as { getCalendarObject: unknown }).getCalendarObject = getCalendarObject;
      (calendarSync as { syncCalendarAccountInBackground: unknown }).syncCalendarAccountInBackground = inBackground;
    }
    await pool.execute('DELETE FROM calendar_accounts WHERE id IN (?, ?)', [account, local]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  // Review r4: a restored calendar's relink, and a mail calendar's address
  // replaced, write only under Calendar's final check (final-step.ts).
  await fromDefaults('S1 r4: a restored calendar is not linked, nor its password dropped, once Calendar is restored or off meanwhile', async () => {
    const calendarAccounts = require('../dist/src/services/calendar-accounts') as typeof import('../src/services/calendar-accounts');
    const calendarSync = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');
    const inBackground = calendarSync.syncCalendarAccountInBackground;
    (calendarSync as { syncCalendarAccountInBackground: unknown }).syncCalendarAccountInBackground = () => undefined;
    try {
      for (const caller of ['person', 'administrator'] as const) {
        for (const late of ['restore', 'module off'] as const) {
          const what = `${caller}, ${late}`;
          const address = `relink-${caller}-${late.replace(' ', '-')}@example.test`;
          const mail = crypto.randomUUID(), calendar = crypto.randomUUID(), restore = crypto.randomUUID();
          const secret = encrypt('synthetic-calendar-password');
          await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, 'custom', 'download', TRUE, ?)",
            [mail, users.alex, address, encrypt('synthetic-mail-password')]);
          await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, provider_config) VALUES (?, ?, 'caldav', ?, TRUE, ?, '{"mailLinked":true}')`,
            [calendar, users.alex, address, secret]);
          // Held once the request has seen the restored calendar, past its early checks.
          const pause = pauseAfter('AND mail_account_id IS NULL AND LOWER(account_email)');
          const pending = caller === 'person'
            ? alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true }).then(reply => ({ status: reply.status, code: reply.body.code }))
            : calendarAccounts.setMailCalendar(users.alex, mail, { enabled: true }, { adminId: users.admin })
              .then(() => ({ status: 200, code: undefined }), (error: FixtureValue) => ({ status: error.status, code: error.code }));
          try {
            await pause.reached();
            if (late === 'restore') await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restore, users.alex]);
            else await call(alex, 'PUT', '/api/modules', { modules: { calendar: { enabled: false } } });
            pause.release();
            const answer = await pending;
            assert.deepEqual([what, answer.status, answer.code], [what, late === 'restore' ? 409 : 403, late === 'restore' ? 'RESTORE_IN_PROGRESS' : 'MODULE_DISABLED']);
          } finally { pause.restore(); await pending; }
          const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password FROM calendar_accounts WHERE id = ?', [calendar]);
          assert.deepEqual([what, row.mail_account_id, row.encrypted_password], [what, null, secret], 'still unlinked, with its password');
          await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
          if (late === 'module off') await call(alex, 'PUT', '/api/modules', { modules: { calendar: { enabled: true } } });
          await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [calendar]);
          await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
        }
      }
    } finally { (calendarSync as { syncCalendarAccountInBackground: unknown }).syncCalendarAccountInBackground = inBackground; }
  });

  await fromDefaults('Q2 r4: a mail calendar\'s new address refused after its discovery leaves the old account and the one it would take over as they were', async () => {
    const caldav = require('../dist/src/services/caldav') as FixtureValue;
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue;
    const address = 'replace-r4@example.test', url = 'https://new.example.test/dav/', oldUrl = 'https://old.example.test/dav/';
    const mail = crypto.randomUUID(), old = crypto.randomUUID(), restored = crypto.randomUUID();
    const secret = encrypt('synthetic-restored-password');
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, 'custom', 'download', TRUE, ?)",
      [mail, users.alex, address, encrypt('synthetic-mail-password')]);
    // The account linked now, at its manual address, and a restored one of the new address.
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, is_active, mail_account_id, base_url, provider_config) VALUES (?, ?, 'caldav', ?, ?, TRUE, ?, ?, ?)`,
      [old, users.alex, address, address, mail, oldUrl, JSON.stringify({ mailLinked: true, server: { url: oldUrl, source: 'manual' } })]);
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, is_active, base_url, encrypted_password, provider_config) VALUES (?, ?, 'caldav', ?, ?, TRUE, ?, ?, ?)`,
      [restored, users.alex, address, address, url, secret, JSON.stringify({ mailLinked: true, server: { url, source: 'manual' } })]);
    const find = caldav.findCalDavServer, reconcile = calendarSync.reconcileCalendarList, inBackground = calendarSync.syncCalendarAccountInBackground;
    let discovering = deferred(), discovered = deferred();
    caldav.findCalDavServer = async () => {
      discovering.resolve(); await discovered.promise;
      return { server: { url, source: 'manual', label: 'Synthetic' }, discovery: { baseUrl: url, principalHref: '/principal/', calendars: [] }, credentialScope: { origin: 'https://new.example.test' } };
    };
    calendarSync.reconcileCalendarList = async () => [];
    calendarSync.syncCalendarAccountInBackground = () => undefined;
    const accountsOf = async () => (await pool.query<RowDataPacket[]>('SELECT id, mail_account_id, encrypted_password FROM calendar_accounts WHERE id IN (?, ?) ORDER BY id', [old, restored]))[0]
      .map(row => [row.id, row.mail_account_id, row.encrypted_password]);
    const before = await accountsOf();
    let pending: ReturnType<typeof alex.request> | undefined;
    try {
      pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: url });
      await within(discovering.promise);
      await setPolicies({ 'accounts.remove': 'forbidden' });
      discovered.resolve();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [403, 'POLICY_FORBIDS', 'accounts.remove'], JSON.stringify(reply.body));
      assert.deepEqual(await accountsOf(), before, 'both accounts as they were');
      // Allowed again, the same change takes the restored one over and removes the old one together.
      await setPolicies({ 'accounts.remove': 'allowed' });
      discovering = deferred(); discovered = deferred(); discovered.resolve();
      await call(alex, 'PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: url });
      assert.deepEqual(await accountsOf(), [[restored, mail, null]], 'taken over, linked, the old one gone');
    } finally {
      discovered.resolve();
      await pending;
      caldav.findCalDavServer = find; calendarSync.reconcileCalendarList = reconcile; calendarSync.syncCalendarAccountInBackground = inBackground;
    }
    await pool.execute('DELETE FROM calendar_accounts WHERE id IN (?, ?)', [old, restored]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  // A restored calendar of a connected mail account's address, not linked yet, with its own password.
  async function restoredUnlinked(address: string) {
    const mail = crypto.randomUUID(), calendar = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, 'custom', 'download', TRUE, ?)",
      [mail, users.alex, address, encrypt('synthetic-mail-password')]);
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, base_url, provider_config)
      VALUES (?, ?, 'caldav', ?, TRUE, ?, 'https://caldav.example.test/', '{"mailLinked":true}')`, [calendar, users.alex, address, secret]);
    return {
      mail, calendar,
      unchanged: async (what: string) => {
        const [[row]] = await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password FROM calendar_accounts WHERE id = ?', [calendar]);
        assert.deepEqual([what, row.mail_account_id, row.encrypted_password], [what, null, secret], 'still unlinked, with its password');
      },
      remove: async () => {
        await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [calendar]);
        await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
      },
    };
  }

  await fromDefaults('r5: reading a mail account\'s calendar shows a restored one as waiting to be linked, and writes nothing', async () => {
    const restored = await restoredUnlinked('read-only-link@example.test');
    const answer = await call(alex, 'GET', `/api/mail/accounts/${restored.mail}/calendar`);
    await restored.unchanged('read');
    assert.deepEqual([answer.calendar.enabled, answer.calendar.link_pending, answer.calendar.account?.id], [true, true, restored.calendar]);
    await call(blair, 'GET', `/api/mail/accounts/${restored.mail}/calendar`, undefined, 404);
    await restored.remove();
  });

  await fromDefaults('r5: a read while a Calendar restore is admitted leaves the restored calendar as it was', async () => {
    const restored = await restoredUnlinked('read-during-restore@example.test');
    const restore = crypto.randomUUID();
    // Held once the read has found the restored calendar, past its early checks.
    const pause = pauseAfter('AND mail_account_id IS NULL AND LOWER(account_email)');
    const pending = alex.request('GET', `/api/mail/accounts/${restored.mail}/calendar`);
    try {
      await pause.reached();
      await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restore, users.alex]);
      pause.release();
      await pending;
    } finally { pause.restore(); await pending; }
    await restored.unchanged('read during a restore');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await restored.remove();
  });

  await fromDefaults('r5: a sync that would link a restored calendar stops when a Calendar restore is admitted under its lock', async () => {
    const caldav = require('../dist/src/services/caldav') as FixtureValue;
    const calendarSync = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');
    const restored = await restoredUnlinked('sync-during-restore@example.test');
    const restore = crypto.randomUUID();
    // No calendar server: a sync that got past its login fails there, which this case does not need.
    const listCalendars = caldav.listCalendars;
    caldav.listCalendars = async () => { throw new Error('synthetic: no calendar server'); };
    // Held at the sync's login, under its account lock and past its gate.
    const pause = pauseAfter('SELECT ca.provider, ca.provider_config, ca.account_email');
    const pending = calendarSync.syncCalendarAccount(restored.calendar, { userId: users.alex }).then(result => result, (error: Error) => ({ error: error.message }));
    try {
      await pause.reached();
      await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restore, users.alex]);
      pause.release();
      assert.deepEqual(await pending, { skipped: true, reason: 'paused' });
    } finally { pause.restore(); await pending; caldav.listCalendars = listCalendars; }
    await restored.unchanged('sync during a restore');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await restored.remove();
  });

  // Review r5: a change acts only on the accounts it saw, and every write of
  // a calendar link, a stored password or an account's removal is checked
  // again where it is written.
  async function mailOf(address: string, username: string | null = null) {
    const id = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, username, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, ?, 'custom', 'download', TRUE, ?)",
      [id, users.alex, address, username, encrypt('synthetic-mail-password')]);
    return id;
  }
  // A mail account's calendar at its manual address, with one event and a subtask of UniHub's own.
  async function linkedAt(mail: string, address: string, url: string) {
    const account = crypto.randomUUID(), calendar = crypto.randomUUID(), event = crypto.randomUUID(), subtask = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, is_active, mail_account_id, base_url, provider_config) VALUES (?, ?, 'caldav', ?, ?, TRUE, ?, ?, ?)`,
      [account, users.alex, address, address, mail, url, JSON.stringify({ mailLinked: true, server: { url, source: 'manual' } })]);
    await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, ?, ?, 'Work', ?, '#2563eb', TRUE, FALSE, FALSE, TRUE)`, [calendar, users.alex, account, `${url}work/`]);
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Synthetic', '2030-01-15 10:00:00', '2030-01-15 11:00:00')", [event, users.alex, calendar]);
    await pool.execute("INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, 'Only step', FALSE, 0)", [subtask, event, users.alex]);
    return { account, event, subtask };
  }
  const linksOf = async (mail: string) => (await pool.query<RowDataPacket[]>('SELECT id FROM calendar_accounts WHERE mail_account_id = ? ORDER BY id', [mail]))[0].map(row => row.id);
  // Discovery answers each address after its own gate opens (none: at once).
  function discoveryHeld() {
    const caldav = require('../dist/src/services/caldav') as FixtureValue;
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue;
    const find = caldav.findCalDavServer, reconcile = calendarSync.reconcileCalendarList, inBackground = calendarSync.syncCalendarAccountInBackground;
    const gates = new Map<string, { reached: ReturnType<typeof deferred>; go: ReturnType<typeof deferred> }>();
    caldav.findCalDavServer = async ({ explicitUrl }: { explicitUrl: string }) => {
      const gate = gates.get(explicitUrl);
      if (gate) { gate.reached.resolve(); await gate.go.promise; }
      return { server: { url: explicitUrl, source: 'manual', label: 'Synthetic' }, discovery: { baseUrl: explicitUrl, principalHref: '/principal/', calendars: [] }, credentialScope: { origin: new URL(explicitUrl).origin } };
    };
    calendarSync.reconcileCalendarList = async () => [];
    calendarSync.syncCalendarAccountInBackground = () => undefined;
    return {
      hold: (url: string) => { const gate = { reached: deferred(), go: deferred() }; gates.set(url, gate); return { reached: () => within(gate.reached.promise), go: () => gate.go.resolve() }; },
      restore: () => { for (const gate of gates.values()) gate.go.resolve(); caldav.findCalDavServer = find; calendarSync.reconcileCalendarList = reconcile; calendarSync.syncCalendarAccountInBackground = inBackground; },
    };
  }

  await fromDefaults('S1 r5: a replacement refuses once another connect took the old calendar over, which keeps its events and subtasks', async () => {
    const address = 'replace-taken@example.test', oldUrl = 'https://old-taken.example.test/dav/', newUrl = 'https://new-taken.example.test/dav/';
    const first = await mailOf(address), second = await mailOf('second-taken@example.test', address);
    const old = await linkedAt(first, address, oldUrl);
    const discovery = discoveryHeld();
    const held = discovery.hold(newUrl);
    let pending: ReturnType<typeof alex.request> | undefined;
    try {
      pending = alex.request('PUT', `/api/mail/accounts/${first}/calendar`, { enabled: true, caldav_url: newUrl });
      await held.reached();
      // The old calendar is moved to the second mail account meanwhile (a
      // change of the person's own waits for this one, person-lock.ts; this
      // is any other writer of the row).
      await pool.execute('UPDATE calendar_accounts SET mail_account_id = ? WHERE id = ?', [second, old.account]);
      held.go();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [409, 'MAIL_CALENDAR_CHANGED'], JSON.stringify(reply.body));
    } finally { discovery.restore(); await pending; }
    assert.deepEqual(await linksOf(second), [old.account], 'still the second mail account\'s calendar');
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_events WHERE id = ?', [old.event]), 1, 'its event stays');
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_event_subtasks WHERE id = ?', [old.subtask]), 1, 'and its subtask');
    assert.deepEqual(await linksOf(first), [], 'nothing was connected for the first one');
    await pool.execute('DELETE FROM calendar_accounts WHERE user_id = ? AND (mail_account_id IN (?, ?) OR account_email = ?)', [users.alex, first, second, address]);
    await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', [first, second]);
  });

  // Review r7: a person's account changes run one at a time (person-lock.ts).
  // Settles within a moment, or false: a request queued behind a held change does not.
  const settlesSoon = (pending: Promise<unknown>, ms = 600) => Promise.race([pending.then(() => true, () => true), new Promise<boolean>(done => setTimeout(() => done(false), ms))]);

  await fromDefaults('r7: of two replacements at once, the later one waits for the earlier one, then replaces its calendar; another person is not held up', async () => {
    const address = 'replace-twice@example.test', oldUrl = 'https://old-twice.example.test/dav/';
    const urls = ['https://one-twice.example.test/dav/', 'https://two-twice.example.test/dav/'];
    const mail = await mailOf(address);
    await linkedAt(mail, address, oldUrl);
    const discovery = discoveryHeld();
    const held = urls.map(url => discovery.hold(url));
    const pending: ReturnType<typeof alex.request>[] = [];
    try {
      pending.push(alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: urls[0] }));
      await held[0].reached();
      pending.push(alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: urls[1] }));
      assert.equal(await settlesSoon(pending[1]), false, 'the later change waits, before it read anything');
      // Blair's own account change goes ahead meanwhile.
      const blairs = await call(blair, 'POST', '/api/calendar/accounts', { provider: 'caldav', account_email: 'blair-own@example.test', username: 'blair-own@example.test',
        password: 'synthetic-blair-password', url: 'https://blair-own.example.test/dav/' });
      assert.ok(blairs.account?.id, 'blair\'s account added while alex\'s change is held');
      held[0].go();
      assert.equal((await pending[0]).status, 200, JSON.stringify((await pending[0]).body));
      await held[1].reached();
      held[1].go();
      const later = await pending[1];
      assert.equal(later.status, 200, JSON.stringify(later.body));
    } finally { discovery.restore(); await Promise.all(pending); }
    const links = await linksOf(mail);
    assert.equal(links.length, 1, 'one calendar linked');
    assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT base_url FROM calendar_accounts WHERE id = ?', [links[0]]))[0].map(row => row.base_url), [urls[1]], 'the later address, which replaced the earlier one');
    await pool.execute('DELETE FROM calendar_accounts WHERE user_id IN (?, ?) AND account_email IN (?, ?)', [users.alex, users.blair, address, 'blair-own@example.test']);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S1 r5: turning a mail calendar off keeps it once another mail account took it over', async () => {
    const address = 'off-taken@example.test', url = 'https://off-taken.example.test/dav/';
    const first = await mailOf(address), second = await mailOf('second-off@example.test', address);
    const old = await linkedAt(first, address, url);
    // Held once the request saw the first one's calendar.
    const pause = pauseAfter('SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC LIMIT 1');
    const pending = alex.request('PUT', `/api/mail/accounts/${first}/calendar`, { enabled: false });
    try {
      await pause.reached();
      await pool.execute('UPDATE calendar_accounts SET mail_account_id = ? WHERE id = ?', [second, old.account]);
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [409, 'MAIL_CALENDAR_CHANGED'], JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; }
    assert.deepEqual(await linksOf(second), [old.account]);
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_event_subtasks WHERE id = ?', [old.subtask]), 1);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', [first, second]);
  });

  await fromDefaults('S2 r5: a sync dropping a link to a deleted mail account changes nothing once a Calendar restore is admitted', async () => {
    const caldav = require('../dist/src/services/caldav') as FixtureValue;
    const calendarSync = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');
    const account = crypto.randomUUID(), restore = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    // Linked to a mail account that no longer exists.
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, is_active, encrypted_password, base_url, mail_account_id, provider_config, sync_status)
      VALUES (?, ?, 'caldav', 'dangling@example.test', TRUE, ?, 'https://caldav.example.test/', ?, '{"mailLinked":true}', 'idle')`, [account, users.alex, secret, crypto.randomUUID()]);
    const rowOf = async () => (await pool.query<RowDataPacket[]>('SELECT mail_account_id, encrypted_password, sync_status, sync_error FROM calendar_accounts WHERE id = ?', [account]))[0][0];
    const before = await rowOf();
    const listCalendars = caldav.listCalendars;
    caldav.listCalendars = async () => { throw new Error('synthetic: no calendar server'); };
    const pause = pauseAfter('SELECT ca.provider, ca.provider_config, ca.account_email');
    const pending = calendarSync.syncCalendarAccount(account, { userId: users.alex }).then(result => result, (error: Error) => ({ error: error.message }));
    try {
      await pause.reached();
      await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restore, users.alex]);
      pause.release();
      assert.deepEqual(await pending, { skipped: true, reason: 'paused' });
    } finally { pause.restore(); await pending; caldav.listCalendars = listCalendars; }
    assert.deepEqual(await rowOf(), before, 'link, password and status as they were');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
  });

  await fromDefaults('Q3 r5: a mail calendar change that waits too long for a lock answers 503 CHANGE_IN_PROGRESS and changes nothing', async () => {
    const address = 'lock-wait@example.test', url = 'https://lock-wait.example.test/dav/';
    const mail = await mailOf(address);
    const linked = await linkedAt(mail, address, url);
    await pool.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('policy_revision', '0') ON DUPLICATE KEY UPDATE setting_key = setting_key");
    // Another change holds the rules revision row.
    const blocker = await pool.getConnection();
    await blocker.beginTransaction();
    await blocker.query("SELECT setting_value FROM system_settings WHERE setting_key = 'policy_revision' FOR UPDATE");
    // The app's transactions wait one second here, not fifty.
    const getConnection = pool.getConnection;
    pool.getConnection = async function (this: typeof pool) {
      const cx = await getConnection.call(this) as PoolConnection;
      await cx.query('SET SESSION innodb_lock_wait_timeout = 1');
      const release = cx.release;
      cx.release = function (this: PoolConnection) {
        cx.release = release;
        void cx.query('SET SESSION innodb_lock_wait_timeout = 50').finally(() => release.call(cx));
      };
      return cx;
    } as typeof pool.getConnection;
    try {
      const reply = await alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: false });
      assert.deepEqual([reply.status, reply.body.code], [503, 'CHANGE_IN_PROGRESS'], JSON.stringify(reply.body));
    } finally {
      pool.getConnection = getConnection;
      await blocker.rollback();
      blocker.release();
    }
    assert.deepEqual(await linksOf(mail), [linked.account], 'the calendar stays');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [linked.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('sweep r5: a calendar account\'s new password is not saved once a Calendar restore is admitted', async () => {
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue;
    const account = crypto.randomUUID(), restore = crypto.randomUUID();
    const secret = encrypt('synthetic-calendar-password');
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, is_active, encrypted_password, base_url, provider_config)
      VALUES (?, ?, 'caldav', 'own-login@example.test', 'own-login', FALSE, ?, 'https://caldav.example.test/', '{}')`, [account, users.alex, secret]);
    const inBackground = calendarSync.syncCalendarAccountInBackground;
    calendarSync.syncCalendarAccountInBackground = () => undefined;
    const pause = pauseAfter('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?');
    const pending = alex.request('PUT', `/api/calendar/accounts/${account}`, { password: 'synthetic-new-password' });
    try {
      await pause.reached();
      await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restore, users.alex]);
      pause.release();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [409, 'RESTORE_IN_PROGRESS'], JSON.stringify(reply.body));
    } finally { pause.restore(); await pending; calendarSync.syncCalendarAccountInBackground = inBackground; }
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT encrypted_password, is_active FROM calendar_accounts WHERE id = ?', [account]);
    assert.deepEqual([row.encrypted_password, Number(row.is_active)], [secret, 0], 'its password and pause as they were');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
  });

  await fromDefaults('sweep r5: a mail account is neither changed nor added once a Mail restore is admitted', async () => {
    const mail = await mailOf('settings-change@example.test');
    for (const what of ['change', 'add'] as const) {
      const restore = crypto.randomUUID();
      const mailService = require('../dist/src/services/mail') as FixtureValue;
      const testImap = mailService.testImapConnection, hostPolicy = mailService.validateMailHostPolicy;
      const reached = deferred(), go = deferred();
      // A change is held after it read the account; an addition at its login test, which succeeds.
      const pause = what === 'change' ? pauseAfter('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?') : null;
      // The synthetic hosts do not resolve: the host policy and the login test answer here.
      if (what === 'add') {
        mailService.validateMailHostPolicy = async () => ({});
        mailService.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
      }
      const before = await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE user_id = ?', [users.alex]);
      const pending = what === 'change'
        ? alex.request('PUT', `/api/mail/accounts/${mail}`, { display_name: 'Changed meanwhile' })
        : alex.request('POST', '/api/mail/accounts', { email_address: 'added-meanwhile@mail.example.test', provider: 'custom', encrypted_password: 'synthetic-mail-password',
          imap_host: 'imap.mail.example.test', imap_port: 993, smtp_host: 'smtp.mail.example.test', smtp_port: 465 });
      try {
        if (pause) await pause.reached(); else await within(reached.promise);
        await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["mail"]')`, [restore, users.alex]);
        if (pause) pause.release(); else go.resolve();
        const reply = await pending;
        assert.deepEqual([what, reply.status, reply.body.code], [what, 409, 'RESTORE_IN_PROGRESS'], JSON.stringify(reply.body));
      } finally { pause?.restore(); go.resolve(); mailService.testImapConnection = testImap; mailService.validateMailHostPolicy = hostPolicy; await pending; }
      assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE user_id = ?', [users.alex]), before, `${what}: no account added`);
      assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT display_name FROM mail_accounts WHERE id = ?', [mail]))[0].map(row => row.display_name), [null], `${what}: unchanged`);
      await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    }
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  // Review r6: a change carries the snapshot of each account it chose
  // (account-identity.ts) and compares it under the row's lock: another
  // writer that changed the account meanwhile makes it refuse with 409
  // ACCOUNT_CHANGED, and what that writer saved stays. A change of the
  // person's own waits instead (person-lock.ts, the r7 cases), so the
  // other writer here writes the row itself.
  const newLogin = (id: string, login: string) => pool.execute('UPDATE calendar_accounts SET username = ?, encrypted_password = ? WHERE id = ?', [login, encrypt('synthetic-new-password'), id]);
  const rowOf = async (table: 'calendar_accounts' | 'mail_accounts', id: string) => (await pool.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE id = ?`, [id]))[0][0];
  const refusedChanged = (reply: { status: number; body: FixtureValue }, what = '') => assert.deepEqual([what, reply.status, reply.body.code], [what, 409, 'ACCOUNT_CHANGED'], JSON.stringify(reply.body));
  // A standalone CalDAV account at `url` with login `login` and its own password.
  async function standaloneAt(url: string, login: string, address = `${login}@standalone.example.test`) {
    const id = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, encrypted_password, base_url, is_active, provider_config)
      VALUES (?, ?, 'caldav', ?, ?, ?, ?, TRUE, '{}')`, [id, users.alex, address, login, encrypt('synthetic-original-password'), url]);
    return id;
  }
  const mailServiceOf = () => require('../dist/src/services/mail') as FixtureValue;

  await fromDefaults('r6: a takeover refuses once the account it found got a new login and password, which stay', async () => {
    const url = 'https://takeover-r6.example.test/dav/', login = 'old-login-r6';
    const mail = await mailOf('takeover-r6@example.test', login), account = await standaloneAt(url, login);
    const discovery = discoveryHeld();
    // Held once the connect found the account by server and login.
    const pause = pauseAfter('WHERE ca.user_id = ? AND ca.provider = ? AND ca.base_url = ?');
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: url });
    try {
      await pause.reached();
      await newLogin(account, 'new-login-r6');
      pause.release();
      refusedChanged(await pending);
    } finally { pause.restore(); await pending; discovery.restore(); }
    const row = await rowOf('calendar_accounts', account);
    assert.deepEqual([row.username, row.mail_account_id], ['new-login-r6', null]);
    assert.ok(row.encrypted_password, 'its new password stays');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r6: a takeover refuses once the mail account whose login found it changed its login', async () => {
    const url = 'https://mail-drift-r6.example.test/dav/', login = 'old-mail-login-r6';
    const mail = await mailOf('mail-drift-r6@example.test', login), account = await standaloneAt(url, login);
    const before = await rowOf('calendar_accounts', account);
    const discovery = discoveryHeld();
    const pause = pauseAfter('WHERE ca.user_id = ? AND ca.provider = ? AND ca.base_url = ?');
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: url });
    try {
      await pause.reached();
      await pool.execute('UPDATE mail_accounts SET username = ?, encrypted_password = ? WHERE id = ?', ['new-mail-login-r6', encrypt('synthetic-new-mail-password'), mail]);
      pause.release();
      refusedChanged(await pending);
    } finally { pause.restore(); await pending; discovery.restore(); }
    const row = await rowOf('calendar_accounts', account);
    assert.deepEqual([row.username, row.encrypted_password, row.mail_account_id], [before.username, before.encrypted_password, null], 'the old login\'s calendar as it was');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r6: turning a mail calendar off keeps a restored one whose login changed meanwhile, with its events', async () => {
    const address = 'off-r6@example.test', url = 'https://off-r6.example.test/dav/';
    const mail = await mailOf(address), old = await linkedAt(mail, address, url);
    await pool.execute('UPDATE calendar_accounts SET mail_account_id = NULL, encrypted_password = ? WHERE id = ?', [encrypt('synthetic-original-password'), old.account]);
    const discovery = discoveryHeld();
    const pause = pauseAfter("provider IN ('caldav', 'ics') AND mail_account_id IS NULL");
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: false });
    try {
      await pause.reached();
      await newLogin(old.account, 'new-off-login-r6');
      pause.release();
      refusedChanged(await pending);
    } finally { pause.restore(); await pending; discovery.restore(); }
    assert.equal((await rowOf('calendar_accounts', old.account)).username, 'new-off-login-r6');
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_event_subtasks WHERE id = ?', [old.subtask]), 1, 'its subtask stays');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r6: a replacement refuses once the account it replaces was changed meanwhile', async () => {
    const address = 'replace-drift-r6@example.test', oldUrl = 'https://old-drift-r6.example.test/dav/', newUrl = 'https://new-drift-r6.example.test/dav/';
    const mail = await mailOf(address), old = await linkedAt(mail, address, oldUrl);
    const discovery = discoveryHeld();
    const held = discovery.hold(newUrl);
    let pending: ReturnType<typeof alex.request> | undefined;
    try {
      pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled: true, caldav_url: newUrl });
      await held.reached();
      // Another request found its server again meanwhile.
      await pool.execute("UPDATE calendar_accounts SET discovery_url = 'https://old-drift-r6.example.test/.well-known/caldav' WHERE id = ?", [old.account]);
      held.go();
      refusedChanged(await pending);
    } finally { discovery.restore(); await pending; }
    assert.deepEqual(await linksOf(mail), [old.account], 'the old one stays linked');
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_event_subtasks WHERE id = ?', [old.subtask]), 1);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r6: linking a restored calendar refuses once it got a new login and password, which stay', async () => {
    const restored = await restoredUnlinked('relink-drift-r6@example.test');
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue, inBackground = calendarSync.syncCalendarAccountInBackground;
    calendarSync.syncCalendarAccountInBackground = () => undefined;
    const pause = pauseAfter('AND mail_account_id IS NULL AND LOWER(account_email)');
    const pending = alex.request('PUT', `/api/mail/accounts/${restored.mail}/calendar`, { enabled: true });
    try {
      await pause.reached();
      await newLogin(restored.calendar, 'new-relink-login');
      pause.release();
      refusedChanged(await pending);
    } finally { pause.restore(); await pending; calendarSync.syncCalendarAccountInBackground = inBackground; }
    const row = await rowOf('calendar_accounts', restored.calendar);
    assert.deepEqual([row.username, row.mail_account_id], ['new-relink-login', null]);
    assert.ok(row.encrypted_password, 'its new password stays');
    await restored.remove();
  });

  await fromDefaults('r6: a calendar account\'s stale change, or its removal, refuses once another one changed its login', async () => {
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue, inBackground = calendarSync.syncCalendarAccountInBackground;
    calendarSync.syncCalendarAccountInBackground = () => undefined;
    try {
      for (const stale of ['change', 'removal'] as const) {
        const account = await standaloneAt(`https://stale-${stale}-r6.example.test/dav/`, `stale-${stale}`);
        // The stale request is held after it read the account; the other one reads it next and saves.
        const pause = pauseAfter('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?');
        const pending = stale === 'change' ? alex.request('PUT', `/api/calendar/accounts/${account}`, { display_name: 'Stale name' })
          : alex.request('DELETE', `/api/calendar/accounts/${account}`);
        try {
          await pause.reached();
          await newLogin(account, `newer-${stale}`);
          pause.release();
          refusedChanged(await pending, stale);
        } finally { pause.restore(); await pending; }
        const row = await rowOf('calendar_accounts', account);
        assert.deepEqual([stale, row?.username, row?.display_name ?? null], [stale, `newer-${stale}`, null], 'the newer change stays, the stale one did nothing');
        await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
      }
    } finally { calendarSync.syncCalendarAccountInBackground = inBackground; }
  });

  await fromDefaults('r6: a mail account\'s change refuses once another writer changed the account while it tested the login', async () => {
    const mail = await mailOf('mail-stale-r6@example.test', 'stale-mail-login');
    const before = await rowOf('mail_accounts', mail);
    const mailService = mailServiceOf(), testImap = mailService.testImapConnection;
    const reached = deferred(), go = deferred();
    mailService.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}`, { encrypted_password: 'synthetic-new-password' });
    try {
      await within(reached.promise);
      await pool.execute("UPDATE mail_accounts SET imap_host = 'imap.moved.example.test' WHERE id = ?", [mail]);
      go.resolve();
      refusedChanged(await pending);
    } finally { go.resolve(); await pending; mailService.testImapConnection = testImap; }
    const row = await rowOf('mail_accounts', mail);
    assert.deepEqual([row.encrypted_password, row.imap_host], [before.encrypted_password, 'imap.moved.example.test'], 'its password as it was');
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r6: deleting a folder at the provider refuses once its account changed while it connected', async () => {
    const { deleteMailFolder } = require('../dist/src/services/mail-folder-delete') as typeof import('../src/services/mail-folder-delete');
    const mail = await mailOf('folder-r6@example.test'), folder = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, mail_account_id) VALUES (?, ?, 'projects-r6', 'Projects', FALSE, ?)", [folder, users.alex, mail]);
    await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name) VALUES (?, ?, 'Projects')", [folder, mail]);
    const deleted: string[] = [];
    const connecting = deferred(), connected = deferred();
    const outcome = deleteMailFolder({ userId: users.alex, slug: 'projects-r6', server: true }, {
      connect: async () => { connecting.resolve(); await connected.promise;
        return (require('../dist/src/services/mail-imap-guard') as FixtureValue).guardImapConnection({ on() {}, close() {}, ...folderServer({ Projects: 1 }),
          mailboxDelete: async (name: string) => { deleted.push(name); } }); },
    }).then(() => null, (error: FixtureValue) => error.code);
    try {
      await within(connecting.promise);
      await pool.execute("UPDATE mail_accounts SET username = 'changed-meanwhile' WHERE id = ?", [mail]);
      connected.resolve();
      assert.equal(await outcome, 'ACCOUNT_CHANGED');
    } finally { connected.resolve(); await outcome; }
    assert.deepEqual(deleted, [], 'nothing deleted at the provider');
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folders WHERE id = ?', [folder]), 1);
    await pool.execute('DELETE FROM mail_folders WHERE id = ?', [folder]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r6: purging a mail account refuses once its address no longer matches the one typed', async () => {
    const address = 'purge-r6@example.test', mail = await mailOf(address);
    await pool.execute('UPDATE mail_accounts SET is_active = FALSE, disconnected_at = UTC_TIMESTAMP(), encrypted_password = NULL WHERE id = ?', [mail]);
    // Held after the typed address was checked against it.
    const pause = pauseAfter('SELECT id, email_address FROM mail_accounts WHERE id = ? AND user_id = ?');
    const pending = alex.request('DELETE', `/api/mail/accounts/${mail}?purge=true&confirm_purge=${encodeURIComponent(address)}`);
    try {
      await pause.reached();
      await pool.execute("UPDATE mail_accounts SET email_address = 'renamed-r6@example.test' WHERE id = ?", [mail]);
      pause.release();
      refusedChanged(await pending);
    } finally { pause.restore(); await pending; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE id = ?', [mail]), 1, 'the account stays');
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S3 r6: a mode forced, or deletion required, while a new account logs in refuses it', async () => {
    const mailService = mailServiceOf();
    const testImap = mailService.testImapConnection, hostPolicy = mailService.validateMailHostPolicy, schedule = mailService.scheduleMailAccountSync;
    mailService.validateMailHostPolicy = async () => ({});
    mailService.scheduleMailAccountSync = async () => ({ started: false, alreadyRunning: false, promise: Promise.resolve({ success: true }) });
    try {
      for (const [index, [values, key]] of ([[{ 'mail.mode.new_accounts': 'sync' }, 'mail.mode.new_accounts'], [{ 'mail.provider_delete': 'required' }, 'mail.provider_delete']] as const).entries()) {
        await pool.query("DELETE FROM setting_policies WHERE target_kind = 'installation'");
        const address = `forced-r6-${index}@example.test`, reached = deferred(), go = deferred();
        mailService.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
        const pending = alex.request('POST', '/api/mail/accounts', { email_address: address, provider: 'custom', encrypted_password: 'synthetic-password', imap_host: 'imap.example.test',
          imap_port: 993, smtp_host: 'smtp.example.test', smtp_port: 465, sync_mode: 'download', delete_emails_on_server: false, try_calendar_sync: false });
        try {
          await within(reached.promise);
          await setPolicies(values);
          go.resolve();
          const reply = await pending;
          assert.deepEqual([reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [403, 'POLICY_FORBIDS', key], JSON.stringify(reply.body));
        } finally { go.resolve(); await pending; }
        assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE email_address = ?', [address]), 0, `${key}: nothing stored`);
      }
    } finally { mailService.testImapConnection = testImap; mailService.validateMailHostPolicy = hostPolicy; mailService.scheduleMailAccountSync = schedule; }
  });

  await fromDefaults('Q1 r6: a password change refused by a Mail restore admitted meanwhile answers RESTORE_IN_PROGRESS and leaves the restore\'s pause', async () => {
    const mail = await mailOf('restore-error-r6@example.test'), restore = crypto.randomUUID();
    const mailService = mailServiceOf(), testImap = mailService.testImapConnection;
    const reached = deferred(), go = deferred();
    mailService.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
    const before = await rowOf('mail_accounts', mail);
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}`, { encrypted_password: 'synthetic-new-password' });
    try {
      await within(reached.promise);
      await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["mail"]')`, [restore, users.alex]);
      // The pause a restore writes when it starts restoring mail.
      await (require('../dist/src/services/backup-mail-engine') as FixtureValue).pauseMailRestore(pool, users.alex);
      go.resolve();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [409, 'RESTORE_IN_PROGRESS'], JSON.stringify(reply.body));
    } finally { go.resolve(); await pending; mailService.testImapConnection = testImap; }
    const row = await rowOf('mail_accounts', mail);
    assert.deepEqual([row.encrypted_password, Number(row.is_active)], [before.encrypted_password, 0], 'its password as it was, paused by the restore');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  // Review r7: a person's account changes run one at a time (person-lock.ts).
  // Each case holds one change where it waited before and starts another of
  // the same person's there: the later one waits until the earlier one has
  // answered, so it never acts on what the earlier one read and then changed.
  const mailStubbed = () => {
    const svc = mailServiceOf(), saved = { testImapConnection: svc.testImapConnection, validateMailHostPolicy: svc.validateMailHostPolicy, scheduleMailAccountSync: svc.scheduleMailAccountSync };
    svc.testImapConnection = async () => ({ success: true });
    svc.validateMailHostPolicy = async () => ({});
    svc.scheduleMailAccountSync = async () => ({ started: false, alreadyRunning: false, promise: Promise.resolve({ success: true }) });
    return { svc, restore: () => Object.assign(svc, saved) };
  };
  // The hold reached, or the answer that came instead, as the failure.
  const reachedBefore = async (reached: Promise<unknown>, answer: Promise<unknown>) => {
    const first = await within(Promise.race([reached.then(() => ({ reached: true })), answer.then(value => ({ answered: value }), error => ({ answered: String(error) }))]));
    if (!('reached' in first)) assert.fail(`answered before its hold: ${JSON.stringify((first as { answered: unknown }).answered)}`);
  };
  const waits = async (pending: Promise<unknown>, what: string) => assert.equal(await settlesSoon(pending), false, `${what} waits for the change in progress`);

  await fromDefaults('S1 r7: a takeover found through another mail account\'s login commits before that account\'s login change, which waits', async () => {
    const url = 'https://joined-r7.example.test/dav/', login = 'original-login-r7';
    const source = await mailOf('source-r7@example.test', login), target = await mailOf('target-r7@example.test', login);
    const old = await linkedAt(source, 'source-r7@example.test', url);
    const discovery = discoveryHeld(), stubs = mailStubbed();
    // Held once the takeover chose the calendar by the source's login.
    const pause = pauseAfter('SELECT ca.* FROM calendar_accounts ca');
    const pending = alex.request('PUT', `/api/mail/accounts/${target}/calendar`, { enabled: true, caldav_url: url });
    let change: ReturnType<typeof alex.request> | undefined;
    try {
      await pause.reached();
      change = alex.request('PUT', `/api/mail/accounts/${source}`, { username: 'different-login-r7', encrypted_password: 'synthetic-new-password' });
      await waits(change, 'the source\'s login change');
      pause.release();
      const reply = await pending;
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal((await change).status, 200, JSON.stringify((await change).body));
    } finally { pause.restore(); await pending; await change; discovery.restore(); stubs.restore(); }
    // The takeover acted on the login it was found by; that login changed only afterwards.
    assert.equal((await rowOf('calendar_accounts', old.account)).mail_account_id, target);
    assert.equal((await rowOf('mail_accounts', source)).username, 'different-login-r7');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', [source, target]);
  });

  await fromDefaults('S2 r7: linking, or turning off, a restored calendar found by its mail address commits before that address changes, which waits', async () => {
    for (const enabled of [true, false]) {
      const address = `relink-${enabled}-r7@example.test`, mail = await mailOf(address), old = await linkedAt(mail, address, `https://relink-${enabled}-r7.example.test/dav/`);
      await pool.execute('UPDATE calendar_accounts SET mail_account_id = NULL, encrypted_password = ? WHERE id = ?', [encrypt('synthetic-standalone-password'), old.account]);
      const discovery = discoveryHeld(), stubs = mailStubbed();
      // Held once the restored calendar was found by the mail account's address.
      const pause = pauseAfter("provider IN ('caldav', 'ics') AND mail_account_id IS NULL");
      const pending = alex.request('PUT', `/api/mail/accounts/${mail}/calendar`, { enabled });
      let change: ReturnType<typeof alex.request> | undefined;
      try {
        await pause.reached();
        change = alex.request('PUT', `/api/mail/accounts/${mail}`, { email_address: `changed-${enabled}-r7@example.test`, username: `changed-${enabled}-r7`, encrypted_password: 'synthetic-new-password' });
        await waits(change, 'the address change');
        pause.release();
        assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
        assert.equal((await change).status, 200, JSON.stringify((await change).body));
      } finally { pause.restore(); await pending; await change; discovery.restore(); stubs.restore(); }
      const row = await rowOf('calendar_accounts', old.account);
      if (enabled) assert.deepEqual([row?.mail_account_id, row?.encrypted_password], [mail, null], 'linked while it was this address\'s calendar');
      else assert.equal(row, undefined, 'removed while it was this address\'s calendar');
      assert.equal((await rowOf('mail_accounts', mail)).email_address, `changed-${enabled}-r7@example.test`);
      await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
  });

  await fromDefaults('S2 r7: a new mail account\'s calendar setup commits before a change of that account, which waits', async () => {
    const stubs = mailStubbed();
    const url = 'https://optional-drift-r7.example.test/dav/', address = 'optional-drift-r7@example.test', standalone = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, encrypted_password, base_url, is_active, provider_config) VALUES (?, ?, 'caldav', 'standalone-r7@example.test', ?, ?, ?, TRUE, '{}')",
      [standalone, users.alex, address, encrypt('synthetic-standalone-password'), url]);
    const discovery = discoveryHeld(), hold = discovery.hold(url);
    const pending = alex.request('POST', '/api/mail/accounts', { provider: 'custom', email_address: address, username: address, encrypted_password: 'synthetic-password', imap_host: 'imap.example.test',
      imap_port: 993, smtp_host: 'smtp.example.test', smtp_port: 465, try_calendar_sync: true, caldav_url: url });
    let mail: string | undefined, change: ReturnType<typeof alex.request> | undefined;
    try {
      await hold.reached();
      // Already stored, and visible, while its calendar is found.
      mail = (await pool.query<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE user_id = ? AND email_address = ?', [users.alex, address]))[0][0].id;
      change = alex.request('PUT', `/api/mail/accounts/${mail}`, { username: 'changed-optional-r7', encrypted_password: 'synthetic-new-password' });
      await waits(change, 'the new account\'s change');
      hold.go();
      const reply = await pending;
      assert.deepEqual([reply.status, (reply.body.calendarSync as FixtureValue)?.success], [200, true], JSON.stringify(reply.body));
      assert.equal((await change).status, 200, JSON.stringify((await change).body));
    } finally { hold.go(); await pending; await change; discovery.restore(); stubs.restore(); }
    assert.equal((await rowOf('calendar_accounts', standalone)).mail_account_id, mail, 'taken over with the login it was found by');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [standalone]);
    if (mail) await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S2 r7: removing a linked calendar account commits before its mail account\'s login change, which waits', async () => {
    const mail = await mailOf('delete-linked-r7@example.test'), old = await linkedAt(mail, 'delete-linked-r7@example.test', 'https://delete-linked-r7.example.test/dav/');
    const discovery = discoveryHeld(), stubs = mailStubbed();
    const pause = pauseAfter('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?');
    const pending = alex.request('DELETE', `/api/calendar/accounts/${old.account}`);
    let change: ReturnType<typeof alex.request> | undefined;
    try {
      await pause.reached();
      change = alex.request('PUT', `/api/mail/accounts/${mail}`, { username: 'changed-direct-r7', encrypted_password: 'synthetic-new-password' });
      await waits(change, 'the mail login change');
      pause.release();
      assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
      assert.equal((await change).status, 200, JSON.stringify((await change).body));
    } finally { pause.restore(); await pending; await change; discovery.restore(); stubs.restore(); }
    assert.equal((await rowOf('mail_accounts', mail)).username, 'changed-direct-r7');
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S3 r7: a calendar account paused while an older password save waits stays paused', async () => {
    const account = await standaloneAt('https://pause-r7.example.test/dav/', 'pause-r7');
    const discovery = discoveryHeld();
    const pause = pauseAfter('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?');
    const pending = alex.request('PUT', `/api/calendar/accounts/${account}`, { password: 'synthetic-new-password' });
    let paused: ReturnType<typeof alex.request> | undefined;
    try {
      await pause.reached();
      paused = alex.request('PUT', `/api/calendar/accounts/${account}`, { is_active: false });
      await waits(paused, 'the pause');
      pause.release();
      assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
      assert.equal((await paused).status, 200, JSON.stringify((await paused).body));
    } finally { pause.restore(); await pending; await paused; discovery.restore(); }
    assert.equal(Number((await rowOf('calendar_accounts', account)).is_active), 0, 'the later pause stays');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
  });

  await fromDefaults('S4 r7: a disconnect commits before a new login and password are saved, which wait and stay', async () => {
    const mail = await mailOf('stale-disconnect-r7@example.test'), stubs = mailStubbed();
    // Held once the disconnect read the account.
    const pause = pauseAfter('FROM mail_accounts WHERE id = ? AND user_id = ?');
    const pending = alex.request('DELETE', `/api/mail/accounts/${mail}`);
    let change: ReturnType<typeof alex.request> | undefined;
    try {
      await pause.reached();
      change = alex.request('PUT', `/api/mail/accounts/${mail}`, { encrypted_password: 'synthetic-new-password', username: 'newer-disconnect-r7' });
      await waits(change, 'the new login');
      pause.release();
      assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
      await change;
    } finally { pause.restore(); await pending; await change; stubs.restore(); }
    // Saved after the disconnect: the account keeps it (a disconnected account waits for a reconnect).
    const row = await rowOf('mail_accounts', mail);
    assert.deepEqual([row.username, Boolean(row.encrypted_password)], ['newer-disconnect-r7', true], JSON.stringify((await change!).body));
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S5 r7: accounts.add forbidden during discovery refuses a remote calendar account, standalone or with a new mail account', async () => {
    const stubs = mailStubbed();
    try {
      for (const mode of ['standalone', 'subscription', 'optional'] as const) {
        await pool.query("DELETE FROM setting_policies WHERE target_kind = 'installation'");
        const discovery = discoveryHeld(), url = `https://${mode}-add-r7.example.test/dav/`, address = `${mode}-add-r7@example.test`;
        const caldav = require('../dist/src/services/caldav') as FixtureValue, fetchIcs = caldav.fetchIcsFeed, validate = caldav.validateDavUrlPolicy;
        const feed = { reached: deferred(), go: deferred() };
        caldav.fetchIcsFeed = async () => { feed.reached.resolve(); await feed.go.promise; return { text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', etag: null }; };
        caldav.validateDavUrlPolicy = async () => ({});
        const hold = mode === 'subscription' ? { reached: () => within(feed.reached.promise), go: () => feed.go.resolve() } : discovery.hold(url);
        const pending = mode === 'standalone' ? alex.request('POST', '/api/calendar/accounts', { provider: 'caldav', account_email: address, username: address, password: 'synthetic-password', url })
          : mode === 'subscription' ? alex.request('POST', '/api/calendar/accounts', { provider: 'ics', url: `https://${mode}-add-r7.example.test/feed.ics` })
          : alex.request('POST', '/api/mail/accounts', { provider: 'custom', email_address: address, encrypted_password: 'synthetic-password', imap_host: 'imap.example.test', imap_port: 993,
            smtp_host: 'smtp.example.test', smtp_port: 465, try_calendar_sync: true, caldav_url: url });
        try {
          await hold.reached();
          await setPolicies({ 'accounts.add': 'forbidden' });
          hold.go();
          const reply = await pending;
          if (mode === 'optional') {
            const setup = reply.body.calendarSync as FixtureValue;
            assert.deepEqual([reply.status, setup?.success, setup?.code], [200, false, 'POLICY_FORBIDS'], JSON.stringify(reply.body));
          } else {
            assert.deepEqual([mode, reply.status, reply.body.code, (reply.body.details as FixtureValue)?.policy], [mode, 403, 'POLICY_FORBIDS', 'accounts.add'], JSON.stringify(reply.body));
          }
        } finally { hold.go(); await pending; discovery.restore(); caldav.fetchIcsFeed = fetchIcs; caldav.validateDavUrlPolicy = validate; }
        assert.equal(await count("SELECT COUNT(*) AS count FROM calendar_accounts WHERE user_id = ? AND (account_email = ? OR discovery_url LIKE ?)", [users.alex, address, `https://${mode}-add-r7.%`]), 0, `${mode}: no calendar account`);
        await pool.execute('DELETE FROM mail_accounts WHERE user_id = ? AND email_address = ?', [users.alex, address]);
      }
    } finally { stubs.restore(); }
  });

  await fromDefaults('S6 r7: a disconnect, a mail clear or a deletion of the person refused after it stopped the mail work puts the work back as it was', async () => {
    const runtime = require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime');
    // A person of this case's own, whose deletion this may be.
    users.dana = crypto.randomUUID();
    await pool.execute("INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, 'dana@example.test', ?, 'dana', 'user')", [users.dana, passwordHash]);
    const dana = await signIn('dana');
    const cases: [string, string, string, (mail: string) => ReturnType<typeof alex.request>][] = [
      ['disconnect', users.alex, 'accounts.remove', mail => alex.request('DELETE', `/api/mail/accounts/${mail}`)],
      ['mail clear', users.alex, 'data.clear', () => alex.request('POST', '/api/settings/clear-mail-accounts', {})],
      ['deleting the person', users.dana, 'account.delete', () => dana.request('DELETE', '/api/settings/account', { current_password: password })],
    ];
    for (const [what, owner, policy, request] of cases) {
      await pool.query("DELETE FROM setting_policies WHERE target_kind = 'installation'");
      const mail = crypto.randomUUID();
      await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, encrypted_password) VALUES (?, ?, ?, 'custom', 'download', TRUE, ?)",
        [mail, owner, `${what.replace(/ /g, '-')}-r7@example.test`, encrypt('synthetic-mail-password')]);
      const job = await runtime.enqueueJob({ userId: owner, accountId: mail, kind: 'sync' });
      // Held once the change paused the account's mail work.
      const pause = pauseAfter('INSERT INTO mail_engine_accounts (mail_account_id,user_id,paused_reason)');
      const pending = request(mail);
      try {
        await pause.reached();
        await setPolicies({ [policy]: 'forbidden' });
        pause.release();
        const reply = await pending;
        assert.deepEqual([what, reply.status, reply.body.code], [what, 403, 'POLICY_FORBIDS'], JSON.stringify(reply.body));
      } finally { pause.restore(); await pending; }
      const [[account]] = await pool.query<RowDataPacket[]>('SELECT is_active, encrypted_password FROM mail_accounts WHERE id = ?', [mail]);
      const [[engine]] = await pool.query<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ?', [mail]);
      const [[queued]] = await pool.query<RowDataPacket[]>('SELECT state FROM mail_engine_jobs WHERE id = ?', [job.id]);
      assert.deepEqual([what, Number(account.is_active), Boolean(account.encrypted_password), engine?.paused_reason ?? null], [what, 1, true, null], 'connected, and its work no longer paused');
      assert.notEqual(queued.state, 'paused', `${what}: its sync goes on`);
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
    await pool.execute('DELETE FROM users WHERE id = ?', [users.dana]);
    delete users.dana;
  });

  await fromDefaults('S6 r7: a refused settings change leaves the pause of a Mail module switched off meanwhile', async () => {
    const mail = await mailOf('module-pause-r7@example.test');
    const svc = mailServiceOf(), testImap = svc.testImapConnection;
    const reached = deferred(), go = deferred();
    svc.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
    const pending = alex.request('PUT', `/api/mail/accounts/${mail}`, { encrypted_password: 'synthetic-new-password' });
    try {
      await within(reached.promise);
      // Mail turned off meanwhile: its own pause, then the change is refused.
      await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: false } } });
      go.resolve();
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [403, 'MODULE_DISABLED'], JSON.stringify(reply.body));
      const [[engine]] = await pool.query<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ?', [mail]);
      assert.equal(engine.paused_reason, 'Mail module disabled', 'the module\'s pause stays');
    } finally {
      go.resolve(); await pending; svc.testImapConnection = testImap;
      await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: true } } });
    }
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('S7 r7: deleting one date of a repeating server event commits before a pause of its account, which waits', async () => {
    const caldav = require('../dist/src/services/caldav') as FixtureValue;
    // Its replaceable functions, put back afterwards (the module's getters stay as they are).
    const saved = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(caldav)).filter(([, field]) => field.writable).map(([key, field]) => [key, field.value]));
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue;
    const { installCalDavFake, insertCalDavAccount, eventIcs, WORK } = require('./helpers/caldav-fake.cts');
    const server = installCalDavFake(caldav), account = crypto.randomUUID();
    await insertCalDavAccount(pool, encrypt, users.alex, account);
    server.store(`${WORK}pause-r7.ics`, eventIcs(`${crypto.randomUUID()}@example.test`, 'Pause occurrence r7', Date.now(), ['RRULE:FREQ=DAILY;COUNT=3']));
    const inBackground = calendarSync.syncCalendarAccountInBackground;
    calendarSync.syncCalendarAccountInBackground = () => undefined;
    let paused: ReturnType<typeof alex.request> | undefined, pending: ReturnType<typeof alex.request> | undefined;
    try {
      await calendarSync.syncCalendarAccount(account, { userId: users.alex, full: true });
      const dates = (await pool.query<RowDataPacket[]>("SELECT id FROM calendar_events WHERE user_id = ? AND title = 'Pause occurrence r7' ORDER BY start_time", [users.alex]))[0];
      assert.equal(dates.length, 3);
      // Held at the delete's login, under the person's lock.
      const held = pauseAfter('SELECT ca.provider, ca.provider_config, ca.account_email, ca.username, ca.encrypted_password, ca.mail_account_id');
      pending = alex.request('DELETE', `/api/calendar/events/${dates[1].id}?scope=occurrence`);
      try {
        await held.reached();
        paused = alex.request('PUT', `/api/calendar/accounts/${account}`, { is_active: false });
        await waits(paused, 'the pause');
        held.release();
        assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
        assert.equal((await paused).status, 200, JSON.stringify((await paused).body));
      } finally { held.restore(); await pending; await paused; }
      assert.equal(server.remote.writes.filter((write: string[]) => write[0] === 'put').length, 1, 'one date removed at the server');
      assert.equal(Number((await rowOf('calendar_accounts', account)).is_active), 0, 'then paused');
    } finally { calendarSync.syncCalendarAccountInBackground = inBackground; Object.assign(caldav, saved); }
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
  });

  await fromDefaults('S8 r7: a folder on two mail accounts is deleted at neither when the second changed while connecting, and partly deleted is answered as such', async () => {
    const { deleteMailFolder } = require('../dist/src/services/mail-folder-delete') as typeof import('../src/services/mail-folder-delete');
    const { guardImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
    for (const failing of [false, true]) {
      const accounts = [await mailOf(`folder-a-${failing}-r7@example.test`), await mailOf(`folder-b-${failing}-r7@example.test`)].sort();
      const addresses = await Promise.all(accounts.map(async id => (await rowOf('mail_accounts', id)).email_address as string));
      const folder = crypto.randomUUID(), slug = `shared-${failing}-r7`;
      await pool.execute('INSERT INTO mail_folders (id, user_id, slug, display_name, is_system) VALUES (?, ?, ?, \'Shared\', FALSE)', [folder, users.alex, slug]);
      await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name) VALUES (?, ?, 'Shared'), (?, ?, 'Shared')", [folder, accounts[0], folder, accounts[1]]);
      const commands: string[] = [], visited: string[] = [];
      const second = { reached: deferred(), go: deferred() };
      const outcome = deleteMailFolder({ userId: users.alex, slug, server: true }, {
        connect: async (account: FixtureValue) => {
          visited.push(account.id);
          if (!failing && visited.length === 2) { second.reached.resolve(); await second.go.promise; }
          // A guarded connection, as connectToAccount gives one.
          return guardImapConnection({ close() {}, on() {}, ...folderServer(), mailboxDelete: async () => {
            commands.push(account.id);
            if (failing && account.id === accounts[1]) throw Object.assign(new Error('synthetic server failure'), { responseStatus: 'NO', responseText: 'Server busy' });
          } } as FixtureValue);
        },
      }).then(() => null, (error: FixtureValue) => ({ status: error.status, code: error.code, details: error.details }));
      try {
        if (!failing) {
          await reachedBefore(second.reached.promise, outcome);
          await pool.execute("UPDATE mail_accounts SET username = 'changed-meanwhile' WHERE id = ?", [accounts[1]]);
          second.go.resolve();
          assert.equal((await outcome)?.code, 'ACCOUNT_CHANGED');
          assert.deepEqual(commands, [], 'no DELETE sent at all');
          assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folder_remote_boxes WHERE folder_id = ?', [folder]), 2);
        } else {
          assert.deepEqual(await outcome, { status: 409, code: 'FOLDER_PARTLY_DELETED', details: { deleted_on: [addresses[0]], remaining_on: [addresses[1]], settled: true } });
          assert.deepEqual(commands, accounts, 'each sent once');
          assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT mail_account_id FROM mail_folder_remote_boxes WHERE folder_id = ?', [folder]))[0].map(row => row.mail_account_id), [accounts[1]],
            'the deleted copy is settled; the folder stays for the other account');
        }
      } finally { second.go.resolve(); await outcome; }
      assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folders WHERE id = ?', [folder]), 1);
      await pool.execute('DELETE FROM mail_folders WHERE id = ?', [folder]);
      await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', accounts);
    }
  });

  await fromDefaults('Q1 r7: required provider deletion relaxed while a new account logs in still adds it as prepared', async () => {
    await setPolicies({ 'mail.provider_delete': 'required' });
    const stubs = mailStubbed(), reached = deferred(), go = deferred();
    stubs.svc.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
    const pending = alex.request('POST', '/api/mail/accounts', { provider: 'custom', email_address: 'relaxed-r7@example.test', encrypted_password: 'synthetic-password', imap_host: 'imap.example.test',
      imap_port: 993, smtp_host: 'smtp.example.test', smtp_port: 465, try_calendar_sync: false });
    try {
      await reachedBefore(reached.promise, pending.then(reply => reply.body));
      await setPolicies({ 'mail.provider_delete': 'user_choice' });
      go.resolve();
      const reply = await pending;
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    } finally { go.resolve(); await pending; stubs.restore(); }
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT delete_emails_on_server FROM mail_accounts WHERE user_id = ? AND email_address = ?', [users.alex, 'relaxed-r7@example.test']);
    assert.equal(Number(row.delete_emails_on_server), 1, 'with deletion, as prepared and still allowed');
    await pool.execute('DELETE FROM mail_accounts WHERE user_id = ? AND email_address = ?', [users.alex, 'relaxed-r7@example.test']);
  });

  await fromDefaults('r7: every change of a person\'s accounts, their own or an administrator\'s, waits for the person\'s lock', async () => {
    const personLock = require('../dist/src/services/person-lock') as typeof import('../src/services/person-lock');
    const stubs = mailStubbed(), discovery = discoveryHeld();
    const kept = await mailOf('fence-kept@example.test'), disconnected = await mailOf('fence-disconnect@example.test'), byAdmin = await mailOf('fence-admin@example.test');
    const purged = await mailOf('fence-purge@example.test');
    await pool.execute('UPDATE mail_accounts SET is_active = FALSE, disconnected_at = UTC_TIMESTAMP(), encrypted_password = NULL WHERE id = ?', [purged]);
    const changed = await standaloneAt('https://fence-change.example.test/dav/', 'fence-change'), removed = await standaloneAt('https://fence-remove.example.test/dav/', 'fence-remove');
    const admin_ = { current_password: password };
    const requests: [string, () => ReturnType<typeof alex.request>][] = [
      ['add a mail account', () => alex.request('POST', '/api/mail/accounts', {})],
      ['change a mail account', () => alex.request('PUT', `/api/mail/accounts/${kept}`, { display_name: 'Fenced' })],
      ['disconnect', () => alex.request('DELETE', `/api/mail/accounts/${disconnected}`)],
      ['purge', () => alex.request('DELETE', `/api/mail/accounts/${purged}?purge=true&confirm_purge=fence-purge@example.test`)],
      ['a mail account\'s calendar', () => alex.request('PUT', `/api/mail/accounts/${kept}/calendar`, { enabled: false })],
      ['add a calendar account', () => alex.request('POST', '/api/calendar/accounts', { provider: 'local', display_name: 'Fenced local' })],
      ['change a calendar account', () => alex.request('PUT', `/api/calendar/accounts/${changed}`, { display_name: 'Fenced' })],
      ['remove a calendar account', () => alex.request('DELETE', `/api/calendar/accounts/${removed}`)],
      ['delete a folder at the provider', () => alex.request('DELETE', '/api/mail/folders/fence-missing?server=1')],
      ['clear a module', () => alex.request('POST', '/api/settings/clear-contacts', {})],
      ['start a restore', () => alex.request('POST', `/api/backup/restore-jobs/${crypto.randomUUID()}/start`, {})],
      ['restore a backup', () => alex.request('POST', `/api/backup/jobs/${crypto.randomUUID()}/restore`, {})],
      ['an administrator adds a calendar account', () => admin.request('POST', `/api/admin/users/${users.alex}/calendar-accounts`, { provider: 'local', display_name: 'Fenced by admin', ...admin_ })],
      ['an administrator removes a mail account', () => admin.request('DELETE', `/api/admin/users/${users.alex}/mail-accounts/${byAdmin}`, admin_)],
      ['an administrator clears a module', () => admin.request('POST', `/api/admin/users/${users.alex}/clear/contacts`, admin_)],
    ];
    const gate = deferred();
    const held = personLock.withPersonLock(users.alex, () => gate.promise);
    const pending = requests.map(([, request]) => request());
    try {
      const early = await Promise.race([Promise.race(pending.map((reply, index) => reply.then(() => index, () => index))), new Promise<number>(done => setTimeout(() => done(-1), 1500))]);
      assert.equal(early === -1 ? null : requests[early][0], null, 'answered while the person\'s lock was held');
      // Blair's own change does not wait for alex's lock.
      assert.ok((await call(blair, 'POST', '/api/calendar/accounts', { provider: 'local', display_name: 'Blair while alex is held' })).account?.id);
    } finally { gate.resolve(); await held; }
    const replies = await Promise.all(pending);
    for (const [index, reply] of replies.entries()) assert.ok(reply.status < 500, `${requests[index][0]}: ${reply.status} ${JSON.stringify(reply.body)}`);
    stubs.restore(); discovery.restore();
    await pool.execute("DELETE FROM calendar_accounts WHERE user_id IN (?, ?) AND (id IN (?, ?) OR display_name IN ('Fenced local', 'Fenced by admin', 'Blair while alex is held'))", [users.alex, users.blair, changed, removed]);
    await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?, ?, ?)', [kept, disconnected, byAdmin, purged]);
  });

  // Review r8.
  await fromDefaults('r8: an administrator\'s change for a person waits for that person\'s own change, however the id is spelled; a malformed id is refused', async () => {
    const url = 'https://case-r8.example.test/dav/', login = 'case-original';
    const source = await mailOf('case-source@example.test', login), target = await mailOf('case-target@example.test', login);
    const old = await linkedAt(source, 'case-source@example.test', url);
    const discovery = discoveryHeld(), stubs = mailStubbed();
    const pause = pauseAfter('SELECT ca.* FROM calendar_accounts ca');
    const pending = alex.request('PUT', `/api/mail/accounts/${target}/calendar`, { enabled: true, caldav_url: url });
    let change: ReturnType<typeof admin.request> | undefined;
    try {
      await pause.reached();
      change = admin.request('PUT', `/api/admin/users/${users.alex.toUpperCase()}/mail-accounts/${source}`, { username: 'case-new-login', encrypted_password: 'synthetic-new-password', current_password: password });
      await waits(change, 'the administrator\'s change');
      pause.release();
      assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
      assert.equal((await change).status, 200, JSON.stringify((await change).body));
    } finally { pause.restore(); await pending; await change; stubs.restore(); discovery.restore(); }
    assert.equal((await rowOf('calendar_accounts', old.account)).mail_account_id, target, 'taken over with the login it was found by');
    assert.equal((await rowOf('mail_accounts', source)).username, 'case-new-login', 'then the login changed');
    const malformed = await admin.request('GET', '/api/admin/users/not-a-person/accounts');
    assert.deepEqual([malformed.status, malformed.body.code], [400, 'INVALID_USER_ID'], JSON.stringify(malformed.body));
    const own = await admin.request('DELETE', `/api/admin/users/${users.admin.toUpperCase()}`, { current_password: password });
    assert.deepEqual([own.status, own.body.error], [400, 'Cannot delete your own account'], JSON.stringify(own.body));
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', [source, target]);
  });

  await fromDefaults('r8: a sync that waited to link a restored calendar links nothing once the account was paused, and keeps its password', async () => {
    const mail = await mailOf('sync-pause-r8@example.test'), old = await linkedAt(mail, 'sync-pause-r8@example.test', 'https://sync-pause-r8.example.test/dav/');
    const secret = encrypt('synthetic-restored-password');
    await pool.execute("UPDATE calendar_accounts SET mail_account_id = NULL, encrypted_password = ?, is_active = TRUE, sync_status = 'pending' WHERE id = ?", [secret, old.account]);
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue;
    const dav = require('../dist/src/services/caldav') as FixtureValue, list = dav.listCalendars;
    let listed = 0;
    dav.listCalendars = async () => { listed++; return []; };
    const personLock = require('../dist/src/services/person-lock') as FixtureValue, original = personLock.withPersonLock;
    const arrived = deferred(), gate = deferred();
    const changes = require('../dist/src/services/calendar-account-changes') as FixtureValue;
    // Alex's change holds the lock; the sync reaches it and waits; the change pauses the account.
    const holder = original(users.alex, async () => { await within(arrived.promise); assert.ok((await changes.updateCalendarAccount(users.alex, old.account, { is_active: false })).account); await gate.promise; });
    personLock.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = calendarSync.syncCalendarAccount(old.account, { userId: users.alex }).then((result: FixtureValue) => result, (error: Error) => ({ error: error.message }));
    try {
      await within(arrived.promise);
      personLock.withPersonLock = original;
      gate.resolve(); await holder;
      assert.deepEqual(await pending, { skipped: true, reason: 'paused' });
    } finally { gate.resolve(); await holder; await pending; personLock.withPersonLock = original; dav.listCalendars = list; }
    const row = await rowOf('calendar_accounts', old.account);
    assert.deepEqual([Number(row.is_active), row.mail_account_id, row.encrypted_password, row.sync_status, listed], [0, null, secret, 'paused', 0], 'paused, unlinked, with its password, nothing asked of the server');
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [old.account]);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r8: confirming a Sync policy waits for a change of the account in progress, and is refused once a Mail restore is admitted', async () => {
    const stubs = mailStubbed();
    const scheduler = (require('../dist/src/services/mail-durable-jobs') as FixtureValue).durableScheduler, enqueue = scheduler.enqueue;
    scheduler.enqueue = async () => ({});
    try {
      const mail = await mailOf('confirm-old@example.test');
      await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync', sync_policy_confirmed_at = NULL WHERE id = ?", [mail]);
      // Held once the confirmation read the account.
      const pause = pauseAfter('FROM mail_accounts WHERE id = ? AND user_id = ?');
      const pending = alex.request('POST', `/api/mail/accounts/${mail}/confirm-sync-policy`, { confirm_address: 'confirm-old@example.test' });
      let change: ReturnType<typeof alex.request> | undefined;
      try {
        await pause.reached();
        change = alex.request('PUT', `/api/mail/accounts/${mail}`, { email_address: 'confirm-new@example.test', username: 'confirm-new', encrypted_password: 'synthetic-new-password' });
        await waits(change, 'the address change');
        pause.release();
        assert.equal((await pending).status, 200, JSON.stringify((await pending).body));
        assert.equal((await change).status, 200, JSON.stringify((await change).body));
      } finally { pause.restore(); await pending; await change; }
      const restore = crypto.randomUUID(), again = await mailOf('confirm-restore@example.test');
      await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync', sync_policy_confirmed_at = NULL WHERE id = ?", [again]);
      const held = pauseAfter('FROM mail_accounts WHERE id = ? AND user_id = ?');
      const refused = alex.request('POST', `/api/mail/accounts/${again}/confirm-sync-policy`, { confirm_address: 'confirm-restore@example.test' });
      try {
        await held.reached();
        await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["mail"]')`, [restore, users.alex]);
        held.release();
        const reply = await refused;
        assert.deepEqual([reply.status, reply.body.code], [409, 'RESTORE_IN_PROGRESS'], JSON.stringify(reply.body));
      } finally { held.restore(); await refused; }
      assert.equal((await rowOf('mail_accounts', again)).sync_policy_confirmed_at, null, 'not confirmed');
      assert.equal(await count("SELECT COUNT(*) AS count FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'prune'", [again]), 0, 'and no removal admitted');
      await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
      await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', [mail, again]);
    } finally { stubs.restore(); scheduler.enqueue = enqueue; }
  });

  await fromDefaults('r8: an administrator\'s switch to Sync confirms with the address the account has when the switch runs', async () => {
    const mail = await mailOf('admin-confirm-old@example.test');
    const stubs = mailStubbed(), reached = deferred(), go = deferred();
    stubs.svc.testImapConnection = async () => { reached.resolve(); await go.promise; return { success: true }; };
    const first = alex.request('PUT', `/api/mail/accounts/${mail}`, { email_address: 'admin-confirm-new@example.test', username: 'admin-new', encrypted_password: 'synthetic-new-password' });
    let second: ReturnType<typeof admin.request> | undefined;
    try {
      await within(reached.promise);
      second = admin.request('PUT', `/api/admin/users/${users.alex}/mail-accounts/${mail}`, { sync_mode: 'sync', current_password: password });
      await waits(second, 'the administrator\'s switch');
      go.resolve();
      assert.equal((await first).status, 200, JSON.stringify((await first).body));
      assert.equal((await second).status, 200, JSON.stringify((await second).body));
    } finally { go.resolve(); await first; await second; stubs.restore(); }
    assert.deepEqual([(await rowOf('mail_accounts', mail)).sync_mode, (await rowOf('mail_accounts', mail)).email_address], ['sync', 'admin-confirm-new@example.test']);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r8: a disconnect or purge that cannot get a connection, or a settings change that fails after its commit, leaves no pause of its own', async () => {
    const lifecycle = require('../dist/src/services/mail-account-lifecycle') as FixtureValue;
    for (const purge of [false, true]) {
      const mail = await mailOf(`acquire-${purge}@example.test`);
      if (purge) await pool.execute('UPDATE mail_accounts SET is_active = FALSE, disconnected_at = UTC_TIMESTAMP() WHERE id = ?', [mail]);
      const svc = mailServiceOf(), stop = svc.stopOwnedMailAccountWork, getConnection = pool.getConnection;
      // The change's own connection, right after its stop, cannot be had; the pool works again afterwards.
      svc.stopOwnedMailAccountWork = async (...args: FixtureValue[]) => {
        const owned = await stop(...args);
        pool.getConnection = async function (this: typeof pool) { pool.getConnection = getConnection; throw new Error('synthetic acquisition failure'); } as typeof pool.getConnection;
        return owned;
      };
      try {
        await assert.rejects(purge ? lifecycle.purgeAccount(users.alex, mail, `acquire-${purge}@example.test`) : lifecycle.disconnectAccount(users.alex, mail), /synthetic acquisition failure/);
      } finally { pool.getConnection = getConnection; svc.stopOwnedMailAccountWork = stop; }
      const [[row]] = await pool.query<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ?', [mail]);
      assert.equal(row?.paused_reason ?? null, null, `${purge ? 'purge' : 'disconnect'}: its pause is gone`);
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
    const mail = await mailOf('settings-exception@example.test'), stubs = mailStubbed();
    const writebacks = require('../dist/src/services/mail-writebacks') as FixtureValue, cancel = writebacks.cancelForAccount;
    writebacks.cancelForAccount = async () => { throw new Error('synthetic cancellation failure'); };
    try {
      const reply = await alex.request('PUT', `/api/mail/accounts/${mail}`, { sync_mode: 'sync', confirm_address: 'settings-exception@example.test' });
      assert.equal(reply.status, 500, JSON.stringify(reply.body));
    } finally { writebacks.cancelForAccount = cancel; stubs.restore(); }
    assert.equal((await rowOf('mail_accounts', mail)).sync_mode, 'sync', 'committed');
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ?', [mail]);
    assert.equal(row?.paused_reason ?? null, null, 'its pause ended all the same');
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r8: an accepted move waiting to run survives a refused settings change and a refused disconnect, with its foreground turn', async () => {
    const writebacks = require('../dist/src/services/mail-writebacks') as FixtureValue;
    const jobs = require('../dist/src/services/mail-durable-jobs') as FixtureValue;
    const modules = require('../dist/src/services/module-settings') as FixtureValue;
    await modules.setUserModules(users.alex, { modules: { mail: { enabled: true, background: false } } });
    const stubs = mailStubbed();
    try {
      for (const [what, policy, request] of [
        ['settings change', 'mail.mode.download', (mail: string) => alex.request('PUT', `/api/mail/accounts/${mail}`, { sync_mode: 'download' })],
        ['disconnect', 'accounts.remove', (mail: string) => alex.request('DELETE', `/api/mail/accounts/${mail}`)],
      ] as [string, string, (mail: string) => ReturnType<typeof alex.request>][]) {
        await pool.query("DELETE FROM setting_policies WHERE target_kind = 'installation'");
        const mail = await mailOf(`intent-${what.replace(/ /g, '-')}-r8@example.test`), email = crypto.randomUUID(), folder = crypto.randomUUID();
        await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync' WHERE id = ?", [mail]);
        await pool.execute("INSERT INTO mail_folders (id, user_id, slug, display_name, is_system) VALUES (?, ?, ?, 'Archive', FALSE)", [folder, users.alex, `archive-${folder.slice(0, 8)}`]);
        await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name) VALUES (?, ?, 'Archive')", [folder, mail]);
        await pool.execute("INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, remote_folder, remote_uid, remote_uidvalidity) VALUES (?, ?, ?, 'sender@example.test', '[]', 'inbox', 'INBOX', 12, 9)", [email, users.alex, mail]);
        const [[row]] = await pool.query<RowDataPacket[]>('SELECT e.*, a.sync_mode, a.is_active FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id WHERE e.id = ?', [email]);
        // Accepted: the intent and its job; the person's own, so it runs with background off.
        await writebacks.queueChanges(pool, users.alex, [row], { move: `archive-${folder.slice(0, 8)}` });
        jobs.foregroundMutationAccounts.add(mail);
        const [[op]] = await pool.query<RowDataPacket[]>('SELECT id FROM mail_writebacks WHERE email_id = ?', [email]);
        const pause = pauseAfter('INSERT INTO mail_engine_accounts (mail_account_id,user_id,paused_reason)');
        const pending = request(mail);
        try {
          await pause.reached();
          await setPolicies({ [policy]: 'forbidden' });
          pause.release();
          const reply = await pending;
          assert.deepEqual([what, reply.status, reply.body.code], [what, 403, 'POLICY_FORBIDS'], JSON.stringify(reply.body));
        } finally { pause.restore(); await pending; }
        const [[job]] = await pool.query<RowDataPacket[]>('SELECT state, kind, error FROM mail_engine_jobs WHERE operation_id = ?', [op.id]);
        assert.notEqual(job.state, 'cancelled', `${what}: the move's job is not retired: ${job.error}`);
        assert.equal(job.kind, 'operation', what);
        if (job.state === 'queued') assert.equal(jobs.foregroundMutationAccounts.has(mail), true, `${what}: still the person's own turn`);
        jobs.foregroundMutationAccounts.delete(mail);
        await pool.execute('DELETE FROM mail_folders WHERE id = ?', [folder]);
        await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
      }
    } finally { stubs.restore(); await modules.setUserModules(users.alex, { modules: { mail: { enabled: true, background: true } } }); }
  });

  await fromDefaults('r8: a refusal does not bring back a Mail switched-off pause once Mail is on again', async () => {
    const mail = await mailOf('prior-pause-r8@example.test');
    const control = require('../dist/src/services/mail-sync-control') as FixtureValue;
    try {
      await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: false } } });
      const owned = await control.stopOwnedMailAccountWork(mail, 'Account settings changing');
      await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: true } } });
      await control.releaseOwnedMailAccountStop(owned);
      const [[row]] = await pool.query<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ?', [mail]);
      assert.equal(row.paused_reason, null);
    } finally { await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: true } } }); }
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  async function sharedFolder(tag: string) {
    const accounts = [await mailOf(`${tag}-a@example.test`), await mailOf(`${tag}-b@example.test`)].sort();
    const folder = crypto.randomUUID(), slug = `${tag}-folder`;
    await pool.execute("INSERT INTO mail_folders (id, user_id, slug, display_name, is_system) VALUES (?, ?, ?, 'Synthetic shared', FALSE)", [folder, users.alex, slug]);
    await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name) VALUES (?, ?, 'Shared'), (?, ?, 'Shared')", [folder, accounts[0], folder, accounts[1]]);
    const remove = async () => { await pool.execute('DELETE FROM mail_folders WHERE id = ?', [folder]); await pool.execute('DELETE FROM mail_accounts WHERE id IN (?, ?)', accounts); };
    return { accounts, folder, slug, remove };
  }
  const folderDeletion = () => require('../dist/src/services/mail-folder-delete') as typeof import('../src/services/mail-folder-delete');
  const guarded = (connection: FixtureValue) => (require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard')).guardImapConnection({ on() {}, close() {}, ...connection });

  await fromDefaults('r8: deleting a folder at the provider counts what the servers answered, even when its final check could not commit', async () => {
    const fx = await sharedFolder('commit-r8'), commands: string[] = [], getConnection = pool.getConnection;
    let inject = true;
    pool.getConnection = async function (this: typeof pool) {
      const cx = await getConnection.call(this) as PoolConnection, commit = cx.commit, release = cx.release;
      cx.commit = async function (this: PoolConnection) { await commit.call(cx); if (inject && commands.length === 2) { inject = false; throw new Error('synthetic lost COMMIT acknowledgement'); } } as typeof cx.commit;
      cx.release = function (this: PoolConnection) { cx.commit = commit; cx.release = release; return release.call(cx); };
      return cx;
    } as typeof pool.getConnection;
    let result: FixtureValue;
    try {
      result = await folderDeletion().deleteMailFolder({ userId: users.alex, slug: fx.slug, server: true },
        { connect: async (account: FixtureValue) => guarded({ ...folderServer(), mailboxDelete: async () => { commands.push(account.id); } }) as FixtureValue });
    } finally { pool.getConnection = getConnection; }
    assert.deepEqual(commands, fx.accounts, 'each DELETE sent once');
    assert.equal(result.server.length, 2);
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folders WHERE id = ?', [fx.folder]), 0, 'and the folder is gone in UniHub');
    await fx.remove();
  });

  await fromDefaults('r8: a folder deleted at one server whose local update failed is not sent again by itself; deleting it again finishes it', async () => {
    const finalStep = require('../dist/src/services/final-step') as FixtureValue, original = finalStep.underFinalStep;
    const modules = require('../dist/src/services/module-settings') as FixtureValue;
    const fx = await sharedFolder('settle-r8'), commands: string[] = [];
    let secondFails = true;
    // Mail switched off right after the servers answered: the local update is refused.
    finalStep.underFinalStep = async (...args: FixtureValue[]) => { try { return await original(...args); } finally { if (secondFails) await modules.setUserModules(users.alex, { modules: { mail: { enabled: false } } }); } };
    const servers = new Map(fx.accounts.map(id => [id, { Shared: 1 } as Record<string, number>]));
    const connect = async (account: FixtureValue) => guarded({ ...folderServer(servers.get(account.id)), mailboxDelete: async (name: string) => {
      commands.push(account.id);
      if (!(name in servers.get(account.id)!)) throw nonexistent(name);
      if (secondFails && account.id === fx.accounts[1]) throw Object.assign(new Error('synthetic server busy'), { responseStatus: 'NO', responseText: 'Server busy' });
      delete servers.get(account.id)![name];
    } }) as FixtureValue;
    try {
      const first = await folderDeletion().deleteMailFolder({ userId: users.alex, slug: fx.slug, server: true }, { connect }).then(() => null, (error: FixtureValue) => error);
      assert.deepEqual([first?.code, first?.details?.settled], ['FOLDER_PARTLY_DELETED', false], String(first?.message));
      assert.deepEqual(first?.details?.deleted_on.length, 1);
      secondFails = false;
      await modules.setUserModules(users.alex, { modules: { mail: { enabled: true } } });
      assert.deepEqual(commands, [fx.accounts[0], fx.accounts[1]], 'nothing is sent again by itself');
      // Deleting it again asks both servers again: the first has no such folder any more, the second deletes it.
      await folderDeletion().deleteMailFolder({ userId: users.alex, slug: fx.slug, server: true }, { connect });
      assert.deepEqual(commands, [fx.accounts[0], fx.accounts[1], fx.accounts[0], fx.accounts[1]]);
      assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folders WHERE id = ?', [fx.folder]), 0);
    } finally { finalStep.underFinalStep = original; await modules.setUserModules(users.alex, { modules: { mail: { enabled: true } } }); }
    await fx.remove();
  });

  await fromDefaults('r8: a folder DELETE without an answer is answered 502, changes nothing locally and is not sent again by itself', async () => {
    const fx = await sharedFolder('uncertain-r8'), commands: string[] = [];
    const connect = async (account: FixtureValue) => guarded({ ...folderServer(), mailboxDelete: async () => {
      commands.push(account.id);
      if (account.id === fx.accounts[0]) throw new Error('synthetic connection lost');
    } }) as FixtureValue;
    const reply = await folderDeletion().deleteMailFolder({ userId: users.alex, slug: fx.slug, server: true }, { connect }).then(() => null, (error: FixtureValue) => error);
    assert.deepEqual([reply?.status, reply?.code], [502, 'MAIL_SERVER_ERROR']);
    assert.doesNotMatch(String(reply?.message), /synthetic connection lost/, 'in UniHub\'s words');
    assert.deepEqual(commands, [fx.accounts[0]], 'the rest is not sent, and the first not again');
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folder_remote_boxes WHERE folder_id = ?', [fx.folder]), 2);
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folders WHERE id = ?', [fx.folder]), 1);
    await fx.remove();
  });

  await fromDefaults('r8: a folder the mail server refused to delete answers 502 in UniHub\'s words, with nothing changed', async () => {
    const fx = await sharedFolder('nodelete-r8');
    const service = folderDeletion(), deleteMailFolder = service.deleteMailFolder;
    (service as FixtureValue).deleteMailFolder = (request: FixtureValue) => deleteMailFolder(request, { connect: async () => guarded({ ...folderServer(),
      mailboxDelete: async () => { throw Object.assign(new Error('synthetic server busy'), { responseStatus: 'NO', responseText: 'Synthetic raw provider text' }); } }) as FixtureValue });
    try {
      const reply = await alex.request('DELETE', `/api/mail/folders/${fx.slug}?server=1`);
      assert.deepEqual([reply.status, reply.body.code], [502, 'MAIL_SERVER_ERROR'], JSON.stringify(reply.body));
      assert.doesNotMatch(JSON.stringify(reply.body), /raw provider text|server busy/i);
    } finally { (service as FixtureValue).deleteMailFolder = deleteMailFolder; }
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_folder_remote_boxes WHERE folder_id = ?', [fx.folder]), 2);
    await fx.remove();
  });

  await fromDefaults('r9: a running foreground operation stopped by a refused disconnect resumes as its own outcome check, while background sync is off', async () => {
    const mail = await mailOf('running-foreground-r9@example.test'), email = crypto.randomUUID(), op = crypto.randomUUID();
    await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync' WHERE id = ?", [mail]);
    await pool.execute("INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, remote_folder, remote_uid, remote_uidvalidity) VALUES (?, ?, ?, 'sender@example.test', '[]', 'inbox', 'INBOX', 10, 80)", [email, users.alex, mail]);
    await pool.execute(`INSERT INTO mail_writebacks (id, user_id, mail_account_id, email_id, action, target_value, base_value, target_folder, remote_folder, remote_uid, remote_uidvalidity, state, is_current, dispatched)
      VALUES (?, ?, ?, ?, 'move', 'Archive', 'inbox', 'archive', 'INBOX', 10, 80, 'queued', TRUE, FALSE)`, [op, users.alex, mail, email]);
    const runtime = require('../dist/src/services/mail-engine/runtime') as FixtureValue;
    const modules = require('../dist/src/services/module-settings') as FixtureValue;
    const jobs = require('../dist/src/services/mail-durable-jobs') as FixtureValue;
    const operations = require('../dist/src/services/mail-engine/operations') as FixtureValue;
    const connections = require('../dist/src/services/mail-engine/connection-pool') as FixtureValue;
    const svc = mailServiceOf();
    const saved = { acquire: connections.acquireImapConnection, release: connections.releaseImapConnection, process: operations.processDueOperations,
      move: operations.applyMove, config: svc.buildImapConnectionConfig, stop: svc.stopOwnedMailAccountWork };
    const entered = deferred(), go = deferred();
    let acquired = 0, checked = 0, captured: FixtureValue = null;
    await modules.setUserModules(users.alex, { modules: { mail: { enabled: true, background: false } } });
    const job = await runtime.enqueueJob({ userId: users.alex, accountId: mail, operationId: op, kind: 'operation' });
    const claimed = await runtime.claimDueJob({ workerId: 'r9-first', accountId: mail, kinds: ['operation'] });
    assert.equal(claimed.id, job.id);
    connections.acquireImapConnection = async () => { acquired++; return {}; };
    connections.releaseImapConnection = () => {};
    svc.buildImapConnectionConfig = async () => ({ imap: {} });
    operations.applyMove = async () => { checked++; };
    // Dispatched, then stopped before its answer was recorded.
    operations.processDueOperations = async () => {
      await pool.execute("UPDATE mail_writebacks SET state = 'executing', dispatched = TRUE WHERE id = ?", [op]);
      entered.resolve(); await go.promise;
      throw Object.assign(new Error('Synthetic interrupted running command'), { code: 'MAIL_WORKER_FENCED' });
    };
    jobs.foregroundMutationAccounts.add(mail);
    const running = jobs.runDurableMailJob(claimed, new AbortController().signal, () => {}).catch((error: FixtureValue) => error);
    try {
      await within(entered.promise);
      svc.stopOwnedMailAccountWork = async (...args: FixtureValue[]) => {
        captured = await saved.stop(...args);
        go.resolve(); await running;
        await setPolicies({ 'accounts.remove': 'forbidden' });
        return captured;
      };
      const refused = await alex.request('DELETE', `/api/mail/accounts/${mail}`);
      assert.deepEqual([refused.status, refused.body.code], [403, 'POLICY_FORBIDS'], JSON.stringify(refused.body));
      svc.stopOwnedMailAccountWork = saved.stop;
      assert.equal(captured.foreground, true, 'the stop saw the running job\'s foreground turn');
      const [[restored]] = await pool.query<RowDataPacket[]>('SELECT kind, state FROM mail_engine_jobs WHERE id = ?', [job.id]);
      assert.deepEqual([restored.kind, restored.state], ['reconcile', 'queued'], 'dispatched: its outcome is checked, it is not sent again');
      assert.equal(jobs.foregroundMutationAccounts.has(mail), true, 'and it has its turn back');
      const next = await runtime.claimDueJob({ workerId: 'r9-reconcile', accountId: mail, kinds: ['reconcile'] });
      assert.equal(next.id, job.id);
      const result = await jobs.runDurableMailJob(next, new AbortController().signal, () => {});
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual([acquired, checked], [2, 1], 'the check ran on a connection of its own, with background sync off');
    } finally {
      go.resolve(); await running;
      Object.assign(connections, { acquireImapConnection: saved.acquire, releaseImapConnection: saved.release });
      Object.assign(operations, { processDueOperations: saved.process, applyMove: saved.move });
      Object.assign(svc, { buildImapConnectionConfig: saved.config, stopOwnedMailAccountWork: saved.stop });
      jobs.foregroundMutationAccounts.delete(mail);
      await modules.setUserModules(users.alex, { modules: { mail: { enabled: true, background: true } } });
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
  });

  await fromDefaults('r9: a running operation that had not been dispatched when a refused change stopped it runs again as itself', async () => {
    const mail = await mailOf('undispatched-r9@example.test'), email = crypto.randomUUID(), op = crypto.randomUUID();
    await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync' WHERE id = ?", [mail]);
    await pool.execute("INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder) VALUES (?, ?, ?, 'synthetic@example.test', '[]', 'inbox')", [email, users.alex, mail]);
    await pool.execute(`INSERT INTO mail_writebacks (id, user_id, mail_account_id, email_id, action, target_value, base_value, remote_folder, remote_uid, remote_uidvalidity, state, is_current, dispatched)
      VALUES (?, ?, ?, ?, 'read', '1', '0', 'INBOX', 1, 1, 'queued', TRUE, FALSE)`, [op, users.alex, mail, email]);
    const runtime = require('../dist/src/services/mail-engine/runtime') as FixtureValue;
    const job = await runtime.enqueueJob({ userId: users.alex, accountId: mail, operationId: op, kind: 'operation' });
    assert.equal((await runtime.claimDueJob({ workerId: 'r9-undispatched', accountId: mail, kinds: ['operation'] })).id, job.id);
    const pause = await runtime.pauseAccount({ userId: users.alex, accountId: mail, reason: 'r9-owned-undispatched' });
    await runtime.takeBackPause({ userId: users.alex, accountId: mail, reason: 'r9-owned-undispatched', ...pause });
    const next = await runtime.claimDueJob({ workerId: 'r9-undispatched-next', accountId: mail, kinds: ['operation'] });
    assert.deepEqual([next?.id, next?.kind], [job.id, 'operation']);
    await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
  });

  await fromDefaults('r9: an account id spelled in another case reaches the same account\'s work: a pause stops its running sync, and its mail lock is one queue', async () => {
    const account = crypto.randomUUID(), secret = encrypt('synthetic-r9-case-password');
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, encrypted_password, base_url, is_active, sync_status)
      VALUES (?, ?, 'caldav', 'case-r9@example.test', 'case-r9', ?, 'https://case-r9.example.test/dav/', TRUE, 'pending')`, [account, users.alex, secret]);
    const sync = require('../dist/src/services/calendar-sync') as FixtureValue, dav = require('../dist/src/services/caldav') as FixtureValue;
    const saved = { list: dav.listCalendars, objects: dav.listCalendarObjects };
    const reached = deferred(), go = deferred();
    dav.listCalendars = async () => { reached.resolve(); await go.promise;
      return [{ url: 'https://case-r9.example.test/dav/new/', href: '/dav/new/', displayName: 'Written after pause', readOnly: false, ctag: 'new', components: ['VEVENT'] }]; };
    dav.listCalendarObjects = async () => [];
    const pending = sync.syncCalendarAccount(account, { userId: users.alex }).catch((error: FixtureValue) => ({ error: error.message }));
    try {
      await within(reached.promise);
      const reply = await alex.request('PUT', `/api/calendar/accounts/${account.toUpperCase()}`, { is_active: false });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      go.resolve();
      const result = await pending;
      assert.notEqual(result.ok, true, JSON.stringify(result));
      assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_calendars WHERE account_id = ?', [account]), 0, 'the stopped sync wrote nothing');
    } finally { go.resolve(); await pending; Object.assign(dav, { listCalendars: saved.list, listCalendarObjects: saved.objects }); await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]); }

    const { withMailAccountLock } = require('../dist/src/services/mail-account-lock') as typeof import('../src/services/mail-account-lock');
    const mail = crypto.randomUUID(), held = deferred(), order: number[] = [];
    const first = withMailAccountLock(mail, async () => { await held.promise; order.push(1); });
    const second = withMailAccountLock(mail.toUpperCase(), async () => { order.push(2); });
    assert.equal(await settlesSoon(second, 100), false, 'the other spelling waits for the change in progress');
    held.resolve(); await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2]);
  });

  await fromDefaults('r9: a sync waiting to drop a link to deleted mail leaves the calendar as a pause meanwhile left it', async () => {
    const account = crypto.randomUUID(), secret = encrypt('synthetic-r9-dangling-password'), dangling = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, encrypted_password, base_url, mail_account_id, provider_config, is_active, sync_status)
      VALUES (?, ?, 'caldav', 'dangling-r9@example.test', ?, 'https://dangling-r9.example.test/dav/', ?, '{"mailLinked":true}', TRUE, 'pending')`, [account, users.alex, secret, dangling]);
    const sync = require('../dist/src/services/calendar-sync') as FixtureValue, locks = require('../dist/src/services/person-lock') as FixtureValue;
    const changes = require('../dist/src/services/calendar-account-changes') as FixtureValue;
    const original = locks.withPersonLock, arrived = deferred(), go = deferred();
    const holder = original(users.alex, async () => { await within(arrived.promise); assert.ok((await changes.updateCalendarAccount(users.alex, account, { is_active: false })).account); await go.promise; });
    locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = sync.syncCalendarAccount(account, { userId: users.alex }).catch((error: FixtureValue) => ({ error: error.message }));
    try {
      await within(arrived.promise); locks.withPersonLock = original; go.resolve(); await holder;
      assert.deepEqual(await pending, { skipped: true, reason: 'paused' });
      const row = await rowOf('calendar_accounts', account);
      assert.deepEqual([Number(row.is_active), row.mail_account_id, row.encrypted_password], [0, dangling, secret], 'paused, with its link and password');
    } finally { go.resolve(); await holder; await pending; locks.withPersonLock = original; await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]); }
  });

  await fromDefaults('r9: a sync that found no password while a new one was saved syncs again with it instead of noting it missing', async () => {
    const account = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, base_url, is_active, sync_status)
      VALUES (?, ?, 'caldav', 'new-login-r9@example.test', 'new-login-r9', 'https://new-login-r9.example.test/dav/', TRUE, 'pending')`, [account, users.alex]);
    const sync = require('../dist/src/services/calendar-sync') as FixtureValue, locks = require('../dist/src/services/person-lock') as FixtureValue;
    const changes = require('../dist/src/services/calendar-account-changes') as FixtureValue, dav = require('../dist/src/services/caldav') as FixtureValue;
    const original = locks.withPersonLock, list = dav.listCalendars, arrived = deferred(), go = deferred();
    let listed = 0;
    dav.listCalendars = async () => { listed++; return []; };
    const holder = original(users.alex, async () => { await within(arrived.promise); assert.ok((await changes.updateCalendarAccount(users.alex, account, { password: 'synthetic-r9-new-password' })).account); await go.promise; });
    locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = sync.syncCalendarAccount(account, { userId: users.alex }).catch((error: FixtureValue) => ({ error: error.message }));
    try {
      await within(arrived.promise); locks.withPersonLock = original; go.resolve(); await holder; await pending;
      for (let tries = 0; tries < 100 && !listed; tries++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(listed > 0, 'it synced again, with the new password');
      await sync.syncCalendarAccount(account, { userId: users.alex });
      const row = await rowOf('calendar_accounts', account);
      assert.ok(row.encrypted_password);
      assert.doesNotMatch(String(row.sync_error ?? ''), /No password is saved/);
    } finally { go.resolve(); await holder; await pending; locks.withPersonLock = original; dav.listCalendars = list; await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]); }
  });

  await fromDefaults('r9: deleting one\'s own account that waited is refused once the session ended or the password changed meanwhile', async () => {
    const locks = require('../dist/src/services/person-lock') as FixtureValue, original = locks.withPersonLock;
    for (const meanwhile of ['reset', 'hash'] as const) {
      const person = crypto.randomUUID(), name = `self-delete-r9-${meanwhile === 'reset' ? 'reset' : 'own'}`;
      await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [person, `${name}@example.test`, passwordHash, name]);
      const client = await signIn(name), arrived = deferred(), go = deferred();
      const holder = original(person, () => go.promise);
      locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === person) arrived.resolve(); return original(...args); };
      const pending = client.request('DELETE', '/api/settings/account', { current_password: password });
      try {
        await within(arrived.promise); locks.withPersonLock = original;
        if (meanwhile === 'reset') {
          // An administrator's reset ends the person's sessions.
          assert.equal((await admin.request('PUT', `/api/admin/users/${person}/password`, { new_password: 'synthetic-r9-replaced-password', current_password: password })).status, 200);
        } else {
          // Another password stored while this session lives on: the one entered for the deletion is not theirs any more.
          await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await (require('bcryptjs') as typeof import('bcryptjs')).hash('synthetic-r9-other-password', 4), person]);
        }
        go.resolve(); await holder;
        const reply = await pending;
        assert.deepEqual([reply.status, reply.body.code], meanwhile === 'reset' ? [401, 'SESSION_ENDED'] : [403, 'PASSWORD_CHANGED'], JSON.stringify(reply.body));
        assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id = ?', [person]), 1, 'the person is kept');
      } finally { go.resolve(); await holder; await pending; locks.withPersonLock = original; await pool.execute('DELETE FROM users WHERE id = ?', [person]); }
    }
  });

  await fromDefaults('r9: an administrator\'s change that waited is refused once they are no administrator or signed out; so are their saves of the rules and of the backup schedule', async () => {
    const locks = require('../dist/src/services/person-lock') as FixtureValue, original = locks.withPersonLock;
    const adminOf = async (name: string) => {
      const id = crypto.randomUUID();
      await pool.execute("INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')", [id, `${name}@example.test`, passwordHash, name]);
      return { id, client: await signIn(name) };
    };
    // The person's account change waits for the person's lock.
    const a = await adminOf('admin-path-r9'), mail = await mailOf('admin-path-r9@example.test');
    const arrived = deferred(), go = deferred();
    const holder = original(users.alex, () => go.promise);
    locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = a.client.request('DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail}`, { current_password: password });
    try {
      await within(arrived.promise); locks.withPersonLock = original;
      await pool.execute("UPDATE users SET role = 'user' WHERE id = ?", [a.id]);
      go.resolve(); await holder;
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [403, 'ADMIN_REQUIRED'], JSON.stringify(reply.body));
      assert.equal((await rowOf('mail_accounts', mail)).disconnected_at, null, 'the account stays connected');
    } finally { go.resolve(); await holder; await pending; locks.withPersonLock = original; await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]); await pool.execute('DELETE FROM users WHERE id = ?', [a.id]); }

    // A save waits for another one's row; the administrator signs out meanwhile.
    for (const [key, url, body] of [
      ['policy_revision', '/api/admin/policies', { values: { 'accounts.remove': 'forbidden' } }],
      ['instance_backup_keep', '/api/admin/instance-backup/settings', { time_utc: '04:30', keep: 3 }],
    ] as const) {
      const b = await adminOf(`saves-r9-${key}`);
      await pool.execute("INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, '0')", [key]);
      const before = await count("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?", [b.id]).catch(() => 0);
      const own = await pool.getConnection();
      await own.beginTransaction();
      await own.execute('SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
      const saving = b.client.request('PUT', url, { ...body, current_password: password });
      try {
        assert.equal(await settlesSoon(saving, 300), false, 'the save waits for the row');
        await pool.execute('DELETE FROM sessions WHERE user_id = ?', [b.id]);
        await own.rollback();
        const reply = await saving;
        assert.deepEqual([reply.status, reply.body.code], [401, 'SESSION_ENDED'], `${url}: ${JSON.stringify(reply.body)}`);
        assert.equal(await count("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?", [b.id]).catch(() => 0), before, 'nothing saved');
      } finally { await own.rollback().catch(() => {}); own.release(); await saving; await pool.execute('DELETE FROM users WHERE id = ?', [b.id]); }
    }
    assert.equal(await count("SELECT COUNT(*) AS count FROM setting_policies WHERE setting_key = 'policy.accounts.remove'"), 0);
  });

  await fromDefaults('r10: an administrator\'s local calendar for a person that waited is refused once they are no administrator, and nothing is made', async () => {
    const caller = crypto.randomUUID(), name = 'local-admin-r10';
    await pool.execute("INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')", [caller, `${name}@example.test`, passwordHash, name]);
    const client = await signIn(name), locks = require('../dist/src/services/person-lock') as FixtureValue;
    const original = locks.withPersonLock, arrived = deferred(), go = deferred();
    const holder = original(users.alex, () => go.promise);
    locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = client.request('POST', `/api/admin/users/${users.alex}/calendar-accounts`, { provider: 'local', display_name: 'After admin demotion', current_password: password });
    try {
      await within(arrived.promise); locks.withPersonLock = original;
      await pool.execute("UPDATE users SET role = 'user' WHERE id = ?", [caller]);
      go.resolve(); await holder;
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [403, 'ADMIN_REQUIRED'], JSON.stringify(reply.body));
      assert.equal(await count("SELECT COUNT(*) AS count FROM calendar_accounts WHERE user_id = ? AND display_name = 'After admin demotion'", [users.alex]), 0, 'no account');
      assert.equal(await count("SELECT COUNT(*) AS count FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id WHERE a.display_name = 'After admin demotion'"), 0, 'no calendar');
    } finally {
      go.resolve(); await holder; await pending; locks.withPersonLock = original;
      await pool.execute("DELETE FROM calendar_accounts WHERE user_id = ? AND display_name = 'After admin demotion'", [users.alex]);
      await pool.execute('DELETE FROM users WHERE id = ?', [caller]);
    }
  });

  await fromDefaults('r10: a sync that found no password while a new one was saved writes nothing once Calendar is off', async () => {
    const account = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, username, base_url, is_active, sync_status)
      VALUES (?, ?, 'caldav', 'guard-r10@example.test', 'guard-r10', 'https://guard-r10.example.test/dav/', TRUE, 'pending')`, [account, users.alex]);
    const sync = require('../dist/src/services/calendar-sync') as FixtureValue, locks = require('../dist/src/services/person-lock') as FixtureValue;
    const changes = require('../dist/src/services/calendar-account-changes') as FixtureValue, modules = require('../dist/src/services/module-settings') as FixtureValue;
    const original = locks.withPersonLock, arrived = deferred(), go = deferred();
    // While the old sync waits: a new password, Calendar switched off, and a newer status.
    const holder = original(users.alex, async () => {
      await within(arrived.promise);
      await changes.updateCalendarAccount(users.alex, account, { password: 'synthetic-r10-new-password' });
      await modules.setUserModules(users.alex, { modules: { calendar: { enabled: false } } });
      await pool.execute("UPDATE calendar_accounts SET sync_status = 'paused', next_sync_at = '2035-01-01 00:00:00' WHERE id = ?", [account]);
      await go.promise;
    });
    locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = sync.syncCalendarAccount(account, { userId: users.alex }).catch((error: FixtureValue) => error);
    try {
      await within(arrived.promise); locks.withPersonLock = original; go.resolve(); await holder;
      assert.deepEqual(await pending, { skipped: true, reason: 'paused' });
      const row = await rowOf('calendar_accounts', account);
      assert.deepEqual([row.sync_status, new Date(row.next_sync_at).toISOString()], ['paused', '2035-01-01T00:00:00.000Z'], 'the newer status stays');
    } finally {
      go.resolve(); await holder; await pending; locks.withPersonLock = original;
      await modules.setUserModules(users.alex, { modules: { calendar: { enabled: true } } });
      await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [account]);
    }
  });

  await fromDefaults('r11: a foreground operation admitted while a refused stop waited for its pause keeps its turn and checks its outcome', async () => {
    const mail = await mailOf('late-foreground-r11@example.test'), email = crypto.randomUUID(), op = crypto.randomUUID();
    await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync' WHERE id = ?", [mail]);
    await pool.execute("INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, remote_folder, remote_uid, remote_uidvalidity) VALUES (?, ?, ?, 'sender@example.test', '[]', 'inbox', 'INBOX', 10, 80)", [email, users.alex, mail]);
    await pool.execute(`INSERT INTO mail_writebacks (id, user_id, mail_account_id, email_id, action, target_value, base_value, target_folder, remote_folder, remote_uid, remote_uidvalidity, state, is_current, dispatched)
      VALUES (?, ?, ?, ?, 'move', 'Archive', 'inbox', 'archive', 'INBOX', 10, 80, 'queued', TRUE, FALSE)`, [op, users.alex, mail, email]);
    const runtime = require('../dist/src/services/mail-engine/runtime') as FixtureValue;
    const modules = require('../dist/src/services/module-settings') as FixtureValue;
    const jobs = require('../dist/src/services/mail-durable-jobs') as FixtureValue;
    const operations = require('../dist/src/services/mail-engine/operations') as FixtureValue;
    const connections = require('../dist/src/services/mail-engine/connection-pool') as FixtureValue;
    const svc = mailServiceOf();
    const saved = { acquire: connections.acquireImapConnection, release: connections.releaseImapConnection, process: operations.processDueOperations,
      move: operations.applyMove, config: svc.buildImapConnectionConfig, stop: svc.stopOwnedMailAccountWork, pause: runtime.pauseAccount };
    const entered = deferred(), go = deferred();
    let acquired = 0, checked = 0, captured: FixtureValue = null, running: Promise<FixtureValue> = Promise.resolve();
    await modules.setUserModules(users.alex, { modules: { mail: { enabled: true, background: false } } });
    const job = await runtime.enqueueJob({ userId: users.alex, accountId: mail, operationId: op, kind: 'operation' });
    const claimed = await runtime.claimDueJob({ workerId: 'r11-first', accountId: mail, kinds: ['operation'] });
    assert.equal(claimed.id, job.id);
    connections.acquireImapConnection = async () => { acquired++; return {}; };
    connections.releaseImapConnection = () => {};
    svc.buildImapConnectionConfig = async () => ({ imap: {} });
    operations.applyMove = async () => { checked++; };
    // Dispatched, then stopped before its answer was recorded.
    operations.processDueOperations = async () => {
      await pool.execute("UPDATE mail_writebacks SET state = 'executing', dispatched = TRUE WHERE id = ?", [op]);
      entered.resolve(); await go.promise;
      throw Object.assign(new Error('Synthetic interrupted running command'), { code: 'MAIL_WORKER_FENCED' });
    };
    // The person's operation is admitted and starts only once the stop has begun, before its pause fences it.
    runtime.pauseAccount = async (...args: FixtureValue[]) => {
      runtime.pauseAccount = saved.pause;
      jobs.foregroundMutationAccounts.add(mail);
      running = jobs.runDurableMailJob(claimed, new AbortController().signal, () => {}).catch((error: FixtureValue) => error);
      await within(entered.promise);
      return saved.pause(...args);
    };
    try {
      svc.stopOwnedMailAccountWork = async (...args: FixtureValue[]) => {
        captured = await saved.stop(...args);
        go.resolve(); await running;
        await setPolicies({ 'accounts.remove': 'forbidden' });
        return captured;
      };
      const refused = await alex.request('DELETE', `/api/mail/accounts/${mail}`);
      assert.deepEqual([refused.status, refused.body.code], [403, 'POLICY_FORBIDS'], JSON.stringify(refused.body));
      svc.stopOwnedMailAccountWork = saved.stop;
      assert.equal(captured.foreground, true, 'the stop counts the turn of the job its pause fenced');
      const [[restored]] = await pool.query<RowDataPacket[]>('SELECT kind, state FROM mail_engine_jobs WHERE id = ?', [job.id]);
      assert.deepEqual([restored.kind, restored.state], ['reconcile', 'queued']);
      assert.equal(jobs.foregroundMutationAccounts.has(mail), true, 'and gives it back');
      const next = await runtime.claimDueJob({ workerId: 'r11-reconcile', accountId: mail, kinds: ['reconcile'] });
      assert.equal(next.id, job.id);
      const result = await jobs.runDurableMailJob(next, new AbortController().signal, () => {});
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual([acquired, checked], [2, 1], 'its outcome is checked with background sync off');
    } finally {
      go.resolve(); await running;
      Object.assign(runtime, { pauseAccount: saved.pause });
      Object.assign(connections, { acquireImapConnection: saved.acquire, releaseImapConnection: saved.release });
      Object.assign(operations, { processDueOperations: saved.process, applyMove: saved.move });
      Object.assign(svc, { buildImapConnectionConfig: saved.config, stopOwnedMailAccountWork: saved.stop });
      jobs.foregroundMutationAccounts.delete(mail);
      await modules.setUserModules(users.alex, { modules: { mail: { enabled: true, background: true } } });
      await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [mail]);
    }
  });

  await fromDefaults('r11: a restore start that waited is refused once restoring is forbidden, and a queued restore a later rule forbids applies nothing', async () => {
    const created = await alex.request('POST', '/api/contacts', { name: { given: 'Archived rule r11' } });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const contact = String((created.body.contact as FixtureValue).id);
    const backup = require('../dist/src/services/backup') as FixtureValue, exportJobs = require('../dist/src/services/export-jobs') as FixtureValue;
    const restoreJobs = require('../dist/src/services/backup-restore-jobs') as FixtureValue;
    const entries = await backup.buildBackupArchiveEntriesForUser(users.alex, ['contacts'], { workDirectory: storage });
    const job = crypto.randomUUID(), restore = crypto.randomUUID(), file = path.join(root('backups'), users.alex, `${job}.zip`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await exportJobs.writeZip(entries, file);
    const edited = await alex.request('PUT', `/api/contacts/${contact}`, { name: { given: 'Newer rule r11' }, version: (created.body.contact as FixtureValue).version });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    await pool.execute("INSERT INTO data_export_jobs (id, user_id, status, phase, progress, file_path) VALUES (?, ?, 'ready', 'complete', 100, ?)", [job, users.alex, file]);
    await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, source_type, source_export_job_id, status, operation, phase, requested_sections, conflict_mode, archive_path, validation_result)
      VALUES (?, ?, 'generated', ?, 'validated', 'restore', 'validated', '["contacts"]', 'replace', ?, '{"valid":true,"errors":[]}')`, [restore, users.alex, job, file]);
    const names = async () => (await pool.query<RowDataPacket[]>('SELECT first_name FROM contacts WHERE id = ?', [contact]))[0].map(row => row.first_name);
    const restoreRow = async () => (await pool.query<RowDataPacket[]>('SELECT status, error FROM backup_restore_jobs WHERE id = ?', [restore]))[0][0];
    const locks = require('../dist/src/services/person-lock') as FixtureValue, original = locks.withPersonLock, arrived = deferred(), go = deferred();
    const holder = original(users.alex, () => go.promise);
    locks.withPersonLock = async (...args: FixtureValue[]) => { if (args[0] === users.alex) arrived.resolve(); return original(...args); };
    const pending = alex.request('POST', `/api/backup/restore-jobs/${restore}/start`, {});
    try {
      // The start passed the boundary and waits for the person's lock; the administrator forbids restoring meanwhile.
      await within(arrived.promise); locks.withPersonLock = original;
      await setPolicies({ 'backup.restore': 'forbidden' });
      go.resolve(); await holder;
      const reply = await pending;
      assert.deepEqual([reply.status, reply.body.code], [403, 'POLICY_FORBIDS'], JSON.stringify(reply.body));
      assert.equal((await restoreRow()).status, 'validated', 'not queued');
      assert.deepEqual(await names(), ['Newer rule r11']);
      // Queued while it was allowed, forbidden before the worker took it: it fails with the rule and applies nothing.
      await pool.execute("UPDATE backup_restore_jobs SET status = 'queued', phase = 'queued' WHERE id = ?", [restore]);
      await restoreJobs.runRestoreJob(restore);
      const after = await restoreRow();
      assert.equal(after.status, 'failed', 'with the rule\'s reason');
      assert.ok(after.error);
      assert.deepEqual(await names(), ['Newer rule r11'], 'the newer contact stays');
    } finally {
      go.resolve(); await holder; await pending; locks.withPersonLock = original;
      await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restore]);
      await pool.execute('DELETE FROM data_export_jobs WHERE id = ?', [job]);
      await pool.execute('DELETE FROM contacts WHERE id = ?', [contact]);
      fs.rmSync(file, { force: true });
    }
  });
});
