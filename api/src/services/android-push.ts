import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ApiError } from '../types';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, unauthorized } from '../http/errors';
import { verifyToken } from '../auth';
import { createServerEvents } from './server-events';
import { hash, normalizeKeys } from './notification-rules';

// Notifications for the Android app (android/), with this server as the app's
// push server: no Google, Apple or other push service is involved.
//
// A phone registers as a push subscription with transport 'android' and the
// keys of RFC 8291, bound to the session that registered it, like a browser's
// subscription. Its app then holds one long-lived stream to this API. The
// dispatcher (notifications.ts) encrypts each notification for the device's
// keys exactly as Web Push does and writes it to that stream; the delivery
// stays pending until the app acknowledges it, and is sent again after
// ACK_WAIT_MS without one. While the phone is offline the dispatcher leaves its
// deliveries alone until they expire; connecting sends them at once.
//
// The streams live in this API process, as the browser event stream does
// (server-events.ts): UniHub runs one API process.

const ENDPOINT_PREFIX = 'unihub-android:';
const MAX_DEVICES = 20;
const ACK_WAIT_MS = 2 * 60 * 1000;
// Only a fallback: connecting sends a device's waiting deliveries at once.
const OFFLINE_RETRY_MS = 10 * 60 * 1000;
const MAX_ACK_IDS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A phone's radio wakes for every byte it receives, so the heartbeat is far
// rarer than the browser's 25 seconds. 45 seconds still keeps common proxy
// read timeouts (60 to 100 seconds) and mobile NAT from dropping an idle
// stream. The app reconnects when it hears nothing for well over this.
const devices = createServerEvents({ heartbeatMs: 45 * 1000, retryMs: 30 * 1000, maxPerUser: MAX_DEVICES, maxTotal: 2000, throttleMs: 0 });
// The newest stream of a device replaces an older one that may be half dead.
const latest = new Map<string, () => void>();

const endpointFor = (deviceId: string) => `${ENDPOINT_PREFIX}${deviceId}`;
async function sessionId(userId: string, sessionToken: string | null) {
  const [sessions] = await db.execute<RowDataPacket[]>('SELECT id FROM sessions WHERE token = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP()', [sessionToken, userId]);
  if (!sessions.length) throw unauthorized('SESSION_EXPIRED', 'Session expired');
  return String(sessions[0].id);
}

// A device of this user, registered by the session making the request.
async function ownDevice(userId: string, sessionToken: string | null, deviceId: unknown) {
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) return null;
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    WHERE p.id = ? AND p.user_id = ? AND p.transport = 'android' AND s.token = ? AND s.expires_at > UTC_TIMESTAMP()`, [deviceId, userId, sessionToken]);
  return rows.length ? String(rows[0].id) : null;
}

/**
 * Registers this phone for the signed-in session. `replaces` names the
 * device the app registered before (another key pair, an earlier session);
 * it is removed so it does not collect deliveries no one acknowledges.
 */
async function registerDevice(userId: string, sessionToken: string | null, input: { keys?: unknown; replaces?: unknown } | null | undefined) {
  const keys = normalizeKeys((input?.keys || null) as Parameters<typeof normalizeKeys>[0]);
  // A key that is not a point on P-256 could never be encrypted for.
  try { const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); ecdh.computeSecret(Buffer.from(keys.p256dh, 'base64url')); }
  catch { throw badRequest('PUSH_SUBSCRIPTION_KEYS_INVALID', 'Invalid push subscription key'); }
  const session = await sessionId(userId, sessionToken);
  if (typeof input?.replaces === 'string' && UUID.test(input.replaces)) {
    await db.execute("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ? AND transport = 'android'", [input.replaces, userId]);
  }
  const [count] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (Number(count[0]?.total) >= MAX_DEVICES) throw badRequest('NOTIFICATION_DEVICE_LIMIT', 'Maximum notification devices reached');
  const id = crypto.randomUUID();
  const endpoint = endpointFor(id);
  await db.execute(`INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth, transport)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'android')`, [id, userId, session, endpoint, hash(endpoint), keys.p256dh, keys.auth]);
  // As for a new browser: the reminder scan includes calendar entries from before.
  await db.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
  return { device: id, endpoint };
}

/** Marks deliveries the app has shown (or knowingly skipped) as delivered. */
async function acknowledge(userId: string, sessionToken: string | null, input: { device?: unknown; ids?: unknown } | null | undefined) {
  const ids = input?.ids;
  if (!Array.isArray(ids) || ids.length > MAX_ACK_IDS || !ids.every(id => typeof id === 'string' && UUID.test(id))) throw badRequest('NOTIFICATION_ACK_IDS_INVALID', 'Invalid notification ids');
  const device = await ownDevice(userId, sessionToken, input?.device);
  if (!device) return { error: 'This device is not registered for notifications', code: 'DEVICE_UNKNOWN', status: 404 };
  if (!ids.length) return { acknowledged: 0 };
  const [result] = await db.execute<ResultSetHeader>(`UPDATE notification_deliveries SET status = 'sent', delivered_at = UTC_TIMESTAMP(), last_error = NULL
    WHERE subscription_id = ? AND status = 'pending' AND event_id IN (${ids.map(() => '?').join(', ')})`, [device, ...ids]);
  return { acknowledged: result.affectedRows };
}

/**
 * GET /api/notifications/android/stream?device=…: the app's connection. Takes
 * over the response like GET /api/events. Every heartbeat checks the session
 * and the device again, so a signed-out or removed device stops receiving.
 */
async function attachStream(req: IncomingMessage, res: ServerResponse, userId: string, sessionToken: string | null, deviceId: unknown) {
  const device = await ownDevice(userId, sessionToken, deviceId);
  if (!device) return { error: 'This device is not registered for notifications', code: 'DEVICE_UNKNOWN', status: 404 };
  latest.get(device)?.();
  const attached = devices.attach({
    userId, req, res, token: sessionToken, modules: [device],
    revalidate: async stream => {
      const current = await verifyToken(req);
      return !!current && String(current) === String(stream.userId) && await ownDevice(String(current), sessionToken, device) === device;
    },
  });
  if (!attached.ok) {
    if (attached.status === 429 || attached.status === 503) res.setHeader('Retry-After', '60');
    return { error: attached.error, status: attached.status };
  }
  const close = attached.close!;
  latest.set(device, close);
  res.on('close', () => { if (latest.get(device) === close) latest.delete(device); });
  // What waited while the phone was away goes out now, not at the next pass.
  void (async () => {
    await db.execute("UPDATE notification_deliveries SET available_at = UTC_TIMESTAMP() WHERE subscription_id = ? AND status = 'pending'", [device]);
    await (require('./notifications') as typeof import('./notifications')).processNotificationJobs();
  })().catch(error => console.error('[NOTIFICATIONS] Android delivery deferred:', (error as ApiError).code || (error as ApiError).name));
  return { __handled: true };
}

/**
 * Writes an encrypted notification to the device's stream. Returns when to
 * look at the delivery again if it is still not acknowledged then.
 */
function sendToDevice(userId: string, deviceId: string, eventId: string, body: Buffer) {
  const written = devices.publish(userId, 'notification', { id: eventId, body: body.toString('base64url') }, { module: deviceId });
  return new Date(Date.now() + (written ? ACK_WAIT_MS : OFFLINE_RETRY_MS));
}

/** The devices whose stream is open in this process. */
function connectedDevices() { return [...latest.keys()]; }

function closeAndroidStreams() { devices.closeAll({ reason: 'shutdown' }); }

export {
  ENDPOINT_PREFIX,
  registerDevice,
  acknowledge,
  attachStream,
  sendToDevice,
  connectedDevices,
  closeAndroidStreams,
  devices as androidStreams,
};
