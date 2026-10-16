import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// The Android app's notifications (api/src/services/android-push.ts) through
// the real request handler and database: a phone registers its keys, holds the
// stream, receives each notification encrypted for those keys only, and
// acknowledges it. Another user can neither stream nor acknowledge for it.
test('Android notification devices: registration, encrypted stream delivery, acknowledgement, offline wait and sign-out', { skip: !process.env.MYSQL_TEST_HOST, timeout: 60000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const ece = require('http_ece');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-android-push-'));
  let server: FixtureValue; let owned = false; let runtime: FixtureValue;
  const streams: { close(): void }[] = [];
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    runtime = createBackupRuntime(directory, 'android-push-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    await runtime('services/data-inventory').verifyDatabaseInventory(pool);
    const password = 'android-push-fixture-password';
    const passwordHash = await require('bcryptjs').hash(password, 10);
    const ids: Record<string, string> = {};
    for (const name of ['owner', 'other']) {
      ids[name] = crypto.randomUUID();
      await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [ids[name], `${name}@example.test`, passwordHash, name]);
    }
    const { handleRequest } = runtime('request-handler');
    const notifications = runtime('services/notifications');
    const { androidStreams } = runtime('services/android-push');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    function session() {
      const cookies = new Map<string, string>(); let csrf: string | undefined;
      const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
      const request = async (method: string, route: string, body?: unknown, expected = 200) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookies.size ? { Cookie: cookieHeader() } : {}),
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const separator = pair.indexOf('='); cookies.set(pair.slice(0, separator), pair.slice(separator + 1)); }
        const result = await response.json();
        assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
        if (result.csrfToken) csrf = result.csrfToken;
        return result;
      };
      // The app's stream: SSE frames are collected as they arrive.
      request.stream = (device: string) => new Promise<FixtureValue>((resolve, reject) => {
        const frames: { type: string; data: FixtureValue }[] = [];
        const waiting: (() => void)[] = [];
        const req = http.get(`${base}/api/notifications/android/stream?device=${encodeURIComponent(device)}`, { headers: { Cookie: cookieHeader(), Accept: 'text/event-stream' } }, res => {
          let buffer = '';
          let ended = false;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
              const type = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (type && data) frames.push({ type, data: JSON.parse(data) });
              waiting.splice(0).forEach(wake => wake());
            }
          });
          res.on('end', () => { ended = true; waiting.splice(0).forEach(wake => wake()); });
          const handle = {
            status: res.statusCode, frames, close: () => req.destroy(), get ended() { return ended; },
            async next(type: string, timeout = 5000) {
              const deadline = Date.now() + timeout;
              for (;;) {
                const found = frames.findIndex(frame => frame.type === type);
                if (found >= 0) return frames.splice(found, 1)[0].data;
                if (ended || Date.now() > deadline) return null;
                await new Promise<void>(wake => { waiting.push(wake); setTimeout(wake, 100); });
              }
            },
          };
          streams.push(handle);
          resolve(handle);
        });
        req.on('error', reject);
      });
      return request;
    }
    function deviceKeys() {
      const ecdh = crypto.createECDH('prime256v1');
      const p256dh = ecdh.generateKeys().toString('base64url');
      const auth = crypto.randomBytes(16).toString('base64url');
      return { ecdh, auth, keys: { p256dh, auth } };
    }
    const open = (device: FixtureValue, body: string) => JSON.parse(ece.decrypt(Buffer.from(body, 'base64url'), { version: 'aes128gcm', privateKey: device.ecdh, authSecret: device.auth }).toString('utf8'));
    async function newMail(subject: string) {
      const accountId = crypto.randomUUID(); const emailId = crypto.randomUUID();
      await pool.execute<ResultSetHeader>("INSERT INTO mail_accounts (id, user_id, email_address, provider) VALUES (?, ?, ?, 'imap')", [accountId, ids.owner, `${accountId.slice(0, 8)}@example.test`]);
      await pool.execute<ResultSetHeader>("INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, folder, is_read) VALUES (?, ?, ?, ?, 'Alex Example', 'alex@example.test', '[]', 'inbox', FALSE)",
        [emailId, ids.owner, accountId, subject]);
      const eventId = await notifications.enqueueMailNotification({ userId: ids.owner, emailId });
      assert.ok(eventId, 'the mail notification is queued for the device');
      return { emailId, eventId };
    }
    const delivery = async (eventId: string) => (await pool.query<RowDataPacket[]>('SELECT status, delivered_at, available_at FROM notification_deliveries WHERE event_id = ?', [eventId]))[0][0];

    const owner = session(), other = session();
    for (const [request, name] of [[owner, 'owner'], [other, 'other']] as const) { await request('POST', '/auth/signin', { email: `${name}@example.test`, password }); await request('GET', '/auth/me'); }
    assert.ok((await owner('GET', '/version')).features.includes('android-notifications'));

    // Registration validates the keys and binds the device to this session.
    await owner('POST', '/notifications/android/devices', { keys: { p256dh: 'short', auth: 'short' } }, 400);
    const phone = deviceKeys();
    const registered = await owner('POST', '/notifications/android/devices', { keys: phone.keys });
    assert.match(registered.device, /^[0-9a-f-]{36}$/);
    assert.equal(registered.endpoint, `unihub-android:${registered.device}`);
    assert.equal((await owner('GET', `/notifications/status?endpoint=${encodeURIComponent(registered.endpoint)}`)).subscribed, true);
    assert.equal((await other('GET', `/notifications/status?endpoint=${encodeURIComponent(registered.endpoint)}`)).subscribed, false);

    // Another user cannot hold this device's stream or acknowledge for it.
    const stolen = await other.stream(registered.device);
    assert.equal(stolen.status, 404);
    await other('POST', '/notifications/android/ack', { device: registered.device, ids: [] }, 404);

    const stream = await owner.stream(registered.device);
    assert.equal(stream.status, 200);
    assert.ok(await stream.next('ready'));

    // A new email reaches the phone encrypted for its keys; the delivery
    // stays pending until the app acknowledges it.
    const first = await newMail('Quarterly numbers');
    await notifications.processNotificationJobs();
    const frame = await stream.next('notification');
    assert.ok(frame, 'the notification is written to the stream');
    assert.equal(frame.id, first.eventId);
    assert.doesNotMatch(Buffer.from(frame.body, 'base64url').toString('latin1'), /Quarterly|Alex/, 'the stream carries ciphertext only');
    const payload = open(phone, frame.body);
    assert.equal(payload.title, 'New Email');
    assert.equal(payload.body, 'Alex Example: Quarterly numbers');
    assert.equal(payload.url, `/mail?email=${first.emailId}`);
    assert.equal(payload.userId, ids.owner);
    assert.equal(payload.notificationId, first.eventId);
    assert.throws(() => open(deviceKeys(), frame.body), 'another key pair cannot read it');
    assert.equal((await delivery(first.eventId)).status, 'pending');
    assert.equal((await owner('GET', `/notifications/status?endpoint=${encodeURIComponent(registered.endpoint)}`)).pending, 1);

    // The other user's acknowledgement of this event on their own device changes nothing.
    const otherPhone = await other('POST', '/notifications/android/devices', { keys: deviceKeys().keys });
    assert.equal((await other('POST', '/notifications/android/ack', { device: otherPhone.device, ids: [first.eventId] })).acknowledged, 0);
    assert.equal((await delivery(first.eventId)).status, 'pending');
    await owner('POST', '/notifications/android/ack', { device: registered.device, ids: ['not-an-id'] }, 400);
    assert.equal((await owner('POST', '/notifications/android/ack', { device: registered.device, ids: [first.eventId] })).acknowledged, 1);
    assert.equal((await owner('POST', '/notifications/android/ack', { device: registered.device, ids: [first.eventId] })).acknowledged, 0);
    const acked = await delivery(first.eventId);
    assert.equal(acked.status, 'sent');
    assert.ok(acked.delivered_at);
    const status = await owner('GET', `/notifications/status?endpoint=${encodeURIComponent(registered.endpoint)}`);
    assert.equal(status.pending, 0);
    assert.ok(status.lastSentAt);
    await notifications.processNotificationJobs();
    assert.equal(await stream.next('notification', 300), null, 'an acknowledged notification is not sent again');

    // Without an acknowledgement the notification is sent again later.
    const second = await newMail('Unacknowledged');
    await notifications.processNotificationJobs();
    assert.equal((await stream.next('notification')).id, second.eventId);
    const waiting = await delivery(second.eventId);
    assert.equal(waiting.status, 'pending');
    assert.ok(new Date(waiting.available_at).getTime() > Date.now() + 60000, 'the next attempt waits for the acknowledgement');
    await pool.execute('UPDATE notification_deliveries SET available_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE event_id = ?', [second.eventId]);
    await notifications.processNotificationJobs();
    assert.equal((await stream.next('notification')).id, second.eventId);
    await owner('POST', '/notifications/android/ack', { device: registered.device, ids: [second.eventId] });

    // While the phone is away its notification waits, and goes out as soon as it connects.
    stream.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    const third = await newMail('While offline');
    await notifications.processNotificationJobs();
    const parked = await delivery(third.eventId);
    assert.equal(parked.status, 'pending');
    assert.ok(new Date(parked.available_at).getTime() > Date.now() + 5 * 60000);
    const again = await owner.stream(registered.device);
    assert.equal(again.status, 200);
    const late = await again.next('notification');
    assert.equal(late?.id, third.eventId, 'connecting delivers what waited');
    assert.equal(open(phone, late.body).body, 'Alex Example: While offline');

    // A newer stream of the same device replaces the older one, and what was
    // written to the old one without an acknowledgement comes again.
    const replacement = await owner.stream(registered.device);
    assert.equal(replacement.status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(again.ended, true);
    assert.equal((await replacement.next('notification'))?.id, third.eventId);
    await owner('POST', '/notifications/android/ack', { device: registered.device, ids: [third.eventId] });

    // A new key pair (the app's data was reset) replaces the old device.
    const renewed = await owner('POST', '/notifications/android/devices', { keys: deviceKeys().keys, replaces: registered.device });
    assert.equal((await owner('GET', `/notifications/status?endpoint=${encodeURIComponent(registered.endpoint)}`)).subscribed, false);
    await androidStreams.tick();
    assert.ok(await replacement.next('end'), 'the stream of a removed device ends at the next heartbeat');
    assert.equal(await replacement.next('notification', 200), null);
    // Another user's device is never removed as "replaced".
    await owner('POST', '/notifications/android/devices', { keys: deviceKeys().keys, replaces: otherPhone.device });
    assert.equal((await other('GET', `/notifications/status?endpoint=${encodeURIComponent(otherPhone.endpoint)}`)).subscribed, true);

    // Signing out removes the device with its session and ends its stream.
    const last = await owner.stream(renewed.device);
    assert.equal(last.status, 200);
    await owner('POST', '/auth/signout', {});
    await androidStreams.tick();
    const end = await last.next('end');
    assert.equal(end?.reason, 'session_ended');
    const [[left]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ? AND transport = 'android'", [ids.owner]);
    assert.equal(Number(left.total), 0);
    const signedOut = await owner.stream(renewed.device);
    assert.equal(signedOut.status, 401);
  } finally {
    for (const stream of streams) stream.close();
    runtime?.('services/android-push').closeAndroidStreams();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});
