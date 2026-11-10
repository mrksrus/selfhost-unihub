// 0.29.0 app lock in the Android app, as a person uses it: Settings → App lock
// (stream E's screens), the page's lock screen and the phone's own prompt
// (AppLock, BiometricAuth). The native rules alone are in
// app-lock-bridge.test.mjs.
//
// The phone gets a PIN and an enrolled fingerprint for this file and loses
// both at the end, so the other files run without a screen lock.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE, adb, answerPromptWithPin, clearDevicePin, enrollFingerprint, lockCoverShown, openApp, setDevicePin, sleep, sleepScreen,
  touch, touchFinger, unlockKeyguard, unlockPromptShown, waitForUnlockPrompt,
} from '../support/android.mjs';

// The screens' words (docs/UI_ACCEPTANCE.md L-01 to L-07).
const LABELS = {
  section: 'App lock',
  wholeApp: 'Whole app',
  off: 'Off',
  askAgain: 'Ask again',
  everyTime: 'Every time UniHub opens',
  oneMinute: 'After 1 minute in the background',
  fifteenMinutes: 'After 15 minutes in the background',
  onDeviceLock: 'Also when the phone is locked',
  locked: 'UniHub is locked',
  unlock: 'Unlock',
};

before(async () => {
  setDevicePin();
  await enrollFingerprint();
});

after(() => {
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', `run-as ${PACKAGE} rm -f shared_prefs/app_lock.xml`);
  clearDevicePin();
});

const lockScreen = page => page.getByText(LABELS.locked, { exact: true });

/** Leaves the app for the launcher, waits, and opens it again (no new process). */
async function leaveAndReturn(awayMs) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(awayMs);
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await sleep(2500);
}

/** The lock screen asks by itself once it shows; a finger opens UniHub. */
async function unlockWithFinger(page) {
  await lockScreen(page).waitFor();
  if (!unlockPromptShown()) await touch(page, page.getByRole('button', { name: LABELS.unlock }));
  await waitForUnlockPrompt();
  await touchFinger(1);
  await lockScreen(page).waitFor({ state: 'hidden' });
}

async function openSettings(page) {
  await page.goto(new URL('/settings?section=app-lock', page.url()).href);
  await page.getByRole('heading', { name: LABELS.section }).first().waitFor();
}

/** Settings → App lock: the whole app, asked again as given; turning it on confirms with the finger. */
async function turnOnWholeApp(page, { askAgain = LABELS.everyTime, onDeviceLock = true } = {}) {
  await openSettings(page);
  const whole = page.getByRole('radio', { name: LABELS.wholeApp });
  if (!await whole.isChecked()) {
    await touch(page, whole);
    await waitForUnlockPrompt();
    await touchFinger(1);
    for (let i = 0; i < 30 && !await whole.isChecked(); i++) await sleep(1000);
    assert.equal(await whole.isChecked(), true, 'the lock is on after the finger confirmed it');
  }
  // A native select or the ui/select combobox.
  await page.getByLabel(LABELS.askAgain).selectOption({ label: askAgain }, { timeout: 5000 }).catch(async () => {
    await touch(page, page.getByRole('combobox', { name: LABELS.askAgain }));
    await touch(page, page.getByRole('option', { name: askAgain }));
  });
  const deviceLock = page.getByRole('switch', { name: LABELS.onDeviceLock });
  if (await deviceLock.isChecked() !== onDeviceLock) await touch(page, deviceLock);
}

/** Settings → App lock → Off; weakening asks for the unlock first. */
async function turnOff(page) {
  await openSettings(page);
  const off = page.getByRole('radio', { name: LABELS.off });
  if (await off.isChecked()) return;
  await touch(page, off);
  await waitForUnlockPrompt();
  await touchFinger(1);
}

/** The app, signed in, with an earlier test's lock already answered. */
async function openOpen() {
  const opened = await openApp();
  if (await lockScreen(opened.page).isVisible().catch(() => false) || lockCoverShown()) await unlockWithFinger(opened.page);
  return opened;
}

test('the whole-app lock asks every time UniHub opens; an unknown finger does not open it, finger 1 and the phone\'s PIN do', { timeout: 900_000 }, async () => {
  const { device, page } = await openOpen();
  try {
    await turnOnWholeApp(page, { askAgain: LABELS.everyTime });
    await leaveAndReturn(2000);
    await lockScreen(page).waitFor();
    await waitForUnlockPrompt();
    await touchFinger(2);
    await sleep(3000);
    assert.equal(await lockScreen(page).isVisible(), true, 'still locked after an unknown finger');
    await touchFinger(1);
    await lockScreen(page).waitFor({ state: 'hidden' });

    await leaveAndReturn(2000);
    await lockScreen(page).waitFor();
    await waitForUnlockPrompt();
    await answerPromptWithPin();
    await lockScreen(page).waitFor({ state: 'hidden' });
  } finally {
    await device.close();
  }
});

test('with one minute, back within 30 s is open and after 70 s locked; a cold start asks', { timeout: 900_000 }, async () => {
  let { device, page } = await openOpen();
  try {
    await turnOnWholeApp(page, { askAgain: LABELS.oneMinute });
    await leaveAndReturn(20_000);
    assert.equal(await lockScreen(page).isVisible(), false, 'back after 20 s');
    await leaveAndReturn(70_000);
    await unlockWithFinger(page);
  } finally {
    await device.close();
  }
  adb('shell', 'am', 'force-stop', PACKAGE);
  ({ device, page } = await openApp());
  try {
    await unlockWithFinger(page);
  } finally {
    await device.close();
  }
});

test('"Also when the phone is locked" asks after the phone locked; the file picker does not', { timeout: 900_000 }, async () => {
  const { device, page } = await openOpen();
  try {
    await turnOnWholeApp(page, { askAgain: LABELS.fifteenMinutes, onDeviceLock: true });
    await sleepScreen();
    await unlockKeyguard();
    await unlockWithFinger(page);

    await turnOnWholeApp(page, { askAgain: LABELS.everyTime });
    await page.evaluate(() => {
      const input = Object.assign(document.createElement('input'), { type: 'file', id: 'app-lock-picker' });
      Object.assign(input.style, { position: 'fixed', top: '40%', left: '10%', width: '80%', height: '80px', zIndex: '99999' });
      document.body.append(input);
    });
    await touch(page, page.locator('#app-lock-picker'));
    await sleep(5000);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(3000);
    assert.equal(await lockScreen(page).isVisible(), false, 'back from the picker without the lock');
    await page.evaluate(() => document.getElementById('app-lock-picker')?.remove());
    await turnOff(page);
  } finally {
    await device.close();
  }
});
