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
    const reply = await client.request(method, url, method === 'GET' ? undefined : body);
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
  // Holds the app's first statement containing `marker`, on the pool or on a
  // connection taken from it, once it has answered, until `release()`.
  function pauseAfter(marker: string) {
    const reached = deferred(), released = deferred();
    let armed = true;
    type Execute = (this: unknown, sql: unknown, ...args: unknown[]) => Promise<unknown>;
    const holding = (original: Execute): Execute => async function (sql, ...args) {
      const result = await original.call(this, sql, ...args);
      if (armed && String((sql as { sql?: string })?.sql ?? sql).includes(marker)) { armed = false; reached.resolve(); await released.promise; }
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
  // A file under a root, for a row that names it.
  function write(file: string, bytes: Buffer | string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }
  const encrypt = (text: string) => (require('../dist/src/security/encryption') as typeof import('../src/security/encryption')).encrypt(text);
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

  await fromDefaults('R1: provider deletion forbidden during the worker\'s last archive check erases nothing at the provider', async () => {
    // On a real IMAP connection to a local peer.
    const message = await archived(7);
    const queue = crypto.randomUUID();
    await pool.execute(`INSERT INTO mail_server_messages (id, user_id, mail_account_id, email_id, source_folder, imap_uid, imap_uidvalidity, delete_status)
      VALUES (?, ?, ?, ?, 'INBOX', 7, 1, 'pending')`, [queue, users.alex, account, message.id]);
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
          else if (/^(SELECT|EXAMINE) /.test(command)) { socket.write('* FLAGS (\\Seen \\Deleted)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 8] next\r\n'); ok('[READ-WRITE] selected'); }
          else if (command.startsWith('UID SEARCH ')) { socket.write('* SEARCH 7\r\n'); ok(); }
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
      await setPolicies({ 'mail.provider_delete': 'forbidden' });
      goOn.resolve();
      const result = await pass as FixtureValue;
      assert.deepEqual([result.deleted, result.stopped], [0, true], JSON.stringify(result));
      assert.deepEqual(commands.filter(command => /^UID (STORE|EXPUNGE)/.test(command)), [], 'no erase was sent');
    } finally {
      goOn.resolve();
      await pass.catch(() => undefined);
      (host as { buildImapConnectionConfig: unknown }).buildImapConnectionConfig = buildImapConnectionConfig;
      content.eligibleForProviderErasure = eligible;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => peer.close(resolve));
    }
    assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT delete_status FROM mail_server_messages WHERE id = ?', [queue]))[0].map(row => row.delete_status), ['pending'], 'it waits for the policy');
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
});
