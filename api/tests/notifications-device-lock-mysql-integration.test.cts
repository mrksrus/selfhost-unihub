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

// Notification privacy per device (F5, F6) through the real request handler
// and database: each device reports its app lock and whether it is open, and
// the dispatcher sends it the kind's content only while that lock allows it.
// alex has a phone (the Android transport), a laptop and a tablet (Web Push);
// blair has a browser. Every send re-reads the device's state.
test('Notification privacy per device: app lock, open window, policies, other people and removed devices', { skip: !process.env.MYSQL_TEST_HOST, timeout: 240000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const ece = require('http_ece');
  const webPush = require('web-push');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-notification-lock-'));
  const originalSend = webPush.sendNotification;
  const pushed: { endpoint: string; payload: FixtureValue }[] = [];
  webPush.sendNotification = async (subscription: FixtureValue, body: string) => { pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; };
  let server: FixtureValue; let owned = false; let runtime: FixtureValue;
  const streams: { close(): void }[] = [];
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    runtime = createBackupRuntime(directory, 'notification-lock-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    await runtime('services/data-inventory').verifyDatabaseInventory(pool);
    const password = 'notification-lock-fixture-password';
    const passwordHash = await require('bcryptjs').hash(password, 10);
    const ids: Record<string, string> = {};
    for (const name of ['alex', 'blair']) {
      ids[name] = crypto.randomUUID();
      await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [ids[name], `${name}@example.test`, passwordHash, name]);
    }
    const { handleRequest } = runtime('request-handler');
    const notifications = runtime('services/notifications');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    function session(agent: string) {
      const cookies = new Map<string, string>(); let csrf: string | undefined;
      const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
      const request = async (method: string, route: string, body?: unknown, expected = 200) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          'User-Agent': agent,
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
      // The Android app's stream: SSE frames are collected as they arrive.
      request.stream = (device: string) => new Promise<FixtureValue>((resolve, reject) => {
        const frames: { type: string; data: FixtureValue }[] = [];
        const waiting: (() => void)[] = [];
        const req = http.get(`${base}/api/notifications/android/stream?device=${encodeURIComponent(device)}`, { headers: { Cookie: cookieHeader(), Accept: 'text/event-stream', 'User-Agent': agent } }, res => {
          let buffer = ''; let ended = false;
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
            status: res.statusCode, close: () => req.destroy(),
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
    const browser = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0';
    const deviceKey = () => crypto.randomBytes(32).toString('base64url');
    const pushKeys = () => {
      const ecdh = crypto.createECDH('prime256v1');
      const auth = crypto.randomBytes(16).toString('base64url');
      return { ecdh, auth, keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth } };
    };
    const signIn = async (agent: string, name: string, device?: FixtureValue) => {
      const request = session(agent);
      await request('POST', '/auth/signin', { email: `${name}@example.test`, password, ...(device ? { device } : {}) });
      return request;
    };
    const phone = await signIn('Mozilla/5.0 (Linux; Android 16) UniHubAndroid/0.29.0 (29) UniHubBridge/3', 'alex', { key: deviceKey(), kind: 'android' });
    const laptop = await signIn(browser, 'alex', { key: deviceKey(), kind: 'web' });
    // A sign-in without a device key, as a page from before 0.29 sends it: a keyless device without a lock record.
    const tablet = await signIn(browser, 'alex');
    const blair = await signIn(browser, 'blair', { key: deviceKey(), kind: 'web' });
    const deviceOf = async (request: FixtureValue) => (await request('GET', '/devices/current')).device.id as string;
    const tabletDevice = await deviceOf(tablet);
    const [[tabletRecord]] = await pool.query<RowDataPacket[]>('SELECT key_hash, lock_applied, open_until FROM devices WHERE id = ?', [tabletDevice]);
    assert.deepEqual([tabletRecord.key_hash, tabletRecord.lock_applied, tabletRecord.open_until], [null, null, null]);

    // The channels: the phone's Android registration and stream, a Web Push subscription of each browser.
    const phoneKeys = pushKeys();
    const registration = await phone('POST', '/notifications/android/devices', { keys: phoneKeys.keys });
    const stream = await phone.stream(registration.device);
    assert.equal(stream.status, 200);
    assert.ok(await stream.next('ready'));
    const endpoints: Record<string, string> = {};
    for (const [name, request] of [['laptop', laptop], ['tablet', tablet], ['blair', blair]] as const) {
      endpoints[name] = `https://fcm.googleapis.com/fcm/send/notification-lock-${name}`;
      await request('POST', '/notifications/subscription', { subscription: { endpoint: endpoints[name], keys: pushKeys().keys } });
    }

    // A device's connect starts a pass of its own in the background; a pass
    // that meets it running is skipped, so run until one really ran.
    const pass = async () => { for (;;) {
      const result = await notifications.processNotificationJobs();
      if (!('skipped' in result)) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    } };
    // What each device was sent for one event: the phone's frame opened with its keys, the browsers' Web Push bodies.
    const onPhone = async (eventId: string) => {
      const frame = await stream.next('notification');
      assert.equal(frame?.id, eventId, 'the phone is sent the event');
      return JSON.parse(ece.decrypt(Buffer.from(frame.body, 'base64url'), { version: 'aes128gcm', privateKey: phoneKeys.ecdh, authSecret: phoneKeys.auth }).toString('utf8'));
    };
    const ack = (eventId: string) => phone('POST', '/notifications/android/ack', { device: registration.device, ids: [eventId] });
    const onBrowsers = (eventId: string) => {
      const sent = pushed.splice(0);
      assert.ok(sent.every(push => push.payload.notificationId === eventId), 'only this event was pushed');
      assert.equal(sent.some(push => push.endpoint === endpoints.blair), false, 'blair\'s browser never gets alex\'s notifications');
      return Object.fromEntries(sent.map(push => [Object.keys(endpoints).find(name => endpoints[name] === push.endpoint), push.payload]));
    };
    const text = (payload: FixtureValue) => payload && [payload.title, payload.body];
    const storedPayload = async (eventId: string) => { const { payload } = (await pool.query<RowDataPacket[]>('SELECT payload FROM notification_events WHERE id = ?', [eventId]))[0][0]; return typeof payload === 'string' ? JSON.parse(payload) : payload; };
    async function mail(subject: string, userId = ids.alex) {
      const accountId = crypto.randomUUID(); const emailId = crypto.randomUUID();
      await pool.execute<ResultSetHeader>("INSERT INTO mail_accounts (id, user_id, email_address, provider) VALUES (?, ?, ?, 'imap')", [accountId, userId, `${accountId.slice(0, 8)}@example.test`]);
      await pool.execute<ResultSetHeader>("INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, folder, is_read) VALUES (?, ?, ?, ?, 'Robin Example', 'robin@example.test', '[]', 'inbox', FALSE)",
        [emailId, userId, accountId, subject]);
      const eventId = await notifications.enqueueMailNotification({ userId, emailId });
      assert.ok(eventId, 'the mail notification is queued');
      await pass();
      return eventId as string;
    }
    const full = (subject: string) => ['New Email', `Robin Example: ${subject}`];
    const hidden = ['New Email', ''];
    const lockReport = (scope: string[]) => ({ applied: { scope, relock_after: '60', on_device_lock: true, method: 'biometric' },
      capabilities: { lock: 'biometric', secure_window: true, recents_hidden: true, device_lock_signal: true } });

    // Without any lock report every device is sent the person's text, as in 0.28.
    const first = await mail('Quarterly numbers');
    const firstOnPhone = await onPhone(first);
    assert.deepEqual(text(firstOnPhone), full('Quarterly numbers'));
    assert.equal(firstOnPhone.module, 'mail', 'every payload names its module');
    let browsers = onBrowsers(first);
    assert.deepEqual([text(browsers.laptop), text(browsers.tablet), browsers.laptop.module], [full('Quarterly numbers'), full('Quarterly numbers'), 'mail']);
    await ack(first);

    // The phone locks Mail and has not reported it is open: its notification
    // carries no sender or subject. The laptop and tablet still get them, and
    // the stored copy keeps the person's text, not the phone's.
    await phone('PUT', '/devices/current/lock', lockReport(['mail']));
    const locked = await mail('Medical results');
    const lockedOnPhone = await onPhone(locked);
    assert.deepEqual(text(lockedOnPhone), hidden);
    assert.doesNotMatch(JSON.stringify(lockedOnPhone), /Medical|Robin/, 'nothing hidden is in any field');
    assert.equal(lockedOnPhone.module, 'mail');
    browsers = onBrowsers(locked);
    assert.deepEqual([text(browsers.laptop), text(browsers.tablet)], [full('Medical results'), full('Medical results')]);
    assert.deepEqual(text(await storedPayload(locked)), full('Medical results'), 'the shared payload holds no device\'s text');
    await ack(locked);

    // A Mail lock leaves another module's content alone.
    const calendarEventId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO calendar_events (id, user_id, title, start_time, end_time) VALUES (?, ?, 'Dentist appointment', UTC_TIMESTAMP() + INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 25 HOUR)", [calendarEventId, ids.alex]);
    const calendar = await notifications.enqueueCalendarNotification({ userId: ids.alex, eventId: calendarEventId });
    await pass();
    const calendarOnPhone = await onPhone(calendar);
    assert.deepEqual([...text(calendarOnPhone), calendarOnPhone.module], ['New Calendar Event', 'Dentist appointment', 'calendar']);
    onBrowsers(calendar);
    await ack(calendar);

    // The state is read again at every send: a notification sent while the
    // phone was locked and not acknowledged comes again with the content once
    // the phone reports it is open.
    const resent = await mail('Lab follow-up');
    assert.deepEqual(text(await onPhone(resent)), hidden);
    onBrowsers(resent);
    const opened = await phone('POST', '/devices/current/lock-state', { state: 'open' });
    assert.ok(new Date(opened.open_until).getTime() > Date.now());
    await pool.execute('UPDATE notification_deliveries SET available_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE event_id = ?', [resent]);
    await pass();
    assert.deepEqual(text(await onPhone(resent)), full('Lab follow-up'), 'the resend is rendered for the device as it is now');
    await ack(resent);
    // Locking again hides the next one.
    await phone('POST', '/devices/current/lock-state', { state: 'locked' });
    const relocked = await mail('Travel plans');
    assert.deepEqual(text(await onPhone(relocked)), hidden);
    onBrowsers(relocked);
    await ack(relocked);

    // The laptop locks the whole app: Mail and Recordings are covered. The
    // phone's Mail lock does not cover a recording, so it still gets the name.
    await laptop('PUT', '/devices/current/lock', lockReport(['app']));
    const appLocked = await mail('Contract draft');
    assert.deepEqual(text(await onPhone(appLocked)), hidden);
    browsers = onBrowsers(appLocked);
    assert.deepEqual([text(browsers.laptop), text(browsers.tablet)], [hidden, full('Contract draft')]);
    await ack(appLocked);
    const uploadId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(`INSERT INTO recording_uploads (id, user_id, title, content_type, total_bytes, bytes_received, temp_path, expires_at)
      VALUES (?, ?, 'Board meeting', 'audio/webm', 100, 10, 'synthetic', UTC_TIMESTAMP() + INTERVAL 1 DAY)`, [uploadId, ids.alex]);
    const recording = await notifications.enqueueEvent({ userId: ids.alex, dedupeKey: `recording-upload:${uploadId}:10`, kind: 'recording', sourceId: uploadId,
      title: 'Recording not uploaded yet', body: '"Board meeting" stopped at 10%.', url: '/recordings', expiresAt: new Date(Date.now() + 3600000), data: { bytesReceived: 10 } });
    assert.ok(recording);
    await pass();
    const recordingOnPhone = await onPhone(recording);
    assert.deepEqual([recordingOnPhone.body, recordingOnPhone.module], ['"Board meeting" stopped at 10%.', 'recordings']);
    await ack(recording);
    browsers = onBrowsers(recording);
    assert.equal(browsers.laptop.module, 'recordings');
    assert.doesNotMatch(JSON.stringify(browsers.laptop), /Board meeting/, 'the whole-app lock hides the recording\'s name');
    assert.match(browsers.tablet.body, /Board meeting/);
    // An account notice has no module; its fixed text carries nothing private.
    const notice = await notifications.enqueueEvent({ userId: ids.alex, dedupeKey: 'test:notification-lock', kind: 'test', title: 'UniHub notifications are working',
      body: 'This notification was sent through the server to this device.', url: '/settings', expiresAt: new Date(Date.now() + 3600000) });
    await pass();
    assert.equal((await onPhone(notice)).module, null);
    await ack(notice);
    browsers = onBrowsers(notice);
    assert.deepEqual([browsers.laptop.title, browsers.laptop.module], ['UniHub notifications are working', null]);

    // The policy is read again for every send: one an administrator saves
    // while an earlier send of the same pass waits on its push service applies
    // to the sends after it. The laptop's send comes first and the policy is
    // saved during it; the tablet, without a lock, is then sent no content.
    await tablet('POST', '/devices/current/lock-state', { state: 'open' });
    await laptop('POST', '/devices/current/lock-state', { state: 'open' });
    const raceAccount = crypto.randomUUID(), raceEmail = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO mail_accounts (id, user_id, email_address, provider) VALUES (?, ?, ?, 'imap')", [raceAccount, ids.alex, `${raceAccount.slice(0, 8)}@example.test`]);
    await pool.execute<ResultSetHeader>("INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, folder, is_read) VALUES (?, ?, ?, 'Quarterly figures', 'Robin Example', 'robin@example.test', '[]', 'inbox', FALSE)",
      [raceEmail, ids.alex, raceAccount]);
    const raced = await notifications.enqueueMailNotification({ userId: ids.alex, emailId: raceEmail }) as string;
    assert.ok(raced);
    await pool.execute(`UPDATE notification_deliveries d JOIN push_subscriptions p ON p.id = d.subscription_id
      SET d.available_at = UTC_TIMESTAMP() - INTERVAL (CASE p.endpoint WHEN ? THEN 30 WHEN ? THEN 10 ELSE 20 END) SECOND WHERE d.event_id = ?`,
    [endpoints.laptop, endpoints.tablet, raced]);
    const plainSend = webPush.sendNotification;
    webPush.sendNotification = async (subscription: FixtureValue, body: string) => {
      if (subscription.endpoint === endpoints.laptop) {
        await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.app_lock.required', '[\"mail\"]', FALSE)");
      }
      return plainSend(subscription, body);
    };
    try { await pass(); } finally { webPush.sendNotification = plainSend; }
    await onPhone(raced); await ack(raced);
    browsers = onBrowsers(raced);
    assert.deepEqual([text(browsers.laptop), text(browsers.tablet)], [full('Quarterly figures'), hidden], 'the policy saved during the laptop\'s send applies to the tablet\'s');
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'policy.app_lock.required'");

    // A policy requires a Mail lock. The tablet has none: even open, it gets
    // no mail content, but other modules' content still. The laptop's open
    // whole-app lock meets the policy, so it gets the content.
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.app_lock.required', '[\"mail\"]', FALSE)");
    await tablet('POST', '/devices/current/lock-state', { state: 'open' });
    await laptop('POST', '/devices/current/lock-state', { state: 'open' });
    const required = await mail('Payroll');
    assert.deepEqual(text(await onPhone(required)), hidden);
    browsers = onBrowsers(required);
    assert.deepEqual([text(browsers.laptop), text(browsers.tablet)], [full('Payroll'), hidden]);
    await ack(required);
    const otherEvent = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO calendar_events (id, user_id, title, start_time, end_time) VALUES (?, ?, 'Team lunch', UTC_TIMESTAMP() + INTERVAL 2 DAY, UTC_TIMESTAMP() + INTERVAL 49 HOUR)", [otherEvent, ids.alex]);
    const lunch = await notifications.enqueueCalendarNotification({ userId: ids.alex, eventId: otherEvent });
    await pass();
    await onPhone(lunch); await ack(lunch);
    assert.equal(onBrowsers(lunch).tablet.body, 'Team lunch', 'a policy for Mail leaves Calendar content alone');
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'policy.app_lock.required'");

    // A removed device gets nothing: its channel goes with it.
    await laptop('DELETE', `/devices/${tabletDevice}`);
    const afterRemoval = await mail('After removal');
    await onPhone(afterRemoval); await ack(afterRemoval);
    browsers = onBrowsers(afterRemoval);
    assert.deepEqual(Object.keys(browsers), ['laptop'], 'only the remaining browser is sent it');
    const [[tabletDeliveries]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM notification_deliveries d JOIN push_subscriptions p ON p.id = d.subscription_id WHERE p.device_id = ?', [tabletDevice]);
    assert.equal(Number(tabletDeliveries.total), 0);

    // blair's own notification reaches blair's browser only, so its absence above meant something.
    const blairs = await mail('For blair only', ids.blair);
    const sent = pushed.splice(0);
    assert.deepEqual(sent.map(push => push.endpoint), [endpoints.blair]);
    assert.equal(sent[0].payload.notificationId, blairs);
    assert.equal(await stream.next('notification', 300), null, 'alex\'s phone is not sent blair\'s notification');
    const [[foreign]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
      JOIN push_subscriptions p ON p.id = d.subscription_id WHERE e.user_id <> p.user_id`);
    assert.equal(Number(foreign.total), 0, 'no delivery crosses people');
  } finally {
    webPush.sendNotification = originalSend;
    for (const stream of streams) stream.close();
    runtime?.('services/android-push').closeAndroidStreams();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (runtime) await runtime('services/side-pools').endSidePools(pool);
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});
