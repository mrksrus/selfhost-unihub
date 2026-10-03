// Disposable MySQL 8 schema ending _test. Sync mode follows the server:
// proven absence, Gmail label merging, retention windows, the per-account
// confirmation gate and its HTTP API, against real SQL and real files.
// Named to sort before database-startup smoke, which leaves a populated schema.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime');

const uuid = () => crypto.randomUUID();
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const exists = file => fs.access(file).then(() => true, () => false);

test('MySQL Sync policy: proven absence, Gmail merge, retention, confirmation gate and API', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 240000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Disposable schema only');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-sync-policy-'));
  const previousEnv = { raw: process.env.MAIL_RAW_STORAGE_ROOT, attachments: process.env.MAIL_ATTACHMENT_UPLOAD_ROOT };
  process.env.MAIL_RAW_STORAGE_ROOT = path.join(directory, 'mail-raw');
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = path.join(directory, 'attachments');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 8 });
  const state = require('../src/state'), previousDb = state.getDb();
  const rows = async (sql, params = []) => (await pool.execute(sql, params))[0];
  const one = async (sql, params = []) => (await rows(sql, params))[0];
  let ownsSchema = false, server = null, isolated = null;
  t.after(async () => {
    try {
      if (isolated) await isolated('services/mail-durable-jobs').durableScheduler.stop();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      if (ownsSchema) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const row of (await cx.query('SHOW TABLES'))[0]) {
            const name = Object.values(row)[0]; assert.match(name, /^[a-z_]+$/);
            await cx.query(`DROP TABLE \`${name}\``);
          }
        } finally { await cx.query('SET FOREIGN_KEY_CHECKS = 1'); cx.release(); }
      }
    } finally {
      state.setDb(previousDb); await pool.end();
      for (const [key, value] of [['MAIL_RAW_STORAGE_ROOT', previousEnv.raw], ['MAIL_ATTACHMENT_UPLOAD_ROOT', previousEnv.attachments]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  assert.match((await one('SELECT VERSION() AS version')).version, /^8\./);
  assert.equal((await rows('SHOW TABLES')).length, 0, 'Refuse a populated schema');
  ownsSchema = true; state.setDb(pool);
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'sync-policy-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-sync-policy-bootstrap-password';
  await require('../src/services/database').ensureSchema();
  const repo = require('../src/services/mail-engine/repository');
  const transport = require('../src/services/mail-engine/transport');
  const { scanMailboxSlice } = require('../src/services/mail-engine/sync');
  const policy = require('../src/services/mail-sync-policy');

  // Synthetic provider: folder -> { epoch, next, gmail, items: uid -> message }.
  const provider = new Map();
  const box = (name, { gmail = false, epoch = 9 } = {}) => {
    if (!provider.has(name)) provider.set(name, { epoch, next: 1, gmail, items: new Map() });
    return provider.get(name);
  };
  const deliver = (name, uid, message, options) => {
    const mailbox = box(name, options);
    mailbox.items.set(uid, { flags: [], gmailMsgId: null, internalDate: daysAgo(1), ...message });
    mailbox.next = Math.max(mailbox.next, uid + 1);
  };
  t.mock.method(transport, 'selectMailbox', async (connection, { folder }) => {
    const mailbox = box(folder);
    return { folder, uidvalidity: mailbox.epoch, uidnext: mailbox.next, highestmodseq: null, nomodseq: true, readOnly: true,
      capabilities: { move: true, condstore: false, uidplus: true, xGmExt1: mailbox.gmail } };
  });
  t.mock.method(transport, 'fetchMetadataWindow', async (connection, { folder, uidvalidity, startUid, endUid }) => {
    const mailbox = box(folder);
    assert.equal(uidvalidity, mailbox.epoch);
    const items = [...mailbox.items].filter(([uid]) => uid >= startUid && uid <= endUid).sort((a, b) => a[0] - b[0])
      .map(([uid, item]) => ({ uid, flags: [...item.flags], modseq: null, gmailMsgId: mailbox.gmail ? item.gmailMsgId : null, internalDate: item.internalDate }));
    return { folder, uidvalidity, startUid, endUid, items, complete: true, bytes: 0 };
  });

  const userId = uuid();
  await pool.execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'sync-policy-owner@example.test', 'synthetic']);
  async function createAccount(label, { mode = 'sync', confirmed = true, syncWindow = null, trashWindow = 30, host = 'imap.example.test' } = {}) {
    const id = uuid();
    await pool.execute(`INSERT INTO mail_accounts (id,user_id,email_address,provider,imap_host,sync_mode,is_active,
        sync_window_days,trash_window_days,sync_policy_confirmed_at)
      VALUES (?,?,?,'custom',?,?,TRUE,?,?,${confirmed ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [id, userId, `${label}@example.test`, host, mode, syncWindow, trashWindow]);
    return id;
  }
  const load = id => one('SELECT * FROM mail_accounts WHERE id = ?', [id]);
  const specialUses = { 'Trash': 'trash', '[Gmail]/All Mail': 'all', '[Gmail]/Trash': 'trash' };
  async function scan(accountId, folderName, stream, { fresh = true } = {}) {
    if (fresh) await pool.execute('DELETE FROM mail_engine_cursors WHERE mail_account_id = ?', [accountId]);
    let result;
    do {
      result = await scanMailboxSlice({ db: pool, connection: {}, account: await load(accountId),
        folder: { folderName, dbFolderName: 'inbox', specialUse: specialUses[folderName] }, stream });
    } while (result.more);
    return result;
  }
  const itemAt = async (accountId, folderName, uid) => (await one(`SELECT o.email_id, o.presence FROM mail_remote_occurrences o
    JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id WHERE o.mail_account_id = ? AND m.remote_name = ? AND o.uid = ?`,
  [accountId, folderName, uid])) || null;
  const emailCount = async accountId => Number((await one('SELECT COUNT(*) AS n FROM emails WHERE mail_account_id = ?', [accountId])).n);
  const prune = async accountId => {
    const total = { removed: 0, filed: 0, merged: 0 };
    let result;
    do {
      result = await policy.runPruneSlice({ account: await load(accountId) });
      for (const key of Object.keys(total)) total[key] += Number(result[key] || 0);
    } while (result.more);
    return { ...result, ...total };
  };
  async function storeFiles(emailId) {
    const raw = path.join(process.env.MAIL_RAW_STORAGE_ROOT, userId, `${emailId}.eml`);
    const attachment = path.join(process.env.MAIL_ATTACHMENT_UPLOAD_ROOT, userId, `${emailId}-note.txt`);
    for (const file of [raw, attachment]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'synthetic'); }
    await pool.execute('UPDATE emails SET raw_storage_path = ? WHERE id = ?', [raw, emailId]);
    await pool.execute(`INSERT INTO email_attachments (id,email_id,user_id,filename,content_type,size_bytes,storage_path)
      VALUES (?,?,?,'note.txt','text/plain',9,?)`, [uuid(), emailId, userId, attachment]);
    return { raw, attachment };
  }

  await t.test('Sync, confirmed: proven absence removes the local item and its files', async () => {
    const accountId = await createAccount('absence');
    deliver('INBOX', 1, {}); deliver('INBOX', 2, {});
    await scan(accountId, 'INBOX', 'presence');
    const kept = (await itemAt(accountId, 'INBOX', 1)).email_id, gone = (await itemAt(accountId, 'INBOX', 2)).email_id;
    const files = await storeFiles(gone);
    provider.get('INBOX').items.delete(2);
    await scan(accountId, 'INBOX', 'presence');
    assert.equal((await itemAt(accountId, 'INBOX', 2)).presence, 'absent');
    assert.equal((await one('SELECT remote_missing FROM emails WHERE id = ?', [gone])).remote_missing, 1);
    assert.equal((await rows("SELECT id FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'prune' AND state = 'queued'", [accountId])).length, 1,
      'Proven absence queues the local prune job');
    const impact = await policy.computeModeImpact(await load(accountId), { mode: 'sync' });
    assert.equal(impact.local_only, 1);
    const result = await prune(accountId);
    assert.equal(result.removed, 1);
    assert.equal(await one('SELECT id FROM emails WHERE id = ?', [gone]), undefined);
    assert.ok(await one('SELECT id FROM emails WHERE id = ?', [kept]));
    assert.equal(await exists(files.raw), false, 'Raw archive removed');
    assert.equal(await exists(files.attachment), false, 'Attachment file removed');
    provider.delete('INBOX');
  });

  await t.test('Download mode and an unconfirmed Sync account keep mail the server no longer has', async () => {
    const download = await createAccount('download', { mode: 'download', confirmed: false });
    const mailbox = await repo.withTransaction(cx => repo.ensureMailbox({ userId, accountId: download, folderName: 'INBOX', epoch: 9 }, cx), pool);
    const archived = uuid(), serverDeleted = uuid();
    for (const [id, uid] of [[archived, 1], [serverDeleted, 2]]) {
      await pool.execute("INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder) VALUES (?,?,?,'a@example.test','[]','inbox')", [id, userId, download]);
      await repo.withTransaction(cx => repo.upsertOccurrence({ userId, accountId: download, mailboxId: mailbox.id, epoch: 9, uid, emailId: id }, cx), pool);
    }
    await pool.execute("UPDATE mail_remote_occurrences SET presence = 'absent' WHERE email_id = ?", [archived]);
    await pool.execute("INSERT INTO mail_server_messages (user_id,mail_account_id,email_id,source_folder,imap_uid,delete_status) VALUES (?,?,?,'INBOX',2,'deleted')",
      [userId, download, serverDeleted]);
    assert.equal((await prune(download)).skipped, 'download_mode');
    assert.equal(await emailCount(download), 2, 'Download mode never removes local mail');
    const toSync = await policy.computeModeImpact(await load(download), { mode: 'sync' });
    assert.equal(toSync.local_only, 2, 'Switching would remove mail missing on the server, including mail UniHub deleted there');
    assert.ok(toSync.notes.some(note => /not counted yet/.test(note)));
    const stay = await policy.computeModeImpact(await load(download), { mode: 'download' });
    assert.equal(stay.total_removals, 0);
    assert.match(stay.notes[0], /deletes nothing/);

    const upgraded = await createAccount('upgraded', { confirmed: false });
    deliver('INBOX', 1, {});
    await scan(upgraded, 'INBOX', 'presence');
    const item = (await itemAt(upgraded, 'INBOX', 1)).email_id;
    provider.get('INBOX').items.delete(1);
    await scan(upgraded, 'INBOX', 'presence');
    const held = await prune(upgraded);
    assert.equal(held.unconfirmed, true);
    assert.equal(held.removed, 0);
    assert.ok(await one('SELECT id FROM emails WHERE id = ? AND remote_missing = TRUE', [item]), 'Kept until the policy is confirmed');
    assert.equal(await policy.pendingRemovals(await load(upgraded)), 1);
    await pool.execute('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [upgraded]);
    assert.equal(await policy.pendingRemovals(await load(upgraded)), null);
    assert.equal((await prune(upgraded)).removed, 1);
    provider.delete('INBOX');
  });

  await t.test('Gmail: one item per X-GM-MSGID; copies merged after confirmation; All Mail keeps archived mail', async () => {
    const accountId = await createAccount('gmail', { confirmed: false, host: 'imap.gmail.com' });
    const gmail = { gmail: true };
    for (const [folder, uid] of [['INBOX', 5], ['Work', 7], ['[Gmail]/All Mail', 50]]) deliver(folder, uid, { gmailMsgId: '9001', flags: ['\\Seen'] }, gmail);
    // Copies imported per label before 0.12 read X-GM-MSGID.
    const keeper = uuid(), copy = uuid();
    await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,import_complete,content_state,is_read,created_at)
      VALUES (?,?,?,'g@example.test','[]','inbox',TRUE,'complete',FALSE,UTC_TIMESTAMP() - INTERVAL 1 DAY),
             (?,?,?,'g@example.test','[]','work',FALSE,'queued',FALSE,UTC_TIMESTAMP())`, [keeper, userId, accountId, copy, userId, accountId]);
    for (const [folder, uid, emailId] of [['INBOX', 5, keeper], ['Work', 7, copy]]) {
      const mailbox = await repo.withTransaction(cx => repo.ensureMailbox({ userId, accountId, folderName: folder, epoch: 9 }, cx), pool);
      await repo.withTransaction(cx => repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid, emailId,
        gmailMsgId: '9001', flags: ['\\Seen'] }, cx), pool);
    }
    const operation = uuid();
    await pool.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,remote_folder,remote_uid,remote_uidvalidity,status,state)
      VALUES (?,?,?,?,'read','1','0','Work',7,9,'done','confirmed')`, [operation, userId, accountId, copy]);
    const files = await storeFiles(copy);
    assert.equal((await rows("SELECT source_id FROM mail_engine_quarantine WHERE mail_account_id = ? AND reason = 'gmail_identity_conflict'", [accountId])).length, 1);
    await scan(accountId, '[Gmail]/All Mail', 'recent');
    assert.equal(await emailCount(accountId), 2, 'An All Mail occurrence joins the known item, never a new one');
    assert.equal((await itemAt(accountId, '[Gmail]/All Mail', 50)).email_id, keeper);
    assert.deepEqual(await policy.syncWarnings(await load(accountId)), []);
    assert.equal((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).gmail_duplicates, 1);
    await pool.execute('UPDATE emails SET is_read = FALSE WHERE id = ?', [keeper]);
    assert.equal((await prune(accountId)).merged, 0, 'Merging is destructive and waits for confirmation');
    assert.equal(await emailCount(accountId), 2);

    await pool.execute('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);
    const merged = await prune(accountId);
    assert.equal(merged.merged, 1);
    assert.equal(await emailCount(accountId), 1);
    assert.deepEqual((await rows('SELECT DISTINCT email_id FROM mail_remote_occurrences WHERE mail_account_id = ?', [accountId])).map(row => row.email_id), [keeper]);
    assert.equal((await one('SELECT email_id FROM mail_writebacks WHERE id = ?', [operation])).email_id, keeper, 'Operation history re-pointed');
    assert.equal((await one("SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND gmail_msgid = '9001'", [accountId])).email_id, keeper);
    assert.equal((await one('SELECT is_read FROM emails WHERE id = ?', [keeper])).is_read, 1, 'Read state from the server');
    assert.equal((await rows("SELECT source_id FROM mail_engine_quarantine WHERE mail_account_id = ? AND reason = 'gmail_identity_conflict'", [accountId])).length, 0);
    assert.equal(await exists(files.raw), false);
    assert.equal(await exists(files.attachment), false);

    // Archived in Gmail: removed from INBOX and Work, still in All Mail.
    provider.get('INBOX').items.delete(5); provider.get('Work').items.delete(7);
    await scan(accountId, 'INBOX', 'presence'); await scan(accountId, 'Work', 'presence');
    assert.equal((await prune(accountId)).removed, 0);
    assert.ok(await one('SELECT id FROM emails WHERE id = ? AND remote_missing = FALSE', [keeper]), 'All Mail alone keeps the item');
    provider.get('[Gmail]/All Mail').items.delete(50);
    await scan(accountId, '[Gmail]/All Mail', 'presence');
    assert.equal((await prune(accountId)).removed, 1, 'Gone from every mailbox including All Mail: deleted');
    assert.equal(await emailCount(accountId), 0);
    for (const name of ['INBOX', 'Work', '[Gmail]/All Mail']) provider.delete(name);
  });

  await t.test('Copies without a server link: removed only as a strict duplicate of a linked item, after confirmation', async () => {
    const accountId = await createAccount('unlinked', { confirmed: false });
    const mailbox = await repo.withTransaction(cx => repo.ensureMailbox({ userId, accountId, folderName: 'INBOX', epoch: 9 }, cx), pool);
    const add = async ({ messageId, from = 'a@example.test', subject = 'Hello', hoursAgo = 2, folder = 'inbox', complete = true, uid = null }) => {
      const id = uuid();
      await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,message_id,from_address,to_addresses,subject,folder,import_complete,received_at)
        VALUES (?,?,?,?,?,'[]',?,?,?,UTC_TIMESTAMP() - INTERVAL ? HOUR)`, [id, userId, accountId, messageId, from, subject, folder, complete, hoursAgo]);
      if (uid) await repo.withTransaction(cx => repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid, emailId: id }, cx), pool);
      return id;
    };
    const linked = await add({ messageId: '<one@example.test>', uid: 1 });
    const duplicate = await add({ messageId: '<one@example.test>', from: 'A@Example.test', hoursAgo: 1, folder: 'sent' });
    const otherSubject = await add({ messageId: '<one@example.test>', subject: 'Hello again', hoursAgo: 1 });
    const lone = await add({ messageId: '<two@example.test>' });
    await add({ messageId: '<three@example.test>', uid: 2, complete: false });
    const incompleteTwin = await add({ messageId: '<three@example.test>' });
    const files = await storeFiles(duplicate);
    assert.equal((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).local_duplicates, 1);
    assert.equal((await prune(accountId)).unconfirmed, true);
    assert.equal(await emailCount(accountId), 6, 'Removal waits for confirmation');

    await pool.execute('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);
    assert.equal((await prune(accountId)).removed, 1);
    assert.equal(await one('SELECT id FROM emails WHERE id = ?', [duplicate]), undefined);
    for (const id of [linked, otherSubject, lone, incompleteTwin]) assert.ok(await one('SELECT id FROM emails WHERE id = ?', [id]), 'Kept');
    assert.equal(await exists(files.raw), false);
    assert.equal(await exists(files.attachment), false);
    assert.equal((await prune(accountId)).removed, 0, 'Nothing more to remove on a second run');
    assert.equal((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).local_duplicates, 0);
  });

  await t.test('Gmail without a visible All Mail keeps missing mail as archived and warns', async () => {
    const accountId = await createAccount('hidden', { host: 'imap.gmail.com' });
    deliver('INBOX', 1, { gmailMsgId: '7001' }, { gmail: true });
    await scan(accountId, 'INBOX', 'presence');
    const item = (await itemAt(accountId, 'INBOX', 1)).email_id;
    assert.deepEqual(await policy.syncWarnings(await load(accountId)), [policy.SYNC_WARNING_GMAIL_ALL_MAIL_HIDDEN]);
    provider.get('INBOX').items.delete(1);
    await scan(accountId, 'INBOX', 'presence');
    const result = await prune(accountId);
    assert.equal(result.removed, 0);
    assert.equal(result.filed, 1);
    assert.deepEqual(await one('SELECT folder, remote_missing FROM emails WHERE id = ?', [item]), { folder: 'archive', remote_missing: 1 });
    const impact = await policy.computeModeImpact(await load(accountId), { mode: 'sync' });
    assert.equal(impact.local_only, 0);
    assert.ok(impact.notes.some(note => /Show in IMAP/.test(note)));
    const { membershipCountQuery } = require('../src/services/mail-folder-view');
    const counts = await rows(membershipCountQuery('emails.is_read', accountId), [userId, accountId]);
    assert.deepEqual(counts.map(row => [row.folder, Number(row.total_count)]), [['archive', 1]], 'Shown in the local Archive view');
    // Once All Mail is visible, absence from every mailbox proves deletion.
    box('[Gmail]/All Mail', { gmail: true });
    await scan(accountId, '[Gmail]/All Mail', 'recent');
    assert.deepEqual(await policy.syncWarnings(await load(accountId)), []);
    assert.equal((await prune(accountId)).removed, 1);
    for (const name of ['INBOX', '[Gmail]/All Mail']) provider.delete(name);
  });

  await t.test('Retention windows: old mail is not imported, existing old copies are removed after confirmation', async () => {
    const accountId = await createAccount('retention', { confirmed: false, syncWindow: 30, trashWindow: 14 });
    deliver('INBOX', 1, { internalDate: daysAgo(5) }); deliver('INBOX', 2, { internalDate: daysAgo(100) });
    deliver('Trash', 1, { internalDate: daysAgo(20) }); deliver('Trash', 2, { internalDate: daysAgo(3) });
    const inbox = await scan(accountId, 'INBOX', 'recent');
    assert.deepEqual([inbox.inserted, inbox.skipped], [1, 1]);
    const trash = await scan(accountId, 'Trash', 'recent');
    assert.deepEqual([trash.inserted, trash.skipped], [1, 1], 'Trash uses its own, shorter window');
    assert.equal(await itemAt(accountId, 'INBOX', 2), null, 'Outside the window: not imported, no body queued');
    assert.equal(await emailCount(accountId), 2);
    // Copies imported before the window was chosen.
    const oldInbox = uuid(), oldTrash = uuid();
    for (const [id, folder, uid, age] of [[oldInbox, 'INBOX', 3, 200], [oldTrash, 'Trash', 4, 20]]) {
      deliver(folder, uid, { internalDate: daysAgo(age) });
      await pool.execute("INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder) VALUES (?,?,?,'r@example.test','[]','inbox')", [id, userId, accountId]);
      const mailbox = await repo.withTransaction(cx => repo.ensureMailbox({ userId, accountId, folderName: folder, epoch: 9 }, cx), pool);
      await repo.withTransaction(cx => repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid, emailId: id, internalDate: daysAgo(age) }, cx), pool);
    }
    const impact = await policy.computeModeImpact(await load(accountId), { mode: 'sync' });
    assert.deepEqual([impact.outside_window, impact.outside_trash_window, impact.total_removals], [1, 1, 2]);
    const wider = await policy.computeModeImpact(await load(accountId), { mode: 'sync', syncWindowDays: null, trashWindowDays: null });
    assert.equal(wider.total_removals, 0, 'All mail keeps everything');
    assert.equal((await prune(accountId)).removed, 0, 'Unconfirmed: nothing removed');
    await pool.execute('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);
    assert.equal((await prune(accountId)).removed, 2);
    assert.equal(await one('SELECT id FROM emails WHERE id IN (?,?)', [oldInbox, oldTrash]), undefined);
    assert.equal(await emailCount(accountId), 2);
    // The server keeps them; a later sweep does not import them again.
    await scan(accountId, 'INBOX', 'presence');
    assert.equal(await emailCount(accountId), 2);

    const download = await createAccount('retention-download', { mode: 'download', confirmed: false, syncWindow: 14, trashWindow: 14 });
    const imported = await scan(download, 'INBOX', 'recent');
    assert.deepEqual([imported.inserted, imported.skipped], [3, 0], 'Download mode ignores windows');
    for (const name of ['INBOX', 'Trash']) provider.delete(name);
  });

  await t.test('HTTP: account fields, mode impact, typed-address switch, confirmation and account backup', async () => {
    // Jobs queued by the engine subtests above belong to accounts without credentials.
    await pool.execute("UPDATE mail_engine_jobs SET state = 'cancelled', completed_at = UTC_TIMESTAMP() WHERE state = 'queued'");
    isolated = createBackupRuntime(directory, 'sync-policy-synthetic-key', pool);
    await isolated('services/database').ensureSchema();
    const password = 'sync-policy-fixture-password-2026';
    const hash = await require('bcryptjs').hash(password, 10);
    const ownerId = uuid();
    await pool.execute('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [ownerId, 'http-owner@example.test', hash, 'Owner']);
    const seed = async (address, mode, confirmed) => {
      const id = uuid();
      await pool.execute(`INSERT INTO mail_accounts (id,user_id,email_address,provider,imap_host,sync_mode,is_active,sync_policy_confirmed_at)
        VALUES (?,?,?,'custom','imap.example.test',?,TRUE,${confirmed ? 'UTC_TIMESTAMP()' : 'NULL'})`, [id, ownerId, address, mode]);
      return id;
    };
    const switching = await seed('switch@example.test', 'download', false);
    const other = await seed('other@example.test', 'download', false);
    const upgraded = await seed('upgraded@example.test', 'sync', false);
    const mail = async (accountId, extra = '') => {
      const id = uuid();
      await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder${extra ? ',remote_missing' : ''})
        VALUES (?,?,?,'h@example.test','[]','inbox'${extra ? ',TRUE' : ''})`, [id, ownerId, accountId]);
      return id;
    };
    const switchingMail = [await mail(switching), await mail(switching)];
    await mail(other);
    const missing = await mail(upgraded, 'missing');

    server = http.createServer((req, res) => isolated('request-handler').handleRequest(req, res).catch(error => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const cookies = new Map(); let csrf;
    const call = async (method, route, body, expected = 200, binary = false) => {
      const response = await fetch(base + route, { method, headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${binary ? '' : JSON.stringify(result)}`);
      if (result.csrfToken) csrf = result.csrfToken;
      return result;
    };
    const waitFor = async (check, label) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.fail(`Timed out: ${label}`);
    };
    await call('POST', '/auth/signin', { email: 'http-owner@example.test', password });
    await call('GET', '/auth/me');

    const listed = (await call('GET', '/mail/accounts')).accounts;
    const byId = id => listed.find(account => account.id === id);
    assert.deepEqual([byId(switching).sync_window_days, byId(switching).trash_window_days, byId(switching).sync_policy_confirmed,
      byId(switching).sync_policy_pending_removals], [null, 30, false, null]);
    assert.deepEqual([byId(upgraded).sync_policy_confirmed, byId(upgraded).sync_policy_pending_removals], [false, 1]);
    assert.equal(byId(upgraded).sync_policy_confirmed_at, undefined);
    assert.deepEqual(byId(upgraded).sync_warnings, []);
    assert.equal((await call('GET', `/mail/accounts/${upgraded}`)).account.sync_policy_pending_removals, 1);

    const impact = await call('GET', `/mail/accounts/${switching}/mode-impact?mode=sync&sync_window_days=&trash_window_days=30`);
    assert.deepEqual(Object.keys(impact).sort(), ['gmail_duplicates', 'local_duplicates', 'local_only', 'mode', 'notes', 'outside_trash_window', 'outside_window', 'total_removals']);
    assert.equal(impact.total_removals, 0);
    assert.equal((await call('GET', `/mail/accounts/${switching}/mode-impact?mode=download`)).total_removals, 0);
    await call('GET', `/mail/accounts/${switching}/mode-impact?mode=sync&sync_window_days=7`, undefined, 400);
    await call('GET', `/mail/accounts/${uuid()}/mode-impact?mode=sync`, undefined, 404);

    const refused = await call('PUT', `/mail/accounts/${switching}`, { sync_mode: 'sync', sync_mode_confirmed: true, sync_window_days: '', trash_window_days: 30 }, 400);
    assert.equal(refused.requires_confirmation, true);
    await call('PUT', `/mail/accounts/${switching}`, { sync_mode: 'sync', sync_mode_confirmed: true, confirm_address: 'other@example.test' }, 400);
    assert.equal((await load(switching)).sync_mode, 'download');
    const switched = await call('PUT', `/mail/accounts/${switching}`, { sync_mode: 'sync', sync_mode_confirmed: true,
      confirm_address: ' SWITCH@example.test ', sync_window_days: '90', trash_window_days: '' });
    assert.deepEqual([switched.account.sync_mode, switched.account.sync_policy_confirmed, switched.account.sync_window_days, switched.account.trash_window_days],
      ['sync', true, 90, null]);
    const back = await call('PUT', `/mail/accounts/${switching}`, { sync_mode: 'download', sync_window_days: 90, trash_window_days: '' });
    assert.match(back.message, /Nothing is deleted/);
    assert.equal(back.account.sync_policy_confirmed, false);
    assert.equal((await load(switching)).sync_policy_confirmed_at, null);
    assert.equal(await emailCount(switching), 2, 'Leaving Sync deletes nothing');

    assert.deepEqual(await call('POST', `/mail/accounts/${upgraded}/confirm-sync-policy`, { confirm_address: 'wrong@example.test' }, 400),
      { error: 'Type the account email address to confirm.' });
    await call('POST', `/mail/accounts/${switching}/confirm-sync-policy`, { confirm_address: 'switch@example.test' }, 409);
    assert.deepEqual(await call('POST', `/mail/accounts/${upgraded}/confirm-sync-policy`, { confirm_address: 'Upgraded@example.test' }),
      { confirmed: true, queued: true });
    await waitFor(async () => !(await one('SELECT id FROM emails WHERE id = ?', [missing])), 'background prune job removes the confirmed account\'s missing mail');
    const confirmed = (await call('GET', `/mail/accounts/${upgraded}`)).account;
    assert.deepEqual([confirmed.sync_policy_confirmed, confirmed.sync_policy_pending_removals], [true, null]);

    const started = await call('POST', `/mail/accounts/${switching}/backup-export`, { encrypt: false }, 202);
    assert.equal(started.job.mail_account_id, switching);
    assert.deepEqual(started.job.requested_sections, ['mail']);
    await call('POST', `/mail/accounts/${uuid()}/backup-export`, {}, 404);
    await waitFor(async () => {
      const { job } = await call('GET', `/backup/jobs/${started.job.id}`);
      assert.notEqual(job.status, 'failed', job.error);
      return job.status === 'ready';
    }, 'account backup ready');
    const archive = await call('GET', `/backup/jobs/${started.job.id}/download`, undefined, 200, true);
    const entries = isolated('services/backup-zip-reader').readZipEntries(archive);
    const backup = JSON.parse(entries.get('data/backup.json').toString('utf8'));
    assert.deepEqual(backup.data.mail_accounts.map(account => account.id), [switching]);
    assert.deepEqual(backup.data.emails.map(email => email.id).sort(), [...switchingMail].sort(), 'Only this account\'s mail');
    assert.deepEqual(backup.data.mail_command_receipts, []);
    assert.equal(backup.data.contacts, undefined, 'Mail section only');
  });
});
