const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const schemaSmokeEnabled = process.env.MYSQL_TEST_HOST && process.env.MYSQL_TEST_SCHEMA_SMOKE === '1';

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z0-9_]+$/);
  return '`' + value + '`';
}

function sortedRows(rows) {
  return rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('populated v0.9.23.0 upgrades on MySQL 8 and survives a second production startup', {
  skip: !schemaSmokeEnabled,
  timeout: 120000,
}, async (t) => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use a dedicated database ending in _test');
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD,
    timezone: '+00:00',
  });
  const { db, getDb, setDb } = require('../src/state');
  let ownsDatabase = false;
  // Only take ownership after proving the opted-in database is empty. Clean up
  // even on failure so the following fresh-install smoke gets an empty schema.
  t.after(async () => {
    try {
      if (ownsDatabase) {
        if (getDb()) { await getDb().end(); setDb(null); }
        delete require.cache[require.resolve('../src/services/notifications')];
        await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
        try {
          const [tables] = await connection.query('SHOW TABLES');
          for (const table of tables) await connection.execute('DROP TABLE ' + quoteIdentifier(Object.values(table)[0]));
        } finally {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
        }
      }
    } finally {
      await connection.end();
    }
  });
  const [[server]] = await connection.execute('SELECT VERSION() AS version');
  assert.match(server.version, /^8\./, 'This upgrade regression requires MySQL 8');
  const [existingTables] = await connection.query('SHOW TABLES');
  assert.equal(existingTables.length, 0, 'The upgrade fixture requires an empty dedicated test database');
  ownsDatabase = true;

  const fixtureDirectory = path.join(__dirname, 'fixtures/v0.9.23.0');
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'data.json'), 'utf8'));
  const schema = await fs.readFile(path.join(fixtureDirectory, 'schema.sql'), 'utf8');
  // The frozen fixture has one statement per semicolon and no semicolons inside
  // literals. No current schema code is used to construct the old database.
  for (const statement of schema.replace(/^--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean)) {
    await connection.execute(statement);
  }
  for (const [table, rows] of Object.entries(fixture.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row).map(quoteIdentifier).join(', ');
      const placeholders = Object.keys(row).map(() => '?').join(', ');
      await connection.execute(`INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${placeholders})`, Object.values(row));
    }
  }
  const [legacyTables] = await connection.query('SHOW TABLES');
  assert.equal(legacyTables.length, 29);
  const addedTables = ['mail_sync_state', 'notification_config', 'push_subscriptions', 'notification_events', 'notification_deliveries', 'notification_reminders'];
  for (const table of addedTables) assert.ok(!legacyTables.some(row => Object.values(row)[0] === table));
  const [legacyImportColumn] = await connection.execute("SHOW COLUMNS FROM emails WHERE Field = 'import_complete'");
  assert.equal(legacyImportColumn.length, 0, 'The upgrade must start without the new import flag');

  const snapshots = new Map();
  for (const table of Object.keys(fixture.tables)) {
    const [rows, fields] = await connection.execute('SELECT * FROM ' + quoteIdentifier(table));
    snapshots.set(table, { columns: fields.map(field => field.name), rows: sortedRows(rows) });
  }
  async function assertLegacyRowsPreserved() {
    for (const [table, snapshot] of snapshots) {
      const [rows] = await db.execute(`SELECT ${snapshot.columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`);
      assert.deepEqual(sortedRows(rows), snapshot.rows, `All existing ${table} rows and IDs must be preserved`);
    }
  }

  delete process.env.DATABASE_URL;
  for (const name of ['HOST', 'PORT', 'DATABASE', 'USER', 'PASSWORD']) {
    if (process.env['MYSQL_TEST_' + name]) process.env['MYSQL_' + name] = process.env['MYSQL_TEST_' + name];
  }
  process.env.JWT_SECRET = 'ci-test-jwt-secret-for-schema-smoke';
  process.env.ENCRYPTION_KEY = fixture.encryptionKey;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'ci-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'ci-bootstrap-password-2026';
  const { initDatabase } = require('../src/services/database');
  const { decrypt } = require('../src/security/encryption');
  const { verifyPassword } = require('../src/auth');
  const { loadFolderSyncState, saveFolderSyncState } = require('../src/services/mail-sync-state');
  const mailAccountId = fixture.tables.mail_accounts[0].id;
  const emailId = fixture.tables.emails[0].id;

  await initDatabase();
  let notifications = require('../src/services/notifications');
  await notifications.ensureNotificationSchema();
  await assertLegacyRowsPreserved();
  const [columns] = await db.execute("SHOW COLUMNS FROM emails WHERE Field = 'import_complete'");
  assert.equal(columns.length, 1);
  assert.equal(columns[0].Null, 'NO');
  assert.equal(String(columns[0].Default), '0');
  const [importStates] = await db.execute('SELECT import_complete FROM emails');
  assert.equal(importStates.length, fixture.tables.emails.length);
  assert.ok(importStates.every(row => row.import_complete === 0), 'Old messages must not be assumed fully imported');
  const [[syncCount]] = await db.execute('SELECT COUNT(*) AS total FROM mail_sync_state');
  assert.equal(syncCount.total, 0);
  assert.deepEqual(await loadFolderSyncState(db, mailAccountId, 'INBOX/Research', 5678), { incremental: false, lastUid: 0 });
  for (const table of addedTables.slice(2)) {
    const [[row]] = await db.execute('SELECT COUNT(*) AS total FROM ' + quoteIdentifier(table));
    assert.equal(row.total, 0, `${table} should start empty`);
  }
  const keys = await notifications.getVapidKeys();
  const [[vapid]] = await db.execute('SELECT encrypted_private_key FROM notification_config WHERE id = 1');
  assert.notEqual(vapid.encrypted_private_key, keys.privateKey);
  assert.equal(decrypt(vapid.encrypted_private_key), keys.privateKey);

  // Persist new-version state before restarting, so repeatability includes both
  // unchanged legacy rows and migration-created data that must not reset.
  await saveFolderSyncState(db, mailAccountId, 'INBOX/Research', 5678, 1234);
  await db.execute('UPDATE emails SET import_complete = TRUE WHERE id = ?', [emailId]);
  await getDb().end();
  setDb(null);
  await initDatabase();
  delete require.cache[require.resolve('../src/services/notifications')];
  notifications = require('../src/services/notifications');
  await notifications.ensureNotificationSchema();
  await assertLegacyRowsPreserved();
  assert.deepEqual(await notifications.getVapidKeys(), keys);
  assert.deepEqual(await loadFolderSyncState(db, mailAccountId, 'INBOX/Research', 5678), { incremental: true, lastUid: 1234 });
  const [restartedImports] = await db.execute('SELECT id, import_complete FROM emails');
  for (const row of restartedImports) assert.equal(row.import_complete, row.id === emailId ? 1 : 0);

  const [[account]] = await db.execute('SELECT encrypted_password FROM mail_accounts WHERE id = ?', [mailAccountId]);
  assert.equal(decrypt(account.encrypted_password), fixture.passwords.mail);
  const [[calendar]] = await db.execute("SELECT encrypted_password, encrypted_access_token, encrypted_refresh_token FROM calendar_accounts WHERE provider = 'caldav'");
  assert.equal(decrypt(calendar.encrypted_password), fixture.passwords.calendar);
  assert.equal(decrypt(calendar.encrypted_access_token), fixture.passwords.accessToken);
  assert.equal(decrypt(calendar.encrypted_refresh_token), fixture.passwords.refreshToken);
  const [[admin]] = await db.execute('SELECT password_hash, encrypted_two_factor_secret FROM users WHERE id = ?', [fixture.tables.users[0].id]);
  assert.equal(decrypt(admin.encrypted_two_factor_secret), fixture.passwords.twoFactor);
  assert.equal(await verifyPassword(fixture.passwords.login, admin.password_hash), true);

  // Folder defaults also run when mail is opened; preserve user edits then.
  const { loadMailFoldersForUser } = require('../src/services/mail');
  const folders = await loadMailFoldersForUser(fixture.tables.users[0].id);
  for (const savedFolder of fixture.tables.mail_folders) {
    const folder = folders.find(row => row.id === savedFolder.id);
    assert.ok(folder);
    assert.equal(folder.mail_account_id, null, 'Existing folders must remain shared');
    assert.equal(folder.slug, savedFolder.slug);
    assert.equal(folder.display_name, savedFolder.display_name);
    assert.equal(folder.position, savedFolder.position);
    assert.equal(folder.is_system, Boolean(savedFolder.is_system));
  }
  await t.test('account folders preserve legacy mappings and reject mixed-account moves atomically', async () => {
    const userId = fixture.tables.users[0].id;
    const secondAccount = { ...fixture.tables.mail_accounts[0], id: crypto.randomUUID(), email_address: 'second@example.test' };
    const addRow = async (table, row) => db.execute(
      `INSERT INTO ${quoteIdentifier(table)} (${Object.keys(row).map(quoteIdentifier).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
    await addRow('mail_accounts', secondAccount);
    const secondEmail = { ...fixture.tables.emails[0], id: crypto.randomUUID(), mail_account_id: secondAccount.id, message_id: '<second-account@example.test>' };
    await addRow('emails', secondEmail);
    const { registerCustomImapFoldersForUser } = require('../src/services/mail');
    const legacy = await registerCustomImapFoldersForUser(userId, mailAccountId, ['INBOX/Research']);
    assert.equal(legacy[0].slug, 'research');
    const first = (await registerCustomImapFoldersForUser(userId, mailAccountId, ['Receipts']))[0];
    const second = (await registerCustomImapFoldersForUser(userId, secondAccount.id, ['Receipts']))[0];
    assert.notEqual(first.slug, second.slug);
    assert.equal((await registerCustomImapFoldersForUser(userId, mailAccountId, ['Receipts']))[0].slug, first.slug);
    const routes = require('../src/routes/mail');
    const list = await routes['GET /api/mail/folders']({ url: '/api/mail/folders?account_id=' + mailAccountId }, userId);
    assert(list.folders.some(folder => folder.slug === 'research'));
    assert(list.folders.some(folder => folder.slug === first.slug && folder.mail_account_id === mailAccountId));
    assert(!list.folders.some(folder => folder.slug === second.slug));
    assert.equal((await routes['POST /api/mail/folders']({}, userId, { display_name: 'Unsafe shared' })).status, 400);
    const [before] = await db.execute('SELECT id, mail_account_id, folder, source_folder, imap_uid FROM emails ORDER BY id');
    const move = body => routes['POST /api/mail/emails/bulk-move']({}, userId, body);
    assert.equal((await move({ email_ids: [emailId, secondEmail.id], folder: first.slug })).status, 400);
    const [after] = await db.execute('SELECT id, mail_account_id, folder, source_folder, imap_uid FROM emails ORDER BY id');
    assert.deepEqual(after, before);
    assert.equal((await move({ email_ids: [emailId], folder: first.slug })).error, undefined);
    assert.equal((await move({ email_ids: [emailId, secondEmail.id], folder: 'research' })).error, undefined);
    const rule = { match_type: 'domain', match_value: 'example.test', target_folder: first.slug };
    assert.equal((await routes['POST /api/mail/sender-rules']({}, userId, rule)).status, 400);
    assert.equal((await routes['POST /api/mail/sender-rules']({}, userId, { ...rule, mail_account_id: secondAccount.id })).status, 400);
    assert.equal((await routes['POST /api/mail/sender-rules']({}, userId, { ...rule, mail_account_id: mailAccountId })).error, undefined);
    const [mappings] = await db.execute('SELECT * FROM mail_folder_remote_boxes WHERE folder_id = ?', [fixture.tables.mail_folder_remote_boxes[0].folder_id]);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].remote_name, 'INBOX/Research');
    // Another startup must preserve new scopes as well as old shared folders.
    await getDb().end();
    setDb(null);
    await initDatabase();
    const [[scoped]] = await db.execute('SELECT mail_account_id FROM mail_folders WHERE user_id = ? AND slug = ?', [userId, first.slug]);
    assert.equal(scoped.mail_account_id, mailAccountId);
  });

  await t.test('backup suspension releases stale restore locks without deleting archives', async () => {
    const userId = fixture.tables.users[0].id;
    const pendingId = crypto.randomUUID();
    const readyId = crypto.randomUUID();
    await db.execute(`INSERT INTO data_export_jobs (id, user_id, status, file_path) VALUES (?, ?, 'ready', '/retained/archive.zip')`, [readyId, userId]);
    await db.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, archive_path, requested_sections) VALUES (?, ?, 'running', '/retained/import.zip', '["mail"]')`, [pendingId, userId]);
    const { suspendPendingBackupJobs } = require('../src/services/backup-availability');
    await suspendPendingBackupJobs(db);
    await suspendPendingBackupJobs(db);
    const [[pending]] = await db.execute('SELECT status, archive_path FROM backup_restore_jobs WHERE id = ?', [pendingId]);
    assert.deepEqual(pending, { status: 'failed', archive_path: '/retained/import.zip' });
    const [[ready]] = await db.execute('SELECT status, file_path FROM data_export_jobs WHERE id = ?', [readyId]);
    assert.deepEqual(ready, { status: 'ready', file_path: '/retained/archive.zip' });
    assert.equal((await require('../src/services/restore-locks').getActiveRestoreSections(userId)).size, 0);
  });
});

// This fresh-install smoke follows the legacy fixture cleanup in the dedicated CI database.
test('production schema startup is repeatable, preserves encrypted VAPID keys and cascades revoked devices', {
  skip: !process.env.MYSQL_TEST_HOST || process.env.MYSQL_TEST_SCHEMA_SMOKE !== '1',
  timeout: 120000,
}, async (t) => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use a dedicated database ending in _test');
  delete process.env.DATABASE_URL;
  for (const name of ['HOST', 'PORT', 'DATABASE', 'USER', 'PASSWORD']) {
    if (process.env['MYSQL_TEST_' + name]) process.env['MYSQL_' + name] = process.env['MYSQL_TEST_' + name];
  }
  process.env.JWT_SECRET = 'ci-test-jwt-secret-for-schema-smoke';
  process.env.ENCRYPTION_KEY = 'ci-test-encryption-key';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'ci-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'ci-bootstrap-password-2026';
  const { initDatabase } = require('../src/services/database');
  const { db, getDb } = require('../src/state');
  t.after(async () => { if (getDb()) await getDb().end(); });
  await initDatabase();
  let notifications = require('../src/services/notifications');
  await notifications.ensureNotificationSchema();
  const before = await notifications.getVapidKeys();
  const [[stored]] = await db.execute('SELECT encrypted_private_key FROM notification_config WHERE id = 1');
  assert.notEqual(stored.encrypted_private_key, before.privateKey);
  assert.ok(stored.encrypted_private_key.length > before.privateKey.length);
  const [columns] = await db.execute("SHOW COLUMNS FROM emails WHERE Field = 'import_complete'");
  assert.equal(columns.length, 1);
  assert.equal(String(columns[0].Default), '0');

  // Close the pool and discard the module's key cache to exercise database-backed recovery.
  await getDb().end();
  await initDatabase();
  delete require.cache[require.resolve('../src/services/notifications')];
  notifications = require('../src/services/notifications');
  await notifications.ensureNotificationSchema();
  assert.deepEqual(await notifications.getVapidKeys(), before);
  await notifications.processNotificationJobs();

  const [[user]] = await db.execute('SELECT id FROM users WHERE email = ?', ['ci-admin@example.test']);
  const sessionId = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/schema-smoke-' + subscriptionId;
  await db.execute('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR))', [sessionId, user.id, crypto.randomUUID()]);
  await db.execute('INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [subscriptionId, user.id, sessionId, endpoint, crypto.createHash('sha256').update(endpoint).digest('hex'), 'test-key', 'test-auth']);
  const queued = await notifications.enqueueTestNotification(user.id, endpoint);
  assert.equal(queued.queued, true);
  const [[beforeDelete]] = await db.execute('SELECT COUNT(*) AS total FROM notification_deliveries WHERE subscription_id = ?', [subscriptionId]);
  assert.equal(beforeDelete.total, 1);
  await db.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
  const [[devices]] = await db.execute('SELECT COUNT(*) AS total FROM push_subscriptions WHERE id = ?', [subscriptionId]);
  const [[deliveries]] = await db.execute('SELECT COUNT(*) AS total FROM notification_deliveries WHERE subscription_id = ?', [subscriptionId]);
  assert.equal(devices.total, 0);
  assert.equal(deliveries.total, 0);
  await db.execute('DELETE FROM notification_events WHERE user_id = ? AND kind = ?', [user.id, 'test']);
});
