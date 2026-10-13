import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { randomUUID } = (require('node:crypto') as typeof import('node:crypto'));
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

// A guarded IMAP client with only what folder deletion uses.
function fakeConnection(mailboxDelete: (name: string) => Promise<unknown>, listed: string[] = ['INBOX']) {
  const { guardImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
  const client = Object.assign(new EventEmitter(), { usable: true, isClosed: false, close() { client.isClosed = true; }, mailboxDelete,
    list: async () => listed.map(path => ({ path, flags: new Set() })) });
  return guardImapConnection(client as unknown as import('../src/types/imap-protocol').ProtocolConnection);
}
const commandFailed = (reply: Record<string, unknown>) => Object.assign(new Error('Command failed'), reply);

test('real MySQL: a local folder empties into Inbox; a server folder goes only together with its server copy', { skip: !process.env.MYSQL_TEST_HOST }, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00' });
  let owned = false;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'folder-delete-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-folder-delete-password';
  const state = require('../dist/src/state') as typeof import('../src/state'), old = state.getDb();
  t.after(async () => {
    if (owned) {
      const cx = await pool.getConnection();
      try {
        await cx.query('SET FOREIGN_KEY_CHECKS=0');
        const [tables] = await cx.query<RowDataPacket[]>('SHOW TABLES');
        for (const row of tables) { const name = Object.values(row)[0]; assert.match((name as string), /^[a-z_]+$/); await cx.query('DROP TABLE `' + name + '`'); }
      } finally { cx.release(); }
    }
    state.setDb(old); await pool.end();
  });
  const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  assert.equal(tables.length, 0, 'Requires an empty disposable test schema'); owned = true;
  state.setDb(pool); await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();

  const owner = randomUUID(), account = randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash) VALUES (?,'folders@example.test','test')", [owner]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,'mail@example.test','custom','sync',TRUE)", [account, owner]);
  const folderIds = { inbox: randomUUID(), notes: randomUUID(), projects: randomUUID(), receipts: randomUUID() };
  await pool.execute<ResultSetHeader>(`INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id)
    VALUES (?,?,'inbox','Inbox',1,NULL),(?,?,'notes','Notes',0,NULL),(?,?,'projects','Projects',0,?),(?,?,'receipts','Receipts',0,?)`,
  [folderIds.inbox, owner, folderIds.notes, owner, folderIds.projects, owner, account, folderIds.receipts, owner, account]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'INBOX'),(?,?,'Projects'),(?,?,'Receipts')",
    [folderIds.inbox, account, folderIds.projects, account, folderIds.receipts, account]);
  // In Projects: one message only there, one also under another label, one
  // kept only in UniHub, a draft, and one with a change still on its way.
  const emails = { inNotes: randomUUID(), onlyHere: randomUUID(), labelled: randomUUID(), localOnly: randomUUID(), draft: randomUUID(), pending: randomUUID(), inInbox: randomUUID() };
  for (const [id, folder, draft] of [[emails.inNotes, 'notes', 0], [emails.onlyHere, 'projects', 0], [emails.labelled, 'projects', 0], [emails.localOnly, 'projects', 0],
    [emails.draft, 'projects', 1], [emails.pending, 'projects', 0], [emails.inInbox, 'inbox', 0]] as const) {
    await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,message_id,is_read,is_starred,is_draft)
      VALUES (?,?,?,'fixture@example.test','[]',?,?,FALSE,FALSE,?)`, [id, owner, account, folder, `${id}@example.test`, draft]);
  }
  await pool.execute<ResultSetHeader>("UPDATE emails SET remote_folder = 'Projects', remote_uid = 6, remote_uidvalidity = 17 WHERE id = ?", [emails.labelled]);
  const repository = require('../dist/src/services/mail-engine/repository') as typeof import('../src/services/mail-engine/repository');
  const box = await repository.withTransaction(cx => repository.ensureMailbox({ userId: owner, accountId: account, folderName: 'Projects', epoch: 17 }, cx), pool);
  const receipts = await repository.withTransaction(cx => repository.ensureMailbox({ userId: owner, accountId: account, folderName: 'Receipts', epoch: 18 }, cx), pool);
  for (const [mailboxId, epoch, uid, emailId] of [[box.id, 17, 5, emails.onlyHere], [box.id, 17, 6, emails.labelled], [receipts.id, 18, 40, emails.labelled],
    [box.id, 17, 7, emails.draft], [box.id, 17, 8, emails.pending]] as const)
    await repository.withTransaction(cx => repository.upsertOccurrence({ userId: owner, accountId: account, mailboxId, epoch, uid, emailId }, cx), pool);
  const writeback = randomUUID();
  await pool.execute<ResultSetHeader>(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,remote_folder,remote_uid,remote_uidvalidity,state,is_current)
    VALUES (?,?,?,?,'read','1','0','Projects',8,17,'queued',TRUE)`, [writeback, owner, account, emails.pending]);
  const rule = randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO mail_sender_rules (id,user_id,match_type,match_value,target_folder) VALUES (?,?,'domain','example.test','projects')", [rule, owner]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folder_rule_overrides (rule_id,mail_account_id,target_folder) VALUES (?,?,'projects')", [rule, account]);

  const { deleteMailFolder } = require('../dist/src/services/mail-folder-delete') as typeof import('../src/services/mail-folder-delete');
  const folderRows = async (slug: string) => (await pool.execute<RowDataPacket[]>('SELECT id FROM mail_folders WHERE user_id = ? AND slug = ?', [owner, slug]))[0].length;
  const emailFolder = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT folder FROM emails WHERE id = ?', [id]))[0][0]?.folder ?? null;
  const mailboxState = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT state FROM mail_remote_mailboxes WHERE id = ?', [id]))[0][0]?.state;
  const untouched = async () => {
    assert.equal(await folderRows('projects'), 1);
    for (const id of [emails.onlyHere, emails.labelled, emails.localOnly, emails.draft, emails.pending]) assert.equal(await emailFolder(id), 'projects');
    assert.equal(await mailboxState(box.id), 'active');
  };

  // A folder that exists only in UniHub: its message goes back to Inbox.
  const local = await deleteMailFolder({ userId: owner, slug: 'notes' }, { pool });
  assert.equal(local.movedMessages, 1);
  assert.equal(local.deletedMessages, 0);
  assert.deepEqual(local.server, []);
  assert.equal(await folderRows('notes'), 0);
  assert.equal(await emailFolder(emails.inNotes), 'inbox');

  // System folders and unknown folders are refused; a server folder needs the explicit choice.
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'inbox' }, { pool }), { status: 400 });
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'missing' }, { pool }), { status: 404 });
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'projects' }, { pool }), { status: 409 });
  // Another user's folder is not visible.
  await assert.rejects(deleteMailFolder({ userId: randomUUID(), slug: 'projects', server: true }, { pool }), { status: 404 });

  // A failed login is not a missing folder, even when its wording says "does not exist".
  const deletedNames: string[] = [];
  const loginFails = () => Promise.reject(commandFailed({ responseStatus: 'NO', responseText: 'User does not exist' }));
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'projects', server: true }, { pool, connect: loginFails }), { status: 502 });
  await untouched();
  // The server refusing leaves everything as it was.
  const refused = () => Promise.resolve(fakeConnection(async () => { throw commandFailed({ responseStatus: 'NO', responseText: 'Permission denied' }); }));
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'projects', server: true }, { pool, connect: refused }), { status: 502 });
  // So does a "does not exist" reply for a folder the server still lists.
  const stillListed = () => Promise.resolve(fakeConnection(async () => { throw commandFailed({ responseStatus: 'NO', responseText: 'Mailbox does not exist' }); }, ['INBOX', 'Projects']));
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'projects', server: true }, { pool, connect: stillListed }), { status: 502 });
  await untouched();

  // Deleted on the server: only the message whose last copy was there goes.
  const connect = () => Promise.resolve(fakeConnection(async (name: string) => { deletedNames.push(name); return { path: name }; }));
  const result = await deleteMailFolder({ userId: owner, slug: 'projects', server: true }, { pool, connect });
  assert.deepEqual(deletedNames, ['Projects']);
  assert.deepEqual(result.server, [{ accountId: account, remoteName: 'Projects', emailAddress: 'mail@example.test' }]);
  assert.equal(result.deletedMessages, 1);
  assert.equal(result.movedMessages, 4);
  assert.equal(await folderRows('projects'), 0);
  assert.equal(await emailFolder(emails.onlyHere), null);
  // Still under another label: filed there, and later changes go to that copy.
  const [[labelled]] = await pool.execute<RowDataPacket[]>('SELECT folder, remote_folder, remote_uid, remote_uidvalidity FROM emails WHERE id = ?', [emails.labelled]);
  assert.deepEqual({ ...labelled }, { folder: 'receipts', remote_folder: 'Receipts', remote_uid: 40, remote_uidvalidity: 18 });
  assert.equal(await emailFolder(emails.localOnly), 'inbox');
  assert.equal(await emailFolder(emails.draft), 'drafts');
  assert.equal(await emailFolder(emails.pending), 'inbox');
  const [[pendingChange]] = await pool.execute<RowDataPacket[]>('SELECT state FROM mail_writebacks WHERE id = ?', [writeback]);
  assert.equal(pendingChange.state, 'queued');
  assert.equal(await emailFolder(emails.inInbox), 'inbox');
  assert.equal(await mailboxState(box.id), 'missing');
  assert.equal(await mailboxState(receipts.id), 'active');
  const [[ruleRow]] = await pool.execute<RowDataPacket[]>('SELECT target_folder FROM mail_sender_rules WHERE id = ?', [rule]);
  assert.equal(ruleRow.target_folder, 'inbox');
  const [overrides] = await pool.execute<RowDataPacket[]>('SELECT rule_id FROM mail_folder_rule_overrides WHERE rule_id = ?', [rule]);
  assert.equal(overrides.length, 0);

  // A folder the server reports as nonexistent counts as deleted there.
  const goneId = randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,'gone','Gone',0,?)", [goneId, owner, account]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'Gone')", [goneId, account]);
  const absent = () => Promise.resolve(fakeConnection(async () => { throw commandFailed({ responseStatus: 'NO', serverResponseCode: 'NONEXISTENT', responseText: 'Unknown Mailbox: Gone' }); }, ['INBOX', 'Gone']));
  const gone = await deleteMailFolder({ userId: owner, slug: 'gone', server: true }, { pool, connect: absent });
  assert.equal(gone.server.length, 1);
  assert.equal(await folderRows('gone'), 0);
});
