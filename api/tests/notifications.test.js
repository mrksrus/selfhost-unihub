const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const {
  reminderMinutes, reminderKey, reminderIsCurrent, normalizeSubscription, retryDisposition,
} = require('../src/services/notification-rules');
const { isPublicAddress } = require('../src/services/push-transport');

function loadService(db, sender = {}) {
  const filename = require.resolve('../src/services/notifications');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testInternals = { enqueueDueReminders, deliverPending, reconcileReminders };', {
    module, exports: module.exports, Date, Buffer, console, process: { env: {} },
    require(name) {
      if (name === '../state') return { db };
      if (name === '../security/encryption') return { encrypt: text => `encrypted:${text}`, decrypt: text => text?.startsWith('encrypted:') ? text.slice(10) : null };
      if (name === 'web-push') return sender;
      return nativeRequire(name);
    },
  }, { filename });
  return module.exports;
}
function validSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/example') {
  const publicKey = Buffer.alloc(65, 1); publicKey[0] = 4;
  return { endpoint, keys: { p256dh: publicKey.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
}

test('at-start and duplicate reminder offsets retain numeric zero', () => {
  assert.deepEqual(reminderMinutes({ reminders: '[0,5,5,60,-1,null]' }), [0, 5, 60]);
  assert.deepEqual(reminderMinutes({ reminder_minutes: 0 }), [0]);
  assert.deepEqual(reminderMinutes({ reminders: [Infinity, -5, 1.5] }), []);
});
test('reminder delivery validates current occurrence, offset, cancellation and lateness', () => {
  const event = { id: 'event-1', start_time: '2026-09-06 12:00:00', reminders: [0, 5], is_visible: 1 };
  const now = Date.parse('2026-09-06T12:00:10Z');
  const payload = { reminderMinutes: 0, dedupeKey: reminderKey(event, 0) };
  assert.equal(reminderIsCurrent(event, payload, now), true);
  for (const mutation of [{ todo_status: 'done' }, { todo_status: 'cancelled' }, { is_visible: 0 }, { start_time: '2026-09-07 12:00:00' }, { reminders: [5] }]) assert.equal(reminderIsCurrent({ ...event, ...mutation }, payload, now), false);
  assert.equal(reminderIsCurrent(event, payload, now + 3 * 3600000), false);
});
test('subscription validation rejects SSRF targets and malformed keys', () => {
  assert.equal(normalizeSubscription(validSubscription()).endpoint, validSubscription().endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://fcm.googleapis.com.attacker.test/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:444/x', 'https://example.com/x']) assert.throws(() => normalizeSubscription(validSubscription(endpoint)));
  assert.throws(() => normalizeSubscription({ ...validSubscription(), keys: { auth: 'x', p256dh: 'x' } }));
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('142.250.180.202'), true);
  assert.equal(isPublicAddress('2607:f8b0:4005:805::200a'), true);
});
test('expired subscriptions are removed and retries are bounded', () => {
  assert.deepEqual(retryDisposition({ statusCode: 410 }, 1), { expired: true, retry: false });
  assert.equal(retryDisposition({ statusCode: 429 }, 1, 0).nextAttempt.getTime(), 30000);
  assert.equal(retryDisposition(new Error('offline'), 3, 0).nextAttempt.getTime(), 120000);
  assert.equal(retryDisposition({ statusCode: 503 }, 8).retry, false);
  assert.equal(retryDisposition({ statusCode: 403 }, 1).retry, false);
});
test('VAPID candidates persist once and reload the winning encrypted key across server restarts', async () => {
  let persisted; let generated = 0;
  const db = { async execute(sql, values) {
    if (sql.startsWith('SELECT public_key')) return [persisted ? [persisted] : []];
    if (sql.startsWith('SELECT email')) return [[{ email: 'admin@example.com' }]];
    if (sql.startsWith('INSERT IGNORE INTO notification_config')) { persisted ||= { public_key: values[0], encrypted_private_key: values[1], subject: values[2] }; return [{ affectedRows: 1 }]; }
    throw new Error(sql);
  } };
  const sender = { generateVAPIDKeys: () => ({ publicKey: `public-${++generated}`, privateKey: `private-${generated}` }) };
  const first = loadService(db, sender);
  const second = loadService(db, sender);
  const [a, b] = await Promise.all([first.getVapidKeys(), second.getVapidKeys()]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(a.privateKey, b.privateKey);
  assert.ok(persisted.encrypted_private_key.startsWith('encrypted:'));
  const restarted = await loadService(db, sender).getVapidKeys();
  assert.equal(restarted.privateKey, a.privateKey);
});
test('outbox duplicates do not fan out new deliveries and use the caller transaction', async () => {
  const keys = new Set(); const deliveries = [];
  const connection = { async execute(sql, values) {
    if (sql.startsWith('SELECT p.id')) return [[{ id: 'device-1' }, { id: 'device-2' }]];
    if (sql.startsWith('INSERT IGNORE INTO notification_events')) {
      if (keys.has(values[2])) return [{ affectedRows: 0 }];
      keys.add(values[2]); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO notification_deliveries')) { deliveries.push(values); return [{}]; }
    throw new Error(sql);
  } };
  const service = loadService({ execute() { throw new Error('Must use caller transaction'); } });
  const event = { userId: 'u1', dedupeKey: 'mail:new-1', kind: 'mail', title: 'Email', url: '/mail', expiresAt: new Date() };
  assert.ok(await service.enqueueEvent(event, connection));
  assert.equal(await service.enqueueEvent(event, connection), null);
  assert.equal(deliveries.length, 2);
});
test('new mail enqueue trusts committed ID and not old sender date; excludes historical imports and drafts', async () => {
  const writes = [];
  const connection = { async execute(sql, values) {
    if (sql.startsWith('SELECT id, subject')) return [[{ id: 'new-1', subject: 'Old sender date, new import', folder: 'inbox', from_address: 'sender@example.com' }]];
    if (sql.startsWith('SELECT p.id')) return [[{ id: 'device-1' }]];
    writes.push({ sql, values }); return [{ affectedRows: 1 }];
  } };
  const service = loadService({});
  assert.equal(await service.enqueueMailNotification({ userId: 'u1', emailId: 'new-1', suppressNotifications: true }, connection), null);
  assert.equal(writes.length, 0);
  assert.ok(await service.enqueueMailNotification({ userId: 'u1', emailId: 'new-1' }, connection));
  assert.ok(writes.some(call => call.sql.includes('notification_events')));
});
test('subscription endpoints require a live session and are scoped on removal', async () => {
  const calls = [];
  const service = loadService({ async execute(sql, values) { calls.push({ sql, values }); return [[]]; } });
  await assert.rejects(service.subscribe('u1', 'expired', validSubscription()), /Session expired/);
  await service.unsubscribe('u1', validSubscription().endpoint);
  assert.ok(calls.some(call => call.sql.startsWith('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?') && call.values[0] === 'u1'));
});
test('delivery retry preserves pending state, and edited/deleted reminder is cancelled before transport', async () => {
  const writes = []; let sends = 0;
  const now = new Date();
  const row = { event_id: 'n1', subscription_id: 's1', attempts: 0, user_id: 'u1', kind: 'reminder', source_id: 'e1', payload: { reminderMinutes: 0, dedupeKey: 'old-occurrence' }, expires_at: new Date(now.getTime() + 60000) };
  const connection = { async execute(sql, values) {
    if (sql.includes('FROM notification_deliveries d')) return [[row]];
    if (sql.startsWith('SELECT e.*')) return [[]];
    writes.push({ sql, values }); return [{}];
  } };
  const service = loadService({ async execute(sql) {
    if (sql.startsWith('SELECT public_key')) return [[{ public_key: 'public', encrypted_private_key: 'encrypted:private', subject: 'mailto:admin@example.com' }]];
    throw new Error(sql);
  } }, { async sendNotification() { sends++; } });
  await service.testInternals.deliverPending(connection, now);
  assert.equal(sends, 0);
  assert.ok(writes.some(call => call.sql.includes("status = 'cancelled'")));
});

test('temporary sender failure schedules retry without falsely acknowledging delivery', async () => {
  const writes = [];
  const now = new Date();
  const row = { event_id: 'n1', subscription_id: 's1', attempts: 1, user_id: 'u1', kind: 'test', payload: { dedupeKey: 'test-1' }, expires_at: new Date(now.getTime() + 60000), endpoint: validSubscription().endpoint, ...validSubscription().keys };
  const connection = { async execute(sql, values) {
    if (sql.includes('FROM notification_deliveries d')) return [[row]];
    writes.push({ sql, values }); return [{}];
  } };
  const service = loadService({ async execute() { return [[{ public_key: 'public', encrypted_private_key: 'encrypted:private', subject: 'mailto:admin@example.com' }]]; } }, {
    async sendNotification() { const error = new Error('Unavailable'); error.statusCode = 503; throw error; },
  });
  assert.equal(await service.testInternals.deliverPending(connection, now), 0);
  assert.ok(writes.some(call => call.values?.[0] === 'pending' && call.values[1] instanceof Date));
  assert.equal(writes.some(call => call.sql.includes("status = 'sent'")), false);
});

test('reminder scans preserve skipped changes through restore cancellation and revalidate older committed timestamps', async () => {
  const initialScan = new Date('2026-09-06T12:00:00Z');
  const now = new Date('2026-09-06T12:01:00Z');
  const settings = { last_reminder_scan_at: initialScan, reminder_revision: 1, scanned_revision: 1 };
  const events = [
    { id: 'restoring-user-event', user_id: 'restoring', updated_at: new Date(initialScan.getTime() + 1000), start_time: new Date(now.getTime() + 3600000), reminders: [0] },
    { id: 'other-user-event', user_id: 'other', updated_at: new Date(initialScan.getTime() + 1000), start_time: new Date(now.getTime() + 3600000), reminders: [0] },
  ];
  const scheduled = new Map();
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    async execute(sql, values = []) {
      if (sql.startsWith('SELECT last_reminder_scan_at')) return [[{ ...settings }]];
      if (sql.startsWith('SELECT e.*, c.is_visible FROM calendar_events')) {
        const field = sql.includes('AND e.updated_at >= ?') ? 'updated_at' : 'start_time';
        return [events.filter(event => event[field] >= values[0])];
      }
      if (sql.startsWith('DELETE FROM notification_reminders')) { scheduled.delete(values[0]); return [{}]; }
      if (sql.startsWith('INSERT INTO notification_reminders')) { scheduled.set(values[0], values[3]); return [{}]; }
      if (sql.startsWith('UPDATE notification_config')) {
        settings.last_reminder_scan_at = values[0]; settings.scanned_revision = values[1]; return [{}];
      }
      throw new Error(sql);
    },
  };
  const service = loadService({});
  await service.testInternals.reconcileReminders(connection, now, new Map([['restoring', new Set(['calendar'])]]));
  assert.equal(settings.last_reminder_scan_at, initialScan);
  assert.equal(scheduled.has('restoring-user-event'), false);
  assert.equal(scheduled.has('other-user-event'), true, 'other users continue to be reconciled');

  // Cancellation has no revision bump; retaining the cursor must still recover skipped changes.
  await service.testInternals.reconcileReminders(connection, now);
  assert.equal(scheduled.has('restoring-user-event'), true);
  assert.equal(settings.last_reminder_scan_at, now);

  // A successful long restore commits a timestamp older than the last scan.
  events.push({ id: 'restored-old-timestamp', user_id: 'restoring', updated_at: new Date(initialScan.getTime() - 60000), start_time: new Date(now.getTime() + 7200000), reminders: [0] });
  settings.reminder_revision++;
  await service.testInternals.reconcileReminders(connection, new Date(now.getTime() + 30000));
  assert.equal(scheduled.has('restored-old-timestamp'), true);
  assert.equal(settings.scanned_revision, settings.reminder_revision);
});

test('restore sections retain todo aliases, merge active jobs, and scope notification query exclusions', async () => {
  const { getActiveRestoreSectionsByUser } = require('../src/services/restore-locks');
  const active = await getActiveRestoreSectionsByUser({ async execute() {
    return [[{ user_id: 'u1', requested_sections: '["todo"]' }, { user_id: 'u1', requested_sections: '["mail"]' }, { user_id: 'u2', requested_sections: '["contacts"]' }]];
  } });
  assert.deepEqual([...active.get('u1')].sort(), ['calendar', 'mail']);
  const calls = [];
  const connection = { async execute(sql, values) { calls.push({ sql, values }); return [[]]; } };
  const service = loadService({});
  const now = new Date();
  await service.testInternals.enqueueDueReminders(connection, now, active);
  await service.testInternals.deliverPending(connection, now, active);
  assert.match(calls[0].sql, /r.user_id NOT IN \(\?\)[\s\S]*LIMIT 200/);
  assert.equal(calls[0].values[1], 'u1');
  assert.match(calls[1].sql, /NOT \(e.kind IN \('calendar', 'todo', 'reminder'\) AND e.user_id IN \(\?\)\)/);
  assert.match(calls[1].sql, /NOT \(e.kind IN \('mail'\) AND e.user_id IN \(\?\)\)/);
  assert.equal(calls[1].values[2], 'u1');
  assert.equal(calls[1].values[3], 'u1');
  assert.equal(calls[1].values.includes('u2'), false, 'a contact restore does not delay notifications');
});
