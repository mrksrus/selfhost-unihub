const crypto = require('crypto');
const { db } = require('../state');
const { encrypt, decrypt } = require('../security/encryption');
const { pushAgent } = require('./push-transport');
const { getActiveRestoreSectionsByUser } = require('./restore-locks');
const {
  REMINDER_GRACE_MS, EXCLUDED_MAIL_FOLDERS, asUtcDate, reminderMinutes,
  reminderKey, reminderIsCurrent, hash, normalizeSubscription, retryDisposition,
} = require('./notification-rules');

let running = false;
let keyPromise = null;
const jsonValue = value => typeof value === 'string' ? JSON.parse(value) : value;

async function ensureNotificationSchema() {
  await db.execute(`CREATE TABLE IF NOT EXISTS notification_config (
    id TINYINT PRIMARY KEY, public_key VARCHAR(128) NOT NULL, encrypted_private_key TEXT NOT NULL,
    subject VARCHAR(320) NOT NULL, last_reminder_scan_at DATETIME NULL,
    reminder_revision BIGINT NOT NULL DEFAULT 0, scanned_revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, session_id CHAR(36) NOT NULL,
    endpoint TEXT NOT NULL, endpoint_hash CHAR(64) NOT NULL UNIQUE,
    p256dh VARCHAR(128) NOT NULL, auth VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    INDEX idx_push_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.execute(`CREATE TABLE IF NOT EXISTS notification_events (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, event_key CHAR(64) NOT NULL,
    kind VARCHAR(24) NOT NULL, source_id CHAR(36) NULL, payload JSON NOT NULL,
    expires_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_notification_event (user_id, event_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_notification_event_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.execute(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    event_id CHAR(36) NOT NULL, subscription_id CHAR(36) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    available_at DATETIME NOT NULL, delivered_at DATETIME NULL, last_error VARCHAR(120) NULL,
    PRIMARY KEY (event_id, subscription_id),
    FOREIGN KEY (event_id) REFERENCES notification_events(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    INDEX idx_notification_due (status, available_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.execute(`CREATE TABLE IF NOT EXISTS notification_reminders (
    event_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, minutes INT NOT NULL,
    due_at DATETIME NOT NULL, queued_at DATETIME NULL,
    PRIMARY KEY (event_id, minutes),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_reminder_due (queued_at, due_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [indexes] = await db.execute("SHOW INDEX FROM calendar_events WHERE Key_name = 'idx_events_notification_scan'");
  if (!indexes.length) {
    try { await db.execute('CREATE INDEX idx_events_notification_scan ON calendar_events(updated_at, start_time)'); }
    catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
  }
  await getVapidKeys();
}

async function getVapidKeys() {
  if (!keyPromise) keyPromise = (async () => {
    let [rows] = await db.execute('SELECT public_key, encrypted_private_key, subject FROM notification_config WHERE id = 1');
    if (!rows.length) {
      const webPush = require('web-push');
      const keys = webPush.generateVAPIDKeys();
      const [admins] = await db.execute("SELECT email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
      const subject = process.env.WEB_PUSH_SUBJECT || `mailto:${admins[0]?.email || 'notifications@unihub.invalid'}`;
      // Concurrent startups may generate candidates; INSERT IGNORE and reread choose exactly one stable pair.
      await db.execute('INSERT IGNORE INTO notification_config (id, public_key, encrypted_private_key, subject) VALUES (1, ?, ?, ?)', [keys.publicKey, encrypt(keys.privateKey), subject]);
      [rows] = await db.execute('SELECT public_key, encrypted_private_key, subject FROM notification_config WHERE id = 1');
    }
    const privateKey = decrypt(rows[0].encrypted_private_key);
    if (!privateKey) throw new Error('Unable to decrypt persisted Web Push key');
    return { publicKey: rows[0].public_key, privateKey, subject: rows[0].subject };
  })().catch(error => { keyPromise = null; throw error; });
  return keyPromise;
}

async function subscribe(userId, sessionToken, input) {
  const subscription = normalizeSubscription(input);
  const [sessions] = await db.execute('SELECT id FROM sessions WHERE token = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP()', [sessionToken, userId]);
  if (!sessions.length) { const error = new Error('Session expired'); error.status = 401; throw error; }
  const [count] = await db.execute('SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ?', [userId]);
  const endpointHash = hash(subscription.endpoint);
  const [existing] = await db.execute('SELECT id, user_id FROM push_subscriptions WHERE endpoint_hash = ?', [endpointHash]);
  if (!existing.length && Number(count[0]?.total) >= 20) throw new Error('Maximum notification devices reached');
  // Never transfer another account's endpoint without explicit unsubscribe by its authenticated owner.
  if (existing.length && existing[0].user_id !== userId) throw new Error('This device subscription belongs to another account. Disable and enable notifications again.');
  await db.execute(`INSERT IGNORE INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [existing[0]?.id || crypto.randomUUID(), userId, sessions[0].id, subscription.endpoint, endpointHash, subscription.keys.p256dh, subscription.keys.auth]);
  await db.execute('UPDATE push_subscriptions SET session_id = ?, p256dh = ?, auth = ?, updated_at = UTC_TIMESTAMP() WHERE user_id = ? AND endpoint_hash = ?',
    [sessions[0].id, subscription.keys.p256dh, subscription.keys.auth, userId, endpointHash]);
  const [owners] = await db.execute('SELECT user_id FROM push_subscriptions WHERE endpoint_hash = ?', [endpointHash]);
  if (owners[0]?.user_id !== userId) throw new Error('This device subscription belongs to another account. Disable and enable notifications again.');
  // Marking this scan dirty includes old calendar entries for a newly subscribed device.
  if (!existing.length) await db.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
  return { subscribed: true };
}
async function unsubscribe(userId, endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) throw new Error('Invalid subscription endpoint');
  await db.execute('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [userId, hash(endpoint)]);
  return { subscribed: false };
}
async function subscriptionStatus(userId, endpoint) {
  if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 4096) return false;
  const [rows] = await db.execute(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    WHERE p.user_id = ? AND p.endpoint_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [userId, hash(endpoint)]);
  return rows.length > 0;
}

async function enqueueEvent({ userId, dedupeKey, kind, sourceId = null, title, body, url, expiresAt, data = {}, endpointHash = null }, connection = db) {
  const [devices] = await connection.execute(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE
    ${endpointHash ? 'AND p.endpoint_hash = ?' : ''}`, endpointHash ? [userId, endpointHash] : [userId]);
  if (!devices.length) return null;
  const eventId = crypto.randomUUID();
  const payload = { version: 1, userId, dedupeKey, kind, title: String(title || 'UniHub').slice(0, 120), body: String(body || '').slice(0, 400), url, ...data };
  const [insert] = await connection.execute(`INSERT IGNORE INTO notification_events (id, user_id, event_key, kind, source_id, payload, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [eventId, userId, hash(dedupeKey), kind, sourceId, JSON.stringify(payload), expiresAt]);
  if (!insert.affectedRows) return null;
  for (const device of devices) await connection.execute(`INSERT INTO notification_deliveries (event_id, subscription_id, available_at) VALUES (?, ?, UTC_TIMESTAMP())`, [eventId, device.id]);
  return eventId;
}
async function enqueueMailNotification({ userId, emailId, suppressNotifications = false }, connection = db) {
  if (suppressNotifications) return null;
  if (connection === db) {
    const transaction = await db.getConnection();
    try {
      await transaction.beginTransaction();
      const eventId = await enqueueMailNotification({ userId, emailId }, transaction);
      await transaction.commit();
      return eventId;
    } catch (error) { await transaction.rollback(); throw error; }
    finally { transaction.release(); }
  }
  const [rows] = await connection.execute('SELECT id, subject, from_name, from_address, folder, is_draft, is_read FROM emails WHERE id = ? AND user_id = ?', [emailId, userId]);
  const email = rows[0];
  if (!email || email.is_draft || email.is_read || EXCLUDED_MAIL_FOLDERS.has(email.folder)) return null;
  return enqueueEvent({ userId, dedupeKey: `mail:${email.id}`, kind: 'mail', sourceId: email.id, title: 'New Email',
    body: `${email.from_name || email.from_address || 'Unknown sender'}: ${email.subject || '(No subject)'}`, url: `/mail?email=${encodeURIComponent(email.id)}`,
    data: { emailId: email.id }, expiresAt: new Date(Date.now() + 86400000) }, connection);
}
async function enqueueCalendarNotification({ userId, eventId }, connection = db) {
  if (connection === db) {
    const transaction = await db.getConnection();
    try {
      await transaction.beginTransaction();
      const id = await enqueueCalendarNotification({ userId, eventId }, transaction);
      await transaction.commit();
      return id;
    } catch (error) { await transaction.rollback(); throw error; }
    finally { transaction.release(); }
  }
  const [events] = await connection.execute('SELECT e.*, c.is_visible FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.user_id = ?', [eventId, userId]);
  const event = events[0];
  if (!event || event.is_visible === 0 || ['done', 'cancelled'].includes(event.todo_status)) return null;
  const kind = event.is_todo_only ? 'todo' : 'calendar';
  return enqueueEvent({ userId, dedupeKey: `${kind}:${event.id}`, kind, sourceId: event.id,
    title: event.is_todo_only ? 'New ToDo' : 'New Calendar Event', body: event.title,
    url: `${event.is_todo_only ? '/todo' : '/calendar'}?event=${encodeURIComponent(event.id)}`, data: { eventId: event.id }, expiresAt: new Date(Date.now() + 86400000) }, connection);
}
async function enqueueTestNotification(userId, endpoint) {
  if (!await subscriptionStatus(userId, endpoint)) throw new Error('Enable notifications on this device first');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const eventId = await enqueueEvent({ userId, dedupeKey: `test:${hash(endpoint)}:${Math.floor(Date.now() / 30000)}`, kind: 'test', title: 'UniHub notifications are working',
      body: 'This notification was sent through the server to this device.', url: '/settings', expiresAt: new Date(Date.now() + 3600000), endpointHash: hash(endpoint) }, connection);
    await connection.commit();
    return { queued: !!eventId };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function reconcileReminders(connection, now, activeRestores = new Map()) {
  const [settings] = await connection.execute('SELECT last_reminder_scan_at, reminder_revision, scanned_revision FROM notification_config WHERE id = 1');
  const revision = settings[0]?.reminder_revision || 0;
  const scanAt = revision === (settings[0]?.scanned_revision || 0) ? settings[0]?.last_reminder_scan_at : null;
  const [events] = await connection.execute(`SELECT e.*, c.is_visible FROM calendar_events e
    LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
    WHERE EXISTS (SELECT 1 FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id WHERE p.user_id = e.user_id AND s.expires_at > UTC_TIMESTAMP())
    ${scanAt ? 'AND e.updated_at >= ?' : 'AND e.start_time >= ?'}`, [scanAt ? new Date(asUtcDate(scanAt).getTime() - 2000) : new Date(now.getTime() - REMINDER_GRACE_MS)]);
  await connection.beginTransaction();
  try {
    for (const event of events) {
      if (activeRestores.get(event.user_id)?.has('calendar')) continue;
      await connection.execute('DELETE FROM notification_reminders WHERE event_id = ?', [event.id]);
      if (['done', 'cancelled'].includes(event.todo_status) || event.is_visible === 0 || event.is_visible === false) continue;
      const start = asUtcDate(event.start_time).getTime();
      if (!Number.isFinite(start)) continue;
      for (const minutes of reminderMinutes(event)) {
        const dueAt = start - minutes * 60000;
        if (dueAt < now.getTime() - REMINDER_GRACE_MS) continue;
        await connection.execute('INSERT INTO notification_reminders (event_id, user_id, minutes, due_at) VALUES (?, ?, ?, ?)', [event.id, event.user_id, minutes, new Date(dueAt)]);
      }
    }
    // Keep the cursor before any skipped changes, including a restore that later
    // fails or is cancelled. Other users' reminders can still be reconciled.
    if (![...activeRestores.values()].some(sections => sections.has('calendar'))) {
      await connection.execute('UPDATE notification_config SET last_reminder_scan_at = ?, scanned_revision = ? WHERE id = 1', [now, revision]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
}
async function enqueueDueReminders(connection, now, activeRestores = new Map()) {
  const blockedUsers = [...activeRestores].filter(([, sections]) => sections.has('calendar')).map(([userId]) => userId);
  const [rows] = await connection.execute(`SELECT e.*, c.is_visible, r.minutes, r.due_at FROM notification_reminders r
    JOIN calendar_events e ON e.id = r.event_id LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
    WHERE r.queued_at IS NULL AND r.due_at <= ?
    ${blockedUsers.length ? `AND r.user_id NOT IN (${blockedUsers.map(() => '?').join(', ')})` : ''}
    ORDER BY r.due_at LIMIT 200`, [now, ...blockedUsers]);
  for (const event of rows) {
    await connection.beginTransaction();
    try {
      const data = { eventId: event.id, reminderMinutes: event.minutes, dedupeKey: reminderKey(event, event.minutes) };
      if (reminderIsCurrent(event, data, now.getTime())) await enqueueEvent({ userId: event.user_id, dedupeKey: data.dedupeKey, kind: 'reminder', sourceId: event.id,
        title: event.title, body: event.minutes === 0 ? 'Event is starting now' : `Event starts in ${event.minutes} minutes`,
        url: `${event.is_todo_only ? '/todo' : '/calendar'}?event=${encodeURIComponent(event.id)}`, data, expiresAt: new Date(asUtcDate(event.due_at).getTime() + REMINDER_GRACE_MS) }, connection);
      await connection.execute('UPDATE notification_reminders SET queued_at = ? WHERE event_id = ? AND minutes = ?', [now, event.id, event.minutes]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }
}
async function eventStillCurrent(row, payload, connection) {
  if (row.kind === 'reminder') {
    const [events] = await connection.execute('SELECT e.*, c.is_visible FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.user_id = ?', [row.source_id, row.user_id]);
    return reminderIsCurrent(events[0], payload);
  }
  if (['calendar', 'todo'].includes(row.kind)) {
    const [events] = await connection.execute('SELECT e.todo_status, c.is_visible FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.user_id = ?', [row.source_id, row.user_id]);
    return !!events[0] && events[0].is_visible !== 0 && !['done', 'cancelled'].includes(events[0].todo_status);
  }
  if (row.kind === 'mail') {
    const [emails] = await connection.execute('SELECT folder, is_draft, is_read FROM emails WHERE id = ? AND user_id = ?', [row.source_id, row.user_id]);
    return !!emails[0] && !emails[0].is_draft && !emails[0].is_read && !EXCLUDED_MAIL_FOLDERS.has(emails[0].folder);
  }
  return true;
}
async function deliverPending(connection, now, activeRestores = new Map()) {
  const exclusions = [];
  const excludedParams = [];
  for (const [section, kinds] of [['calendar', "'calendar', 'todo', 'reminder'"], ['mail', "'mail'"]]) {
    const users = [...activeRestores].filter(([, sections]) => sections.has(section)).map(([userId]) => userId);
    if (users.length) {
      exclusions.push(`NOT (e.kind IN (${kinds}) AND e.user_id IN (${users.map(() => '?').join(', ')}))`);
      excludedParams.push(...users);
    }
  }
  const [rows] = await connection.execute(`SELECT d.*, e.user_id, e.kind, e.source_id, e.payload, e.expires_at, p.endpoint, p.p256dh, p.auth
    FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    JOIN push_subscriptions p ON p.id = d.subscription_id JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id JOIN users u ON u.id = p.user_id
    WHERE d.status = 'pending' AND d.available_at <= ? AND e.expires_at > ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE
    ${exclusions.length ? `AND ${exclusions.join(' AND ')}` : ''}
    ORDER BY d.available_at LIMIT 25`, [now, now, ...excludedParams]);
  if (!rows.length) return 0;
  const keys = await getVapidKeys();
  const webPush = require('web-push');
  let delivered = 0;
  for (const row of rows) {
    const payload = jsonValue(row.payload);
    if (!await eventStillCurrent(row, payload, connection)) {
      await connection.execute("UPDATE notification_deliveries SET status = 'cancelled' WHERE event_id = ? AND subscription_id = ?", [row.event_id, row.subscription_id]);
      continue;
    }
    const attempts = Number(row.attempts) + 1;
    await connection.execute('UPDATE notification_deliveries SET attempts = ?, available_at = ? WHERE event_id = ? AND subscription_id = ?', [attempts, new Date(Date.now() + 60000), row.event_id, row.subscription_id]);
    try {
      await webPush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({ ...payload, notificationId: row.event_id }),
        { agent: pushAgent, vapidDetails: keys, TTL: Math.max(0, Math.min(86400, Math.floor((asUtcDate(row.expires_at).getTime() - Date.now()) / 1000))), urgency: row.kind === 'reminder' ? 'high' : 'normal', timeout: 10000, topic: hash(payload.dedupeKey).slice(0, 32) });
      await connection.execute("UPDATE notification_deliveries SET status = 'sent', delivered_at = UTC_TIMESTAMP(), last_error = NULL WHERE event_id = ? AND subscription_id = ?", [row.event_id, row.subscription_id]);
      delivered++;
    } catch (error) {
      const outcome = retryDisposition(error, attempts);
      if (outcome.expired) await connection.execute('DELETE FROM push_subscriptions WHERE id = ?', [row.subscription_id]);
      else await connection.execute('UPDATE notification_deliveries SET status = ?, available_at = ?, last_error = ? WHERE event_id = ? AND subscription_id = ?',
        [outcome.retry ? 'pending' : 'failed', outcome.nextAttempt || now, `Push service ${Number(error.statusCode) || 'network error'}`, row.event_id, row.subscription_id]);
    }
  }
  return delivered;
}
async function processNotificationJobs() {
  if (running) return { skipped: true };
  running = true;
  let connection;
  let locked = false;
  try {
    connection = await db.getConnection();
    const [lock] = await connection.execute("SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':notification-jobs'), 256), 0) AS acquired");
    locked = Number(lock[0]?.acquired) === 1;
    if (!locked) return { skipped: true };
    const now = new Date();
    await reconcileReminders(connection, now, await getActiveRestoreSectionsByUser(connection));
    await connection.execute('DELETE FROM notification_reminders WHERE due_at < ?', [new Date(now.getTime() - REMINDER_GRACE_MS)]);
    await enqueueDueReminders(connection, now, await getActiveRestoreSectionsByUser(connection));
    const delivered = await deliverPending(connection, now, await getActiveRestoreSectionsByUser(connection));
    await connection.execute("DELETE FROM notification_events WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 30 DAY");
    await connection.execute("DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE expires_at <= UTC_TIMESTAMP())");
    return { delivered };
  } finally {
    if (connection) {
      if (locked) await connection.execute("SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':notification-jobs'), 256))").catch(() => {});
      connection.release();
    }
    running = false;
  }
}
module.exports = { ensureNotificationSchema, getVapidKeys, subscribe, unsubscribe, subscriptionStatus, enqueueMailNotification, enqueueCalendarNotification, enqueueTestNotification, enqueueEvent, processNotificationJobs };
