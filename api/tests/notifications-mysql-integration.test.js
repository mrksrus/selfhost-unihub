const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Each table is temporary and connection-local: the optional CI database is never mutated.
test('MySQL notification schema, atomic outbox, due reminders, stale cancellation and session expiry', { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
  process.env.ENCRYPTION_KEY ||= 'notification-mysql-test-key';
  const mysql = require('mysql2/promise');
  const webPush = require('web-push');
  const originalSend = webPush.sendNotification;
  const sent = [];
  webPush.sendNotification = async (_subscription, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; };
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: 'Z' });
  const { setDb } = require('../src/state');
  const executor = {
    async execute(sql, params) {
      // MySQL does not support foreign keys on temporary tables. Production FK constraints
      // are verified by API startup; this fixture exercises the real column/index SQL and queries.
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS notification_') || sql.startsWith('CREATE TABLE IF NOT EXISTS push_')) {
        sql = sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE IF NOT EXISTS').replace(/^\s*FOREIGN KEY[^\n]*\n/gm, '');
      }
      return connection.execute(sql, params);
    },
    getConnection: async () => executor,
    beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release() {},
  };
  setDb(executor);
  t.after(async () => { webPush.sendNotification = originalSend; setDb(null); await connection.end(); });
  const options = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
  await connection.execute(`CREATE TEMPORARY TABLE users (id CHAR(36) PRIMARY KEY, email VARCHAR(255), role VARCHAR(16), is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE sessions (id CHAR(36) PRIMARY KEY, user_id CHAR(36), token VARCHAR(512), expires_at DATETIME) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE calendar_calendars (id CHAR(36) PRIMARY KEY, is_visible BOOLEAN) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE calendar_events (id CHAR(36) PRIMARY KEY, user_id CHAR(36), calendar_id CHAR(36), title VARCHAR(255), start_time DATETIME, end_time DATETIME,
    reminders JSON, reminder_minutes INT, todo_status VARCHAR(24), is_todo_only BOOLEAN DEFAULT FALSE, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE emails (id CHAR(36) PRIMARY KEY, user_id CHAR(36), subject TEXT, from_name TEXT, from_address TEXT, folder VARCHAR(64), is_draft BOOLEAN DEFAULT FALSE, is_read BOOLEAN DEFAULT FALSE) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE backup_restore_jobs (id CHAR(36) PRIMARY KEY, user_id CHAR(36), requested_sections JSON, status VARCHAR(24)) ${options}`);
  const userId = crypto.randomUUID(); const sessionId = crypto.randomUUID();
  await connection.execute("INSERT INTO users (id, email, role) VALUES (?, 'admin@example.com', 'admin')", [userId]);
  await connection.execute('INSERT INTO sessions VALUES (?, ?, ?, ?)', [sessionId, userId, 'test-session', new Date(Date.now() + 86400000)]);
  const service = require('../src/services/notifications');
  await service.ensureNotificationSchema();
  const keys = await service.getVapidKeys();
  const keyBytes = Buffer.alloc(65, 1); keyBytes[0] = 4;
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mysql-test', keys: { p256dh: keyBytes.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
  await service.subscribe(userId, 'test-session', subscription);
  assert.equal(await service.subscriptionStatus(userId, subscription.endpoint), true);
  await service.unsubscribe('different-user', subscription.endpoint);
  assert.equal(await service.subscriptionStatus(userId, subscription.endpoint), true);

  const emailId = crypto.randomUUID();
  await connection.execute("INSERT INTO emails (id, user_id, subject, from_address, folder) VALUES (?, ?, 'Mail', 'sender@example.com', 'inbox')", [emailId, userId]);
  await connection.beginTransaction();
  await service.enqueueMailNotification({ userId, emailId }, executor);
  await connection.rollback();
  const [[rolledBack]] = await connection.execute('SELECT COUNT(*) AS total FROM notification_events');
  assert.equal(rolledBack.total, 0);
  await connection.beginTransaction();
  await service.enqueueMailNotification({ userId, emailId }, executor);
  await service.enqueueMailNotification({ userId, emailId }, executor);
  await connection.commit();
  const [[queued]] = await connection.execute('SELECT COUNT(*) AS total FROM notification_deliveries');
  assert.equal(queued.total, 1);

  const eventId = crypto.randomUUID();
  const start = new Date(Date.now() - 5000);
  await connection.execute("INSERT INTO calendar_events (id, user_id, title, start_time, end_time, reminders) VALUES (?, ?, 'At start', ?, ?, '[0]')", [eventId, userId, start, new Date(start.getTime() + 3600000)]);
  const restoreId = crypto.randomUUID();
  await connection.execute("INSERT INTO backup_restore_jobs VALUES (?, ?, '[\"calendar\",\"mail\"]', 'running')", [restoreId, userId]);
  await service.processNotificationJobs();
  assert.equal(sent.length, 0, 'active mail/calendar restores defer deliveries');
  const [[deferred]] = await connection.execute('SELECT COUNT(*) AS total FROM notification_deliveries WHERE attempts = 0 AND status = ?', ['pending']);
  assert.equal(deferred.total, 1, 'deferred mail stays pending without consuming an attempt');
  const [[scan]] = await connection.execute('SELECT last_reminder_scan_at FROM notification_config WHERE id = 1');
  assert.equal(scan.last_reminder_scan_at, null, 'a restore cannot advance the reminder scan cursor');
  await connection.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
  await service.processNotificationJobs();
  assert.equal(sent.filter(item => item.kind === 'mail').length, 1);
  assert.equal(sent.filter(item => item.kind === 'reminder').length, 1);
  await service.processNotificationJobs();
  assert.equal(sent.length, 2);

  // Simulate a reminder queued before its event was edited; the delivery worker must cancel it.
  const staleId = await service.enqueueEvent({ userId, dedupeKey: 'reminder:stale-occurrence', kind: 'reminder', sourceId: eventId,
    title: 'Obsolete', url: '/calendar', data: { reminderMinutes: 0 }, expiresAt: new Date(Date.now() + 3600000) }, executor);
  await connection.execute("UPDATE calendar_events SET todo_status = 'cancelled' WHERE id = ?", [eventId]);
  await service.processNotificationJobs();
  const [[cancelled]] = await connection.execute('SELECT status FROM notification_deliveries WHERE event_id = ?', [staleId]);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(sent.length, 2);
  assert.equal((await service.getVapidKeys()).publicKey, keys.publicKey);
  await connection.execute('UPDATE sessions SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 60000), sessionId]);
  await service.processNotificationJobs();
  const [[expired]] = await connection.execute('SELECT COUNT(*) AS total FROM push_subscriptions');
  assert.equal(expired.total, 0);
});
