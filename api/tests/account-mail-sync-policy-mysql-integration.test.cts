'use strict';
import type { FixtureValue, With } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
// Disposable MySQL 8 schema ending _test. Sync mode follows the server:
// proven absence, Gmail label merging, retention windows, the per-account
// confirmation gate and its HTTP API, against real SQL and real files.
// Named to sort before database-startup smoke, which leaves a populated schema.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

const uuid = () => crypto.randomUUID();
const daysAgo = (n: FixtureValue) => new Date(Date.now() - n * 86400000).toISOString();
const exists = (file: FixtureValue) => fs.access(file).then(() => true, () => false);

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
  const state = require('../dist/src/state') as typeof import('../src/state'), previousDb = state.getDb();
  const rows = async (sql: string, params: FixtureValue[] = []) => (await pool.execute<RowDataPacket[]>(sql, params))[0];
  const one = async (sql: string, params: FixtureValue[] = []) => (await rows(sql, params))[0];
  let ownsSchema = false, server: FixtureValue = null, isolated: FixtureValue = null;
  t.after(async () => {
    try {
      if (isolated) await isolated('services/mail-durable-jobs').durableScheduler.stop();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      if (ownsSchema) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const row of (await cx.query<RowDataPacket[]>('SHOW TABLES'))[0]) {
            const name = Object.values(row)[0]; assert.match((name as string), /^[a-z_]+$/);
            await cx.query(`DROP TABLE \`${name}\``);
          }
        } finally { await cx.query('SET FOREIGN_KEY_CHECKS = 1'); cx.release(); }
      }
    } finally {
      state.setDb(previousDb); await pool.end();
      for (const [key, value] of [['MAIL_RAW_STORAGE_ROOT', previousEnv.raw], ['MAIL_ATTACHMENT_UPLOAD_ROOT', previousEnv.attachments]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  assert.match((await one('SELECT VERSION() AS version')).version, /MariaDB/);
  assert.equal(((await rows('SHOW TABLES'))).length, 0, 'Refuse a populated schema');
  ownsSchema = true; state.setDb(pool);
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'sync-policy-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-sync-policy-bootstrap-password';
  await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();
  const repo = require('../dist/src/services/mail-engine/repository') as typeof import('../src/services/mail-engine/repository');
  const transport = require('../dist/src/services/mail-engine/transport') as typeof import('../src/services/mail-engine/transport');
  const { scanMailboxSlice } = require('../dist/src/services/mail-engine/sync') as typeof import('../src/services/mail-engine/sync');
  const policy = require('../dist/src/services/mail-sync-policy') as typeof import('../src/services/mail-sync-policy');

  // Synthetic provider: folder -> { epoch, next, gmail, items: uid -> message }.
  const provider = new Map();
  const box = (name: FixtureValue, { gmail = false, epoch = 9 } = {}) => {
    if (!provider.has(name)) provider.set(name, { epoch, next: 1, gmail, items: new Map() });
    return provider.get(name);
  };
  const deliver = (name: FixtureValue, uid: FixtureValue, message: FixtureValue, options?: FixtureValue) => {
    const mailbox = box(name, options);
    mailbox.items.set(uid, { flags: [], gmailMsgId: null, internalDate: daysAgo(1), ...message });
    mailbox.next = Math.max(mailbox.next, uid + 1);
  };
  t.mock.method(transport, 'selectMailbox', async (connection: FixtureValue, { folder }: FixtureValue) => {
    const mailbox = box(folder);
    return { folder, uidvalidity: mailbox.epoch, uidnext: mailbox.next, highestmodseq: null, nomodseq: true, readOnly: true,
      capabilities: { move: true, condstore: false, uidplus: true, xGmExt1: mailbox.gmail } };
  });
  t.mock.method(transport, 'fetchMetadataWindow', async (connection: FixtureValue, { folder, uidvalidity, startUid, endUid }: FixtureValue) => {
    const mailbox = box(folder);
    assert.equal(uidvalidity, mailbox.epoch);
    const items = [...mailbox.items].filter(([uid]) => uid >= startUid && uid <= endUid).sort((a, b) => a[0] - b[0])
      .map(([uid, item]) => ({ uid, flags: [...item.flags], modseq: null, gmailMsgId: mailbox.gmail ? item.gmailMsgId : null, internalDate: item.internalDate }));
    return { folder, uidvalidity, startUid, endUid, items, complete: true, bytes: 0 };
  });

  const userId = uuid();
  await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'sync-policy-owner@example.test', 'synthetic']);
  async function createAccount(label: string, { mode = 'sync', confirmed = true, syncWindow = null, trashWindow = 30, host = 'imap.example.test' }: FixtureValue = {}) {
    const id = uuid();
    await pool.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id,user_id,email_address,provider,imap_host,sync_mode,is_active,
        sync_window_days,trash_window_days,sync_policy_confirmed_at)
      VALUES (?,?,?,'custom',?,?,TRUE,?,?,${confirmed ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [id, userId, `${label}@example.test`, host, mode, syncWindow, trashWindow]);
    return id;
  }
  const load = (id: FixtureValue) => one('SELECT * FROM mail_accounts WHERE id = ?', [id]) as Promise<Parameters<typeof policy.computeModeImpact>[0]>;
  const specialUses: FixtureValue = { 'Trash': 'trash', '[Gmail]/All Mail': 'all', '[Gmail]/Trash': 'trash' };
  async function scan(accountId: string, folderName: FixtureValue, stream: FixtureValue, { fresh = true }: FixtureValue = {}) {
    if (fresh) await pool.execute<ResultSetHeader>('DELETE FROM mail_engine_cursors WHERE mail_account_id = ?', [accountId]);
    let result;
    do {
      result = await scanMailboxSlice({ db: pool, connection: {} as FixtureValue, account: await load(accountId) as Parameters<typeof scanMailboxSlice>[0]['account'],
        folder: { folderName, dbFolderName: 'inbox', specialUse: specialUses[folderName] }, stream });
    } while (result.more);
    return result;
  }
  const itemAt = async (accountId: string, folderName: FixtureValue, uid: FixtureValue) => (await one(`SELECT o.email_id, o.presence FROM mail_remote_occurrences o
    JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id WHERE o.mail_account_id = ? AND m.remote_name = ? AND o.uid = ?`,
  [accountId, folderName, uid])) || null;
  const emailCount = async (accountId: string) => Number((await one('SELECT COUNT(*) AS n FROM emails WHERE mail_account_id = ?', [accountId])).n);
  const prune = async (accountId: string) => {
    const total: FixtureValue = { removed: 0, filed: 0, merged: 0 };
    let result;
    do {
      result = await policy.runPruneSlice({ account: await load(accountId) });
      for (const key of Object.keys(total)) total[key] += Number(result[key as keyof typeof result] || 0);
    } while (result.more);
    return { ...result, ...total };
  };
  async function storeFiles(emailId: string) {
    const raw = path.join((process.env.MAIL_RAW_STORAGE_ROOT as string), userId, `${emailId}.eml`);
    const attachment = path.join((process.env.MAIL_ATTACHMENT_UPLOAD_ROOT as string), userId, `${emailId}-note.txt`);
    for (const file of [raw, attachment]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'synthetic'); }
    await pool.execute<ResultSetHeader>('UPDATE emails SET raw_storage_path = ? WHERE id = ?', [raw, emailId]);
    await pool.execute<ResultSetHeader>(`INSERT INTO email_attachments (id,email_id,user_id,filename,content_type,size_bytes,storage_path)
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
    assert.equal(((await rows("SELECT id FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'prune' AND state = 'queued'", [accountId]))).length, 1,
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
    const mailbox = await repo.withTransaction((cx) => repo.ensureMailbox({ userId, accountId: download, folderName: 'INBOX', epoch: 9 }, cx), pool);
    const archived = uuid(), serverDeleted = uuid();
    for (const [id, uid] of [[archived, 1], [serverDeleted, 2]] as const) {
      await pool.execute<ResultSetHeader>("INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder) VALUES (?,?,?,'a@example.test','[]','inbox')", [id, userId, download]);
      await repo.withTransaction((cx) => repo.upsertOccurrence({ userId, accountId: download, mailboxId: mailbox.id, epoch: 9, uid, emailId: id }, cx), pool);
    }
    await pool.execute<ResultSetHeader>("UPDATE mail_remote_occurrences SET presence = 'absent' WHERE email_id = ?", [archived]);
    await pool.execute<ResultSetHeader>("INSERT INTO mail_server_messages (user_id,mail_account_id,email_id,source_folder,imap_uid,delete_status) VALUES (?,?,?,'INBOX',2,'deleted')",
      [userId, download, serverDeleted]);
    assert.equal((await prune(download)).skipped, 'download_mode');
    assert.equal(await emailCount(download), 2, 'Download mode never removes local mail');
    const toSync = await policy.computeModeImpact(await load(download), { mode: 'sync' });
    assert.equal(toSync.local_only, 2, 'Switching would remove mail missing on the server, including mail UniHub deleted there');
    assert.ok(toSync.notes.some((note) => /not counted yet/.test(note)));
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
    await pool.execute<ResultSetHeader>('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [upgraded]);
    assert.equal(await policy.pendingRemovals(await load(upgraded)), null);
    assert.equal((await prune(upgraded)).removed, 1);
    provider.delete('INBOX');
  });

  await t.test('Gmail: one item per X-GM-MSGID; copies merged after confirmation; All Mail keeps archived mail', async () => {
    const accountId = await createAccount('gmail', { confirmed: false, host: 'imap.gmail.com' });
    const gmail = { gmail: true };
    for (const [folder, uid] of [['INBOX', 5], ['Work', 7], ['[Gmail]/All Mail', 50]] as const) deliver(folder, uid, { gmailMsgId: '9001', flags: ['\\Seen'] }, gmail);
    // Copies imported per label before 0.12 read X-GM-MSGID.
    const keeper = uuid(), copy = uuid();
    await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,import_complete,content_state,is_read,created_at)
      VALUES (?,?,?,'g@example.test','[]','inbox',TRUE,'complete',FALSE,UTC_TIMESTAMP() - INTERVAL 1 DAY),
             (?,?,?,'g@example.test','[]','work',FALSE,'queued',FALSE,UTC_TIMESTAMP())`, [keeper, userId, accountId, copy, userId, accountId]);
    for (const [folder, uid, emailId] of [['INBOX', 5, keeper], ['Work', 7, copy]] as const) {
      const mailbox = await repo.withTransaction((cx) => repo.ensureMailbox({ userId, accountId, folderName: folder, epoch: 9 }, cx), pool);
      await repo.withTransaction((cx) => repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid, emailId,
        gmailMsgId: '9001', flags: ['\\Seen'] }, cx), pool);
    }
    const operation = uuid();
    await pool.execute<ResultSetHeader>(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,remote_folder,remote_uid,remote_uidvalidity,status,state)
      VALUES (?,?,?,?,'read','1','0','Work',7,9,'done','confirmed')`, [operation, userId, accountId, copy]);
    // A task made from the copy the merge removes, deleted into the bin.
    const list = uuid(), listAccount = uuid(), binnedTask = uuid();
    await pool.execute("INSERT INTO calendar_accounts (id,user_id,provider,display_name) VALUES (?,?,'local','UniHub')", [listAccount, userId]);
    await pool.execute("INSERT INTO calendar_calendars (id,user_id,account_id,name) VALUES (?,?,?,'Gmail tasks')", [list, userId, listAccount]);
    await pool.execute(`INSERT INTO calendar_events (id,user_id,calendar_id,title,start_time,end_time,is_todo_only,source_email_id,source_email_json)
      VALUES (?,?,?,'Reply to the label copy','2030-01-01 10:00:00','2030-01-01 11:00:00',TRUE,?,?)`, [binnedTask, userId, list, copy, JSON.stringify({ subject: 'Labelled mail' })]);
    await (require('../dist/src/services/transactions') as typeof import('../src/services/transactions'))
      .withTransaction(cx => (require('../dist/src/services/bin-calendar') as typeof import('../src/services/bin-calendar')).binLocalEvents(cx, userId, [binnedTask]));
    const files = await storeFiles(copy);
    assert.equal(((await rows("SELECT source_id FROM mail_engine_quarantine WHERE mail_account_id = ? AND reason = 'gmail_identity_conflict'", [accountId]))).length, 1);
    await scan(accountId, '[Gmail]/All Mail', 'recent');
    assert.equal(await emailCount(accountId), 2, 'An All Mail occurrence joins the known item, never a new one');
    assert.equal((await itemAt(accountId, '[Gmail]/All Mail', 50)).email_id, keeper);
    assert.deepEqual(await policy.syncWarnings(await load(accountId)), []);
    assert.equal((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).gmail_duplicates, 1);
    await pool.execute<ResultSetHeader>('UPDATE emails SET is_read = FALSE WHERE id = ?', [keeper]);
    assert.equal((await prune(accountId)).merged, 0, 'Merging is destructive and waits for confirmation');
    assert.equal(await emailCount(accountId), 2);

    await pool.execute<ResultSetHeader>('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);
    // A synced task made from the same copy, in the bin; its server object is back already (another app restored it), as a row without UniHub's state.
    const davAccount = uuid(), davCalendar = uuid(), object = uuid(), returned = uuid(), syncedBin = uuid(), syncedUid = 'gmail-merge-race@example.test';
    const href = '/dav/team/merge-race.ics';
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${syncedUid}`, 'DTSTART:20301110T100000Z', 'DTEND:20301110T110000Z', 'SUMMARY:Merge race', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
    await pool.execute(`INSERT INTO calendar_accounts (id,user_id,provider,display_name,account_email,username,encrypted_password,base_url,is_active)
      VALUES (?,?,'caldav','Team','person@example.test','person',?,'https://dav.example.test/',1)`, [davAccount, userId, encrypt('synthetic-dav-password')]);
    await pool.execute("INSERT INTO calendar_calendars (id,user_id,account_id,name,external_id) VALUES (?,?,?,'Team','https://dav.example.test/dav/team/')", [davCalendar, userId, davAccount]);
    await pool.execute('INSERT INTO calendar_remote_objects (id,user_id,account_id,calendar_id,href,href_hash,uid,ics) VALUES (?,?,?,?,?,?,?,?)',
      [object, userId, davAccount, davCalendar, href, crypto.createHash('sha256').update(href).digest('hex'), syncedUid, ics]);
    await pool.execute("INSERT INTO calendar_events (id,user_id,calendar_id,uid,title,start_time,end_time) VALUES (?,?,?,?,'Merge race','2030-11-10 10:00:00','2030-11-10 11:00:00')",
      [returned, userId, davCalendar, syncedUid]);
    await pool.execute("INSERT INTO calendar_event_external_refs (id,user_id,event_id,calendar_id,account_id,provider,external_event_id,remote_object_id) VALUES (?,?,?,?,?,'caldav',?,?)",
      [uuid(), userId, returned, davCalendar, davAccount, `${object}|`, object]);
    const syncedState = { todo_status: 'done', done_at: '2030-11-10 12:00:00', source_email_id: copy, source_email_json: { subject: 'Labelled mail' }, subtasks: [] };
    await pool.execute("INSERT INTO bin_items (id,user_id,module,item_type,item_id,title,reason,payload,payload_version) VALUES (?,?,'calendar','task',?,'Merge race','deleted',?,1)",
      [syncedBin, userId, uuid(), JSON.stringify({ provider: 'caldav', origin: 'Team', calendar: { id: davCalendar, account_id: davAccount, external_id: 'https://dav.example.test/dav/team/', name: 'Team' },
        object: { href, uid: syncedUid, ics }, event: { title: 'Merge race', source_email_id: copy }, subtasks: [], attendees: [], task_order: [], occurrences: [{ recurrence_id: '', state: syncedState }] })]);
    // Its restore reads the item and waits for the account's login; the merge runs meanwhile.
    const calendarSync = require('../dist/src/services/calendar-sync') as FixtureValue;
    const realLogin = calendarSync.resolveLogin;
    let atLogin!: () => void, goOn!: () => void;
    const loginReached = new Promise<void>(resolve => { atLogin = resolve; }), loginAllowed = new Promise<void>(resolve => { goOn = resolve; });
    calendarSync.resolveLogin = async (account: FixtureValue) => { atLogin(); await loginAllowed; return realLogin(account); };
    let merged: FixtureValue, restoring: Promise<FixtureValue> | null = null;
    try {
      restoring = (require('../dist/src/services/bin') as typeof import('../src/services/bin')).restoreFromBin(userId, { ids: [syncedBin] });
      await loginReached;
      merged = await prune(accountId);
      const waiting = JSON.parse((await one('SELECT payload FROM bin_items WHERE id = ?', [syncedBin])).payload);
      assert.equal(waiting.occurrences[0].state.source_email_id, keeper, 'the merge pointed the waiting item at the kept copy');
      goOn();
      assert.deepEqual((await restoring).failed, []);
    } finally { goOn(); calendarSync.resolveLogin = realLogin; await restoring?.catch(() => undefined); }
    const adopted = await one('SELECT todo_status, source_email_id FROM calendar_events WHERE id = ?', [returned]);
    assert.deepEqual([adopted.todo_status, adopted.source_email_id], ['done', keeper], 'the returned task takes its state with the kept copy, not the removed one');
    assert.equal(merged.merged, 1);
    assert.equal(await emailCount(accountId), 1);
    assert.deepEqual(((await rows('SELECT DISTINCT email_id FROM mail_remote_occurrences WHERE mail_account_id = ?', [accountId]))).map((row) => row.email_id), [keeper]);
    assert.equal((await one('SELECT email_id FROM mail_writebacks WHERE id = ?', [operation])).email_id, keeper, 'Operation history re-pointed');
    assert.equal((await one("SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND gmail_msgid = '9001'", [accountId])).email_id, keeper);
    assert.equal((await one('SELECT is_read FROM emails WHERE id = ?', [keeper])).is_read, 1, 'Read state from the server');
    assert.equal(((await rows("SELECT source_id FROM mail_engine_quarantine WHERE mail_account_id = ? AND reason = 'gmail_identity_conflict'", [accountId]))).length, 0);
    assert.equal(await exists(files.raw), false);
    assert.equal(await exists(files.attachment), false);
    // The binned task names the kept copy, and comes back from the bin linked to it.
    const binned = await one("SELECT id, payload FROM bin_items WHERE user_id = ? AND item_id = ?", [userId, binnedTask]);
    assert.equal(JSON.parse(binned.payload).event.source_email_id, keeper, 'the bin follows the merge');
    const bin = require('../dist/src/services/bin') as typeof import('../src/services/bin');
    assert.deepEqual((await bin.restoreFromBin(userId, { ids: [binned.id] })).failed, []);
    assert.equal((await one('SELECT source_email_id FROM calendar_events WHERE id = ?', [binnedTask])).source_email_id, keeper);

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
    const mailbox = await repo.withTransaction((cx) => repo.ensureMailbox({ userId, accountId, folderName: 'INBOX', epoch: 9 }, cx), pool);
    const add = async ({ messageId, from = 'a@example.test', subject = 'Hello', hoursAgo = 2, folder = 'inbox', complete = true, uid = null }: FixtureValue) => {
      const id = uuid();
      await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,message_id,from_address,to_addresses,subject,folder,import_complete,received_at)
        VALUES (?,?,?,?,?,'[]',?,?,?,UTC_TIMESTAMP() - INTERVAL ? HOUR)`, [id, userId, accountId, messageId, from, subject, folder, complete, hoursAgo]);
      if (uid) await repo.withTransaction((cx) => repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid, emailId: id }, cx), pool);
      return id;
    };
    const linked = await add({ messageId: '<one@example.test>', uid: 1 });
    const duplicate = await add({ messageId: '<one@example.test>', from: 'A@Example.test', hoursAgo: 1, folder: 'sent' });
    const otherSubject = await add({ messageId: '<one@example.test>', subject: 'Hello again', hoursAgo: 1 });
    const lone = await add({ messageId: '<two@example.test>' });
    await add({ messageId: '<three@example.test>', uid: 2, complete: false });
    const incompleteTwin = await add({ messageId: '<three@example.test>' });
    const files = await storeFiles(duplicate);
    assert.equal(((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })) as FixtureValue).local_duplicates, 1);
    assert.equal((await prune(accountId)).unconfirmed, true);
    assert.equal(await emailCount(accountId), 6, 'Removal waits for confirmation');

    await pool.execute<ResultSetHeader>('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);
    assert.equal((await prune(accountId)).removed, 1);
    assert.equal(await one('SELECT id FROM emails WHERE id = ?', [duplicate]), undefined);
    for (const id of [linked, otherSubject, lone, incompleteTwin]) assert.ok(await one('SELECT id FROM emails WHERE id = ?', [id]), 'Kept');
    assert.equal(await exists(files.raw), false);
    assert.equal(await exists(files.attachment), false);
    assert.equal((await prune(accountId)).removed, 0, 'Nothing more to remove on a second run');
    assert.equal(((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })) as FixtureValue).local_duplicates, 0);
  });

  // Two copies of one message as imported per label before 0.12: a (older,
  // holding the Gmail mapping) under INBOX and b under Work.
  const gmailBoxes = new Map<string, FixtureValue>();
  let gmailUid = 100;
  async function gmailCopies(accountId: string, gmailMsgId: string, { a = {}, b = {} }: FixtureValue = {}) {
    const ids: FixtureValue = {};
    for (const [key, folder, extra, age] of [['a', 'INBOX', a, 2], ['b', 'Work', b, 1]] as const) {
      if (!gmailBoxes.has(accountId + folder)) gmailBoxes.set(accountId + folder, await repo.withTransaction((cx) => repo.ensureMailbox({ userId, accountId, folderName: folder, epoch: 9 }, cx), pool));
      const id = ids[key] = uuid();
      const row = { import_complete: 1, content_state: 'complete', ...extra };
      await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,subject,folder,import_complete,content_state,
          is_draft,snoozed_until,snooze_returned_at,created_at) VALUES (?,?,?,'g@example.test','[]',?,'inbox',?,?,?,?,?,UTC_TIMESTAMP() - INTERVAL ? DAY)`,
      [id, userId, accountId, `Held ${gmailMsgId}`, row.import_complete, row.content_state, row.is_draft || 0, row.snoozed_until || null, row.snooze_returned_at || null, age]);
      await repo.withTransaction((cx) => repo.upsertOccurrence({ userId, accountId, mailboxId: gmailBoxes.get(accountId + folder).id, epoch: 9, uid: gmailUid++, emailId: id, gmailMsgId }, cx), pool);
    }
    return ids;
  }
  const copiesLeft = async (ids: FixtureValue) => (await rows('SELECT id FROM emails WHERE id IN (?, ?)', [ids.a, ids.b])).map(row => row.id === ids.a ? 'a' : 'b').sort();

  await t.test('Gmail merge: the returned snooze and filing history of a removed copy go to the kept copy; the count is what the merge does; an incomplete kept copy gets its content; a pending notice or snooze waits, a delivered notice stays', async () => {
    const accountId = await createAccount('gmail-held', { host: 'imap.gmail.com' });
    const plain = await gmailCopies(accountId, '7100');
    // A draft copy is never merged, and so not counted.
    const draft = await gmailCopies(accountId, '7103', { b: { is_draft: 1 } });
    // b's returned snooze and filing history go to a.
    const held = await gmailCopies(accountId, '7101', { b: { snooze_returned_at: '2026-01-01 09:00:00' } });
    await pool.execute<ResultSetHeader>(`INSERT INTO mail_folder_recovery_items (email_id,user_id,source_account_id,original_folder,target_folder,action)
      VALUES (?,?,?,'archive','archive','kept')`, [held.b, userId, accountId]);
    // Two different returned snoozes cannot both be kept: the copies stay apart.
    const twoSnoozes = await gmailCopies(accountId, '7102', { a: { snooze_returned_at: '2026-01-01 09:00:00' }, b: { snooze_returned_at: '2026-02-01 09:00:00' } });
    // A copy still snoozed waits for its return and its notice.
    const stillSnoozed = await gmailCopies(accountId, '7110', { b: { snoozed_until: '2030-01-01 09:00:00' } });
    // Neither copy complete, the kept one never queued (an old import): its content is queued now.
    const incomplete = await gmailCopies(accountId, '7104', { a: { import_complete: 0, content_state: 'legacy' }, b: { import_complete: 0, content_state: 'slow' } });
    // b's notice has nothing left to deliver: the copies merge, and the
    // notice stays as it was. A held arrival (its content still coming) waits.
    const notice = async (emailId: string, payload: FixtureValue = {}) => pool.execute<ResultSetHeader>(`INSERT INTO notification_events (id,user_id,event_key,kind,source_id,payload,expires_at)
      VALUES (?,?,SHA2(?,256),'mail',?,?,UTC_TIMESTAMP() + INTERVAL 1 DAY)`,
    [uuid(), userId, `mail:${emailId}`, emailId, JSON.stringify({ dedupeKey: `mail:${emailId}`, emailId, url: `/mail?email=${emailId}`, title: 'New Email', ...payload })]);
    const noticed = await gmailCopies(accountId, '7105');
    await notice(noticed.b);
    const arriving = await gmailCopies(accountId, '7111');
    await notice(arriving.b, { held: true });
    assert.equal((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).gmail_duplicates, 4, 'only the groups the merge joins');
    assert.equal((await prune(accountId)).merged, 4);
    assert.deepEqual(await copiesLeft(plain), ['a']);
    assert.deepEqual(await copiesLeft(draft), ['a', 'b']);
    assert.deepEqual(await copiesLeft(held), ['a']);
    assert.equal(new Date((await one('SELECT snooze_returned_at FROM emails WHERE id = ?', [held.a])).snooze_returned_at).toISOString(), '2026-01-01T09:00:00.000Z', 'the returned snooze stays');
    assert.equal((await one('SELECT email_id FROM mail_folder_recovery_items WHERE user_id = ?', [userId])).email_id, held.a, 'the filing history stays');
    assert.deepEqual(await copiesLeft(twoSnoozes), ['a', 'b']);
    assert.deepEqual(await copiesLeft(stillSnoozed), ['a', 'b']);
    assert.deepEqual(await copiesLeft(arriving), ['a', 'b']);
    assert.deepEqual(await copiesLeft(incomplete), ['a']);
    assert.equal((await one('SELECT content_state FROM emails WHERE id = ?', [incomplete.a])).content_state, 'queued');
    assert.ok(await one("SELECT id FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'body' AND state = 'queued'", [accountId]), 'its body is queued');
    assert.deepEqual(await copiesLeft(noticed), ['a']);
    const event = await one("SELECT JSON_VALUE(payload, '$.emailId') AS email FROM notification_events WHERE user_id = ? AND source_id = ?", [userId, noticed.b]);
    assert.equal(event?.email, noticed.b, 'the merge leaves notices to the notification worker');
    assert.equal((await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).gmail_duplicates, 0);
  });

  await t.test('Copies with a snooze notice on its way merge once it is delivered; every reminder goes out once', async () => {
    const accountId = await createAccount('gmail-snooze', { host: 'imap.gmail.com' });
    const due = '2026-01-01 09:00:00';
    const subscribe = async () => {
      const sessionId = uuid(), id = uuid();
      await pool.execute<ResultSetHeader>('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,UTC_TIMESTAMP() + INTERVAL 1 DAY)', [sessionId, userId, `synthetic-${sessionId}`]);
      await pool.execute<ResultSetHeader>(`INSERT INTO push_subscriptions (id,user_id,session_id,endpoint,endpoint_hash,p256dh,auth) VALUES (?,?,?,?,SHA2(?,256),'synthetic','synthetic')`,
        [id, userId, sessionId, `https://push.example.test/${sessionId}`, sessionId]);
      return id;
    };
    // b's snooze comes back. In the second message both copies' snoozes come
    // back with the same time, and a second device subscribes in between.
    const single = await gmailCopies(accountId, '7108', { b: { snoozed_until: due } });
    const both = await gmailCopies(accountId, '7109', { a: { snoozed_until: due }, b: { snoozed_until: '2030-01-01 09:00:00' } });
    const first = await subscribe();
    const impact = async () => (await policy.computeModeImpact(await load(accountId), { mode: 'sync' })).gmail_duplicates;
    assert.equal(await impact(), 0, 'a copy still snoozed waits');
    assert.equal((await prune(accountId)).merged, 0);
    const snooze = require('../dist/src/services/mail-snooze') as typeof import('../src/services/mail-snooze');
    const now = new Date();
    assert.equal((await snooze.returnDueSnoozes(now)).returned, 2);
    const second = await subscribe();
    await pool.execute<ResultSetHeader>('UPDATE emails SET snoozed_until = ? WHERE id = ?', [due, both.b]);
    assert.equal((await snooze.returnDueSnoozes(now)).returned, 1);
    const pending = await rows(`SELECT e.source_id, d.subscription_id FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
      WHERE e.user_id = ? AND e.kind = 'snooze' AND d.status = 'pending'`, [userId]);
    const key = (source: string, subscription: string) => `${source}/${subscription === first ? 'first' : 'second'}`;
    const expected = [key(single.b, first), key(both.a, first), key(both.b, first), key(both.b, second)].sort();
    assert.deepEqual(pending.map(row => key(row.source_id, row.subscription_id)).sort(), expected);

    // The real worker picks the deliveries and waits in the push transport
    // (a recording stub) while the merge runs: the merge keeps the copies
    // apart and touches no notice, so nothing is cancelled or lost.
    const transports = (require('../dist/src/services/notification-transports') as FixtureValue).NOTIFICATION_TRANSPORTS.webpush;
    const notifications = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
    const { ready, send } = transports;
    const sent: string[] = [];
    let atReady: () => void = () => {}, release: () => void = () => {}, paused = true;
    const picked = new Promise<void>(resolve => { atReady = resolve; }), mayGoOn = new Promise<void>(resolve => { release = resolve; });
    transports.ready = async () => { if (paused) { paused = false; atReady(); await mayGoOn; } };
    transports.send = async (target: FixtureValue, message: FixtureValue) => {
      if (message.kind === 'snooze') sent.push(key(message.payload.emailId, target.id));
      return { sent: true };
    };
    try {
      const working = notifications.processNotificationJobs();
      await picked;
      assert.equal((await prune(accountId)).merged, 0, 'a notice on its way keeps the copies apart');
      assert.equal(await impact(), 0);
      release();
      await working;
      assert.deepEqual([...sent].sort(), expected, 'every reminder once, for the copy it came back on');
      assert.deepEqual(await rows(`SELECT d.status FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        WHERE e.user_id = ? AND e.kind = 'snooze' AND d.status <> 'sent'`, [userId]), []);

      // Delivered: a later pass merges, and nothing is sent again.
      assert.equal(await impact(), 2);
      assert.equal((await prune(accountId)).merged, 2);
      assert.deepEqual([await copiesLeft(single), await copiesLeft(both)], [['a'], ['a']]);
      assert.ok((await one('SELECT snooze_returned_at FROM emails WHERE id = ?', [single.a])).snooze_returned_at, 'the kept copy came back from snooze');
      await notifications.processNotificationJobs();
      assert.equal((await snooze.returnDueSnoozes()).returned, 0);
      assert.deepEqual([...sent].sort(), expected, 'nothing more after the merge');
    } finally { paused = false; release(); transports.ready = ready; transports.send = send; }
  });

  await t.test('A snooze that comes back while a fenced prune job runs is delivered, before and after the merge', async () => {
    const accountId = await createAccount('gmail-fenced', { host: 'imap.gmail.com' });
    const engine = require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime');
    const snooze = require('../dist/src/services/mail-snooze') as typeof import('../src/services/mail-snooze');
    const notifications = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
    const transports = (require('../dist/src/services/notification-transports') as FixtureValue).NOTIFICATION_TRANSPORTS.webpush;
    const due = '2026-01-01 09:00:00';
    // All Mail is visible, so the slice goes straight to the merge.
    await repo.withTransaction((cx) => repo.ensureMailbox({ userId, accountId, folderName: '[Gmail]/All Mail', epoch: 9 }, cx), pool);
    // A prune slice of a claimed job: its fence is the transaction's first
    // read, so the transaction's snapshot is taken there.
    const fencedPrune = async () => {
      await engine.enqueueJob({ userId, accountId, kind: 'prune' });
      const job = await engine.claimDueJob({ workerId: 'sync-policy-fenced', accountId, kinds: ['prune'], leaseSeconds: 120 });
      assert.ok(job);
      try { return await policy.runPruneSlice({ account: await load(accountId), job }); }
      finally { await engine.completeJob({ accountId, jobId: job.id, workerId: job.lease_owner!, generation: Number(job.worker_generation) }); }
    };
    let onSql: ((phase: string, sql: string, params: FixtureValue[]) => Promise<void>) | null = null;
    const getConnection = pool.getConnection.bind(pool), watched = Symbol('watched');
    (pool as FixtureValue).getConnection = async () => {
      const cx: FixtureValue = await getConnection();
      if (!cx[watched]) {
        const execute = cx.execute.bind(cx);
        cx.execute = async (sql: string, params: FixtureValue[] = [], ...rest: FixtureValue[]) => {
          if (onSql) await onSql('before', String(sql), params);
          const result = await execute(sql, params, ...rest);
          if (onSql) await onSql('after', String(sql), params);
          return result;
        };
        cx[watched] = true;
      }
      return cx;
    };
    const signal = () => { let fire: () => void = () => {}; const fired = new Promise<void>(resolve => { fire = resolve; }); return { fired, fire }; };
    const { ready, send } = transports;
    const sent: string[] = [];
    transports.ready = async () => {};
    transports.send = async (target: FixtureValue, message: FixtureValue) => { if (message.kind === 'snooze') sent.push(`${message.payload.emailId}/${target.id}`); return { sent: true }; };
    // Every reminder goes out once, for the copy it came back on; a later
    // pass merges and nothing is sent again.
    const deliveredOnceThenMerged = async (ids: FixtureValue) => {
      const queued = (await rows(`SELECT d.subscription_id FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        WHERE e.user_id = ? AND e.kind = 'snooze' AND e.source_id = ? AND d.status = 'pending'`, [userId, ids.b])).map(row => `${ids.b}/${row.subscription_id}`).sort();
      assert.ok(queued.length, 'the return queued its reminder');
      await notifications.processNotificationJobs();
      assert.deepEqual(sent.filter(entry => entry.startsWith(ids.b)).sort(), queued);
      assert.equal((await prune(accountId)).merged, 1);
      assert.deepEqual(await copiesLeft(ids), ['a']);
      assert.ok((await one('SELECT snooze_returned_at FROM emails WHERE id = ?', [ids.a])).snooze_returned_at, 'the kept copy came back from snooze');
      await notifications.processNotificationJobs();
      assert.deepEqual(sent.filter(entry => entry.startsWith(ids.b)).sort(), queued, 'nothing more after the merge');
    };
    try {
      // The return holds b and has not committed when the job's slice takes
      // its snapshot; the merge waits for b and commits after the return. It
      // sees b's reminder on its way and keeps the copies apart.
      const overlap = await gmailCopies(accountId, '7112', { b: { snoozed_until: due } });
      const returning = signal(), returnMayCommit = signal(), merging = signal();
      onSql = async (phase, sql, params) => {
        if (phase === 'after' && sql.startsWith('UPDATE emails SET snoozed_until = NULL, snooze_returned_at') && params[1] === overlap.b) { returning.fire(); await returnMayCommit.fired; }
        if (phase === 'before' && sql.includes('SELECT e.id, e.import_complete')) merging.fire();
      };
      const returned = snooze.returnDueSnoozes();
      await returning.fired;
      const pruned = fencedPrune();
      await Promise.race([merging.fired, pruned]);
      await new Promise(resolve => setTimeout(resolve, 300));
      returnMayCommit.fire();
      assert.equal((await returned).returned, 1);
      assert.equal((await pruned).merged, 0, 'a reminder on its way keeps the copies apart');
      onSql = null;
      await deliveredOnceThenMerged(overlap);

      // A return that starts while the merge holds the copies waits for it;
      // the merge kept a copy still snoozed, so the return then goes ahead.
      const waiting = await gmailCopies(accountId, '7113', { b: { snoozed_until: due } });
      const planned = signal(), mergeMayCommit = signal();
      onSql = async (phase, sql) => {
        if (phase === 'after' && sql.includes('FROM notification_events n')) { planned.fire(); await mergeMayCommit.fired; }
      };
      const held = fencedPrune();
      await Promise.race([planned.fired, held]);
      let settled = false;
      const late = snooze.returnDueSnoozes().finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(settled, false, 'the return waits for the merge');
      mergeMayCommit.fire();
      assert.equal((await held).merged, 0, 'a copy still snoozed is kept');
      assert.equal((await late).returned, 1);
      onSql = null;
      await deliveredOnceThenMerged(waiting);
    } finally { onSql = null; (pool as FixtureValue).getConnection = getConnection; transports.ready = ready; transports.send = send; }
  });

  await t.test('A task made from a copy the Gmail merge removes meanwhile is refused, not linked to a missing email', async () => {
    const accountId = await createAccount('gmail-race', { host: 'imap.gmail.com' });
    const racing = await gmailCopies(accountId, '7106');
    // The create reads b, then waits while the merge removes b; its insert
    // then finds b gone. A create that locked b first is moved by the merge.
    const tasks = require('../dist/src/services/email-tasks') as typeof import('../src/services/email-tasks');
    const calendarRoutes = require('../dist/src/routes/calendar') as FixtureValue;
    const snapshot = tasks.snapshotSourceEmail;
    let reached: () => void = () => {}, release: () => void = () => {};
    const atSnapshot = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    (tasks as FixtureValue).snapshotSourceEmail = async (...args: FixtureValue[]) => { const result = await (snapshot as FixtureValue)(...args); reached(); await gate; return result; };
    let created: FixtureValue;
    try {
      const pending = calendarRoutes['POST /api/calendar/events']({ headers: { host: 'localhost' } }, userId, { title: 'Racing task', is_todo_only: true, source_email_id: racing.b });
      await atSnapshot;
      assert.equal((await prune(accountId)).merged, 1);
      release();
      created = await pending;
    } finally { (tasks as FixtureValue).snapshotSourceEmail = snapshot; release(); }
    assert.deepEqual(await copiesLeft(racing), ['a']);
    assert.equal(created.status, 404);
    assert.deepEqual(await rows("SELECT id FROM calendar_events WHERE user_id = ? AND title = 'Racing task'", [userId]), []);

    // An edit linking a task to b while the merge holds b and is about to
    // move b's tasks: the edit waits for b before it locks the task, then
    // finds b gone. Neither deadlocks, and the edit's other change stays.
    const editing = await gmailCopies(accountId, '7107');
    const taskId = uuid();
    await pool.execute<ResultSetHeader>(`INSERT INTO calendar_events (id,user_id,title,start_time,end_time,is_todo_only,source_email_id,source_email_json)
      VALUES (?,?,'Linked task',UTC_TIMESTAMP(),UTC_TIMESTAMP(),TRUE,?,?)`, [taskId, userId, editing.b, JSON.stringify({ subject: 'Held 7107' })]);
    let pausing = true, atTasks: () => void = () => {}, resume: () => void = () => {};
    const mergeAtTasks = new Promise<void>(resolve => { atTasks = resolve; }), mayGoOn = new Promise<void>(resolve => { resume = resolve; });
    const getConnection = pool.getConnection.bind(pool), paused = Symbol('paused');
    (pool as FixtureValue).getConnection = async () => {
      const cx: FixtureValue = await getConnection();
      if (!cx[paused]) {
        const execute = cx.execute.bind(cx);
        cx.execute = async (sql: string, ...rest: FixtureValue[]) => {
          if (pausing && String(sql).startsWith('UPDATE calendar_events SET source_email_id = ?')) { pausing = false; atTasks(); await mayGoOn; }
          return execute(sql, ...rest);
        };
        cx[paused] = true;
      }
      return cx;
    };
    let edited: FixtureValue, merging: FixtureValue;
    try {
      const pruning = prune(accountId);
      await mergeAtTasks;
      const pending = calendarRoutes['PUT /api/calendar/events/:id']({ url: `/api/calendar/events/${taskId}`, params: { id: taskId }, headers: { host: 'localhost' } },
        userId, { title: 'Edited task', source_email_id: editing.b });
      await new Promise(resolve => setTimeout(resolve, 300));
      resume();
      [edited, merging] = await Promise.all([pending, pruning]);
    } finally { pausing = false; resume(); (pool as FixtureValue).getConnection = getConnection; }
    assert.equal(edited.error, undefined, `the edit succeeds: ${JSON.stringify(edited)}`);
    assert.equal(merging.merged, 1);
    assert.deepEqual(await copiesLeft(editing), ['a']);
    const saved = await one('SELECT title, source_email_id FROM calendar_events WHERE id = ?', [taskId]);
    assert.equal(saved.title, 'Edited task');
    assert.ok(saved.source_email_id === null || saved.source_email_id === editing.a, 'never the removed copy');
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
    assert.ok(impact.notes.some((note) => /Show in IMAP/.test(note)));
    const { membershipCountQuery } = require('../dist/src/services/mail-folder-view') as typeof import('../src/services/mail-folder-view');
    const counts = await rows(membershipCountQuery('emails.is_read', accountId, false), [userId, accountId]);
    assert.deepEqual(counts.map((row) => [row.folder, Number(row.total_count)]), [['archive', 1]], 'Shown in the local Archive view');
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
    assert.deepEqual([inbox.inserted, (inbox as With<typeof inbox, 'skipped'>).skipped], [1, 1]);
    const trash = await scan(accountId, 'Trash', 'recent');
    assert.deepEqual([trash.inserted, (trash as With<typeof trash, 'skipped'>).skipped], [1, 1], 'Trash uses its own, shorter window');
    assert.equal(await itemAt(accountId, 'INBOX', 2), null, 'Outside the window: not imported, no body queued');
    assert.equal(await emailCount(accountId), 2);
    // Copies imported before the window was chosen.
    const oldInbox = uuid(), oldTrash = uuid();
    for (const [id, folder, uid, age] of [[oldInbox, 'INBOX', 3, 200], [oldTrash, 'Trash', 4, 20]] as const) {
      deliver(folder, uid, { internalDate: daysAgo(age) });
      await pool.execute<ResultSetHeader>("INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder) VALUES (?,?,?,'r@example.test','[]','inbox')", [id, userId, accountId]);
      const mailbox = await repo.withTransaction((cx) => repo.ensureMailbox({ userId, accountId, folderName: folder, epoch: 9 }, cx), pool);
      await repo.withTransaction((cx) => repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid, emailId: id, internalDate: daysAgo(age) }, cx), pool);
    }
    const impact = await policy.computeModeImpact(await load(accountId), { mode: 'sync' });
    assert.deepEqual([impact.outside_window, impact.outside_trash_window, impact.total_removals], [1, 1, 2]);
    const wider = await policy.computeModeImpact(await load(accountId), { mode: 'sync', syncWindowDays: null, trashWindowDays: null });
    assert.equal(wider.total_removals, 0, 'All mail keeps everything');
    assert.equal((await prune(accountId)).removed, 0, 'Unconfirmed: nothing removed');
    await pool.execute<ResultSetHeader>('UPDATE mail_accounts SET sync_policy_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);
    assert.equal((await prune(accountId)).removed, 2);
    assert.equal(await one('SELECT id FROM emails WHERE id IN (?,?)', [oldInbox, oldTrash]), undefined);
    assert.equal(await emailCount(accountId), 2);
    // The server keeps them; a later sweep does not import them again.
    await scan(accountId, 'INBOX', 'presence');
    assert.equal(await emailCount(accountId), 2);

    const download = await createAccount('retention-download', { mode: 'download', confirmed: false, syncWindow: 14, trashWindow: 14 });
    const imported = await scan(download, 'INBOX', 'recent');
    assert.deepEqual([imported.inserted, (imported as With<typeof imported, 'skipped'>).skipped], [3, 0], 'Download mode ignores windows');
    for (const name of ['INBOX', 'Trash']) provider.delete(name);
  });

  await t.test('HTTP: account fields, mode impact, typed-address switch, confirmation and account backup', async () => {
    // Jobs queued by the engine subtests above belong to accounts without credentials.
    await pool.execute<ResultSetHeader>("UPDATE mail_engine_jobs SET state = 'cancelled', completed_at = UTC_TIMESTAMP() WHERE state = 'queued'");
    isolated = createBackupRuntime(directory, 'sync-policy-synthetic-key', pool);
    await isolated('services/database').ensureSchema();
    const password = 'sync-policy-fixture-password-2026';
    const hash = await require('bcryptjs').hash(password, 10);
    const ownerId = uuid();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [ownerId, 'http-owner@example.test', hash, 'Owner']);
    const seed = async (address: FixtureValue, mode: FixtureValue, confirmed: FixtureValue) => {
      const id = uuid();
      await pool.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id,user_id,email_address,provider,imap_host,sync_mode,is_active,sync_policy_confirmed_at)
        VALUES (?,?,?,'custom','imap.example.test',?,TRUE,${confirmed ? 'UTC_TIMESTAMP()' : 'NULL'})`, [id, ownerId, address, mode]);
      return id;
    };
    const switching = await seed('switch@example.test', 'download', false);
    const other = await seed('other@example.test', 'download', false);
    const upgraded = await seed('upgraded@example.test', 'sync', false);
    const mail = async (accountId: string, extra = '') => {
      const id = uuid();
      await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder${extra ? ',remote_missing' : ''})
        VALUES (?,?,?,'h@example.test','[]','inbox'${extra ? ',TRUE' : ''})`, [id, ownerId, accountId]);
      return id;
    };
    const switchingMail = [await mail(switching), await mail(switching)];
    await mail(other);
    const missing = await mail(upgraded, 'missing');

    server = http.createServer((req, res) => isolated('request-handler').handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const cookies = new Map(); let csrf: FixtureValue;
    const call = async (method: string, route: FixtureValue, body?: FixtureValue, expected = 200, binary = false) => {
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
    const waitFor = async (check: FixtureValue, label: string) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.fail(`Timed out: ${label}`);
    };
    await call('POST', '/auth/signin', { email: 'http-owner@example.test', password });
    await call('GET', '/auth/me');

    const listed = (await call('GET', '/mail/accounts')).accounts;
    const byId = (id: FixtureValue) => listed.find((account: FixtureValue) => account.id === id);
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
    // Encrypted although the client asked otherwise; readable with the revealed recovery password.
    const { recovery_password: recoveryPassword } = await call('POST', `/backup/jobs/${started.job.id}/recovery-password/reveal`, {});
    const sealed = path.join(directory, 'account-backup.zip'), opened = path.join(directory, 'account-backup-inner.zip');
    await fs.writeFile(sealed, await call('GET', `/backup/jobs/${started.job.id}/download`, undefined, 200, true));
    await isolated('services/backup-envelope').openBackupEnvelope(sealed, opened, recoveryPassword);
    const entries = isolated('services/backup-zip-reader').readZipEntries(await fs.readFile(opened));
    const backup = JSON.parse(entries.get('UniHub restore data/backup.json').toString('utf8'));
    assert.deepEqual(backup.data.mail_accounts.map((account: FixtureValue) => account.id), [switching]);
    assert.deepEqual(backup.data.emails.map((email: FixtureValue) => email.id).sort(), [...switchingMail].sort(), 'Only this account\'s mail');
    assert.deepEqual(backup.data.mail_command_receipts, []);
    assert.equal(backup.data.contacts, undefined, 'Mail section only');
  });
});
