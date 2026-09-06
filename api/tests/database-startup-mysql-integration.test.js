const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// This smoke creates the real schema only in an explicitly designated CI test database.
// The other MySQL tests use connection-local temporary tables.
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
