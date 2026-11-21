// Chat files and group notifications in the Android app. The app's person
// writes with Blair, who has a desktop Chrome of her own (the runner's
// installed one, or UNIHUB_E2E_CHROMIUM): a picture picked in Android's
// picker and a voice message from the emulator's microphone reach her, her
// PDF opens in the app's reader and goes to Android's Open with sheet as a
// PDF. Then Drew, through the API as chat-notifications.test.mjs writes,
// posts to a group chat with the app in the background: the notification
// names him and the chat, and says when he mentioned the app's person.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  PACKAGE, adb, bridgeMessage, chooserType, closeChooser, openApp, pickFromDownloads, pushToDownloads, shownNotifications, signOutApp, sleep,
} from '../support/android.mjs';
import { PASSWORD, acknowledge, addPerson, chatAccount, createGroup, ok, resetPeople } from '../support/people.mjs';

const webPush = createRequire(new URL('../../../api/package.json', import.meta.url))('web-push');
const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;
const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const run = Date.now().toString(36);
const random = length => crypto.randomBytes(length).toString('base64url');
const PASSPHRASE = 'synthetic chat passphrase';

before(async () => {
  await resetPeople();
  await signOutApp();
  adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
  if (sdk >= 33) adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
});

after(resetPeople);

/** Chooses the person's chat passphrase in the page's own engine (src/lib/chat/test-hook.ts), standing in for the passphrase screen. */
async function choosePassphrase(page, origin = new URL(page.url()).origin) {
  await page.goto(`${origin}/chat#chat-test`);
  await page.waitForFunction(() => 'chatTest' in window, null, { timeout: 120_000 });
  await page.evaluate(passphrase => window.chatTest.passphrase(passphrase), PASSPHRASE);
}

const drawn = image => image.evaluate(element => element.complete && element.naturalWidth > 0);

async function until(check, what, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await sleep(500); }
  throw new Error(`${what} did not happen`);
}

async function waitForNotification(arrived, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = shownNotifications().find(n => n.title !== '' && !/^Connected to/.test(n.title) && arrived(n));
    if (found) return found;
    await sleep(2000);
  }
  throw new Error(`no such notification: ${JSON.stringify(shownNotifications())}`);
}

test('in the app a picked picture and a recorded voice message reach Blair, her PDF opens in the reader and in Android\'s Open with as a PDF, and a group message notifies with sender, chat and mention', { timeout: 1_200_000 }, async () => {
  const team = await createGroup('chat files');
  const [me, blair, drew] = [await addPerson('phone', { groups: [team.id] }), await addPerson('blair'), await addPerson('drew', { groups: [team.id] })];
  const sessions = await Promise.all([me, blair, drew].map(person => person.session()));
  await acknowledge(sessions);
  const [myName, blairName, drewName] = await Promise.all(sessions.map(async api => (await ok(api('GET', '/api/auth/me'), 'me')).user.full_name));
  await pushToDownloads(fixture('synthetic-photo.jpg'));
  adb('logcat', '-c');

  const { device, page } = await openApp({ email: me.email });
  const chrome = await chromium.launch(process.env.UNIHUB_E2E_CHROMIUM ? { executablePath: process.env.UNIHUB_E2E_CHROMIUM } : { channel: 'chrome' });
  try {
    const enabled = await bridgeMessage(page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    await choosePassphrase(page);
    await until(() => page.evaluate(async () => (await fetch('/api/chat/devices/current')).ok), 'the app\'s chat device');

    // Blair in her own browser starts the chat and writes.
    const context = await chrome.newContext({ viewport: { width: 1440, height: 900 } });
    const signedIn = await context.request.post(`${base}/api/auth/signin`, { data: { email: blair.email, password: PASSWORD } });
    assert.equal(signedIn.status(), 200, 'Blair signs in');
    const b = await context.newPage();
    await choosePassphrase(b, base);
    await b.goto(`${base}/contacts?book=company&contact=${me.id}`);
    await b.getByRole('button', { name: 'Message', exact: true }).click();
    await b.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
    const hello = `Hello from Blair ${run}`;
    await b.getByLabel(`Message to ${myName}`, { exact: true }).fill(hello);
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    const blairSees = b.getByRole('list', { name: `Messages with ${myName}` });

    // The app opens the chat; Blair's PDF opens in the reader, and Open with hands Android's sheet a PDF.
    await page.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${blairName}`) }).click({ timeout: 120_000 });
    const iSee = page.getByRole('list', { name: `Messages with ${blairName}` });
    await iSee.getByText(hello, { exact: true }).waitFor({ timeout: 120_000 });
    await b.getByLabel('Choose files to send').setInputFiles(fixture('synthetic-report.pdf'));
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    await iSee.getByRole('button', { name: 'Open synthetic-report.pdf', exact: true }).click({ timeout: 120_000 });
    const reader = page.getByRole('dialog', { name: 'synthetic-report.pdf', exact: true });
    await reader.getByText(/page 1 of \d+/).waitFor({ timeout: 90_000 });
    await reader.locator('canvas').first().waitFor();
    await reader.getByRole('button', { name: 'Open synthetic-report.pdf with…', exact: true }).click();
    await closeChooser('android-chat-chooser');
    assert.equal(await chooserType('open'), 'application/pdf');
    await reader.getByRole('button', { name: 'Close', exact: true }).click();
    await reader.waitFor({ state: 'hidden' });

    // A picture picked in Android's picker reaches Blair, preview and picture.
    await page.getByRole('button', { name: 'Attach files' }).click();
    await pickFromDownloads(['synthetic-photo.jpg']);
    await page.getByRole('list', { name: 'Files to send' }).getByText('synthetic-photo.jpg', { exact: true }).waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const picture = blairSees.getByRole('button', { name: 'Open the picture synthetic-photo.jpg', exact: true });
    await picture.waitFor({ timeout: 120_000 });
    await until(() => drawn(picture.locator('img')), 'the picture\'s preview for Blair');
    await picture.click();
    await until(() => drawn(b.getByRole('dialog', { name: 'synthetic-photo.jpg', exact: true }).locator('img')), 'the picture for Blair');
    await b.keyboard.press('Escape');

    // A voice message from the emulator's microphone, which Blair plays.
    await page.getByRole('button', { name: 'Record a voice message', exact: true }).click();
    await until(async () => /^0:0[2-9]$/.test(await page.getByRole('timer').textContent() ?? ''), 'two seconds of recording', 60_000);
    await page.getByRole('button', { name: 'Send the voice message', exact: true }).click();
    const play = blairSees.getByRole('button', { name: /^Play the voice message, 0:0\d$/ });
    await play.click({ timeout: 120_000 });
    await until(() => b.evaluate(() => { const audio = document.querySelector('audio'); return !!audio && !audio.error && audio.currentTime > 0; }), 'Blair hearing the voice message');

    // Drew writes to a group chat with the app in the background, then mentions the app's person.
    const [, , drewApi] = sessions;
    await ok(drewApi('POST', '/api/chat/devices', { preview: null, key_packages: [random(313)], last_resort: random(313) }), 'Drew\'s chat device');
    await ok(drewApi('POST', '/api/chat/account', chatAccount()), 'Drew sets Chat up');
    const chat = `Team ${run}`;
    const { id: conversation } = (await ok(drewApi('POST', '/api/chat/conversations', { kind: 'group', name: chat, user_ids: [me.id] }), 'group chat')).conversation;
    const { devices } = await ok(drewApi('GET', `/api/chat/conversations/${conversation}/devices`), 'devices');
    const mine = devices.filter(item => item.user_id === me.id && item.preview);
    assert.equal(mine.length, 1, JSON.stringify(devices));
    const groupId = crypto.randomUUID();
    await ok(drewApi('POST', `/api/chat/conversations/${conversation}/groups`, { group_id: groupId, previous_group_id: null, welcome: random(900),
      chat_device_ids: devices.map(item => item.chat_device_id) }), 'group');
    const send = (text, mentions) => ok(drewApi('POST', `/api/chat/conversations/${conversation}/messages`, {
      id: crypto.randomUUID(), group_id: groupId, replaces: null, format: 1, ciphertext: random(402), archive: random(300), mentions,
      previews: mine.map(item => ({ chat_device_id: item.chat_device_id, sealed: webPush.encrypt(item.preview.p256dh, item.preview.auth, text, 'aes128gcm').cipherText.toString('base64url') })),
    }), 'send');
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    const plain = `Stand-up moved ${run}`;
    await send(plain, []);
    assert.equal((await waitForNotification(n => n.text === plain)).title, `${drewName} in ${chat}`);
    const mention = `Can you take it? ${run}`;
    await send(mention, [me.id]);
    assert.equal((await waitForNotification(n => n.text === mention)).title, `${drewName} mentioned you in ${chat}`);
  } finally {
    await bridgeMessage(page, 'notifications', 'disable').catch(() => {});
    await chrome.close().catch(() => {});
    await device.close();
  }
});
