import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const vm = (require('node:vm') as typeof import('node:vm'));
const { createRequire } = (require('node:module') as typeof import('node:module'));
const {
  reminderMinutes, reminderKey, reminderIsCurrent, normalizeSubscription, retryDisposition,
} = require('../dist/src/services/notification-rules') as typeof import('../src/services/notification-rules');
const { isPublicAddress } = require('../dist/src/services/push-transport') as typeof import('../src/services/push-transport');

// The service and its delivery transports run in one sandbox that shares the
// synthetic database, encryption and web-push sender; `transports` replaces
// the transport map to test the dispatcher alone.
function loadService(db: FixtureValue, sender: FixtureValue = {}, transports: FixtureValue = null) {
  const sandboxed = new Set(['../dist/src/services/notifications', '../dist/src/services/notification-transports', '../dist/src/services/sessions'].map(name => require.resolve(name)));
  function load(filename: string) {
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    const internals = filename.endsWith('notifications.js') ? '\nmodule.exports.testInternals = { enqueueDueReminders, deliverPending, reconcileReminders, enqueueSessionExpiryWarnings, transports: notification_transports_1.NOTIFICATION_TRANSPORTS };' : '';
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + internals, {
      module, exports: module.exports, Date, Buffer, console, process: { env: {} },
      require(name: FixtureValue) {
        if (name === '../state') return { db };
        // A test double serves the side pools itself, as side-pools.ts does for one.
        if (name === './side-pools') return { controlPool: () => db };
        if (name === '../security/encryption') return { encrypt: (text: string) => `encrypted:${text}`, decrypt: (text: string) => text?.startsWith('encrypted:') ? text.slice(10) : null };
        if (name === 'web-push') return sender;
        if (name === './notification-transports' && transports) return transports;
        const resolved = nativeRequire.resolve(name);
        return sandboxed.has(resolved) ? load(resolved) : nativeRequire(name);
      },
    }, { filename });
    return module.exports;
  }
  return load(require.resolve('../dist/src/services/notifications'));
}
function validSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/example') {
  const publicKey = Buffer.alloc(65, 1); publicKey[0] = 4;
  return { endpoint, keys: { p256dh: publicKey.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
}

test('at-start and duplicate reminder offsets retain numeric zero', () => {
  assert.deepEqual(reminderMinutes({ reminders: '[0,5,5,60,-1,null]' } as FixtureValue), [0, 5, 60]);
  assert.deepEqual(reminderMinutes({ reminder_minutes: 0 } as FixtureValue), [0]);
  assert.deepEqual(reminderMinutes({ reminders: [Infinity, -5, 1.5] } as FixtureValue), []);
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
  assert.equal(retryDisposition({ statusCode: 429 }, 1, 0).nextAttempt!.getTime(), 30000);
  assert.equal(retryDisposition(new Error('offline') as FixtureValue, 3, 0).nextAttempt!.getTime(), 120000);
  assert.equal(retryDisposition({ statusCode: 503 }, 8).retry, false);
  assert.equal(retryDisposition({ statusCode: 403 }, 1).retry, false);
});
test('VAPID candidates persist once and reload the winning encrypted key across server restarts', async () => {
  let persisted: FixtureValue; let generated = 0;
  const db = { async execute(sql: string, values: FixtureValue) {
    if (sql.startsWith('SELECT public_key')) return [persisted ? [persisted] : []];
    if (sql.startsWith('SELECT email')) return [[{ email: 'admin@example.com' }]];
    if (sql.startsWith('INSERT IGNORE INTO notification_config')) { persisted ||= { public_key: values[0], encrypted_private_key: values[1], subject: values[2] }; return [{ affectedRows: 1 }]; }
    throw new Error(sql);
  } };
  const sender = { generateVAPIDKeys: () => ({ publicKey: `public-${++generated}`, privateKey: `private-${generated}` }) };
  const first: FixtureValue = loadService(db, sender);
  const second: FixtureValue = loadService(db, sender);
  const [a, b] = await Promise.all([first.getVapidKeys(), second.getVapidKeys()]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(a.privateKey, b.privateKey);
  assert.ok(persisted.encrypted_private_key.startsWith('encrypted:'));
  const restarted = await (loadService(db, sender) as FixtureValue).getVapidKeys();
  assert.equal(restarted.privateKey, a.privateKey);
});
test('outbox duplicates do not fan out new deliveries and use the caller transaction', async () => {
  const keys = new Set<FixtureValue>(); const deliveries = [];
  const connection = { async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM user_settings')) return [[]];
    if (sql.startsWith('SELECT p.id')) return [[{ id: 'device-1' }, { id: 'device-2' }]];
    if (sql.startsWith('INSERT IGNORE INTO notification_events')) {
      if (keys.has(values[2])) return [{ affectedRows: 0 }];
      keys.add(values[2]); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT IGNORE INTO notification_deliveries')) { deliveries.push(values); return [{}]; }
    throw new Error(sql);
  } };
  const service: FixtureValue = loadService({ execute() { throw new Error('Must use caller transaction'); } });
  const event = { userId: 'u1', dedupeKey: 'mail:new-1', kind: 'mail', title: 'Email', url: '/mail', expiresAt: new Date() };
  assert.ok(await service.enqueueEvent(event, connection));
  assert.equal(await service.enqueueEvent(event, connection), null);
  assert.equal(deliveries.length, 2);
});
test('subscription endpoints require a live session and are scoped on removal', async () => {
  const calls: FixtureValue[] = [];
  const service: FixtureValue = loadService({ async execute(sql: string, values: FixtureValue) { calls.push({ sql, values }); return [[]]; } });
  await assert.rejects(service.subscribe('u1', 'expired', validSubscription()), /Session expired/);
  await service.unsubscribe('u1', validSubscription().endpoint);
  assert.ok(calls.some(call => call.sql.startsWith('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?') && call.values[0] === 'u1'));
});
test('delivery retry preserves pending state, and edited/deleted reminder is cancelled before transport', async () => {
  const writes: FixtureValue[] = []; let sends = 0;
  const now = new Date();
  const row = { event_id: 'n1', subscription_id: 's1', attempts: 0, user_id: 'u1', kind: 'reminder', source_id: 'e1', payload: { reminderMinutes: 0, dedupeKey: 'old-occurrence' }, expires_at: new Date(now.getTime() + 60000) };
  const connection = { async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM notification_deliveries d')) return [[row]];
    if (sql.startsWith('SELECT e.*') || sql.includes('FROM backup_restore_jobs')) return [[]];
    writes.push({ sql, values }); return [{}];
  } };
  const service: FixtureValue = loadService({ async execute(sql: string) {
    if (sql.startsWith('SELECT public_key')) return [[{ public_key: 'public', encrypted_private_key: 'encrypted:private', subject: 'mailto:admin@example.com' }]];
    throw new Error(sql);
  } }, { async sendNotification() { sends++; } });
  await service.testInternals.deliverPending(connection, now);
  assert.equal(sends, 0);
  assert.ok(writes.some(call => call.sql.includes("status = 'cancelled'")));
});

test('temporary sender failure schedules retry without falsely acknowledging delivery', async () => {
  const writes: FixtureValue[] = [];
  const now = new Date();
  const row = { event_id: 'n1', subscription_id: 's1', attempts: 1, user_id: 'u1', kind: 'test', payload: { dedupeKey: 'test-1' }, expires_at: new Date(now.getTime() + 60000), endpoint: validSubscription().endpoint, ...validSubscription().keys };
  const connection = { async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM notification_deliveries d')) return [[row]];
    writes.push({ sql, values }); return [{}];
  } };
  const service: FixtureValue = loadService({ async execute() { return [[{ public_key: 'public', encrypted_private_key: 'encrypted:private', subject: 'mailto:admin@example.com' }]]; } }, {
    async sendNotification() { const error: FixtureValue = new Error('Unavailable'); error.statusCode = 503; throw error; },
  });
  assert.equal(await service.testInternals.deliverPending(connection, now), 0);
  assert.ok(writes.some(call => call.values?.[0] === 'pending' && call.values[1] instanceof Date));
  assert.equal(writes.some(call => call.sql.includes("status = 'sent'")), false);
});

test('the dispatcher routes each due delivery to the transport of its target kind and records the outcome', async () => {
  const now = new Date();
  const row = (id: string, attempts: number) => ({ event_id: id, subscription_id: `sub-${id}`, attempts, user_id: 'u1', kind: 'test', payload: { dedupeKey: id }, expires_at: new Date(now.getTime() + 60000), endpoint: `https://push.example/${id}`, p256dh: 'key', auth: 'auth' });
  const outcomes: FixtureValue = {
    sent: { sent: true },
    gone: { sent: false, targetGone: true, retry: false, nextAttempt: null, error: 'Push service 410' },
    later: { sent: false, targetGone: false, retry: true, nextAttempt: new Date(now.getTime() + 30000), error: 'Push service 503' },
    dead: { sent: false, targetGone: false, retry: false, nextAttempt: null, error: 'Push service 403' },
  };
  const sends: FixtureValue[] = []; const discarded: FixtureValue[] = []; let readied = 0;
  const transports = { NOTIFICATION_TRANSPORTS: { webpush: {
    async ready() { readied++; },
    async send(target: FixtureValue, message: FixtureValue, attempts: number) { sends.push({ target, message, attempts }); return outcomes[message.eventId]; },
    async discardTarget(_connection: FixtureValue, target: FixtureValue) { discarded.push(target.id); },
  } } };
  const writes: FixtureValue[] = [];
  const connection = { async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM notification_deliveries d')) return [[row('sent', 0), row('gone', 1), row('later', 2), row('dead', 3)]];
    writes.push({ sql, values }); return [{}];
  } };
  const service: FixtureValue = loadService({}, {}, transports);
  assert.equal(await service.testInternals.deliverPending(connection, now), 1);
  assert.equal(readied, 1, 'the transport is readied once per batch');
  assert.deepEqual(sends.map(call => [call.target.kind, call.target.id, call.target.endpoint, call.attempts, call.message.payload.dedupeKey]), [
    ['webpush', 'sub-sent', 'https://push.example/sent', 1, 'sent'], ['webpush', 'sub-gone', 'https://push.example/gone', 2, 'gone'],
    ['webpush', 'sub-later', 'https://push.example/later', 3, 'later'], ['webpush', 'sub-dead', 'https://push.example/dead', 4, 'dead'],
  ]);
  assert.deepEqual(discarded, ['sub-gone']);
  const reserved = writes.filter(call => call.sql.startsWith('UPDATE notification_deliveries SET attempts = ?'));
  assert.deepEqual(reserved.map(call => call.values[0]), [1, 2, 3, 4], 'every attempt is reserved before transport');
  // Arrays created inside the sandbox have another realm's prototype; copy them before comparing.
  assert.deepEqual(writes.filter(call => call.sql.includes("status = 'sent'")).map(call => [...call.values]), [['sent', 'sub-sent']]);
  const settled = writes.filter(call => call.sql.startsWith('UPDATE notification_deliveries SET status = ?'));
  assert.deepEqual(settled.map(call => [...call.values]), [['pending', outcomes.later.nextAttempt, 'Push service 503', 'later', 'sub-later'], ['failed', now, 'Push service 403', 'dead', 'sub-dead']]);
});

test('the web push transport classifies expired, temporary and permanent push service failures', async () => {
  const service: FixtureValue = loadService({ async execute() { return [[{ public_key: 'public', encrypted_private_key: 'encrypted:private', subject: 'mailto:admin@example.com' }]]; } }, {
    async sendNotification(subscription: FixtureValue) { const status = Number(new URL(subscription.endpoint).pathname.slice(1)); if (!status) return { statusCode: 201 }; throw Object.assign(new Error('Push failed'), { statusCode: status }); },
  });
  const transport = service.testInternals.transports.webpush;
  const target = (status: number) => ({ kind: 'webpush', id: 's1', endpoint: `https://push.example/${status}`, p256dh: 'key', auth: 'auth' });
  const message = { eventId: 'n1', kind: 'test', payload: { dedupeKey: 'test-1' }, expiresAt: new Date(Date.now() + 60000) };
  assert.equal(JSON.stringify(await transport.send(target(0), message, 1)), '{"sent":true}');
  const gone = await transport.send(target(410), message, 1);
  assert.deepEqual([gone.sent, gone.targetGone, gone.error], [false, true, 'Push service 410']);
  const later = await transport.send(target(503), message, 1);
  assert.deepEqual([later.sent, later.targetGone, later.retry, later.error], [false, false, true, 'Push service 503']);
  assert.ok(later.nextAttempt instanceof Date);
  const dead = await transport.send(target(403), message, 1);
  assert.deepEqual([dead.sent, dead.targetGone, dead.retry, dead.nextAttempt, dead.error], [false, false, false, null, 'Push service 403']);
  const deletes: FixtureValue[] = [];
  await transport.discardTarget({ async execute(sql: string, values: FixtureValue) { deletes.push([sql, [...values]]); return [{}]; } }, target(410));
  assert.deepEqual(deletes, [['DELETE FROM push_subscriptions WHERE id = ?', ['s1']]]);
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
    async execute(sql: string, values: FixtureValue[] = []) {
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
  const service: FixtureValue = loadService({});
  await service.testInternals.reconcileReminders(connection, now, new Map([['restoring', new Set<FixtureValue>(['calendar'])]]));
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
  const { getActiveRestoreSectionsByUser } = require('../dist/src/services/restore-locks') as typeof import('../src/services/restore-locks');
  const active = await getActiveRestoreSectionsByUser({ async execute() {
    return [[{ user_id: 'u1', requested_sections: '["todo"]' }, { user_id: 'u1', requested_sections: '["mail"]' }, { user_id: 'u2', requested_sections: '["contacts"]' }]];
  } } as FixtureValue);
  assert.deepEqual([...active.get('u1')!].sort(), ['calendar', 'mail']);
  const calls: FixtureValue[] = [];
  const connection = { async execute(sql: string, values: FixtureValue) { calls.push({ sql, values }); return [[]]; } };
  const service: FixtureValue = loadService({});
  const now = new Date();
  await service.testInternals.enqueueDueReminders(connection, now, active);
  await service.testInternals.deliverPending(connection, now, active);
  assert.match(calls[0].sql, /r.user_id NOT IN \(\?\)[\s\S]*LIMIT 200/);
  assert.equal(calls[0].values[1], 'u1');
  assert.equal(calls[1].sql.match(/NOT \(e.kind IN \(\?, \?, \?\) AND e.user_id IN \(\?\)\)/g)?.length, 2);
  assert.deepEqual([...calls[1].values.slice(2)].sort(), ['calendar', 'mail', 'reminder', 'scheduled-send', 'snooze', 'todo', 'u1', 'u1'], 'mail and calendar kinds of u1 only');
  assert.equal(calls[1].values.includes('u2'), false, 'a contact restore does not delay notifications');
});

test('paused mail and calendar deliveries retain pending attempts and never call transport', async () => {
  for (const kind of ['mail', 'calendar', 'todo', 'reminder']) {
    const writes: FixtureValue[] = []; let sends = 0;
    const connection = { async execute(sql: string, values: FixtureValue) {
      if (sql.includes('FROM notification_deliveries')) return [[{
        event_id: 'event', subscription_id: 'device', user_id: 'u1', kind, source_id: 'source', attempts: 2,
        payload: { dedupeKey: 'test' }, expires_at: new Date(Date.now() + 60000),
      }]];
      if (sql.startsWith('SELECT public_key')) return [[{ public_key: 'public', encrypted_private_key: 'encrypted:secret', subject: 'mailto:test@example.com' }]];
      if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { enabled: false }, calendar: { background: false } }) }]];
      writes.push({ sql, values }); return [{}];
    } };
    const service: FixtureValue = loadService(connection, { sendNotification: async () => { sends++; } });
    assert.equal(await service.testInternals.deliverPending(connection, new Date()), 0);
    assert.equal(sends, 0);
    assert.deepEqual(writes, []);
  }
});

test('a pause during source revalidation preserves the delivery before reserving an attempt', async () => {
  let paused = false; const writes: FixtureValue[] = []; let sends = 0;
  const connection = { async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM notification_deliveries')) return [[{ event_id: 'event', subscription_id: 'device', user_id: 'u1', kind: 'mail', source_id: 'source', attempts: 2, payload: { dedupeKey: 'test' }, expires_at: new Date(Date.now() + 60000) }]];
    if (sql.startsWith('SELECT public_key')) return [[{ public_key: 'public', encrypted_private_key: 'encrypted:secret', subject: 'mailto:test@example.com' }]];
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { background: !paused } }) }]];
    if (sql.includes('FROM emails')) { paused = true; return [[{ folder: 'inbox', is_read: 0, is_draft: 0 }]]; }
    if (sql.includes('FROM setting_policies')) return [[]];
    writes.push({ sql, values }); return [{}];
  } };
  const service: FixtureValue = loadService(connection, { sendNotification: async () => { sends++; } });
  assert.equal(await service.testInternals.deliverPending(connection, new Date()), 0);
  assert.equal(sends, 0);
  assert.deepEqual(writes, []);
});

test('devices whose session is about to end get one warning, cancelled once the session is renewed', async () => {
  const expiresAt = new Date(Date.now() + 30 * 3600000);
  const inserts: FixtureValue[] = [];
  const connection = { async execute(sql: string, values: FixtureValue) {
    if (sql.startsWith('SELECT p.user_id, p.session_id')) return [[{ user_id: 'u1', session_id: 'sess1', endpoint_hash: 'a'.repeat(64), expires_at: expiresAt }]];
    if (sql.startsWith('SELECT p.id FROM push_subscriptions')) { assert.equal(values[1], 'a'.repeat(64)); return [[{ id: 's1' }]]; }
    if (sql.startsWith('INSERT IGNORE INTO notification_events')) { inserts.push(values); return [{ affectedRows: inserts.length === 1 ? 1 : 0 }]; }
    return [{}];
  } };
  const service: FixtureValue = loadService({});
  assert.equal(await service.testInternals.enqueueSessionExpiryWarnings(connection), 1);
  assert.equal(await service.testInternals.enqueueSessionExpiryWarnings(connection), 0, 'dedupe key is stable for one expiry');
  const payload = JSON.parse(inserts[0][5]);
  assert.equal(inserts[0][3], 'session');
  assert.equal(inserts[0][4], 'sess1');
  assert.equal(payload.title, 'Notifications will stop soon');
  assert.match(payload.body, /within 30 hours/);
  assert.equal(inserts[0][6], expiresAt);

  // The device opened UniHub in the meantime: the session no longer ends soon.
  const writes: FixtureValue[] = []; let sends = 0;
  const row = { event_id: 'n1', subscription_id: 's1', attempts: 0, user_id: 'u1', kind: 'session', source_id: 'sess1', payload, expires_at: expiresAt };
  const delivery = { async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM notification_deliveries d')) return [[row]];
    if (sql.startsWith('SELECT id FROM sessions')) return [[]];
    writes.push({ sql, values }); return [{}];
  } };
  const sender: FixtureValue = loadService({ async execute() { return [[{ public_key: 'public', encrypted_private_key: 'encrypted:private', subject: 'mailto:admin@example.com' }]]; } }, { async sendNotification() { sends++; } });
  await sender.testInternals.deliverPending(delivery, new Date());
  assert.equal(sends, 0);
  assert.ok(writes.some(call => call.sql.includes("status = 'cancelled'")));
});

test('device status reports the latest delivery and only unresolved problems', async () => {
  let failure = { last_error: 'Push service 503', created_at: '2026-10-01 08:00:00' };
  const service: FixtureValue = loadService({ async execute(sql: string) {
    if (sql.startsWith('SELECT p.id, s.expires_at')) return [[{ id: 's1', expires_at: '2026-10-20 08:00:00' }]];
    if (sql.startsWith('SELECT MAX')) return [[{ last_sent_at: '2026-10-02 08:00:00', pending: '1' }]];
    if (sql.startsWith('SELECT d.last_error')) return [failure ? [failure] : []];
    throw new Error(sql);
  } });
  const endpoint = validSubscription().endpoint;
  const status = async (value: FixtureValue) => JSON.parse(JSON.stringify(await service.deviceStatus('u1', value)));
  assert.deepEqual(await status(endpoint), { subscribed: true, sessionExpiresAt: '2026-10-20T08:00:00.000Z', lastSentAt: '2026-10-02T08:00:00.000Z', pending: 1, lastError: null });
  failure = { last_error: 'Push service 503', created_at: '2026-10-03 08:00:00' };
  assert.deepEqual((await status(endpoint)).lastError, { message: 'Push service 503', at: '2026-10-03T08:00:00.000Z' });
  assert.deepEqual(await status(''), { subscribed: false });
});

// The route answers through the shared error contract: a service's typed 4xx
// keeps its text, anything else is the route's generic 500.
test('notification routes pass typed validation errors through and hide unknown failures', async (t) => {
  const paths = ['../dist/src/routes/notifications', '../dist/src/services/notifications', '../dist/src/services/android-push', '../dist/src/auth'].map(name => require.resolve(name));
  const previous = paths.map(name => require.cache[name]);
  t.after(() => paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; }));
  const stub = (name: string, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  delete require.cache[paths[0]];
  const { badRequest } = require('../dist/src/http/errors') as typeof import('../src/http/errors');
  let failure: unknown;
  stub(paths[1], { subscribe: async () => { throw failure; }, unsubscribe: async (_user: string, endpoint: unknown) => { if (typeof endpoint !== 'string') throw badRequest('NOTIFICATION_ENDPOINT_INVALID', 'Invalid subscription endpoint'); return { subscribed: false }; } });
  stub(paths[2], {});
  stub(paths[3], { getAuthTokenFromRequest: () => 'token' });
  const specs = require(paths[0]) as Record<string, { handler: (req: FixtureValue, userId: string, body: FixtureValue, res: FixtureValue) => Promise<FixtureValue> }>;
  const routes = Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, spec.handler]));
  t.mock.method(console, 'error', () => {});

  assert.deepEqual(await routes['POST /api/notifications/unsubscribe']({ url: '/api/notifications/unsubscribe' }, 'u1', { endpoint: 7 }, {}),
    { error: 'Invalid subscription endpoint', status: 400, code: 'NOTIFICATION_ENDPOINT_INVALID' });
  failure = Object.assign(new Error('Session expired'), { status: 401 });
  assert.deepEqual(await routes['POST /api/notifications/subscription']({ url: '/api/notifications/subscription' }, 'u1', { subscription: {} }, {}), { error: 'Session expired', status: 401 });
  failure = Object.assign(new Error('Invalid JSON text in argument 1 to function json_extract'), { code: 'ER_INVALID_JSON_TEXT' });
  assert.deepEqual(await routes['POST /api/notifications/subscription']({ url: '/api/notifications/subscription' }, 'u1', { subscription: {} }, {}),
    { error: 'Could not update notifications. Please try again.', status: 500 });
});
