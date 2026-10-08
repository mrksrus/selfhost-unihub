const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z0-9_]+$/);
  return '`' + value + '`';
}

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
  const { initDatabase } = require('../dist/src/services/database');
  const { db, getDb, setDb } = require('../dist/src/state');
  const mysql = require('mysql2/promise');
  const cleanupConnection = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00',
  });
  let ownsDatabase = false;
  t.after(async () => {
    try {
      if (getDb()) { await getDb().end(); setDb(null); }
      if (ownsDatabase) {
        await cleanupConnection.execute('SET FOREIGN_KEY_CHECKS = 0');
        try {
          const [tables] = await cleanupConnection.query('SHOW TABLES');
          for (const row of tables) await cleanupConnection.execute('DROP TABLE ' + quoteIdentifier(Object.values(row)[0]));
        } finally { await cleanupConnection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
        const [remaining] = await cleanupConnection.query('SHOW TABLES');
        assert.equal(remaining.length, 0, 'Fresh-install fixture must leave an empty database');
      }
    } finally { await cleanupConnection.end(); }
  });
  const [existingTables] = await cleanupConnection.query('SHOW TABLES');
  assert.equal(existingTables.length, 0, 'Fresh-install fixture requires an empty dedicated test database');
  ownsDatabase = true;
  await initDatabase();
  let notifications = require('../dist/src/services/notifications');
  await notifications.ensureNotificationSchema();
  await require('../dist/src/services/data-inventory').verifyDatabaseInventory(db);
  await db.execute('ALTER TABLE emails ADD COLUMN recovery_inventory_probe TEXT NULL');
  try {
    await assert.rejects(require('../dist/src/services/data-inventory').verifyDatabaseInventory(db), /Unclassified field emails.recovery_inventory_probe/);
  } finally {
    await db.execute('ALTER TABLE emails DROP COLUMN recovery_inventory_probe');
  }
  const [upgradeHistory] = await db.execute('SELECT id, name, completed_at FROM schema_migrations ORDER BY id');
  assert.deepEqual(upgradeHistory.map(row => [row.id, row.name]), [
    [1, 'verified-0.10.5-baseline'], [2, 'sent-draft-read-repair'],
    [3, 'mail-server-follow-mode'], [4, 'notes-with-revisions-and-attachments'],
    [5, 'explicit-mail-writebacks'], [6, 'mail-engine-additive-storage'],
    [7, 'mail-engine-resumable-backfill'], [8, 'mail-engine-manual-refresh-intent'],
    [9, 'calendar-color-default'], [10, 'mail-sync-policy'], [11, 'remove-notes-module'], [12, 'calendar-sync'],
    [13, 'calendar-mail-link-marker'], [14, 'calendar-linked-login'],
  ]);
  const [policyColumns] = await db.execute(`SELECT COLUMN_NAME AS name, COLUMN_DEFAULT AS dflt, IS_NULLABLE AS nullable
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts'
      AND COLUMN_NAME IN ('sync_window_days','trash_window_days','sync_policy_confirmed_at') ORDER BY COLUMN_NAME`);
  // MariaDB reports a missing default on a nullable column as the text NULL.
  assert.deepEqual(policyColumns.map(row => [row.name, row.dflt == null || row.dflt === 'NULL' ? null : String(row.dflt), row.nullable]), [
    ['sync_policy_confirmed_at', null, 'YES'], ['sync_window_days', null, 'YES'], ['trash_window_days', '30', 'YES'],
  ], 'Upgraded accounts keep every window open and the destructive Sync policy unconfirmed');
  const [[owner]] = await db.execute('SELECT id FROM users LIMIT 1');
  const sentId = crypto.randomUUID();
  const sentAccountId = crypto.randomUUID();
  await db.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, is_active) VALUES (?, ?, 'sent-repair@example.test', 'imap', FALSE)", [sentAccountId, owner.id]);
  // A completed historical repair must not rewrite later user state on restart.
  await db.execute('INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, is_read) VALUES (?, ?, ?, ?, ?, ?, FALSE)', [sentId, owner.id, sentAccountId, 'sent-repair@example.test', '[]', 'sent']);
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
  delete require.cache[require.resolve('../dist/src/services/notifications')];
  notifications = require('../dist/src/services/notifications');
  await notifications.ensureNotificationSchema();
  assert.deepEqual(await notifications.getVapidKeys(), before);
  await require('../dist/src/services/data-inventory').verifyDatabaseInventory(db);
  const [restartedHistory] = await db.execute('SELECT id, name, completed_at FROM schema_migrations ORDER BY id');
  assert.deepEqual(restartedHistory, upgradeHistory, 'Completed migrations are unchanged after restart');
  const [[sent]] = await db.execute('SELECT is_read FROM emails WHERE id = ?', [sentId]);
  assert.equal(sent.is_read, 0, 'Completed sent/draft repair must not run again');
  await db.execute('DELETE FROM mail_accounts WHERE id = ?', [sentAccountId]);
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

  // Replay the steps after the 0.16.0 baseline, as after a crash before they
  // were recorded: each must detect its completed work.
  await db.execute('DELETE FROM schema_migrations WHERE id >= 12');
  await getDb().end();
  await initDatabase();
  const [history] = await db.execute('SELECT id FROM schema_migrations ORDER BY id');
  assert.deepEqual(history.map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const [[calendarSync]] = await db.execute('SELECT name FROM schema_migrations WHERE id = 12');
  assert.equal(calendarSync.name, 'calendar-sync');

  await t.test('backup suspension releases stale restore locks without deleting archives', async () => {
    const [[{ id: userId }]] = await db.execute('SELECT id FROM users LIMIT 1');
    const pendingId = crypto.randomUUID();
    const readyId = crypto.randomUUID();
    await db.execute(`INSERT INTO data_export_jobs (id, user_id, status, file_path) VALUES (?, ?, 'ready', '/retained/archive.zip')`, [readyId, userId]);
    await db.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, archive_path, requested_sections) VALUES (?, ?, 'running', '/retained/import.zip', '["mail"]')`, [pendingId, userId]);
    const { suspendPendingBackupJobs } = require('../dist/src/services/backup-availability');
    await suspendPendingBackupJobs(db);
    await suspendPendingBackupJobs(db);
    const [[pending]] = await db.execute('SELECT status, archive_path FROM backup_restore_jobs WHERE id = ?', [pendingId]);
    assert.deepEqual(pending, { status: 'failed', archive_path: '/retained/import.zip' });
    const [[ready]] = await db.execute('SELECT status, file_path FROM data_export_jobs WHERE id = ?', [readyId]);
    assert.deepEqual(ready, { status: 'ready', file_path: '/retained/archive.zip' });
    assert.equal((await require('../dist/src/services/restore-locks').getActiveRestoreSections(userId)).size, 0);
  });
});
