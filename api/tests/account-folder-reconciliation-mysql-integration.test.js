const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime');
const id = () => crypto.randomUUID();

test('0.10.3 folder reconciliation and Legacy recovery on MySQL', { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const pool = require('mysql2/promise').createPool({ host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00', connectionLimit: 3 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-folder-reconcile-'));
  let owns = false;
  t.after(async () => {
    if (owns) {
      const connection = await pool.getConnection();
      try {
        await connection.query('SET FOREIGN_KEY_CHECKS = 0');
        const [tables] = await connection.query('SHOW TABLES');
        for (const row of tables) { const table = Object.values(row)[0]; assert.match(table, /^[a-z_]+$/); await connection.query('DROP TABLE `' + table + '`'); }
      } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); connection.release(); }
    }
    await pool.end(); await fs.rm(root, { recursive: true, force: true });
  });
  const [tables] = await pool.query('SHOW TABLES');
  assert.equal(tables.length, 0, 'Refuse a nonempty/live database'); owns = true;
  const runtime = createBackupRuntime(root, 'folder-fixture-key', pool);
  const schema = runtime('services/database');
  await schema.ensureSchema();
  // Remove the complete 0.10.4/0.10.5 folder delta to populate the 0.10.3 shape.
  // The rest of ensureSchema is unchanged from the tagged 0.10.3 initializer.
  await pool.query('DROP TABLE mail_folder_rule_overrides, mail_folder_recovery_items, mail_folder_reconciliations');
  await pool.query('ALTER TABLE emails DROP FOREIGN KEY fk_emails_filing_account, DROP COLUMN filing_account_id, DROP COLUMN is_legacy');
  await pool.query('ALTER TABLE mail_folders DROP FOREIGN KEY fk_mail_folders_account, DROP COLUMN mail_account_id, DROP COLUMN special_use');
  async function insert(table, row) {
    const columns = Object.keys(row);
    await pool.execute(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
  }
  const user = id(), otherUser = id();
  await insert('users', { id: user, email: 'owner@example.test', password_hash: 'fixture' });
  await insert('users', { id: otherUser, email: 'other@example.test', password_hash: 'fixture' });
  const accountA = id(), accountB = id(), foreign = id();
  for (const [account, owner, email] of [[accountA, user, 'a@example.test'], [accountB, user, 'b@example.test'], [foreign, otherUser, 'foreign@example.test']]) {
    await insert('mail_accounts', { id: account, user_id: owner, provider: 'custom', email_address: email });
  }
  await runtime('services/mail').ensureDefaultMailFoldersForUser(user);
  const folderIds = {};
  for (const [slug, name] of [['projects', 'Projects'], ['receipts', 'Receipts'], ['case', 'CASE'], ['old_label', 'Renamed locally']]) {
    folderIds[slug] = id();
    await insert('mail_folders', { id: folderIds[slug], user_id: user, slug, display_name: name, is_system: false });
  }
  await insert('mail_folders', { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', user_id: user, slug: 'project_copies', display_name: 'Projects', is_system: false });
  await insert('mail_folder_remote_boxes', { folder_id: folderIds.old_label, mail_account_id: accountA, remote_name: 'Remote/Actual' });
  const rule = id();
  await insert('mail_sender_rules', { id: rule, user_id: user, match_type: 'domain', match_value: 'example.test', target_folder: 'receipts' });
  const messages = {};
  for (const [name, account, folder, recipients] of [
    ['connected', accountA, 'projects', ['relay@private.test']],
    ['duplicateLabel', accountA, 'project_copies', ['a@example.test']],
    ['sameNameOtherAccount', accountB, 'projects', ['b@example.test']],
    ['toOtherAccount', accountA, 'receipts', ['b@example.test']],
    ['relay', accountA, 'receipts', ['relay@private.test']],
    ['ambiguous', accountA, 'receipts', ['a@example.test', 'b@example.test']],
    ['caseSensitive', accountA, 'case', ['a@example.test']],
    ['important', accountA, 'important', ['a@example.test']],
    ['mapped', accountA, 'old_label', []],
    ['sent', accountA, 'sent', ['a@example.test']],
    ['draft', accountA, 'drafts', ['a@example.test']],
    ['trash', accountA, 'trash', ['a@example.test']],
    ['orphan', accountA, 'missing_catalog_folder', []],
  ]) {
    messages[name] = id();
    await insert('emails', { id: messages[name], user_id: user, mail_account_id: account,
      folder, from_address: 'sender@example.test', to_addresses: JSON.stringify(recipients),
      message_id: `<${name}@fixture.test>`, subject: name, body_text: 'Unchanged body: ' + name,
      source_folder: 'INBOX', imap_uid: Object.keys(messages).length, imap_uidvalidity: 42,
      is_starred: name === 'important', is_draft: name === 'draft', is_read: ['sent', 'draft'].includes(name) });
  }
  const originalRows = (await pool.execute('SELECT * FROM emails ORDER BY id'))[0];
  await schema.ensureSchema(); await schema.ensureSchema();
  const migration = runtime('services/mail-folder-reconciliation');
  const inventory = ['INBOX', 'Projects', 'Remote/Actual', 'case'];
  const read = async name => (await pool.execute('SELECT * FROM emails WHERE id = ?', [messages[name]]))[0][0];
  const originalColumns = Object.keys(originalRows[0]);
  await t.test('failed listing and a mid-migration failure leave all old assignments intact', async () => {
    await assert.rejects(runtime('services/mail').listAvailableImapFolders({ getBoxes: async () => { throw new Error('offline'); } }, new Map(), true), /offline/);
    await assert.rejects(migration.reconcileAccountFolders(user, accountA, []), /inventory/);
    let writes = 0;
    const faulty = { async getConnection() {
      const c = await pool.getConnection();
      return new Proxy(c, { get(target, key) {
        if (key === 'execute') return async (sql, params) => {
          if (sql.startsWith('UPDATE emails SET folder') && ++writes === 2) throw new Error('injected interruption');
          return c.execute(sql, params);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    await assert.rejects(migration.reconcileAccountFolders(user, accountA, inventory, new Map(), faulty), /injected interruption/);
    const [rows] = await pool.query('SELECT ' + originalColumns.join(',') + ' FROM emails ORDER BY id');
    assert.deepEqual(rows, originalRows);
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM mail_folder_recovery_items'))[0][0].n, 0);
  });
  await t.test('exact server links, receiving-account Inbox and unresolved Legacy preserve identities and contents', async () => {
    await migration.prepareFolderReconciliation();
    await migration.reconcileAccountFolders(user, accountA, inventory);
    await migration.reconcileAccountFolders(user, accountB, ['INBOX']);
    assert.equal((await read('connected')).folder, 'projects');
    assert.equal((await read('connected')).is_legacy, 0);
    assert.equal((await read('duplicateLabel')).folder, 'projects');
    assert.equal((await read('mapped')).folder, 'old_label');
    for (const name of ['sameNameOtherAccount', 'toOtherAccount', 'caseSensitive', 'important']) assert.equal((await read(name)).folder, 'inbox');
    assert.equal((await read('toOtherAccount')).filing_account_id, accountB);
    for (const name of ['relay', 'ambiguous', 'orphan']) assert.equal((await read(name)).is_legacy, 1);
    assert.equal((await read('relay')).folder, 'receipts');
    for (const name of ['sent', 'draft', 'trash']) assert.equal((await read(name)).folder, name === 'draft' ? 'drafts' : name);
    const protectedColumns = originalColumns.filter(column => column !== 'folder');
    const [rows] = await pool.query('SELECT ' + protectedColumns.join(',') + ' FROM emails ORDER BY id');
    assert.deepEqual(rows, originalRows.map(row => Object.fromEntries(protectedColumns.map(column => [column, row[column]]))));
    assert.equal((await runtime('services/mail').loadActiveMailSenderRules(user, accountA))[0].target_folder, 'inbox');
    const links = await migration.folderConnections(user);
    assert.deepEqual(links.get('projects'), [accountA]);
    assert(!links.has('case'), 'CASE must not connect to case');
  });
  await t.test('Legacy filters and explicit recovery to another account preserve source UID identity', async () => {
    const routes = runtime('routes/mail');
    const list = await routes['GET /api/mail/emails']({ url: '/api/mail/emails?account_id=legacy', headers: { host: 'localhost' } }, user);
    assert.equal(list.pagination.total, 3);
    const move = await routes['POST /api/mail/emails/bulk-move']({}, user, { email_ids: [messages.relay], folder: 'inbox', account_id: accountB });
    assert.equal(move.error, undefined);
    const restored = await read('relay');
    assert.equal(restored.mail_account_id, accountA);
    assert.equal(restored.filing_account_id, accountB);
    assert.equal(restored.is_legacy, 0);
    assert.equal(restored.imap_uidvalidity, 42);
    const deletion = await routes['DELETE /api/mail/accounts/:id']({ url: '/api/mail/accounts/' + accountA, params: { id: accountA } }, user);
    assert.equal(deletion.status, 409, 'Deleting a source account must not erase recovered mail in another account');
    assert.equal((await read('relay')).id, messages.relay);
    const inbox = await routes['GET /api/mail/emails']({ url: '/api/mail/emails?account_id=' + accountB + '&folder=inbox', headers: { host: 'localhost' } }, user);
    assert(inbox.emails.some(email => email.id === messages.relay));
    const before = await read('ambiguous');
    assert.equal((await routes['POST /api/mail/emails/bulk-move']({}, user, { email_ids: [messages.ambiguous], folder: 'inbox', account_id: foreign })).status, 400);
    assert.equal((await routes['POST /api/mail/emails/bulk-move']({}, user, { email_ids: [messages.ambiguous, messages.connected], folder: 'inbox', account_id: accountB })).status, 400);
    assert.deepEqual(await read('ambiguous'), before);
  });
  await t.test('repeat startup/sync does not undo recovered or newly organized messages', async () => {
    await pool.execute("UPDATE emails SET folder = 'important' WHERE id = ?", [messages.important]);
    const [before] = await pool.query('SELECT * FROM emails ORDER BY id');
    await schema.ensureSchema(); await migration.prepareFolderReconciliation();
    assert.equal((await migration.reconcileAccountFolders(user, accountA, inventory)).skipped, true);
    const [after] = await pool.query('SELECT * FROM emails ORDER BY id');
    assert.deepEqual(after, before);
  });
});
