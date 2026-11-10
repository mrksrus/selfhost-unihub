import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = require('node:http') as typeof import('node:http');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// Devices as records (F5) through the real request handler and a disposable
// MariaDB, with alex (the owner), blair (a second person) and casey (a
// stranger to both):
// - a sign-in, sign-up or two-factor sign-in binds its session to the device
//   its key names, per person; a session from before 0.29 adopts the key and
//   joins its browser's device with its push channel, and nobody is signed out
// - each person lists and removes only their own devices; removing one signs
//   it out, revokes its push channels and deliveries, closes its live streams
//   at once and is audited; the current device signs out with Sign out
// - one push channel per device and transport
// - lock reports, lock state and the device settings stay with the device
// - last use, the clean-up of idle devices, user deletion, and a personal
//   restore, which brings no device back
// Most of the time goes to building the fresh schema (every upgrade step).
test('devices: binding at sign-in, key adoption, owner-scoped list and removal, push channels, lock reports, clean-up and restore', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match(process.env.MYSQL_TEST_DATABASE as string, /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-devices-'));
  let server: FixtureValue; let owned = false; let runtime: FixtureValue;
  const streams: { close(): void }[] = [];
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    runtime = createBackupRuntime(directory, 'devices-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    const password = 'devices-fixture-password-2026';
    const passwordHash = await require('bcryptjs').hash(password, 10);
    const ids: Record<string, string> = {};
    for (const name of ['alex', 'blair', 'casey']) {
      ids[name] = crypto.randomUUID();
      await pool.execute<ResultSetHeader>('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [ids[name], `${name}@example.test`, passwordHash, name]);
    }
    const { handleRequest } = runtime('request-handler');
    const devices = runtime('services/devices');
    const notifications = runtime('services/notifications');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const agents = {
      laptop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      phone: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 UniHubAndroid/0.29.0 (29000) UniHubBridge/3',
      tablet: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    };
    // One browser (or app) with its cookies, CSRF token and user agent.
    function client(agent: string) {
      const cookies = new Map<string, string>(); let csrf: string | undefined;
      const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
      const request = async (method: string, route: string, body?: unknown, expected: number | null = 200) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          'User-Agent': agent,
          ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' }),
          ...(cookies.size ? { Cookie: cookieHeader() } : {}),
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';')[0]; const separator = pair.indexOf('=');
          if (/Expires=Thu, 01 Jan 1970/.test(cookie)) cookies.delete(pair.slice(0, separator)); else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        const binary = /zip|octet-stream/.test(response.headers.get('content-type') || '');
        const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
        if (expected !== null) assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
        if (result?.csrfToken) csrf = result.csrfToken;
        return result;
      };
      request.signIn = async (email: string, device?: unknown) => {
        const result = await request('POST', '/auth/signin', { email, password, ...(device === undefined ? {} : { device }) });
        await request('GET', '/auth/me');
        return result;
      };
      // A live stream (the browser's /api/events, the app's notification
      // stream): its frames are collected, `ended` once the server closes it.
      request.stream = (route: string) => new Promise<FixtureValue>((resolve, reject) => {
        const frames: { type: string; data: FixtureValue }[] = [];
        const req = http.get(`${base}/api${route}`, { headers: { Cookie: cookieHeader(), Accept: 'text/event-stream', 'User-Agent': agent } }, res => {
          let buffer = ''; let ended = false;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
              const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
              if (type && data) frames.push({ type, data: JSON.parse(data) });
            }
          });
          res.on('end', () => { ended = true; });
          res.on('error', () => { ended = true; });
          const handle = {
            status: res.statusCode, frames, close: () => req.destroy(), get ended() { return ended; },
            async until(check: () => boolean, timeout = 3000) {
              const deadline = Date.now() + timeout;
              while (!check() && Date.now() < deadline) await new Promise(wake => setTimeout(wake, 25));
              return check();
            },
          };
          streams.push(handle);
          resolve(handle);
        });
        req.on('error', reject);
      });
      return request;
    }
    const newKey = () => crypto.randomBytes(32).toString('base64url');
    const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
    const count = async (sql: string, values: unknown[] = []) => Number((await rows(sql, values))[0].n);
    const deviceOf = async (person: FixtureValue) => (await person('GET', '/devices/current')).device;
    const webKeys = () => {
      const ecdh = crypto.createECDH('prime256v1');
      return { p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
    };
    const webSubscription = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: webKeys() });

    // --- Binding at sign-in --------------------------------------------------
    const laptopKey = newKey();
    const laptop = client(agents.laptop);
    // A device field that is not { key, kind } refuses the sign-in before anything is written.
    for (const device of [{ key: 'short', kind: 'web' }, { key: laptopKey, kind: 'desktop' }, { kind: 'web' }, 'web', [laptopKey]]) {
      const refused = await laptop('POST', '/auth/signin', { email: 'alex@example.test', password, device }, 400);
      assert.equal(refused.code, 'DEVICE_INVALID', JSON.stringify(device));
    }
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM devices'), 0);
    // A page that claims to be the Android app in a browser is a browser.
    await laptop.signIn('alex@example.test', { key: laptopKey, kind: 'android' });
    const alexLaptop = await deviceOf(laptop);
    assert.deepEqual([alexLaptop.current, alexLaptop.kind, alexLaptop.app_version, alexLaptop.user_agent, alexLaptop.lock, alexLaptop.notifications],
      [true, 'web', null, agents.laptop, null, false]);
    const [stored] = await rows('SELECT key_hash, user_id FROM devices WHERE id = ?', [alexLaptop.id]);
    assert.equal(stored.user_id, ids.alex);
    assert.match(stored.key_hash, /^[0-9a-f]{64}$/);
    assert.ok(!stored.key_hash.includes(laptopKey) && stored.key_hash !== laptopKey, 'only the key\'s hash is stored');
    // The same browser signing in again (another tab after a sign-out, a second window) is the same device.
    const laptopAgain = client(agents.laptop);
    await laptopAgain.signIn('alex@example.test', { key: laptopKey, kind: 'pwa' });
    assert.equal((await deviceOf(laptopAgain)).id, alexLaptop.id);
    assert.equal((await deviceOf(laptopAgain)).kind, 'pwa', 'an installed web app is known from the page only');
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?', [alexLaptop.id]), 2);
    await laptopAgain('POST', '/auth/signout', {});
    assert.equal((await laptop('GET', '/devices')).devices.length, 1);
    // blair in the same browser profile (the same key) gets a device of her own.
    const blairLaptop = client(agents.laptop);
    await blairLaptop.signIn('blair@example.test', { key: laptopKey, kind: 'web' });
    const blairDevice = await deviceOf(blairLaptop);
    assert.notEqual(blairDevice.id, alexLaptop.id);
    assert.deepEqual((await blairLaptop('GET', '/devices')).devices.map((device: FixtureValue) => device.id), [blairDevice.id]);
    // The Android app is known from its user agent, whatever the page says.
    const phoneKey = newKey();
    const phone = client(agents.phone);
    await phone.signIn('alex@example.test', { key: phoneKey, kind: 'web' });
    const alexPhone = await deviceOf(phone);
    assert.deepEqual([alexPhone.kind, alexPhone.app_version], ['android', '0.29.0']);
    assert.equal(Number((await rows('SELECT bridge_level FROM devices WHERE id = ?', [alexPhone.id]))[0].bridge_level), 3);

    // Sign-up binds the device too.
    await runtime('services/settings').setSignupMode('open');
    const dana = client(agents.tablet);
    const signedUp = await dana('POST', '/auth/signup', { email: 'dana@example.test', password, full_name: 'Dana', device: { key: newKey(), kind: 'pwa' } });
    ids.dana = signedUp.user.id;
    await dana('GET', '/auth/me');
    assert.equal((await deviceOf(dana)).kind, 'pwa');
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions s JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id WHERE s.user_id = ?', [ids.dana]), 1);
    await dana('POST', '/auth/signup', { email: 'dana-2@example.test', password, device: { key: 'x', kind: 'pwa' } }, 400);
    assert.equal(await count("SELECT COUNT(*) AS n FROM users WHERE email = 'dana-2@example.test'"), 0, 'a broken device field creates no account');

    // So does the two-factor sign-in, with the device named in its second step.
    const secretBytes = crypto.randomBytes(20);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '', secret = '';
    for (const byte of secretBytes) bits += byte.toString(2).padStart(8, '0');
    for (let index = 0; index < bits.length; index += 5) secret += alphabet[parseInt(bits.slice(index, index + 5), 2)];
    await runtime('services/two-factor').enableTwoFactor(ids.casey, secret, []);
    const totp = () => {
      const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
      const digest = crypto.createHmac('sha1', secretBytes).update(counter).digest();
      const offset = digest[digest.length - 1] & 0x0f;
      return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
    };
    const casey = client(agents.tablet);
    const caseyKey = newKey();
    const challenge = await casey('POST', '/auth/signin', { email: 'casey@example.test', password });
    assert.equal(challenge.requires2fa, true);
    await casey('POST', '/auth/2fa/login', { challenge_token: challenge.challengeToken, code: totp(), device: { key: 'broken', kind: 'web' } }, 400);
    const second = await casey('POST', '/auth/signin', { email: 'casey@example.test', password });
    await casey('POST', '/auth/2fa/login', { challenge_token: second.challengeToken, code: totp(), device: { key: caseyKey, kind: 'web' } });
    await casey('GET', '/auth/me');
    const caseyDevice = await deviceOf(casey);
    assert.equal((await rows('SELECT key_hash FROM devices WHERE id = ?', [caseyDevice.id]))[0].key_hash, devices.deviceKeyHash(caseyKey));

    // --- A session from before 0.29 adopts its browser's key ----------------
    // Upgrade step 26 gave each session a keyless device; a sign-in without a
    // key (an old tab, a script) gets one too. Its push channel moves along.
    const oldTab = client(agents.laptop);
    await oldTab.signIn('alex@example.test');
    const keyless = await deviceOf(oldTab);
    assert.notEqual(keyless.id, alexLaptop.id);
    assert.equal((await rows('SELECT key_hash FROM devices WHERE id = ?', [keyless.id]))[0].key_hash, null);
    await oldTab('POST', '/notifications/subscription', { subscription: webSubscription('old-tab') });
    assert.equal((await deviceOf(oldTab)).notifications, true);
    await oldTab('POST', '/devices/current/key', { key: 'not a key' }, 400).then((refused: FixtureValue) => assert.equal(refused.code, 'DEVICE_KEY_INVALID'));
    assert.deepEqual(await oldTab('POST', '/devices/current/key', { key: laptopKey }), { device_id: alexLaptop.id, merged: true });
    assert.equal(await count('SELECT COUNT(*) AS n FROM devices WHERE id = ?', [keyless.id]), 0, 'the keyless device is gone');
    assert.equal((await oldTab('GET', '/auth/me')).user.id, ids.alex, 'nobody is signed out');
    const merged = await deviceOf(oldTab);
    assert.deepEqual([merged.id, merged.current, merged.notifications], [alexLaptop.id, true, true]);
    assert.deepEqual((await rows("SELECT device_id FROM push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/old-tab'")).map(row => row.device_id), [alexLaptop.id]);
    // Naming the key again changes nothing; two tabs sending it at once end on one device.
    const [first, again] = await Promise.all([oldTab('POST', '/devices/current/key', { key: laptopKey }), oldTab('POST', '/devices/current/key', { key: laptopKey })]);
    assert.deepEqual([first, again], [{ device_id: alexLaptop.id, merged: false }, { device_id: alexLaptop.id, merged: false }]);
    // A keyless device that names a key nobody has keeps its id and takes the key.
    const script = client(agents.tablet);
    await script.signIn('blair@example.test');
    const blairTablet = await deviceOf(script);
    const tabletKey = newKey();
    assert.deepEqual(await script('POST', '/devices/current/key', { key: tabletKey }), { device_id: blairTablet.id, merged: false });
    const blairTabletAgain = client(agents.tablet);
    await blairTabletAgain.signIn('blair@example.test', { key: tabletKey, kind: 'web' });
    assert.equal((await deviceOf(blairTabletAgain)).id, blairTablet.id);
    // A key is matched per person only: blair naming alex's phone key gets no part of alex's phone.
    assert.deepEqual(await blairTabletAgain('POST', '/devices/current/key', { key: phoneKey }), { device_id: blairTablet.id, merged: false });
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?', [alexPhone.id]), 1);
    await blairTabletAgain('POST', '/auth/signout', {});
    await script('POST', '/auth/signout', {});

    // --- A session no 0.29 writer made still works and gets a device --------
    const legacyToken = runtime('auth').generateToken(ids.casey);
    const legacySession = crypto.randomUUID();
    await pool.execute('INSERT INTO sessions (id, user_id, token, expires_at, user_agent) VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY, ?)',
      [legacySession, ids.casey, runtime('services/sessions').sessionKey(legacyToken), agents.phone]);
    const legacy = await fetch(`${base}/api/devices/current`, { headers: { Cookie: `auth-token=${legacyToken}` } });
    assert.equal(legacy.status, 200);
    const legacyDevice = (await legacy.json()).device;
    assert.equal((await rows('SELECT device_id FROM sessions WHERE id = ?', [legacySession]))[0].device_id, legacyDevice.id);
    assert.equal(legacyDevice.kind, 'android');

    // --- One push channel per device and transport --------------------------
    // The push service rotated the browser's endpoint: the new one replaces the old.
    await laptop('POST', '/notifications/subscription', { subscription: webSubscription('laptop-rotated') });
    assert.deepEqual((await rows("SELECT endpoint FROM push_subscriptions WHERE device_id = ? AND transport = 'webpush'", [alexLaptop.id])).map(row => row.endpoint),
      ['https://fcm.googleapis.com/fcm/send/laptop-rotated']);
    // The app registers again without naming its old registration: still one.
    const phoneKeys = () => ({ keys: webKeys() });
    const lost = await phone('POST', '/notifications/android/devices', phoneKeys());
    const registration = await phone('POST', '/notifications/android/devices', phoneKeys());
    assert.deepEqual((await rows("SELECT id FROM push_subscriptions WHERE device_id = ? AND transport = 'android'", [alexPhone.id])).map(row => row.id), [registration.device]);
    assert.equal(await count('SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = ?', [lost.device]), 0);
    // A browser channel on the phone's device stays beside its app channel.
    await phone('POST', '/notifications/subscription', { subscription: webSubscription('phone-browser') });
    assert.equal(await count('SELECT COUNT(*) AS n FROM push_subscriptions WHERE device_id = ?', [alexPhone.id]), 2);
    // Another person's endpoint is never taken over.
    const foreign = await blairLaptop('POST', '/notifications/subscription', { subscription: webSubscription('phone-browser') }, 400);
    assert.equal(foreign.code, 'NOTIFICATION_DEVICE_FOREIGN');

    // --- The person's devices, and nobody else's -----------------------------
    const alexList = (await laptop('GET', '/devices')).devices;
    assert.deepEqual(alexList.map((device: FixtureValue) => [device.id, device.current]), [[alexLaptop.id, true], [alexPhone.id, false]], 'the current device first');
    assert.equal(alexList.find((device: FixtureValue) => device.id === alexPhone.id).notifications, true);
    assert.deepEqual((await phone('GET', '/devices')).devices.map((device: FixtureValue) => [device.id, device.current]), [[alexPhone.id, true], [alexLaptop.id, false]]);
    const everyone = new Map<string, string[]>();
    for (const [name, person] of [['alex', laptop], ['blair', blairLaptop], ['casey', casey]] as const) everyone.set(name, (await person('GET', '/devices')).devices.map((device: FixtureValue) => device.id));
    const owners = await rows('SELECT id, user_id FROM devices');
    for (const [name, listed] of everyone) {
      for (const id of listed) assert.equal(owners.find(row => row.id === id)?.user_id, ids[name], `${name} lists only their own devices`);
    }
    assert.ok(!everyone.get('blair')!.includes(blairTablet.id), 'a signed-out device is no longer listed');

    // --- Removing a device ----------------------------------------------------
    const before = await rows('SELECT id, user_id FROM devices ORDER BY id');
    for (const [person, id] of [[laptop, blairDevice.id], [casey, alexPhone.id], [blairLaptop, alexLaptop.id], [laptop, crypto.randomUUID()], [laptop, 'not-a-device']] as const) {
      const refused = await person('DELETE', `/devices/${id}`, undefined, 404);
      assert.equal(refused.code, 'DEVICE_NOT_FOUND');
    }
    assert.equal((await laptop('DELETE', `/devices/${alexLaptop.id}`, undefined, 400)).code, 'DEVICE_CURRENT');
    assert.equal((await laptop('DELETE', `/devices/${alexLaptop.id.toUpperCase()}`, undefined, 400)).code, 'DEVICE_CURRENT', 'an id in capitals is the same device');
    assert.deepEqual(await rows('SELECT id, user_id FROM devices ORDER BY id'), before, 'a refused removal changes nothing');
    assert.equal((await blairLaptop('GET', '/auth/me')).user.id, ids.blair);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.removed'"), 0);

    // alex signs the phone out from the laptop: its sessions, push channels,
    // pending deliveries and live streams end at once.
    await notifications.enqueueEvent({ userId: ids.alex, dedupeKey: 'test:before-removal', kind: 'test', title: 'Test', url: '/settings', expiresAt: new Date(Date.now() + 3600000) });
    const phoneChannels = (await rows('SELECT id FROM push_subscriptions WHERE device_id = ?', [alexPhone.id])).map(row => row.id);
    assert.ok(await count(`SELECT COUNT(*) AS n FROM notification_deliveries WHERE subscription_id IN (${phoneChannels.map(() => '?').join(', ')})`, phoneChannels) > 0);
    const appStream = await phone.stream(`/notifications/android/stream?device=${registration.device}`);
    const pageStream = await phone.stream('/events');
    const laptopStream = await laptop.stream('/events');
    assert.deepEqual([appStream.status, pageStream.status, laptopStream.status], [200, 200, 200]);
    assert.deepEqual(await laptop('DELETE', `/devices/${alexPhone.id}`), { removed: true });
    assert.ok(await appStream.until(() => appStream.ended), 'the app\'s stream closes at once');
    assert.ok(await pageStream.until(() => pageStream.ended), 'the page\'s stream closes at once');
    for (const stream of [appStream, pageStream]) assert.equal(stream.frames.find((frame: FixtureValue) => frame.type === 'end')?.data.reason, 'signed_out');
    assert.equal(laptopStream.ended, false, 'the remover\'s own stream stays open');
    assert.equal((await phone('GET', '/auth/me', undefined, 401)).error, 'Unauthorized');
    assert.equal(await count('SELECT COUNT(*) AS n FROM devices WHERE id = ?', [alexPhone.id]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?', [alexPhone.id]), 0);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE id IN (${phoneChannels.map(() => '?').join(', ')})`, phoneChannels), 0);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM notification_deliveries WHERE subscription_id IN (${phoneChannels.map(() => '?').join(', ')})`, phoneChannels), 0);
    const [audit] = await rows("SELECT actor_id, target_user_id, details FROM audit_log WHERE action = 'device.removed'");
    assert.deepEqual([audit.actor_id, audit.target_user_id], [ids.alex, ids.alex]);
    assert.deepEqual(typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details, { device: alexPhone.id, kind: 'android', sessions: 1 });
    assert.deepEqual((await laptop('GET', '/devices')).devices.map((device: FixtureValue) => device.id), [alexLaptop.id]);
    assert.equal((await laptop('GET', '/auth/me')).user.id, ids.alex);
    // Removal cannot be undone from the phone: its key no longer matches, so its next sign-in is a new device.
    const phoneAgain = client(agents.phone);
    await phoneAgain.signIn('alex@example.test', { key: phoneKey, kind: 'web' });
    const newPhone = await deviceOf(phoneAgain);
    assert.notEqual(newPhone.id, alexPhone.id);
    await laptop('DELETE', `/devices/${alexPhone.id}`, undefined, 404);

    // --- Lock reports, lock state and the device's settings ----------------
    const current = await laptop('GET', '/devices/current');
    assert.deepEqual(current.settings, {
      app_lock_scope: { value: [], source: 'default', locked: false },
      app_lock_relock_after: { value: '60', source: 'default', locked: false },
      app_lock_on_device_lock: { value: true, source: 'default', locked: false },
    });
    assert.deepEqual([current.compliance, current.policy], [{ meets: true, required: [], max_background: null, reason: null }, { screenshots: 'allowed' }]);
    const capabilities = { lock: 'biometric', secure_window: true, recents_hidden: true, device_lock_signal: true };
    for (const report of [{ capabilities }, { applied: { scope: ['notes'], relock_after: '60', on_device_lock: true, method: 'pin' }, capabilities },
      { applied: { scope: ['mail'], relock_after: '120', on_device_lock: true, method: 'pin' }, capabilities }, { applied: null, capabilities: { ...capabilities, lock: 'face' } },
      { applied: JSON.stringify({ scope: ['mail'], relock_after: '60', on_device_lock: true, method: 'pin' }), capabilities }]) {
      assert.equal((await laptop('PUT', '/devices/current/lock', report, 400)).code, 'DEVICE_LOCK_INVALID', JSON.stringify(report));
    }
    const reported = await laptop('PUT', '/devices/current/lock', { applied: { scope: ['mail', 'app'], relock_after: '900', on_device_lock: false, method: 'pin' }, capabilities });
    assert.deepEqual(reported.device.lock, { scope: ['app'], method: 'pin' }, 'the whole app stands alone');
    const [lockRow] = await rows('SELECT lock_applied, capabilities, lock_reported_at FROM devices WHERE id = ?', [alexLaptop.id]);
    assert.deepEqual(typeof lockRow.capabilities === 'string' ? JSON.parse(lockRow.capabilities) : lockRow.capabilities, capabilities);
    assert.ok(lockRow.lock_reported_at);
    // The device's settings are its own: another device of the same person keeps the defaults.
    assert.equal((await laptop('PUT', '/settings/values/device', { values: { app_lock_relock_after: '300' } })).device_id, alexLaptop.id);
    assert.deepEqual((await phoneAgain('GET', '/settings/values/device')).settings.app_lock_relock_after, { value: '60', source: 'default', locked: false });
    assert.equal((await phoneAgain('GET', '/settings/values/device')).device_id, newPhone.id);
    // Open counts for the shorter of the reported lock and the settings, plus the heartbeat's grace; background for that time; locked ends it.
    const openFor = async (state: string) => {
      const { open_until } = await laptop('POST', '/devices/current/lock-state', { state });
      return Math.round((new Date(open_until).getTime() - Date.now()) / 1000);
    };
    assert.ok(Math.abs(await openFor('open') - 390) <= 3);
    assert.ok(Math.abs(await openFor('background') - 300) <= 3);
    assert.ok(Math.abs(await openFor('locked')) <= 3);
    assert.equal((await laptop('POST', '/devices/current/lock-state', { state: 'unlocked' }, 400)).code, 'DEVICE_LOCK_STATE_INVALID');
    assert.equal(await count('SELECT COUNT(*) AS n FROM devices WHERE open_until IS NOT NULL AND id <> ?', [alexLaptop.id]), 0, 'a report reaches only the device of the session');
    // Under a required lock, a device meets it only with a report that covers it, and a weaker setting is refused.
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value) VALUES ('installation', '', 'policy.app_lock.required', '[\"mail\"]')");
    assert.equal((await laptop('GET', '/devices/current')).compliance.meets, true, 'a lock of the whole app covers Mail');
    const short = (await phoneAgain('GET', '/devices/current')).compliance;
    assert.deepEqual([short.meets, short.required], [false, ['mail']]);
    assert.ok(short.reason);
    assert.equal((await phoneAgain('PUT', '/settings/values/device', { values: { app_lock_scope: [] } }, 403)).code, 'POLICY_FLOOR');
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'policy.app_lock.required'");
    // Reporting no lock clears it.
    assert.equal((await laptop('PUT', '/devices/current/lock', { applied: null, capabilities })).device.lock, null);

    // --- Last use -------------------------------------------------------------
    // A request through the boundary records the device's use, at most every 5 minutes.
    const seen = async (id: string) => new Date(`${(await rows("SELECT DATE_FORMAT(last_seen_at, '%Y-%m-%dT%H:%i:%sZ') AS at FROM devices WHERE id = ?", [id]))[0].at}`).getTime();
    const fresh = client(agents.tablet);
    const freshKey = newKey();
    const step = await fresh('POST', '/auth/signin', { email: 'casey@example.test', password });
    await fresh('POST', '/auth/2fa/login', { challenge_token: step.challengeToken, code: totp(), device: { key: freshKey, kind: 'web' } });
    const freshId = (await rows('SELECT id FROM devices WHERE user_id = ? AND key_hash = ?', [ids.casey, devices.deviceKeyHash(freshKey)]))[0].id;
    await pool.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE id = ?', [freshId]);
    assert.equal((await fresh('GET', '/devices/current')).device.id, freshId);
    assert.ok(Date.now() - await seen(freshId) < 60000, 'the use is recorded');
    await pool.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE id = ?', [freshId]);
    await fresh('GET', '/devices/current');
    assert.ok(Date.now() - await seen(freshId) > 86400000, 'not again within 5 minutes');

    // --- Clean-up -------------------------------------------------------------
    // A device without a session goes after 30 days unused; one with a session, or used lately, stays.
    const idle = client(agents.tablet), recent = client(agents.tablet);
    await idle.signIn('blair@example.test', { key: newKey(), kind: 'web' });
    const idleId = (await deviceOf(idle)).id;
    await idle('POST', '/auth/signout', {});
    await recent.signIn('blair@example.test', { key: newKey(), kind: 'web' });
    const recentId = (await deviceOf(recent)).id;
    await recent('POST', '/auth/signout', {});
    await pool.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE id IN (?, ?)', [idleId, blairDevice.id]);
    await pool.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 10 DAY WHERE id = ?', [recentId]);
    const kept = await rows('SELECT id FROM devices WHERE id <> ? ORDER BY id', [idleId]);
    assert.equal(await devices.pruneIdleDevices(), 1);
    assert.deepEqual(await rows('SELECT id FROM devices ORDER BY id'), kept, 'only the idle device without a session went');
    assert.equal((await blairLaptop('GET', '/auth/me')).user.id, ids.blair, 'a signed-in device is never cleaned up');

    // --- A personal restore brings no device back -----------------------------
    const backupKept = await rows('SELECT id, user_id, key_hash FROM devices ORDER BY id');
    const sessionsKept = await rows('SELECT id, device_id FROM sessions ORDER BY id');
    const wait = async (route: string, ...statuses: string[]) => {
      const deadline = Date.now() + 30000;
      let last: FixtureValue = null;
      while (Date.now() < deadline) {
        const { job } = await laptop('GET', route);
        assert.notEqual(job.status, 'failed', job.error);
        if (statuses.includes(job.status)) return job;
        last = job;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(`${route} never reached ${statuses.join(' or ')}: ${JSON.stringify(last)}`);
    };
    // The backup is taken while a second device exists, which is then removed.
    const tablet = client(agents.tablet);
    await tablet.signIn('alex@example.test', { key: newKey(), kind: 'web' });
    const tabletId = (await deviceOf(tablet)).id;
    const created = await laptop('POST', '/backup/jobs', { sections: ['settings'], encrypt: true }, 202);
    await wait(`/backup/jobs/${created.job.id}`, 'ready');
    const { recovery_password } = await laptop('POST', `/backup/jobs/${created.job.id}/recovery-password/reveal`, {});
    const archive = await laptop('GET', `/backup/jobs/${created.job.id}/download`);
    assert.ok(Buffer.isBuffer(archive) && archive.length > 0);
    await laptop('DELETE', `/devices/${tabletId}`);
    const imported = await laptop('POST', '/backup/import?sections=settings&conflict_mode=replace', archive, 202);
    // This installation's own backup may open without its recovery password.
    if ((await wait(`/backup/restore-jobs/${imported.job.id}`, 'awaiting_password', 'validated')).status === 'awaiting_password') {
      await laptop('POST', `/backup/restore-jobs/${imported.job.id}/unlock`, { password: recovery_password }, 202);
      await wait(`/backup/restore-jobs/${imported.job.id}`, 'validated');
    }
    await laptop('POST', `/backup/restore-jobs/${imported.job.id}/start`, {}, 202);
    await wait(`/backup/restore-jobs/${imported.job.id}`, 'completed');
    assert.deepEqual(await rows('SELECT id, user_id, key_hash FROM devices ORDER BY id'), backupKept, 'the removed device stays removed and the others are untouched');
    assert.deepEqual((await rows('SELECT id, device_id FROM sessions ORDER BY id')).filter(row => row.device_id !== tabletId), sessionsKept, 'no session comes back or moves');
    assert.equal(await count('SELECT COUNT(*) AS n FROM devices WHERE id = ?', [tabletId]), 0);
    assert.equal((await laptop('GET', '/settings/values/device')).settings.app_lock_relock_after.value, '300', 'the device\'s own settings are not part of a personal backup');
    assert.equal((await tablet('GET', '/auth/me', undefined, 401)).error, 'Unauthorized');

    // --- Deleting a person removes their devices -----------------------------
    assert.ok(await count('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [ids.dana]) > 0);
    await pool.execute('DELETE FROM users WHERE id = ?', [ids.dana]);
    assert.equal(await count('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [ids.dana]), 0);
  } finally {
    for (const stream of streams) stream.close();
    runtime?.('services/android-push').closeAndroidStreams();
    runtime?.('services/server-events').serverEvents?.closeAll?.({ reason: 'shutdown' });
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) {
      const connection = await pool.getConnection();
      try {
        await connection.query('SET FOREIGN_KEY_CHECKS=0');
        const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
        for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]);
      } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); }
    }
    await pool.end();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
