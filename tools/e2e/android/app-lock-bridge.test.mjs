// 0.29.0 app lock, the app's own part (bridge level 3, AppLock): what the
// page asks of the app through the `appLock` message, sent here straight from
// the test as src/lib/platform.ts sends it. The page's lock screens and
// settings are covered by app-lock.test.mjs; this file proves the native
// timing, cover, unlock and window rules on their own.
//
// The phone gets a PIN and an enrolled fingerprint for this file and loses
// both at the end, so the other files run without a screen lock.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE, adb, answerPromptWithPin, appLockMessage, bridgeMessage, dismissFirstRunOffers, enrollFingerprint, lockCoverShown, openApp, resetAppLock, screenShare,
  setDevicePin, shownNotifications, sleep, sleepScreen, stackSession, touch, touchFinger, unlockKeyguard, unlockPromptShown, waitForUnlockPrompt, windowIsSecure,
} from '../support/android.mjs';

const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const MINUTE = 60_000;

// Whatever an earlier file or test left, and nothing for the next file.
before(async () => {
  await resetAppLock();
  setDevicePin();
  await enrollFingerprint();
});

after(resetAppLock);

/** Leaves the app for the launcher, waits, and opens it again (no new process). */
async function leaveAndReturn(awayMs) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(awayMs);
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await sleep(2500);
}

async function state(page) {
  const reply = await appLockMessage(page, 'state');
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
}

/** Starts `authenticate` and returns its pending reply. */
function authenticate(page) {
  return appLockMessage(page, 'authenticate', { reason: 'Test unlock' }, { timeoutMs: 120_000 });
}

/** Unlocks with finger 1, as the page's Unlock button would, and lets the page show itself. */
async function unlockWithFinger(page) {
  const pending = authenticate(page);
  await waitForUnlockPrompt();
  await touchFinger(1);
  const reply = await pending;
  assert.equal(reply.result, 'ok', JSON.stringify(reply));
  await appLockMessage(page, 'release', { unlocked: true });
}

/**
 * The app, signed in and unlocked: openApp force-stops it, and a new process
 * with the lock on starts locked (an earlier test's configuration).
 */
async function openUnlocked() {
  const opened = await openApp();
  if ((await state(opened.page)).due) {
    await appLockMessage(opened.page, 'release');
    await unlockWithFinger(opened.page);
    // The app's own questions waited for the cover.
    await dismissFirstRunOffers({ waitMs: 3000 });
  }
  return opened;
}

async function configure(page, fields) {
  const reply = await appLockMessage(page, 'configure', { scope: ['app'], relockAfterMs: MINUTE, onDeviceLock: true, blockScreenshots: false, ...fields });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
}

test('the app reports the phone\'s unlock, and with "every time" a return locks behind the cover until a finger unlocks', { timeout: 900_000 }, async () => {
  const { device, page } = await openUnlocked();
  try {
    const method = await appLockMessage(page, 'method');
    assert.deepEqual({ method: method.method, biometric: method.biometric, deviceSecure: method.deviceSecure },
      { method: 'biometric', biometric: 'available', deviceSecure: true });
    assert.deepEqual(method.capabilities, { secureWindow: true, hideRecents: sdk >= 33, deviceLockSignal: true });

    // Turning the lock on does not lock: the person has just confirmed it.
    await configure(page, { relockAfterMs: 0 });
    assert.equal((await state(page)).due, false);
    assert.equal(lockCoverShown(), false);

    await leaveAndReturn(2000);
    assert.equal(lockCoverShown(), true, 'the cover hides the page');
    const locked = await state(page);
    assert.equal(locked.due, true);
    assert.equal(locked.covered, true);
    // Measured from the activity stopping, which a slow emulator does a moment after Home.
    assert.ok(locked.hiddenForMs > 0 && locked.hiddenForMs < 60_000, JSON.stringify(locked));
    assert.deepEqual(await page.evaluate(() => window.__appLockEvents), ['locked'], 'the page hears that the app locked');

    // The page shows its lock screen, then asks for the unlock.
    await appLockMessage(page, 'release');
    assert.equal(lockCoverShown(), false);
    assert.equal((await state(page)).due, true, 'released for the lock screen, still locked');

    // A finger the phone does not know: the prompt stays, nothing unlocks.
    const pending = authenticate(page);
    await waitForUnlockPrompt();
    await touchFinger(2);
    await sleep(3000);
    assert.equal(unlockPromptShown(), true, 'the prompt stays after an unknown finger');
    assert.equal((await state(page)).due, true);
    await touchFinger(1);
    assert.equal((await pending).result, 'ok');
    const open = await state(page);
    assert.equal(open.due, false);
    assert.equal(open.freshProcess, false);
    assert.ok(Math.abs(open.authenticatedAt - Date.now()) < 60_000, `authenticatedAt is the phone's wall clock: ${open.authenticatedAt}`);

    // The phone's PIN through "Use PIN".
    await leaveAndReturn(1000);
    assert.equal((await state(page)).due, true);
    await appLockMessage(page, 'release');
    const byPin = authenticate(page);
    await waitForUnlockPrompt();
    await answerPromptWithPin();
    assert.equal((await byPin).result, 'ok');

    // Back closes the prompt: cancelled, still locked.
    await leaveAndReturn(1000);
    await appLockMessage(page, 'release');
    const cancelled = authenticate(page);
    await waitForUnlockPrompt();
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    assert.equal((await cancelled).result, 'cancelled');
    assert.equal((await state(page)).due, true);
    await unlockWithFinger(page);
  } finally {
    await device.close();
  }
});

test('with one minute, a return within it does not ask and one after 70 s does; a cold start always asks', { timeout: 900_000 }, async () => {
  const { device, page } = await openUnlocked();
  try {
    await configure(page, { relockAfterMs: MINUTE });
    await leaveAndReturn(10_000);
    assert.equal(lockCoverShown(), false);
    assert.equal((await state(page)).due, false, 'back after 10 s');
    // The app measures with the monotonic clock, so this needs real waiting.
    await leaveAndReturn(70_000);
    assert.equal(lockCoverShown(), true);
    assert.equal((await state(page)).due, true, 'back after 70 s');
    await appLockMessage(page, 'release');
    await unlockWithFinger(page);
    // The page configures the app after an unlock with its own settings (no
    // lock on this device): this test's configuration is the last one again.
    await sleep(3000);
    await configure(page, { relockAfterMs: MINUTE });
  } finally {
    await device.close();
  }

  // Force-stopped: a new process covers the page before it loads. The debug
  // app logs when its cover goes up and down and when the page's content
  // first becomes visible; Android logs the activity's first drawn frame
  // ("Displayed"). The cover must be up before that frame and stay up until
  // the page shows content. A look at the screen cannot prove this: the page
  // configures the app with its own settings as soon as it loads (here no
  // lock, since this test configured the app directly), which lifts the cover
  // within a second, about as long as a view dump takes. The cover goes up
  // at the start only when the new process is locked; what the page then
  // asks with its own settings is app-lock.test.mjs's [29-04].
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
  const order = () => adb('logcat', '-d', '-s', 'UniHubLock:I', 'ActivityTaskManager:I').split('\n')
    .map(line => line.includes(`Displayed ${PACKAGE}/`) ? 'first frame' : /cover up|cover down|page visible/.exec(line)?.[0]).filter(Boolean);
  for (let tries = 0; tries < 60 && !order().includes('page visible'); tries++) await sleep(500);
  const events = order();
  const at = event => events.indexOf(event);
  const down = at('cover down');
  assert.ok(at('cover up') === 0 && at('first frame') > 0 && at('page visible') > 0 && (down < 0 || down > Math.max(at('first frame'), at('page visible'))),
    `the cover is up from the first frame until the page shows content: ${events.join(', ')}`);
});

test('the file picker is no time away; the screen turning off locks only when asked to', { timeout: 900_000 }, async () => {
  const { device, page } = await openUnlocked();
  try {
    await configure(page, { relockAfterMs: 0, onDeviceLock: true });
    // A file input the person taps, which opens Android's document picker.
    await page.evaluate(() => {
      const input = Object.assign(document.createElement('input'), { type: 'file', id: 'app-lock-picker' });
      Object.assign(input.style, { position: 'fixed', top: '40%', left: '10%', width: '80%', height: '80px', zIndex: '99999' });
      document.body.append(input);
    });
    await touch(page, page.locator('#app-lock-picker'));
    let picker = false;
    for (let i = 0; i < 30 && !picker; i++) {
      picker = /documentsui/i.test(adb('shell', 'dumpsys', 'window').match(/mCurrentFocus=.*$/m)?.[0] ?? '');
      if (!picker) await sleep(1000);
    }
    assert.ok(picker, 'the picker opened');
    await sleep(3000);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(2500);
    assert.equal(lockCoverShown(), false, 'back from the picker, with "every time"');
    assert.equal((await state(page)).due, false);
    await page.evaluate(() => document.getElementById('app-lock-picker')?.remove());

    // The phone locked and unlocked within 15 minutes: asks only with onDeviceLock.
    await configure(page, { relockAfterMs: 15 * MINUTE, onDeviceLock: false });
    await sleepScreen();
    await unlockKeyguard();
    await sleep(2000);
    const without = await state(page);
    assert.equal(without.due, false, JSON.stringify(without));
    assert.equal(without.deviceLockedSinceHidden, true);

    await configure(page, { relockAfterMs: 15 * MINUTE, onDeviceLock: true });
    await sleepScreen();
    await unlockKeyguard({ finger: 1 });
    await sleep(2000);
    assert.equal((await state(page)).due, true, 'asked after the phone was locked');
    assert.equal(lockCoverShown(), true);
    await appLockMessage(page, 'release');
    await unlockWithFinger(page);
  } finally {
    await device.close();
  }
});

test('[29-06] blocked screenshots make the window secure, also with the lock off; the recent-apps picture shows no page', { timeout: 900_000 }, async () => {
  const { device, page } = await openUnlocked();
  // A full red layer over the page, so a screen capture shows at once whether the page was in it.
  const red = () => page.evaluate(() => {
    const layer = Object.assign(document.createElement('div'), { id: 'app-lock-red' });
    Object.assign(layer.style, { position: 'fixed', inset: '0', background: 'rgb(220, 20, 20)', zIndex: '99999' });
    document.body.append(layer);
  });
  try {
    await red();
    await configure(page, { scope: [], blockScreenshots: true });
    await sleep(1500);
    assert.equal(windowIsSecure(), true, 'FLAG_SECURE with the policy');
    const secure = screenShare([220, 20, 20]);
    assert.ok(secure.empty || (secure.share === 0 && secure.black > 0.95), `a black or refused capture: ${JSON.stringify(secure)}`);
    // Reset at once: FLAG_SECURE blanks the failure screenshots of what follows.
    await configure(page, { scope: [], blockScreenshots: false });
    await sleep(1500);
    assert.equal(windowIsSecure(), false);
    assert.ok(screenShare([220, 20, 20]).share > 0.8, 'the page is captured again');

    if (sdk >= 33) {
      await configure(page, { scope: [], blockScreenshots: false });
      adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      await sleep(2000);
      adb('shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH');
      await sleep(4000);
      const shown = screenShare([220, 20, 20]);
      adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      await leaveAndReturn(500);
      await configure(page, { relockAfterMs: 15 * MINUTE });
      adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      await sleep(2000);
      adb('shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH');
      await sleep(4000);
      const hidden = screenShare([220, 20, 20]);
      adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      assert.ok(shown.share > 0.05, `without the lock the recent-apps card shows the page: ${JSON.stringify(shown)}`);
      assert.equal(hidden.share, 0, `with the lock it does not: ${JSON.stringify(hidden)}`);
      await leaveAndReturn(500);
      if ((await state(page)).due) {
        await appLockMessage(page, 'release');
        await unlockWithFinger(page);
      }
    }
  } finally {
    await page.evaluate(() => document.getElementById('app-lock-red')?.remove()).catch(() => {});
    await device.close();
  }
});

test('a notification of a locked app shows only its generic text; unlocked, its text', { timeout: 900_000 }, async () => {
  // Notifications on without Android's questions: allowed, and allowed in the background.
  if (sdk >= 33) adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
  const api = await stackSession();
  const { device, page } = await openUnlocked();
  /** Asks the server for its test notification ("UniHub notifications are working", no module) and waits for it on the phone. */
  async function testNotification(endpoint, arrived) {
    const sent = await api('POST', '/api/notifications/test', { endpoint });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    for (let i = 0; i < 60; i++) {
      // Not the connection's own ongoing notification.
      const shown = shownNotifications().filter(n => n.title !== '' && !/^Connected to/.test(n.title));
      if (shown.some(arrived)) return shown;
      await sleep(2000);
    }
    throw new Error(`no such notification arrived: ${JSON.stringify(shownNotifications())}`);
  }
  try {
    const enabled = await bridgeMessage(page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const endpoint = enabled.state.endpoint;

    // The whole app locked, the app in the background: what any notification may show.
    await configure(page, { scope: ['app'], relockAfterMs: 0 });
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    const locked = await testNotification(endpoint, () => true);
    assert.deepEqual(locked.map(n => n.title), ['New notification'], JSON.stringify(locked));
    assert.equal(locked.some(n => /working|through the server/.test(`${n.title} ${n.text}`)), false, 'no content while locked');

    // Unlocked and the lock off: the notification says what it is. The server sends one test per 30 s.
    await leaveAndReturn(500);
    if ((await state(page)).due) {
      await appLockMessage(page, 'release');
      await unlockWithFinger(page);
    }
    await configure(page, { scope: [] });
    await sleep(31_000);
    const open = await testNotification(endpoint, n => n.title === 'UniHub notifications are working');
    assert.ok(open.some(n => n.text === 'This notification was sent through the server to this device.'), JSON.stringify(open));
  } finally {
    await bridgeMessage(page, 'notifications', 'disable').catch(() => {});
    await device.close();
  }
});
