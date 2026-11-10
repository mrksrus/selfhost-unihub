// 0.29.0 app lock under the administrator's policies, in the Android app:
// - a required lock shows the "required" prompt, and turning it on opens Mail
// - blocked screenshots make the app's window secure
// - an app below bridge level 3 gets the page's PIN and the update hint, and
//   the phone's UniHub contacts stay while the device falls short
// Every policy change is acknowledged for all three people first (the rules
// notice is due for everyone).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE, adb, clearDevicePin, enrollFingerprint, navigate, openApp, screenNodes, screenShare, setDevicePin, sleep, stackSession, touch, touchFinger,
  waitForUnlockPrompt, windowIsSecure,
} from '../support/android.mjs';

const PEOPLE = ['admin@example.com', 'alex@example.com', 'blair@example.com'];
const PASSWORD = 'local-dev-admin-password';
const previousApk = process.env.UNIHUB_E2E_PREVIOUS_APK;
const repo = new URL('../../..', import.meta.url).pathname;
const candidateApk = process.env.UNIHUB_E2E_CANDIDATE_APK ?? `${repo}android/app/build/outputs/apk/debug/app-debug.apk`;
const OFF = { 'app_lock.required': [], 'app_lock.max_background': 'none', 'app_lock.screenshots': 'allowed' };

let sessions;

/** Sets installation policies as the administrator, then confirms the rules notice for all three people. */
async function setPolicies(values) {
  // The administrator's own device is held to the lock they require, the
  // policies route included: this session reports a whole-app lock, as a page
  // does once its lock is set up, so it can turn the rules off again.
  const reported = await sessions[0]('PUT', '/api/devices/current/lock', {
    applied: { scope: ['app'], relock_after: '0', on_device_lock: false, method: 'pin' },
    capabilities: { lock: 'pin', secure_window: false, recents_hidden: false, device_lock_signal: false },
  });
  assert.equal(reported.status, 200, JSON.stringify(reported.data));
  const saved = await sessions[0]('PUT', '/api/admin/policies', { values, current_password: PASSWORD });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  for (const api of sessions) {
    const { data } = await api('GET', '/api/policies/effective');
    if (data.acknowledged_revision < data.revision) await api('POST', '/api/policies/acknowledge', { revision: data.revision });
  }
}

before(async () => {
  sessions = await Promise.all(PEOPLE.map(email => stackSession(email, PASSWORD)));
  setDevicePin();
  await enrollFingerprint();
});

after(async () => {
  await setPolicies(OFF).catch(() => {});
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', `run-as ${PACKAGE} rm -f shared_prefs/app_lock.xml`);
  clearDevicePin();
});

test('[29-08] a required whole-app lock asks to turn it on; with the finger, Mail opens', { timeout: 900_000 }, async () => {
  await setPolicies({ ...OFF, 'app_lock.required': ['app'] });
  const { device, page } = await openApp();
  try {
    await page.getByText('Your administrator requires the app lock', { exact: true }).waitFor({ timeout: 60_000 });
    await touch(page, page.getByRole('button', { name: 'Turn on the app lock' }));
    await waitForUnlockPrompt();
    await touchFinger(1);
    await page.getByText('Your administrator requires the app lock', { exact: true }).waitFor({ state: 'hidden' });
    await navigate(page, '/mail');
    await page.getByRole('button', { name: 'Compose' }).filter({ visible: true }).first().waitFor({ timeout: 60_000 });
    // The server now takes the device's word that it locks: Mail answers.
    const inbox = await page.evaluate(async () => (await fetch('/api/mail/accounts', { credentials: 'include' })).status);
    assert.equal(inbox, 200);
  } finally {
    await device.close();
    await setPolicies(OFF);
  }
});

test('[29-12] blocked screenshots make the app\'s window secure, also without a lock; allowed again, it is not', { timeout: 600_000 }, async () => {
  await setPolicies({ ...OFF, 'app_lock.screenshots': 'forbidden' });
  let { device, page } = await openApp();
  try {
    for (let i = 0; i < 30 && !windowIsSecure(); i++) await sleep(1000);
    assert.equal(windowIsSecure(), true, 'FLAG_SECURE under the policy');
    const capture = screenShare([255, 255, 255]);
    assert.ok(capture.empty || capture.black > 0.95, `a black or refused capture: ${JSON.stringify(capture)}`);
  } finally {
    await device.close();
    // At once: FLAG_SECURE blanks the failure screenshots of what follows.
    await setPolicies(OFF);
  }
  ({ device, page } = await openApp());
  try {
    for (let i = 0; i < 30 && windowIsSecure(); i++) await sleep(1000);
    assert.equal(windowIsSecure(), false);
    assert.ok(await page.evaluate(() => document.title !== undefined));
  } finally {
    await device.close();
  }
});

test('an app without the native lock gets the page\'s PIN and the update hint; its phone contacts stay', { timeout: 1_200_000 }, async t => {
  if (!previousApk) { t.skip('UNIHUB_E2E_PREVIOUS_APK names no earlier app'); return; }
  adb('shell', `run-as ${PACKAGE} rm -f shared_prefs/app_lock.xml`);
  adb('install', '-r', '-d', previousApk);
  try {
    // Contacts on the phone first, while nothing is required.
    adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.READ_CONTACTS');
    adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.WRITE_CONTACTS');
    const rawContacts = () => (adb('shell', 'content', 'query', '--uri', 'content://com.android.contacts/raw_contacts', '--projection', '_id',
      '--where', `"account_type='${PACKAGE}' AND deleted=0"`).match(/^Row:/gm) ?? []).length;
    const { device } = await openApp();
    await device.close();
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`, '-a', `${PACKAGE}.SHOW_CONTACTS`);
    for (let i = 0; i < 60 && rawContacts() === 0; i++) {
      // Dialog buttons show in capitals on newer Android versions.
      const button = screenNodes().find(node => /^show contacts$/i.test(node.text));
      if (button) adb('shell', 'input', 'tap', `${button.x}`, `${button.y}`);
      adb('shell', 'requestsync', '-t', PACKAGE, '-a', 'com.android.contacts', '-f');
      await sleep(3000);
    }
    const before = rawContacts();
    assert.ok(before > 0, 'the seeded contacts are on the phone');

    await setPolicies({ ...OFF, 'app_lock.required': ['contacts'] });
    const { device: old, page } = await openApp();
    try {
      await page.getByText(/Update the UniHub app to unlock with your fingerprint/).first().waitFor({ timeout: 60_000 });
    } finally {
      await old.close();
    }
    // Syncs under the requirement: the contacts routes are exempt, nothing leaves the phone.
    for (let i = 0; i < 3; i++) {
      adb('shell', 'requestsync', '-t', PACKAGE, '-a', 'com.android.contacts', '-f');
      await sleep(15_000);
    }
    assert.equal(rawContacts(), before, 'the phone\'s UniHub contacts stay');
  } finally {
    await setPolicies(OFF);
    adb('install', '-r', '-d', candidateApk);
  }
});
