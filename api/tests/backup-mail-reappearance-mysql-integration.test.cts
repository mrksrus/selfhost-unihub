import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

const uuid = () => crypto.randomUUID();
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

// A Sync message a backup keeps (no live copy at the provider when it was
// made) comes back with the provider address it had. When the provider
// presents that exact address again (same account, mailbox, UIDVALIDITY and
// UID), the sync links the restored copy instead of downloading a second one
// beside it, which no later pass would ever remove. The production backup,
// restore, metadata scan, body import, presence, history and flags streams
// and two confirmed prune passes run; only the IMAP wire is a stub.
test('a restored Sync copy is linked when the provider shows its exact address again', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async (t) => {
  const database = process.env.MYSQL_TEST_DATABASE || 'unihub_test';
  assert.match(database, /_test$/, 'Use an empty disposable database ending in _test');
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database,
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password', timezone: '+00:00', connectionLimit: 4 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-mail-reappearance-'));
  const previousRawRoot = process.env.MAIL_RAW_STORAGE_ROOT;
  process.env.MAIL_RAW_STORAGE_ROOT = path.join(directory, 'mail-raw');
  let owned = false;
  let runtime: FixtureValue = null;
  t.after(async () => {
    try {
      if (runtime) await runtime('services/side-pools').endSidePools(pool);
      if (owned) {
        const connection = await pool.getConnection();
        try {
          await connection.query('SET FOREIGN_KEY_CHECKS = 0');
          const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
          for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]);
        } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); connection.release(); }
      }
    } finally {
      if (previousRawRoot === undefined) delete process.env.MAIL_RAW_STORAGE_ROOT; else process.env.MAIL_RAW_STORAGE_ROOT = previousRawRoot;
      await pool.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const [existing] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
  owned = true;
  runtime = createBackupRuntime(directory, 'reappearance-synthetic-key', pool);
  await runtime('services/database').ensureSchema();
  const insert = (table: string, row: FixtureValue) => pool.execute(`INSERT INTO ${table} (${Object.keys(row).map(field => '`' + field + '`').join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));

  const [owner, reader] = [uuid(), uuid()];
  for (const [userId, label] of [[owner, 'reappearance-owner'], [reader, 'reappearance-reader']]) {
    await insert('users', { id: userId, email: `${label}@example.test`, password_hash: 'synthetic-hash' });
    await runtime('services/mail-folders').ensureDefaultMailFoldersForUser(userId);
  }
  // Each case: a Sync account with one complete message at INBOX UID 71 of
  // epoch 19, and no live occurrence. The provider later shows UID 71 again,
  // in the epoch the case names.
  const cases = [
    { label: 'address', email: {}, providerEpoch: 19, copies: 1, linked: true },
    { label: 'missing', email: { remote_missing: 1 }, providerEpoch: 19, copies: 1, linked: false },
    { label: 'unlinked', email: { remote_folder: null, remote_uid: null, remote_uidvalidity: null }, providerEpoch: 19, copies: 1, linked: false },
    // Another epoch: UID 71 may be another message now, so nothing links.
    { label: 'reset', email: {}, providerEpoch: 20, copies: 2, linked: false },
  ];
  const raws = new Map<string, Buffer>();
  for (const scenario of cases) {
    const account = uuid(), email = uuid();
    const raw = Buffer.from(`From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Reappearing ${scenario.label}\r\nMessage-ID: <reappearing-${scenario.label}@example.test>\r\n`
      + 'Date: Sun, 25 Oct 2026 12:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nSynthetic complete copy\r\n');
    raws.set(scenario.label, raw);
    const stored = path.join(directory, 'mail-raw', owner, `${email}.eml`);
    await fs.mkdir(path.dirname(stored), { recursive: true });
    await fs.writeFile(stored, raw);
    await insert('mail_accounts', { id: account, user_id: owner, email_address: `reappearing-${scenario.label}@example.test`, provider: 'custom', sync_mode: 'sync', imap_host: 'imap.example.test' });
    await insert('emails', { id: email, user_id: owner, mail_account_id: account, message_id: `<reappearing-${scenario.label}@example.test>`, subject: `Reappearing ${scenario.label}`,
      from_address: 'sender@example.test', to_addresses: '["reader@example.test"]', body_text: 'Synthetic complete copy', folder: 'inbox', source_folder: 'INBOX',
      received_at: '2026-10-25 12:00:00', raw_storage_path: stored, raw_sha256: sha256(raw), raw_bytes: raw.length, raw_format: 'exact_octets', raw_verified: 1, import_complete: 1,
      remote_folder: 'INBOX', remote_uid: 71, remote_uidvalidity: 19, imap_uid: 71, imap_uidvalidity: 19, ...scenario.email });
  }

  const backup = runtime('services/backup');
  const archive = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: true });
  assert.equal(archive.data.emails.length, cases.length, 'the backup keeps every copy: none has a live copy at the provider');
  const restored = await backup.importBackupForUser(reader, archive, { mode: 'apply', sections: ['mail'], conflict_mode: 'keep_existing', startAccountSync: () => {} });
  assert.equal(restored.valid, true, JSON.stringify(restored.errors));

  const transport = runtime('services/mail-engine/transport');
  const engine = runtime('services/mail-engine/sync');
  const content = runtime('services/mail-engine/content');
  const policy = runtime('services/mail-sync-policy');
  for (const scenario of cases) {
    const [[account]] = await pool.query<RowDataPacket[]>('SELECT * FROM mail_accounts WHERE user_id = ? AND email_address = ?', [reader, `reappearing-${scenario.label}@example.test`]);
    await pool.execute('UPDATE mail_accounts SET is_active = TRUE, sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [account.id]);
    Object.assign(account, { is_active: 1, sync_policy_confirmed_at: new Date() });
    const [[before]] = await pool.query<RowDataPacket[]>('SELECT id, is_read FROM emails WHERE user_id = ? AND mail_account_id = ?', [reader, account.id]);
    const raw = raws.get(scenario.label)!;
    let fetched = 0;
    transport.selectMailbox = async () => ({ folder: 'INBOX', uidvalidity: scenario.providerEpoch, uidnext: 72, highestmodseq: null, nomodseq: true, readOnly: true,
      capabilities: { move: true, condstore: false, uidplus: true, xGmExt1: false } });
    transport.fetchMetadataWindow = async (_connection: unknown, request: FixtureValue) => ({ ...request, complete: true, bytes: 0,
      items: request.startUid <= 71 && request.endUid >= 71 ? [{ uid: 71, flags: ['\\Seen'], modseq: null, gmailMsgId: null, internalDate: '2026-10-25T12:00:00Z' }] : [] });
    transport.fetchRawMessage = async () => { fetched += 1; return { raw }; };
    const folder = { folderName: 'INBOX', dbFolderName: 'inbox' };
    const scan = async (stream: string) => { let result; do { result = await engine.scanMailboxSlice({ db: pool, connection: {}, account, folder, stream }); } while (result.more); };
    await scan('recent');
    const [[mailbox]] = await pool.query<RowDataPacket[]>('SELECT id FROM mail_remote_mailboxes WHERE mail_account_id = ?', [account.id]);
    await content.processBodySlice({ db: pool, connection: {}, account, folder, mailboxId: mailbox.id });
    for (const stream of ['presence', 'history', 'flags']) await scan(stream);
    for (let pass = 0; pass < 2; pass++) await policy.runPruneSlice({ account });

    const [copies] = await pool.query<RowDataPacket[]>(`SELECT e.id, e.import_complete, e.raw_storage_path, e.is_read,
        (SELECT COUNT(*) FROM mail_remote_occurrences o WHERE o.email_id = e.id AND o.presence = 'present') AS live
      FROM emails e WHERE e.user_id = ? AND e.mail_account_id = ?`, [reader, account.id]);
    assert.equal(copies.length, scenario.copies, `${scenario.label}: copies`);
    for (const copy of copies) {
      assert.equal(Number(copy.import_complete), 1, scenario.label);
      assert.deepEqual(await fs.readFile(copy.raw_storage_path), raw, scenario.label);
    }
    const view = runtime('services/mail-list').mailListView(new URLSearchParams({ account_id: account.id, folder: 'all' }), reader, false);
    const [[visible]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM emails WHERE ${view.whereSql}`, view.params);
    assert.equal(Number(visible.n), scenario.copies, `${scenario.label}: visible`);
    const restoredCopy = copies.find(copy => copy.id === before.id);
    if (scenario.linked) {
      // The restored item itself carries the live copy now; nothing was downloaded again.
      assert.ok(restoredCopy, `${scenario.label}: the restored item stays`);
      assert.equal(Number(restoredCopy.live), 1, `${scenario.label}: linked to the provider's copy`);
      assert.equal(Number(restoredCopy.is_read), 1, `${scenario.label}: the provider's flags apply`);
      assert.equal(fetched, 0, `${scenario.label}: no second download`);
    } else if (restoredCopy) {
      assert.equal(Number(restoredCopy.live), 0, `${scenario.label}: the restored item is not taken for the provider's copy`);
    }
  }
});
