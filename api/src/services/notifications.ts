import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor, ApiError } from '../types';

import crypto from 'crypto';
import { db } from '../state';
import { isModuleBackgroundEnabled } from './module-settings';
import { getActiveRestoreSectionsByUser } from './restore-locks';
import { blockedBackgroundModulesByUser } from './access-policy';
import { NOTIFICATION_TRANSPORTS, getVapidKeys } from './notification-transports';
import type { DeliveryTarget, NotificationTransport } from './notification-transports';
import {
  REMINDER_GRACE_MS,
  EXCLUDED_MAIL_FOLDERS,
  asUtcDate,
  reminderMinutes,
  reminderKey,
  reminderIsCurrent,
  hash,
  normalizeSubscription,
} from './notification-rules';

interface NotificationPayload extends Record<string, unknown> {
  dedupeKey?: string;
  reminderMinutes?: unknown;
  bytesReceived?: unknown;
}
interface EventInput {
  userId: string;
  dedupeKey: string;
  kind: string;
  sourceId?: string | null;
  title?: unknown;
  body?: unknown;
  url: string;
  expiresAt: Date;
  data?: Record<string, unknown>;
  endpointHash?: string | null;
  held?: boolean;
}
interface EventRow { kind: string; source_id: string | null; user_id: string }
interface DueDelivery extends EventRow {
  event_id: string;
  subscription_id: string;
  attempts: number | string;
  payload: unknown;
  expires_at: unknown;
  endpoint: string;
  p256dh: string;
  auth: string;
  transport: string;
}
type BlockedModules = ReadonlyMap<string, ReadonlySet<string>>;

const SESSION_WARNING_MS = 2 * 24 * 60 * 60 * 1000;
const RECORDING_STALL_MS = 10 * 60 * 1000;
let running = false;
const jsonValue = (value: unknown): NotificationPayload => (typeof value === 'string' ? JSON.parse(value) : value) as NotificationPayload;

async function subscribe(userId: string, sessionToken: string | null, input: unknown) {
  const subscription = normalizeSubscription(input as Parameters<typeof normalizeSubscription>[0]);
  const [sessions] = await db.execute<RowDataPacket[]>('SELECT id FROM sessions WHERE token = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP()', [sessionToken, userId]);
  if (!sessions.length) { const error: ApiError = new Error('Session expired'); error.status = 401; throw error; }
  const [count] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ?', [userId]);
  const endpointHash = hash(subscription.endpoint);
  const [existing] = await db.execute<RowDataPacket[]>('SELECT id, user_id FROM push_subscriptions WHERE endpoint_hash = ?', [endpointHash]);
  if (!existing.length && Number(count[0]?.total) >= 20) throw new Error('Maximum notification devices reached');
  // Never transfer another account's endpoint without explicit unsubscribe by its authenticated owner.
  if (existing.length && existing[0].user_id !== userId) throw new Error('This device subscription belongs to another account. Disable and enable notifications again.');
  await db.execute(`INSERT IGNORE INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [existing[0]?.id || crypto.randomUUID(), userId, sessions[0].id, subscription.endpoint, endpointHash, subscription.keys.p256dh, subscription.keys.auth]);
  await db.execute('UPDATE push_subscriptions SET session_id = ?, p256dh = ?, auth = ?, updated_at = UTC_TIMESTAMP() WHERE user_id = ? AND endpoint_hash = ?',
    [sessions[0].id, subscription.keys.p256dh, subscription.keys.auth, userId, endpointHash]);
  const [owners] = await db.execute<RowDataPacket[]>('SELECT user_id FROM push_subscriptions WHERE endpoint_hash = ?', [endpointHash]);
  if (owners[0]?.user_id !== userId) throw new Error('This device subscription belongs to another account. Disable and enable notifications again.');
  // Marking this scan dirty includes old calendar entries for a newly subscribed device.
  if (!existing.length) await db.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
  return { subscribed: true };
}
async function unsubscribe(userId: string, endpoint: unknown) {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) throw new Error('Invalid subscription endpoint');
  await db.execute('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [userId, hash(endpoint)]);
  return { subscribed: false };
}
async function subscriptionStatus(userId: string, endpoint: unknown) {
  if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 4096) return false;
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    WHERE p.user_id = ? AND p.endpoint_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [userId, hash(endpoint)]);
  return rows.length > 0;
}

// What Settings shows for this device: whether the server still has its
// subscription, when its session ends, and the latest delivery outcome.
async function deviceStatus(userId: string, endpoint: unknown) {
  if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 4096) return { subscribed: false };
  const [devices] = await db.execute<RowDataPacket[]>(`SELECT p.id, s.expires_at FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    WHERE p.user_id = ? AND p.endpoint_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [userId, hash(endpoint)]);
  if (!devices.length) return { subscribed: false };
  // An app that was offline holds pending deliveries until they expire; those no longer wait.
  const [[summary]] = await db.execute<RowDataPacket[]>(`SELECT MAX(CASE WHEN d.status = 'sent' THEN d.delivered_at END) AS last_sent_at,
    SUM(d.status = 'pending' AND e.expires_at > UTC_TIMESTAMP()) AS pending FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE d.subscription_id = ?`, [devices[0].id]);
  const [failures] = await db.execute<RowDataPacket[]>(`SELECT d.last_error, e.created_at FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE d.subscription_id = ? AND d.last_error IS NOT NULL ORDER BY e.created_at DESC LIMIT 1`, [devices[0].id]);
  const iso = (value: unknown) => value ? asUtcDate(value).toISOString() : null;
  const lastSentAt = iso(summary?.last_sent_at);
  // A problem with a notification older than the latest delivery is resolved.
  const failure = failures[0] && (!lastSentAt || asUtcDate(failures[0].created_at).toISOString() > lastSentAt) ? failures[0] : null;
  return {
    subscribed: true,
    sessionExpiresAt: iso(devices[0].expires_at),
    lastSentAt,
    pending: Number(summary?.pending || 0),
    lastError: failure ? { message: failure.last_error, at: iso(failure.created_at) } : null,
  };
}

function notificationModule(kind: string) {
  return kind === 'mail' ? 'mail' : ['calendar', 'todo', 'reminder'].includes(kind) ? 'calendar' : kind === 'recording' ? 'recordings' : null;
}
// The user's devices that can still be reached: subscriptions of live sessions.
async function subscribedDevices(userId: string, connection: SqlExecutor, endpointHash: string | null = null) {
  const [devices] = await connection.execute<RowDataPacket[]>(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE
    ${endpointHash ? 'AND p.endpoint_hash = ?' : ''}`, endpointHash ? [userId, endpointHash] : [userId]);
  return devices as { id: string }[];
}
async function queueDeliveries(eventId: string, devices: { id: string }[], connection: SqlExecutor) {
  for (const device of devices) await connection.execute(`INSERT IGNORE INTO notification_deliveries (event_id, subscription_id, available_at) VALUES (?, ?, UTC_TIMESTAMP())`, [eventId, device.id]);
}
// A held event is recorded without deliveries; releasing it later (mail) fills
// in its payload and queues the deliveries then.
async function enqueueEvent({ userId, dedupeKey, kind, sourceId = null, title, body, url, expiresAt, data = {}, endpointHash = null, held = false }: EventInput, connection: SqlExecutor = db) {
  const moduleId = notificationModule(kind);
  if (moduleId && !await isModuleBackgroundEnabled(userId, moduleId, connection)) return null;
  const devices = await subscribedDevices(userId, connection, endpointHash);
  if (!devices.length) return null;
  const eventId = crypto.randomUUID();
  const payload = { version: 1, userId, dedupeKey, kind, title: String(title || 'UniHub').slice(0, 120), body: String(body || '').slice(0, 400), url, ...data, ...(held ? { held: true } : {}) };
  const [insert] = await connection.execute<ResultSetHeader>(`INSERT IGNORE INTO notification_events (id, user_id, event_key, kind, source_id, payload, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [eventId, userId, hash(dedupeKey), kind, sourceId, JSON.stringify(payload), expiresAt]);
  if (!insert.affectedRows) return null;
  if (!held) await queueDeliveries(eventId, devices, connection);
  return eventId;
}
function mailNotificationText(email: RowDataPacket) {
  return { title: 'New Email', body: `${email.from_name || email.from_address || 'Unknown sender'}: ${email.subject || '(No subject)'}`,
    url: `/mail?email=${encodeURIComponent(email.id)}` };
}
async function announceableMail(userId: string, emailId: string, connection: SqlExecutor) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT id, subject, from_name, from_address, folder, is_draft, is_read FROM emails WHERE id = ? AND user_id = ?', [emailId, userId]);
  const email = rows[0];
  return !email || email.is_draft || email.is_read || EXCLUDED_MAIL_FOLDERS.has(email.folder) ? null : email;
}
// The mail engine records an arrival before it downloads the message, so the
// sender and subject are not known yet. With `held`, the event is created in
// the same transaction as the arrival (fixing which messages count as new) and
// nothing is sent until the import releases it (releaseMailNotification). A
// message whose content never arrives expires unsent.
async function enqueueMailNotification({ userId, emailId, held = false }: { userId: string; emailId: string; held?: boolean }, connection: SqlExecutor = db): Promise<string | null> {
  if (connection === db) {
    const transaction = await db.getConnection();
    try {
      await transaction.beginTransaction();
      const eventId = await enqueueMailNotification({ userId, emailId, held }, transaction);
      await transaction.commit();
      return eventId;
    } catch (error) { await transaction.rollback(); throw error; }
    finally { transaction.release(); }
  }
  const email = await announceableMail(userId, emailId, connection);
  if (!email) return null;
  return enqueueEvent({ userId, dedupeKey: `mail:${email.id}`, kind: 'mail', sourceId: email.id, ...mailNotificationText(email),
    data: { emailId: email.id }, expiresAt: new Date(Date.now() + 86400000), held }, connection);
}
// Called by the import that brings the message content, in its transaction:
// the held event gets the real sender and subject and its deliveries. A message
// read or filed away before its content arrived stays unsent; an event that
// was already released is left alone.
async function releaseMailNotification({ userId, emailId }: { userId: string; emailId: string }, connection: SqlExecutor): Promise<string | null> {
  const [events] = await connection.execute<RowDataPacket[]>("SELECT id, payload FROM notification_events WHERE user_id = ? AND kind = 'mail' AND source_id = ? FOR UPDATE", [userId, emailId]);
  const event = events[0];
  if (!event || jsonValue(event.payload).held !== true) return null;
  const email = await announceableMail(userId, emailId, connection);
  if (!email) return null;
  const { held: _held, ...stored } = jsonValue(event.payload);
  const text = mailNotificationText(email);
  const payload = { ...stored, title: text.title.slice(0, 120), body: text.body.slice(0, 400), url: text.url };
  await connection.execute('UPDATE notification_events SET payload = ? WHERE id = ? AND user_id = ?', [JSON.stringify(payload), event.id, userId]);
  await queueDeliveries(event.id, await subscribedDevices(userId, connection), connection);
  return event.id;
}
async function enqueueCalendarNotification({ userId, eventId }: { userId: string; eventId: string }, connection: SqlExecutor = db): Promise<string | null> {
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
  const [events] = await connection.execute<(RowDataPacket & { id: string; user_id: string; start_time: unknown; reminders?: unknown; reminder_minutes?: unknown; todo_status: string; is_visible: boolean | number })[]>('SELECT e.*, c.is_visible FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.user_id = ?', [eventId, userId]);
  const event = events[0];
  if (!event || event.is_visible === 0 || ['done', 'cancelled'].includes(event.todo_status)) return null;
  const kind = event.is_todo_only ? 'todo' : 'calendar';
  return enqueueEvent({ userId, dedupeKey: `${kind}:${event.id}`, kind, sourceId: event.id,
    title: event.is_todo_only ? 'New ToDo' : 'New Calendar Event', body: event.title,
    url: `${event.is_todo_only ? '/todo' : '/calendar'}?event=${encodeURIComponent(event.id)}`, data: { eventId: event.id }, expiresAt: new Date(Date.now() + 86400000) }, connection);
}
async function enqueueTestNotification(userId: string, endpoint: unknown) {
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

async function reconcileReminders(connection: PoolConnection, now: Date, activeRestores: BlockedModules = new Map()) {
  const [settings] = await connection.execute<RowDataPacket[]>('SELECT last_reminder_scan_at, reminder_revision, scanned_revision FROM notification_config WHERE id = 1');
  const revision = settings[0]?.reminder_revision || 0;
  const scanAt = revision === (settings[0]?.scanned_revision || 0) ? settings[0]?.last_reminder_scan_at : null;
  const [events] = await connection.execute<(RowDataPacket & { id: string; user_id: string; start_time: unknown; reminders?: unknown; reminder_minutes?: unknown; todo_status: string; is_visible: boolean | number })[]>(`SELECT e.*, c.is_visible FROM calendar_events e
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
async function enqueueDueReminders(connection: PoolConnection, now: Date, activeRestores: BlockedModules = new Map()) {
  const blockedUsers = [...activeRestores].filter(([, sections]) => sections.has('calendar')).map(([userId]) => userId);
  const [rows] = await connection.execute<(RowDataPacket & { id: string; user_id: string; start_time: unknown; reminders?: unknown; reminder_minutes?: unknown; todo_status: string; is_visible: boolean | number })[]>(`SELECT e.*, c.is_visible, r.minutes, r.due_at FROM notification_reminders r
    JOIN calendar_events e ON e.id = r.event_id LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
    WHERE r.queued_at IS NULL AND r.due_at <= ?
    ${blockedUsers.length ? `AND r.user_id NOT IN (${blockedUsers.map(() => '?').join(', ')})` : ''}
    ORDER BY r.due_at LIMIT 200`, [now, ...blockedUsers]);
  for (const event of rows) {
    if (!await isModuleBackgroundEnabled(event.user_id, 'calendar', connection)) continue;
    await connection.beginTransaction();
    try {
      const data = { eventId: event.id, reminderMinutes: event.minutes, dedupeKey: reminderKey(event, event.minutes) };
      if (reminderIsCurrent(event, data, now.getTime())) await enqueueEvent({ userId: event.user_id, dedupeKey: data.dedupeKey, kind: 'reminder', sourceId: event.id,
        title: event.title, body: event.minutes === 0 ? 'Event is starting now' : `Event starts in ${event.minutes} minutes`,
        url: `${event.is_todo_only ? '/todo' : '/calendar'}?event=${encodeURIComponent(event.id)}`, data, expiresAt: new Date(asUtcDate(event.due_at).getTime() + REMINDER_GRACE_MS) }, connection);
      if (!await isModuleBackgroundEnabled(event.user_id, 'calendar', connection)) { await connection.rollback(); continue; }
      await connection.execute('UPDATE notification_reminders SET queued_at = ? WHERE event_id = ? AND minutes = ?', [now, event.id, event.minutes]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }
}
async function eventStillCurrent(row: EventRow, payload: NotificationPayload, connection: SqlExecutor) {
  if (row.kind === 'session') {
    // Skip the warning once the session was renewed by opening the app.
    const [sessions] = await connection.execute<RowDataPacket[]>('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND expires_at <= UTC_TIMESTAMP() + INTERVAL ? SECOND',
      [row.source_id, row.user_id, Math.ceil(SESSION_WARNING_MS / 1000)]);
    return sessions.length > 0;
  }
  if (row.kind === 'reminder') {
    const [events] = await connection.execute<(RowDataPacket & { id: string; user_id: string; start_time: unknown; reminders?: unknown; reminder_minutes?: unknown; todo_status: string; is_visible: boolean | number })[]>('SELECT e.*, c.is_visible FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.user_id = ?', [row.source_id, row.user_id]);
    return reminderIsCurrent(events[0], payload);
  }
  if (['calendar', 'todo'].includes(row.kind)) {
    const [events] = await connection.execute<(RowDataPacket & { id: string; user_id: string; start_time: unknown; reminders?: unknown; reminder_minutes?: unknown; todo_status: string; is_visible: boolean | number })[]>('SELECT e.todo_status, c.is_visible FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.user_id = ?', [row.source_id, row.user_id]);
    return !!events[0] && events[0].is_visible !== 0 && !['done', 'cancelled'].includes(events[0].todo_status);
  }
  if (row.kind === 'recording') {
    // An upload that moved on, finished or was cancelled needs no warning.
    const [uploads] = await connection.execute<RowDataPacket[]>('SELECT bytes_received FROM recording_uploads WHERE id = ? AND user_id = ?', [row.source_id, row.user_id]);
    return !!uploads[0] && Number(uploads[0].bytes_received) === Number(payload.bytesReceived);
  }
  if (row.kind === 'mail') {
    const [emails] = await connection.execute<RowDataPacket[]>('SELECT folder, is_draft, is_read FROM emails WHERE id = ? AND user_id = ?', [row.source_id, row.user_id]);
    return !!emails[0] && !emails[0].is_draft && !emails[0].is_read && !EXCLUDED_MAIL_FOLDERS.has(emails[0].folder);
  }
  return true;
}
// Due deliveries whose device still belongs to a live session of an active
// user, skipping users whose section is being restored.
async function selectDueDeliveries(connection: SqlExecutor, now: Date, activeRestores: BlockedModules) {
  const exclusions = [];
  const excludedParams: string[] = [];
  for (const [section, kinds] of [['calendar', "'calendar', 'todo', 'reminder'"], ['mail', "'mail'"], ['recordings', "'recording'"]]) {
    const users = [...activeRestores].filter(([, sections]) => sections.has(section)).map(([userId]) => userId);
    if (users.length) {
      exclusions.push(`NOT (e.kind IN (${kinds}) AND e.user_id IN (${users.map(() => '?').join(', ')}))`);
      excludedParams.push(...users);
    }
  }
  // An Android device is reached only while its stream is open here; an
  // offline phone's deliveries wait unselected (connecting makes them due), so
  // they never fill the batch ahead of other devices.
  const live = (require('./android-push') as typeof import('./android-push')).connectedDevices();
  const [rows] = await connection.execute<(RowDataPacket & DueDelivery)[]>(`SELECT d.*, e.user_id, e.kind, e.source_id, e.payload, e.expires_at, p.endpoint, p.p256dh, p.auth, p.transport
    FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    JOIN push_subscriptions p ON p.id = d.subscription_id JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id JOIN users u ON u.id = p.user_id
    WHERE d.status = 'pending' AND d.available_at <= ? AND e.expires_at > ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE
    ${exclusions.length ? `AND ${exclusions.join(' AND ')}` : ''}
    AND (p.transport <> 'android'${live.length ? ` OR p.id IN (${live.map(() => '?').join(', ')})` : ''})
    ORDER BY d.available_at LIMIT ${BATCH}`, [now, now, ...excludedParams, ...live]);
  return rows;
}
// The subscription's transport selects how the delivery is sent.
function deliveryTarget(row: DueDelivery): DeliveryTarget {
  if (row.transport === 'android') return { kind: 'android', id: row.subscription_id, userId: row.user_id, p256dh: row.p256dh, auth: row.auth };
  return { kind: 'webpush', id: row.subscription_id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
}
// TypeScript cannot relate a target's kind to its transport by itself.
function transportFor<T extends DeliveryTarget>(target: T) {
  return NOTIFICATION_TRANSPORTS[target.kind] as unknown as NotificationTransport<T>;
}
// Further batches while the last was full, for up to MAX_BATCHES batches and
// BATCH_TIME_MS: a phone that comes back with a backlog gets it within a pass
// or two instead of 25 per 30 seconds, and a slow push service still cannot
// hold one pass for long.
const BATCH = 25;
const MAX_BATCHES = 8;
const BATCH_TIME_MS = 20 * 1000;
async function deliverPending(connection: SqlExecutor, now: Date, activeRestores: BlockedModules = new Map()) {
  let delivered = 0;
  const started = Date.now();
  for (let batch = 0; batch < MAX_BATCHES && Date.now() - started < BATCH_TIME_MS; batch++) {
    const rows = await selectDueDeliveries(connection, now, activeRestores);
    if (!rows.length) break;
    delivered += await deliverBatch(connection, now, rows);
    if (rows.length < BATCH) break;
  }
  return delivered;
}
async function deliverBatch(connection: SqlExecutor, now: Date, rows: DueDelivery[]) {
  for (const kind of new Set(rows.map(row => deliveryTarget(row).kind))) await NOTIFICATION_TRANSPORTS[kind].ready();
  let delivered = 0;
  for (const row of rows) {
    const moduleId = notificationModule(row.kind);
    if (moduleId && !await isModuleBackgroundEnabled(row.user_id, moduleId, connection)) continue;
    const payload = jsonValue(row.payload);
    const current = await eventStillCurrent(row, payload, connection);
    // Recheck after source reads, before changing queued work or starting network IO.
    // A restore may have started since the snapshot the rows were selected with.
    if (moduleId && (!await isModuleBackgroundEnabled(row.user_id, moduleId, connection) || (await getActiveRestoreSectionsByUser(connection, row.user_id)).get(row.user_id)?.has(moduleId))) continue;
    if (!current) {
      await connection.execute("UPDATE notification_deliveries SET status = 'cancelled' WHERE event_id = ? AND subscription_id = ? AND status = 'pending'", [row.event_id, row.subscription_id]);
      continue;
    }
    const attempts = Number(row.attempts) + 1;
    await connection.execute('UPDATE notification_deliveries SET attempts = ?, available_at = ? WHERE event_id = ? AND subscription_id = ?', [attempts, new Date(Date.now() + 60000), row.event_id, row.subscription_id]);
    const target = deliveryTarget(row);
    const outcome = await transportFor(target).send(target, { eventId: row.event_id, kind: row.kind, payload, expiresAt: row.expires_at }, attempts);
    if (outcome.sent) {
      await connection.execute("UPDATE notification_deliveries SET status = 'sent', delivered_at = UTC_TIMESTAMP(), last_error = NULL WHERE event_id = ? AND subscription_id = ?", [row.event_id, row.subscription_id]);
      delivered++;
    } else if ('awaiting' in outcome) {
      // The acknowledgement may already have arrived; it is never undone here.
      await connection.execute("UPDATE notification_deliveries SET available_at = ?, last_error = NULL WHERE event_id = ? AND subscription_id = ? AND status = 'pending'",
        [outcome.nextAttempt, row.event_id, row.subscription_id]);
    } else if (outcome.targetGone) {
      await transportFor(target).discardTarget(connection, target);
    } else {
      await connection.execute('UPDATE notification_deliveries SET status = ?, available_at = ?, last_error = ? WHERE event_id = ? AND subscription_id = ?',
        [outcome.retry ? 'pending' : 'failed', outcome.nextAttempt || now, outcome.error, row.event_id, row.subscription_id]);
    }
  }
  return delivered;
}
// A push subscription belongs to a signed-in session (a lost device stops
// receiving content when its session ends). Sessions slide with use; warn each
// device before an unused one ends so notifications do not stop silently.
async function enqueueSessionExpiryWarnings(connection: SqlExecutor) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT p.user_id, p.session_id, p.endpoint_hash, s.expires_at FROM push_subscriptions p
    JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id JOIN users u ON u.id = p.user_id
    WHERE u.is_active = TRUE AND s.expires_at > UTC_TIMESTAMP() AND s.expires_at <= UTC_TIMESTAMP() + INTERVAL ? SECOND
    ORDER BY s.expires_at LIMIT 100`, [Math.ceil(SESSION_WARNING_MS / 1000)]);
  let queued = 0;
  for (const row of rows) {
    const expiresAt = asUtcDate(row.expires_at);
    const hoursLeft = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 3600000));
    const eventId = await enqueueEvent({ userId: row.user_id, dedupeKey: `session-expiry:${row.endpoint_hash}:${expiresAt.toISOString()}`, kind: 'session', sourceId: row.session_id,
      title: 'Notifications will stop soon', body: `Open UniHub on this device within ${hoursLeft >= 36 ? `${Math.round(hoursLeft / 24)} days` : `${hoursLeft} hours`} to keep notifications on.`,
      url: '/settings', expiresAt, endpointHash: row.endpoint_hash }, connection);
    if (eventId) queued++;
  }
  return queued;
}
// A recording upload stops when the app is closed and the browser gives the
// service worker no time to finish it. The recording stays on the device that
// made it; tell the user to open UniHub there. Works without Background Sync.
async function enqueueStalledRecordingUploads(connection: SqlExecutor, blocked: BlockedModules = new Map()) {
  // No warning while Recordings is switched off or being restored.
  const skipped = [...blocked].filter(([, modules]) => modules.has('recordings')).map(([userId]) => userId);
  // Only uploads that can still get a new warning (a signed-in device, no warning
  // yet for this stopping point), so handled uploads never fill the batch.
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT r.id, r.user_id, r.title, r.bytes_received, r.total_bytes, r.expires_at FROM recording_uploads r
    JOIN users u ON u.id = r.user_id
    WHERE u.is_active = TRUE AND r.expires_at > UTC_TIMESTAMP() AND r.updated_at <= UTC_TIMESTAMP() - INTERVAL ? SECOND
    ${skipped.length ? `AND r.user_id NOT IN (${skipped.map(() => '?').join(', ')})` : ''}
    AND EXISTS (SELECT 1 FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
      WHERE p.user_id = r.user_id AND s.expires_at > UTC_TIMESTAMP())
    AND NOT EXISTS (SELECT 1 FROM notification_events e WHERE e.user_id = r.user_id
      AND e.event_key = SHA2(CONCAT('recording-upload:', r.id, ':', r.bytes_received), 256))
    ORDER BY r.updated_at LIMIT 100`, [Math.ceil(RECORDING_STALL_MS / 1000), ...skipped]);
  let queued = 0;
  for (const row of rows) {
    const bytesReceived = Number(row.bytes_received);
    const percent = Math.min(99, Math.floor((bytesReceived / Math.max(1, Number(row.total_bytes))) * 100));
    const eventId = await enqueueEvent({ userId: row.user_id, dedupeKey: `recording-upload:${row.id}:${bytesReceived}`, kind: 'recording', sourceId: row.id,
      title: 'Recording not uploaded yet', body: `"${String(row.title || 'Recording').slice(0, 80)}" stopped at ${percent}%. It is saved on the device that recorded it. Open UniHub there to finish.`,
      url: '/recordings', expiresAt: asUtcDate(row.expires_at), data: { bytesReceived, tag: `recording-upload:${row.id}` } }, connection);
    if (eventId) queued++;
  }
  return queued;
}
async function processNotificationJobs() {
  if (running) return { skipped: true };
  running = true;
  let connection: PoolConnection | undefined;
  let locked = false;
  try {
    connection = await db.getConnection();
    const [lock] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':notification-jobs'), 256), 0) AS acquired");
    locked = Number(lock[0]?.acquired) === 1;
    if (!locked) return { skipped: true };
    const now = new Date();
    await reconcileReminders(connection, now, await blockedBackgroundModulesByUser(connection));
    const paused = await blockedBackgroundModulesByUser(connection);
    const calendarUsers = [...paused].filter(([, modules]) => modules.has('calendar')).map(([userId]) => userId);
    await connection.execute(`DELETE FROM notification_reminders WHERE due_at < ? ${calendarUsers.length ? `AND user_id NOT IN (${calendarUsers.map(() => '?').join(', ')})` : ''}`, [new Date(now.getTime() - REMINDER_GRACE_MS), ...calendarUsers]);
    await enqueueDueReminders(connection, now, await blockedBackgroundModulesByUser(connection));
    await enqueueSessionExpiryWarnings(connection);
    await enqueueStalledRecordingUploads(connection, await blockedBackgroundModulesByUser(connection));
    const delivered = await deliverPending(connection, now, await blockedBackgroundModulesByUser(connection));
    const pausedUsers = [...paused].filter(([, modules]) => modules.has('calendar') || modules.has('mail')).map(([userId]) => userId);
    await connection.execute(`DELETE FROM notification_events WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 30 DAY ${pausedUsers.length ? `AND user_id NOT IN (${pausedUsers.map(() => '?').join(', ')})` : ''}`, pausedUsers);
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
export {
  getVapidKeys,
  subscribe,
  unsubscribe,
  subscriptionStatus,
  deviceStatus,
  enqueueMailNotification,
  releaseMailNotification,
  enqueueCalendarNotification,
  enqueueTestNotification,
  enqueueEvent,
  enqueueStalledRecordingUploads,
  eventStillCurrent,
  processNotificationJobs,
};
