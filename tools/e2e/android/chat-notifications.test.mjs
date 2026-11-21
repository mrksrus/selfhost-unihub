// Chat notifications in the Android app, with the app in the background:
// Blair writes to the administrator, sealing the message's start to each of
// the administrator's chat devices as the page does (the app's key is its
// push key). The app opens it and shows the text at the level 'full', the
// sender at 'sender', and nothing under an app lock on Chat. A tap opens the
// conversation, whose window refuses screenshots; Mail's does not.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  PACKAGE, adb, appLockMessage, bridgeMessage, navigate, openApp, resetAppLock, shownNotifications, sleep, tapNative, windowIsSecure,
} from '../support/android.mjs';
import { chatAccount, ok, people, seededIds } from '../support/people.mjs';

const webPush = createRequire(new URL('../../../api/package.json', import.meta.url))('web-push');
const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const run = Date.now().toString(36);
const random = length => crypto.randomBytes(length).toString('base64url');

before(async () => {
  await resetAppLock();
  if (sdk >= 33) adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
});

after(resetAppLock);

async function waitForNotification(arrived, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = shownNotifications().find(n => n.title !== '' && !/^Connected to/.test(n.title) && arrived(n));
    if (found) return found;
    await sleep(2000);
  }
  throw new Error(`no such notification: ${JSON.stringify(shownNotifications())}`);
}

async function until(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (check()) return; await sleep(500); }
  throw new Error(`${what} did not happen`);
}

test('a chat message shows its text at "full", the sender at "sender", nothing under the Chat lock; a tap opens the chat in a secure window', { timeout: 900_000 }, async () => {
  const [admin, , blair] = await people();
  const ids = await seededIds();
  const blairName = (await ok(blair('GET', '/api/auth/me'), 'Blair')).user.full_name;
  const { device, page } = await openApp();
  try {
    const enabled = await bridgeMessage(page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    // The app's chat device, which the page's engine enrols at the start (no preview key of its own: the push key is used).
    const enrolled = Date.now() + 120_000;
    while (!(await page.evaluate(async () => (await fetch('/api/chat/devices/current')).ok))) {
      if (Date.now() > enrolled) throw new Error('the app enrolled no chat device');
      await sleep(1000);
    }
    // The administrator sets Chat up from the app's own session, which joins the app's chat device.
    const setUp = await page.evaluate(async body => {
      const { csrfToken } = await (await fetch('/api/auth/me')).json();
      return (await fetch('/api/chat/account', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) })).status;
    }, chatAccount());
    assert.equal(setUp, 200, 'the administrator sets Chat up in the app');

    await ok(blair('POST', '/api/chat/devices', { preview: null, key_packages: [random(313)], last_resort: random(313) }), 'Blair\'s chat device');
    await ok(blair('POST', '/api/chat/account', chatAccount()), 'Blair sets Chat up');
    const { id: conversation, current_group_id: previous } = (await ok(blair('POST', '/api/chat/conversations', { user_id: ids['admin@example.com'] }), 'conversation')).conversation;
    const { devices } = await ok(blair('GET', `/api/chat/conversations/${conversation}/devices`), 'devices');
    assert.ok(devices.some(item => item.user_id === ids['admin@example.com'] && item.preview), JSON.stringify(devices));
    const groupId = crypto.randomUUID();
    await ok(blair('POST', `/api/chat/conversations/${conversation}/groups`, { group_id: groupId, previous_group_id: previous, welcome: random(900),
      chat_device_ids: devices.map(item => item.chat_device_id) }), 'group');
    const send = text => ok(blair('POST', `/api/chat/conversations/${conversation}/messages`, {
      id: crypto.randomUUID(), group_id: groupId, replaces: null, format: 1, ciphertext: random(402), archive: random(300),
      previews: devices.filter(item => item.user_id === ids['admin@example.com'] && item.preview).map(item => ({ chat_device_id: item.chat_device_id,
        sealed: webPush.encrypt(item.preview.p256dh, item.preview.auth, text, 'aes128gcm').cipherText.toString('base64url') })),
    }), 'send');
    const level = value => ok(admin('PUT', '/api/settings/values', { values: { chat_notification_detail: value } }), `level ${value}`);
    const home = async () => { adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(2000); };

    // Full: the sender and the text.
    await home();
    const lunch = `Lunch at noon? ${run}`;
    await send(lunch);
    const full = await waitForNotification(n => n.text === lunch);
    assert.equal(full.title, blairName);

    // The tap opens the conversation; Chat's window is secure, Mail's is not.
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await tapNative(new RegExp(lunch.replace(/[?]/g, '\\?')));
    await page.waitForURL(url => url.pathname === '/chat' && url.searchParams.get('c') === conversation, { timeout: 60_000 });
    await until(() => windowIsSecure(), 'a secure window in Chat');
    await navigate(page, '/mail');
    await until(() => !windowIsSecure(), 'a window that can be captured in Mail');

    // Sender: the name without the text.
    await level('sender');
    await home();
    await send(`Sender only ${run}`);
    const sender = await waitForNotification(n => n.title === blairName);
    assert.equal(sender.text, 'New message');

    // The app lock on Chat, locked: the lock is checked before the preview is opened.
    await level('full');
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await sleep(2500);
    const locked = await appLockMessage(page, 'configure', { scope: ['chat'], relockAfterMs: 0, onDeviceLock: true, blockScreenshots: false });
    assert.equal(locked.ok, true, JSON.stringify(locked));
    await home();
    await send(`Secret ${run}`);
    const hidden = await waitForNotification(n => n.title === 'New message');
    assert.equal(hidden.text, '');
    assert.equal(shownNotifications().some(n => `${n.title} ${n.text}`.includes('Secret')), false);
  } finally {
    await ok(admin('PUT', '/api/settings/values', { values: { chat_notification_detail: 'full' } }), 'level full').catch(() => {});
    await bridgeMessage(page, 'notifications', 'disable').catch(() => {});
    await device.close();
  }
});
