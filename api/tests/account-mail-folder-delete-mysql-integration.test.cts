import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { randomUUID } = (require('node:crypto') as typeof import('node:crypto'));
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

// A guarded IMAP client with only what folder deletion uses.
function fakeConnection(mailboxDelete: (name: string) => Promise<unknown>) {
  const { guardImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
  const client = Object.assign(new EventEmitter(), { usable: true, isClosed: false, close() { client.isClosed = true; }, mailboxDelete });
  return guardImapConnection(client as unknown as import('../src/types/imap-protocol').ProtocolConnection);
}

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
  const folderIds = { inbox: randomUUID(), notes: randomUUID(), projects: randomUUID() };
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,'inbox','Inbox',1,NULL),(?,?,'notes','Notes',0,NULL),(?,?,'projects','Projects',0,?)",
    [folderIds.inbox, owner, folderIds.notes, owner, folderIds.projects, owner, account]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'INBOX'),(?,?,'Projects')", [folderIds.inbox, account, folderIds.projects, account]);
  const emails = { inNotes: randomUUID(), inProjects: randomUUID(), alsoInProjects: randomUUID(), inInbox: randomUUID() };
  for (const [id, folder] of [[emails.inNotes, 'notes'], [emails.inProjects, 'projects'], [emails.alsoInProjects, 'projects'], [emails.inInbox, 'inbox']] as const) {
    await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,message_id,is_read,is_starred)
      VALUES (?,?,?,'fixture@example.test','[]',?,?,FALSE,FALSE)`, [id, owner, account, folder, `${id}@example.test`]);
  }
  const repository = require('../dist/src/services/mail-engine/repository') as typeof import('../src/services/mail-engine/repository');
  const box = await repository.withTransaction(cx => repository.ensureMailbox({ userId: owner, accountId: account, folderName: 'Projects', epoch: 17 }, cx), pool);
  await repository.withTransaction(cx => repository.upsertOccurrence({ userId: owner, accountId: account, mailboxId: box.id, epoch: 17, uid: 5, emailId: emails.inProjects }, cx), pool);
  const rule = randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO mail_sender_rules (id,user_id,match_type,match_value,target_folder) VALUES (?,?,'domain','example.test','projects')", [rule, owner]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folder_rule_overrides (rule_id,mail_account_id,target_folder) VALUES (?,?,'projects')", [rule, account]);

  const { deleteMailFolder } = require('../dist/src/services/mail-folder-delete') as typeof import('../src/services/mail-folder-delete');
  const folderRows = async (slug: string) => (await pool.execute<RowDataPacket[]>('SELECT id FROM mail_folders WHERE user_id = ? AND slug = ?', [owner, slug]))[0].length;
  const emailFolder = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT folder FROM emails WHERE id = ?', [id]))[0][0]?.folder ?? null;

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

  // The server refusing leaves everything as it was.
  const refused = () => Promise.resolve(fakeConnection(async () => { throw Object.assign(new Error('Command failed'), { responseText: 'NO [CANNOT] Permission denied' }); }));
  await assert.rejects(deleteMailFolder({ userId: owner, slug: 'projects', server: true }, { pool, connect: refused }), { status: 502 });
  assert.equal(await folderRows('projects'), 1);
  assert.equal(await emailFolder(emails.inProjects), 'projects');

  // Deleted on the server: the messages in it are gone here too, the rules file into Inbox again.
  const deletedNames: string[] = [];
  const connect = () => Promise.resolve(fakeConnection(async (name: string) => { deletedNames.push(name); return { path: name }; }));
  const result = await deleteMailFolder({ userId: owner, slug: 'projects', server: true }, { pool, connect });
  assert.deepEqual(deletedNames, ['Projects']);
  assert.deepEqual(result.server, [{ accountId: account, remoteName: 'Projects', emailAddress: 'mail@example.test' }]);
  assert.equal(result.deletedMessages, 2);
  assert.equal(result.movedMessages, 0);
  assert.equal(await folderRows('projects'), 0);
  assert.equal(await emailFolder(emails.inProjects), null);
  assert.equal(await emailFolder(emails.alsoInProjects), null);
  assert.equal(await emailFolder(emails.inInbox), 'inbox');
  const [[mailbox]] = await pool.execute<RowDataPacket[]>('SELECT state FROM mail_remote_mailboxes WHERE id = ?', [box.id]);
  assert.equal(mailbox.state, 'missing');
  const [[ruleRow]] = await pool.execute<RowDataPacket[]>('SELECT target_folder FROM mail_sender_rules WHERE id = ?', [rule]);
  assert.equal(ruleRow.target_folder, 'inbox');
  const [overrides] = await pool.execute<RowDataPacket[]>('SELECT rule_id FROM mail_folder_rule_overrides WHERE rule_id = ?', [rule]);
  assert.equal(overrides.length, 0);

  // A folder the server no longer has counts as deleted there.
  const goneId = randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,'gone','Gone',0,?)", [goneId, owner, account]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'Gone')", [goneId, account]);
  const absent = () => Promise.resolve(fakeConnection(async () => { throw Object.assign(new Error('Command failed'), { responseText: 'NO Mailbox does not exist' }); }));
  const gone = await deleteMailFolder({ userId: owner, slug: 'gone', server: true }, { pool, connect: absent });
  assert.equal(gone.server.length, 1);
  assert.equal(await folderRows('gone'), 0);
});
