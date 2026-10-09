import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));

// Each table is temporary and connection-local: the optional CI database is never mutated.
test('MySQL notification schema, atomic outbox, due reminders, stale cancellation and session expiry', { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
  process.env.ENCRYPTION_KEY ||= 'notification-mysql-test-key';
  const mysql = require('mysql2/promise');
  const webPush = require('web-push');
  const originalSend = webPush.sendNotification;
  const sent: FixtureValue[] = [];
  webPush.sendNotification = async (_subscription: FixtureValue, payload: FixtureValue) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; };
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: 'Z' });
  const { setDb } = require('../dist/src/state');
  const executor = {
    async execute(sql: string, params: FixtureValue) {
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
  await connection.execute(`CREATE TEMPORARY TABLE user_settings (user_id CHAR(36) NOT NULL,
    setting_key VARCHAR(100) NOT NULL, setting_value JSON, PRIMARY KEY (user_id, setting_key)) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE calendar_calendars (id CHAR(36) PRIMARY KEY, is_visible BOOLEAN) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE calendar_events (id CHAR(36) PRIMARY KEY, user_id CHAR(36), calendar_id CHAR(36), title VARCHAR(255), start_time DATETIME, end_time DATETIME,
    reminders JSON, reminder_minutes INT, todo_status VARCHAR(24), is_todo_only BOOLEAN DEFAULT FALSE, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE emails (id CHAR(36) PRIMARY KEY, user_id CHAR(36), subject TEXT, from_name TEXT, from_address TEXT, folder VARCHAR(64), is_draft BOOLEAN DEFAULT FALSE, is_read BOOLEAN DEFAULT FALSE) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE recording_uploads (id CHAR(36) PRIMARY KEY, user_id CHAR(36), title VARCHAR(255), total_bytes BIGINT, bytes_received BIGINT DEFAULT 0,
    expires_at DATETIME, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ${options}`);
  await connection.execute(`CREATE TEMPORARY TABLE backup_restore_jobs (id CHAR(36) PRIMARY KEY, user_id CHAR(36), requested_sections JSON, status VARCHAR(24)) ${options}`);
  const userId = crypto.randomUUID(); const sessionId = crypto.randomUUID();
  await connection.execute("INSERT INTO users (id, email, role) VALUES (?, 'admin@example.com', 'admin')", [userId]);
  await connection.execute('INSERT INTO sessions VALUES (?, ?, ?, ?)', [sessionId, userId, 'test-session', new Date(Date.now() + 10 * 86400000)]);
  const service = require('../dist/src/services/notifications');
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
  // The outbox uses SQL UTC_TIMESTAMP(), whereas a worker tick captures its
  // cutoff before reconciling reminders. A second boundary-safe tick delivers
  // newly queued reminders even when reconciliation crossed a whole second.
  const [[reminderOutbox]] = await connection.execute("SELECT COUNT(*) AS total FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id WHERE e.kind = 'reminder'");
  assert.equal(reminderOutbox.total, 1, 'the due reminder was genuinely queued');
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

  // A recording upload that stopped moving warns once per stopping point.
  const uploadId = crypto.randomUUID();
  await connection.execute("INSERT INTO recording_uploads VALUES (?, ?, 'Song idea', 1000, 400, ?, UTC_TIMESTAMP() - INTERVAL 11 MINUTE)",
    [uploadId, userId, new Date(Date.now() + 86400000)]);
  await service.processNotificationJobs();
  await service.processNotificationJobs();
  const stalled = sent.filter(item => item.kind === 'recording');
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].tag, `recording-upload:${uploadId}`);
  assert.match(stalled[0].body, /stopped at 40%/);
  // Progress before delivery cancels the warning.
  const movedId = await service.enqueueEvent({ userId, dedupeKey: `recording-upload:${uploadId}:0`, kind: 'recording', sourceId: uploadId,
    title: 'Old', url: '/recordings', data: { bytesReceived: 0 }, expiresAt: new Date(Date.now() + 3600000) }, executor);
  await service.processNotificationJobs();
  const [[moved]] = await connection.execute('SELECT status FROM notification_deliveries WHERE event_id = ?', [movedId]);
  assert.equal(moved.status, 'cancelled');
  await connection.execute('DELETE FROM recording_uploads WHERE id = ?', [uploadId]);
  sent.length = 2;

  // No warning while Recordings is switched off or being restored; one afterwards.
  const quietId = crypto.randomUUID();
  const quietWarnings = () => sent.filter(item => item.tag === `recording-upload:${quietId}`).length;
  await connection.execute("INSERT INTO recording_uploads VALUES (?, ?, 'Quiet take', 1000, 500, ?, UTC_TIMESTAMP() - INTERVAL 11 MINUTE)",
    [quietId, userId, new Date(Date.now() + 86400000)]);
  const { SETTING_KEY } = require('../dist/src/services/module-settings');
  await connection.execute('INSERT INTO user_settings VALUES (?, ?, ?)', [userId, SETTING_KEY, JSON.stringify({ recordings: { enabled: false } })]);
  await service.processNotificationJobs();
  const [[offEvents]] = await connection.execute("SELECT COUNT(*) AS total FROM notification_events WHERE source_id = ?", [quietId]);
  assert.equal(offEvents.total, 0, 'a disabled Recordings module queues no warning');
  await connection.execute('DELETE FROM user_settings WHERE user_id = ? AND setting_key = ?', [userId, SETTING_KEY]);
  const recordingsRestore = crypto.randomUUID();
  await connection.execute("INSERT INTO backup_restore_jobs VALUES (?, ?, '[\"recordings\"]', 'running')", [recordingsRestore, userId]);
  await service.processNotificationJobs();
  const [[restoreEvents]] = await connection.execute("SELECT COUNT(*) AS total FROM notification_events WHERE source_id = ?", [quietId]);
  assert.equal(restoreEvents.total, 0, 'a Recordings restore queues no warning');
  // A warning queued before the restore started waits for it to end.
  await service.enqueueEvent({ userId, dedupeKey: `recording-upload:${quietId}:500`, kind: 'recording', sourceId: quietId,
    title: 'Recording not uploaded yet', url: '/recordings', data: { bytesReceived: 500, tag: `recording-upload:${quietId}` }, expiresAt: new Date(Date.now() + 3600000) }, executor);
  await service.processNotificationJobs();
  assert.equal(quietWarnings(), 0, 'a Recordings restore defers delivery');
  await connection.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [recordingsRestore]);
  await service.processNotificationJobs();
  await service.processNotificationJobs();
  assert.equal(quietWarnings(), 1, 'the queued warning is sent once after the restore');
  await connection.execute('DELETE FROM recording_uploads WHERE id = ?', [quietId]);

  // A restore that starts while pushes go out holds back the rest of them.
  const racing = [crypto.randomUUID(), crypto.randomUUID()];
  const racingRestore = crypto.randomUUID();
  for (const id of racing) {
    await connection.execute("INSERT INTO recording_uploads VALUES (?, ?, 'Racing take', 1000, 200, ?, UTC_TIMESTAMP())", [id, userId, new Date(Date.now() + 86400000)]);
    await service.enqueueEvent({ userId, dedupeKey: `recording-upload:${id}:200`, kind: 'recording', sourceId: id,
      title: 'Recording not uploaded yet', url: '/recordings', data: { bytesReceived: 200, tag: `recording-upload:${id}` }, expiresAt: new Date(Date.now() + 3600000) }, executor);
  }
  const racingWarnings = () => sent.filter(item => racing.some(id => item.tag === `recording-upload:${id}`)).length;
  const plainSend = webPush.sendNotification;
  webPush.sendNotification = async (subscriptionInfo: FixtureValue, payload: FixtureValue) => {
    webPush.sendNotification = plainSend;
    await connection.execute("INSERT INTO backup_restore_jobs VALUES (?, ?, '[\"recordings\"]', 'queued')", [racingRestore, userId]);
    return plainSend(subscriptionInfo, payload);
  };
  await service.processNotificationJobs();
  assert.equal(racingWarnings(), 1, 'the push after the restore started is held back');
  const [[held]] = await connection.execute("SELECT COUNT(*) AS total FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id WHERE e.source_id IN (?, ?) AND d.status = 'pending' AND d.attempts = 0", racing);
  assert.equal(held.total, 1, 'the held push keeps its attempts');
  await connection.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [racingRestore]);
  await service.processNotificationJobs();
  assert.equal(racingWarnings(), 2);
  await connection.execute('DELETE FROM recording_uploads WHERE id IN (?, ?)', racing);

  // Uploads that cannot get a new warning do not hold back newer ones.
  const otherUser = crypto.randomUUID();
  await connection.execute("INSERT INTO users (id, email, role) VALUES (?, 'alex@example.com', 'user')", [otherUser]);
  const unsubscribed = Array.from({ length: 100 }, () => crypto.randomUUID());
  await connection.execute(`INSERT INTO recording_uploads VALUES ${unsubscribed.map(() => "(?, ?, 'Old take', 1000, 100, ?, UTC_TIMESTAMP() - INTERVAL 30 MINUTE)").join(', ')}`,
    unsubscribed.flatMap(id => [id, otherUser, new Date(Date.now() + 86400000)]));
  const newerId = crypto.randomUUID();
  await connection.execute("INSERT INTO recording_uploads VALUES (?, ?, 'New take', 1000, 300, ?, UTC_TIMESTAMP() - INTERVAL 11 MINUTE)",
    [newerId, userId, new Date(Date.now() + 86400000)]);
  await service.processNotificationJobs();
  assert.equal(sent.filter(item => item.tag === `recording-upload:${newerId}`).length, 1);
  await connection.execute('DELETE FROM recording_uploads');
  sent.length = 2;

  // An unused session nearing its end warns the device once.
  await connection.execute('UPDATE sessions SET expires_at = ? WHERE id = ?', [new Date(Date.now() + 30 * 3600000), sessionId]);
  await service.processNotificationJobs();
  await service.processNotificationJobs();
  assert.deepEqual(sent.filter(item => item.kind === 'session').map(item => item.title), ['Notifications will stop soon']);
  const status = await service.deviceStatus(userId, subscription.endpoint);
  assert.equal(status.subscribed, true);
  assert.ok(Date.parse(status.lastSentAt) > Date.now() - 600000);
  assert.ok(Date.parse(status.sessionExpiresAt) > Date.now());
  assert.equal(status.lastError, null);
  await connection.execute('UPDATE sessions SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 60000), sessionId]);
  await service.processNotificationJobs();
  const [[expired]] = await connection.execute('SELECT COUNT(*) AS total FROM push_subscriptions');
  assert.equal(expired.total, 0);
});
