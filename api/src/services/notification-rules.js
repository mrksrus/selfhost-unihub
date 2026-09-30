const crypto = require('crypto');

const REMINDER_GRACE_MS = 2 * 60 * 60 * 1000;
const EXCLUDED_MAIL_FOLDERS = new Set(['sent', 'drafts', 'trash', 'archive']);

function asUtcDate(value) {
  if (value instanceof Date) return value;
  const text = String(value || '');
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}
function reminderMinutes(event) {
  let values = event.reminders;
  if (typeof values === 'string') {
    try { values = JSON.parse(values); } catch { values = []; }
  }
  if (!Array.isArray(values) || values.length === 0) values = event.reminder_minutes == null ? [] : [event.reminder_minutes];
  return [...new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value >= 0 && value <= 525600))].sort((a, b) => a - b);
}
function reminderKey(event, minutes) {
  return `reminder:${event.id}:${asUtcDate(event.start_time).toISOString()}:${minutes}`;
}
function reminderIsCurrent(event, payload, now = Date.now()) {
  if (!event || ['done', 'cancelled'].includes(event.todo_status) || event.is_visible === 0 || event.is_visible === false) return false;
  const start = asUtcDate(event.start_time).getTime();
  const minutes = Number(payload.reminderMinutes);
  if (!Number.isFinite(start) || !reminderMinutes(event).includes(minutes)) return false;
  const due = start - minutes * 60000;
  return reminderKey(event, minutes) === payload.dedupeKey && due <= now && now - due <= REMINDER_GRACE_MS;
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function normalizeSubscription(input) {
  if (!input || typeof input.endpoint !== 'string' || input.endpoint.length > 4096) throw new Error('Invalid push subscription');
  const url = new URL(input.endpoint);
  // A browser supplies these URLs, but the API must still reject arbitrary SSRF targets.
  const providers = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash ||
      !providers.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Unsupported push service endpoint');
  const keys = input.keys || {};
  for (const [key, length] of [['p256dh', 65], ['auth', 16]]) {
    if (typeof keys[key] !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys[key]) || Buffer.from(keys[key], 'base64url').length !== length) throw new Error('Invalid push subscription keys');
  }
  if (Buffer.from(keys.p256dh, 'base64url')[0] !== 4) throw new Error('Invalid push subscription key');
  return { endpoint: url.toString(), keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
function retryDisposition(error, attempts, now = Date.now()) {
  const status = Number(error?.statusCode);
  if ([404, 410].includes(status)) return { expired: true, retry: false };
  if ((status >= 400 && status < 500 && ![408, 429].includes(status)) || attempts >= 8) return { retry: false };
  return { retry: true, nextAttempt: new Date(now + Math.min(3600000, 30000 * 2 ** Math.max(0, attempts - 1))) };
}
module.exports = { REMINDER_GRACE_MS, EXCLUDED_MAIL_FOLDERS, asUtcDate, reminderMinutes, reminderKey, reminderIsCurrent, hash, normalizeSubscription, retryDisposition };
