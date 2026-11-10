// 0.29.0: notifications while Mail is locked in the Android app. A mail that
// arrives shows only "New Email" (the server renders nothing for a locked
// device, and the app shows only the kind's text whatever it gets); tapping it
// asks for the lock first, then opens the message. A notification of no module
// (the server's test notification) keeps its text: only Mail is locked.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  PACKAGE, adb, bridgeMessage, clearDevicePin, enrollFingerprint, openApp, setDevicePin, shownNotifications, sleep, stackSession, tapNative,
  touch, touchFinger, waitForUnlockPrompt,
} from '../support/android.mjs';

const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const stackEnv = Object.fromEntries(execFileSync(new URL('../stack.sh', import.meta.url).pathname, ['env'], { encoding: 'utf8' })
  .trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const nodemailer = createRequire(new URL('../../../api/package.json', import.meta.url))('nodemailer');

/** A synthetic mail from outside to the admin's mailbox, through the provider's SMTPS. */
async function deliver(subject) {
  const transport = nodemailer.createTransport({
    host: stackEnv.UNIHUB_E2E_PROVIDER_HOST, port: Number(stackEnv.UNIHUB_E2E_SMTPS_PORT), secure: true,
    auth: { user: 'sam@example.org', pass: stackEnv.UNIHUB_E2E_PROVIDER_PASSWORD },
    tls: { ca: readFileSync(stackEnv.UNIHUB_E2E_CA) },
  });
  try {
    await transport.sendMail({ from: 'Sam Example <sam@example.org>', to: 'admin@mail.test', subject, text: 'Synthetic message for the app lock test.' });
  } finally {
    transport.close();
  }
}

async function waitForNotification(arrived, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const shown = shownNotifications().filter(n => n.title !== '' && !/^Connected to/.test(n.title));
    const found = shown.find(arrived);
    if (found) return { found, shown };
    await sleep(3000);
  }
  throw new Error(`no such notification: ${JSON.stringify(shownNotifications())}`);
}

before(async () => {
  setDevicePin();
  await enrollFingerprint();
  if (sdk >= 33) adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
});

after(() => {
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', `run-as ${PACKAGE} rm -f shared_prefs/app_lock.xml`);
  clearDevicePin();
});

test('[29-05] with Mail locked, a new mail shows only "New Email"; the tap asks first, then opens it; other notifications keep their text', { timeout: 1_200_000 }, async () => {
  const api = await stackSession();
  const { device, page } = await openApp();
  try {
    const enabled = await bridgeMessage(page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));

    // Settings → App lock: Mail only, every time UniHub opens.
    await page.goto(new URL('/settings?section=app-lock', page.url()).href);
    // The row is the tap target; its input is drawn by the row (RadioRow).
    await touch(page, page.getByText('Chosen modules', { exact: true }));
    await touch(page, page.getByRole('checkbox', { name: 'Mail' }));
    await waitForUnlockPrompt();
    await touchFinger(1);
    await page.getByLabel('Ask again').selectOption({ label: 'Every time UniHub opens' }, { timeout: 5000 }).catch(async () => {
      await touch(page, page.getByRole('combobox', { name: 'Ask again' }));
      await touch(page, page.getByRole('option', { name: 'Every time UniHub opens' }));
    });
    await sleep(2000);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(3000);

    const subject = `Locked mail ${Date.now().toString(36)}`;
    await deliver(subject);
    const { found } = await waitForNotification(n => n.title === 'New Email');
    assert.equal(found.text, '', 'no sender or subject');
    assert.equal(shownNotifications().some(n => `${n.title} ${n.text}`.includes(subject) || n.text.includes('sam@example.org')), false);

    // Not Mail: the server's test notification keeps its text.
    const sent = await api('POST', '/api/notifications/test', { endpoint: enabled.state.endpoint });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    await waitForNotification(n => n.title === 'UniHub notifications are working');

    // The tap: the lock first, then the message.
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await tapNative(/^New Email$/);
    await page.getByText('Mail is locked', { exact: true }).waitFor({ timeout: 60_000 }).catch(() => {});
    await waitForUnlockPrompt();
    await touchFinger(1);
    await page.getByText(subject).first().waitFor({ timeout: 60_000 });
  } finally {
    await bridgeMessage(page, 'notifications', 'disable').catch(() => {});
    await device.close();
  }
});
