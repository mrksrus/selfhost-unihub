// The device read helpers (services/devices.ts, F5) the request boundary and
// the notification stage share: what a user agent says about the device,
// which reported lock the server takes, and whether a device falls short of
// the app lock the person's policies require. The SQL is in the
// *-mysql-integration tests.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { deviceFromUserAgent, parseLockApplied, lockCovers, appLockShortfall } = require('../dist/src/services/devices') as typeof import('../src/services/devices');

test('a user agent names the Android app with its version and bridge level; anything else is a browser', () => {
  assert.deepEqual(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile Safari/537.36 UniHubAndroid/0.29.0 (29000) UniHubBridge/3'),
    { kind: 'android', app_version: '0.29.0', bridge_level: 3 });
  assert.deepEqual(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14) UniHubAndroid/0.24.3 (24003)'), { kind: 'android', app_version: '0.24.3', bridge_level: 1 },
    'an app before bridge levels counts as level 1');
  for (const agent of ['Mozilla/5.0 (X11; Linux x86_64) Firefox/144.0', '', null, undefined, 'UniHubAndroid/', 'UniHubAndroid/0.29.0']) {
    assert.deepEqual(deviceFromUserAgent(agent), { kind: 'web', app_version: null, bridge_level: null }, String(agent));
  }
});

test('a reported lock is taken only in the shape the server accepts', () => {
  const lock = { scope: ['mail', 'contacts'], relock_after: '300', on_device_lock: true, method: 'biometric' };
  assert.deepEqual(parseLockApplied(JSON.stringify(lock)), lock);
  assert.deepEqual(parseLockApplied(lock), lock);
  for (const broken of [null, '', 'not json', '[]', { ...lock, scope: ['notes'] }, { ...lock, relock_after: '120' }, { ...lock, method: 'face' },
    { ...lock, on_device_lock: 'yes' }, { ...lock, scope: 'mail' }]) {
    assert.equal(parseLockApplied(typeof broken === 'object' && broken ? JSON.stringify(broken) : broken), null, JSON.stringify(broken));
  }
});

test('a device falls short only of a required area it does not lock, or of the maximum time while an area is required', () => {
  const lock = (scope: ('app' | 'mail' | 'contacts' | 'calendar' | 'recordings')[], relock_after: '0' | '60' | '300' | '900' = '60') =>
    ({ scope, relock_after, on_device_lock: true, method: 'pin' as const });
  const nothing = { required: [], max_background: null };
  assert.equal(appLockShortfall(null, nothing), false, 'nothing required');
  assert.equal(appLockShortfall(null, { required: [], max_background: '300' }), false, 'a maximum alone requires no lock');
  const mail = { required: ['mail' as const], max_background: '300' as const };
  assert.equal(appLockShortfall(null, mail), true, 'no lock reported');
  assert.equal(appLockShortfall(lock([]), mail), true);
  assert.equal(appLockShortfall(lock(['contacts']), mail), true);
  assert.equal(appLockShortfall(lock(['mail', 'contacts']), mail), false);
  assert.equal(appLockShortfall(lock(['app']), mail), false, 'the whole app covers Mail');
  assert.equal(appLockShortfall(lock(['mail'], '900'), mail), true, 'waits longer than allowed');
  assert.equal(appLockShortfall(lock(['mail'], '0'), mail), false);
  assert.equal(appLockShortfall(lock(['mail', 'contacts']), { required: ['app'], max_background: null }), true, 'modules do not cover the whole app');
  assert.equal(lockCovers(lock(['app']), 'recordings'), true);
  assert.equal(lockCovers(lock(['mail']), 'calendar'), false);
  assert.equal(lockCovers(null, 'mail'), false);
});
