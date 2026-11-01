import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import { encrypt, decrypt } from '../security/encryption';
import { pushAgent } from './push-transport';
import { asUtcDate, hash, retryDisposition } from './notification-rules';
import { controlPool } from './side-pools';

// Delivery transports, keyed by the kind of target a delivery row points at
// (push_subscriptions.transport).
//
// The dispatcher in notifications.ts selects due deliveries, revalidates
// their source and records the outcome; a transport only knows how to reach
// one kind of device and how to classify that device's failures.
// - 'webpush': a browser's push subscription, reached through the browser's
//   push service (Web Push with VAPID).
// - 'android': the Android app, reached over its own connection to this API
//   (android-push.ts). The payload is encrypted the same way (RFC 8291), so a
//   later route through a UnifiedPush distributor carries the same message.
interface VapidKeys { publicKey: string; privateKey: string; subject: string }
interface WebPushTarget { kind: 'webpush'; id: string; endpoint: string; p256dh: string; auth: string }
interface AndroidTarget { kind: 'android'; id: string; userId: string; p256dh: string; auth: string }
type DeliveryTarget = WebPushTarget | AndroidTarget;
interface DeliveryMessage {
  eventId: string;
  kind: string;
  payload: Record<string, unknown> & { dedupeKey?: unknown };
  expiresAt: unknown;
}
type DeliveryOutcome =
  | { sent: true }
  // Handed to the device, which acknowledges it (android-push.ts); until then
  // the delivery stays pending and is looked at again at nextAttempt.
  | { sent: false; awaiting: true; nextAttempt: Date }
  // targetGone: the device no longer exists; the dispatcher discards the target.
  | { sent: false; targetGone: boolean; retry: boolean; nextAttempt: Date | null; error: string };
interface NotificationTransport<T extends DeliveryTarget = DeliveryTarget> {
  // Once per batch, before any attempt is reserved: a transport whose identity
  // is unavailable fails the pass here instead of using up attempts.
  ready(): Promise<void>;
  send(target: T, message: DeliveryMessage, attempts: number): Promise<DeliveryOutcome>;
  discardTarget(connection: SqlExecutor, target: T): Promise<void>;
}
type PushError = Error & { statusCode?: number };

let keyPromise: Promise<VapidKeys> | null = null;
async function getVapidKeys(): Promise<VapidKeys> {
  // Shared by every caller, among them the notification pass holding its
  // connection, so read on the control pool (side-pools.ts).
  if (!keyPromise) keyPromise = (async () => {
    const control = controlPool();
    let [rows] = await control.execute<(RowDataPacket & { public_key: string; encrypted_private_key: string; subject: string })[]>('SELECT public_key, encrypted_private_key, subject FROM notification_config WHERE id = 1');
    if (!rows.length) {
      const webPush = require('web-push') as typeof import('web-push');
      const keys = webPush.generateVAPIDKeys();
      const [admins] = await control.execute<RowDataPacket[]>("SELECT email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
      const subject = process.env.WEB_PUSH_SUBJECT || `mailto:${admins[0]?.email || 'notifications@unihub.invalid'}`;
      // Concurrent startups may generate candidates; INSERT IGNORE and reread choose exactly one stable pair.
      await control.execute('INSERT IGNORE INTO notification_config (id, public_key, encrypted_private_key, subject) VALUES (1, ?, ?, ?)', [keys.publicKey, encrypt(keys.privateKey), subject]);
      [rows] = await control.execute<(RowDataPacket & { public_key: string; encrypted_private_key: string; subject: string })[]>('SELECT public_key, encrypted_private_key, subject FROM notification_config WHERE id = 1');
    }
    const privateKey = decrypt(rows[0].encrypted_private_key);
    if (!privateKey) throw new Error('Unable to decrypt persisted Web Push key');
    return { publicKey: rows[0].public_key, privateKey, subject: rows[0].subject };
  })().catch(error => { keyPromise = null; throw error; });
  return keyPromise;
}

const webPushTransport: NotificationTransport<WebPushTarget> = {
  async ready() { await getVapidKeys(); },
  async send(target, message, attempts) {
    const keys = await getVapidKeys();
    const webPush = require('web-push') as typeof import('web-push');
    try {
      await webPush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, messageBody(message),
        { agent: pushAgent, vapidDetails: keys, TTL: Math.max(0, Math.min(86400, Math.floor((asUtcDate(message.expiresAt).getTime() - Date.now()) / 1000))), urgency: message.kind === 'reminder' ? 'high' : 'normal', timeout: 10000, topic: hash(message.payload.dedupeKey).slice(0, 32) });
      return { sent: true };
    } catch (error) {
      const outcome = retryDisposition(error as PushError, attempts);
      return { sent: false, targetGone: !!outcome.expired, retry: !!outcome.retry, nextAttempt: outcome.nextAttempt || null,
        error: `Push service ${Number((error as PushError).statusCode) || 'network error'}` };
    }
  },
  async discardTarget(connection, target) {
    await connection.execute('DELETE FROM push_subscriptions WHERE id = ?', [target.id]);
  },
};

// The payload of a delivery as both transports send it.
function messageBody(message: DeliveryMessage) {
  return JSON.stringify({ ...message.payload, notificationId: message.eventId });
}

const androidTransport: NotificationTransport<AndroidTarget> = {
  async ready() {},
  async send(target, message) {
    const webPush = require('web-push') as typeof import('web-push');
    let cipherText: Buffer;
    try {
      ({ cipherText } = webPush.encrypt(target.p256dh, target.auth, messageBody(message), 'aes128gcm'));
    } catch {
      // Keys that cannot be encrypted for never will be (registration checks
      // them; this covers anything stored otherwise): the device goes.
      return { sent: false, targetGone: true, retry: false, nextAttempt: null, error: 'Device key is not usable' };
    }
    // Loaded when used, as web-push is: whatever imports the dispatcher need not hold the stream bus.
    const { sendToDevice } = require('./android-push') as typeof import('./android-push');
    return { sent: false, awaiting: true, nextAttempt: sendToDevice(target.userId, target.id, message.eventId, cipherText) };
  },
  async discardTarget(connection, target) {
    await connection.execute('DELETE FROM push_subscriptions WHERE id = ?', [target.id]);
  },
};

const NOTIFICATION_TRANSPORTS: { readonly [K in DeliveryTarget['kind']]: NotificationTransport<Extract<DeliveryTarget, { kind: K }>> } = Object.freeze({
  webpush: webPushTransport,
  android: androidTransport,
});

export { NOTIFICATION_TRANSPORTS, getVapidKeys };
export type { AndroidTarget, DeliveryTarget, DeliveryMessage, DeliveryOutcome, NotificationTransport, VapidKeys, WebPushTarget };
