// Chat's devices run in the app's WebView under the server's headers, through
// the page's test hook (src/lib/chat/test-hook.ts): two devices in one page
// make a group from their IndexedDB stores and the MLS module, write both
// ways, and one reads on after the page loaded again
// (tools/e2e/tests/chat/chat-device.e2e.ts does it across two browsers).
//
// And the app as a new device of a person who has Chat on a browser: signed in
// fresh it waits, with nothing of Chat and no chat notification, until that
// browser approves it by the code; then it has the chats and their history,
// and is notified.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { PACKAGE, adb, bridgeMessage, navigate, openApp, shownNotifications, signOutApp, sleep } from '../support/android.mjs';
import { PASSWORD, acknowledge, addPerson, ok, resetPeople } from '../support/people.mjs';

const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;
const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const stamp = Date.now().toString(36);
const CODE = /^Code: \d( \d){5}$/;

before(async () => {
  await resetPeople();
  await signOutApp();
  if (sdk >= 33) adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
});

after(resetPeople);

// The signed-in app never stays on "/", so this is always a new page load.
async function openHook(page) {
  await page.goto(new URL('/#chat-test', page.url()).href);
  await page.waitForFunction(() => 'chatTest' in window, null, { timeout: 120_000 });
}
const run = (page, name, ...args) => page.evaluate(([name, args]) => window.chatTest[name](...args), [name, args]);

test('Chat\'s devices and their stores work in the app\'s WebView', { timeout: 600_000 }, async () => {
  const { device, page } = await openApp();
  try {
    await openHook(page);
    const packageB = await run(page, 'enrol', 'b');
    await run(page, 'enrol', 'a');
    const welcome = await run(page, 'createGroup', 'a', 'test-group', [packageB]);
    assert.equal(await run(page, 'join', 'b', welcome), 'test-group');
    assert.equal(await run(page, 'decrypt', 'b', 'test-group', await run(page, 'encrypt', 'a', 'test-group', 'hello')), 'hello');
    assert.equal(await run(page, 'decrypt', 'a', 'test-group', await run(page, 'encrypt', 'b', 'test-group', 'hi back')), 'hi back');
    const later = await run(page, 'encrypt', 'a', 'test-group', 'after the reload');

    await openHook(page);
    assert.equal(await run(page, 'reopen', 'b'), true);
    assert.equal(await run(page, 'decrypt', 'b', 'test-group', later), 'after the reload');
  } finally {
    await device.close();
  }
});

/** A desktop browser of the person with Chat set up through the page's own engine (src/lib/chat/test-hook.ts), standing in for the passphrase screen. */
async function browserInChat(chrome, person) {
  const context = await chrome.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(`${base}/api/auth/signin`, { data: { email: person.email, password: PASSWORD } })).status(), 200, `${person.email} signs in`);
  const page = await context.newPage();
  await page.goto(`${base}/chat#chat-test`);
  await page.waitForFunction(() => 'chatTest' in window, null, { timeout: 120_000 });
  await page.evaluate(passphrase => window.chatTest.passphrase(passphrase), 'synthetic chat passphrase');
  return page;
}

const chatNotifications = () => shownNotifications().filter(n => n.title !== '' && !/^Connected to/.test(n.title));

test('the app signed in fresh waits for Chat and gets no chat notification; approved by the code on a browser, it has the chats, their history and notifications', { timeout: 1_200_000 }, async () => {
  const [me, blair] = [await addPerson('newphone'), await addPerson('blair')];
  const sessions = await Promise.all([me, blair].map(person => person.session()));
  await acknowledge(sessions);
  const [myName, blairName] = await Promise.all(sessions.map(async api => (await ok(api('GET', '/api/auth/me'), 'me')).user.full_name));
  const chrome = await chromium.launch(process.env.UNIHUB_E2E_CHROMIUM ? { executablePath: process.env.UNIHUB_E2E_CHROMIUM } : { channel: 'chrome' });
  let app;
  try {
    // The person has Chat on a browser, and Blair writes to them from hers.
    const mine = await browserInChat(chrome, me);
    const b = await browserInChat(chrome, blair);
    await b.goto(`${base}/contacts?book=company&contact=${me.id}`);
    await b.getByRole('button', { name: 'Message', exact: true }).click();
    await b.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
    const write = async text => {
      await b.getByLabel(`Message to ${myName}`, { exact: true }).fill(text);
      await b.getByRole('button', { name: 'Send', exact: true }).click();
      await b.getByRole('list', { name: `Messages with ${myName}` }).getByText(text, { exact: true }).waitFor({ timeout: 60_000 });
    };
    const first = `Before the phone ${stamp}`;
    await write(first);
    await mine.goto(`${base}/chat`);
    await mine.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${blairName}`) }).click({ timeout: 120_000 });
    const browserSees = mine.getByRole('list', { name: `Messages with ${blairName}` });
    await browserSees.getByText(first, { exact: true }).waitFor({ timeout: 120_000 });

    // The app, signed in fresh with notifications on, waits: Chat shows no chat.
    app = await openApp({ email: me.email });
    const { page } = app;
    const enabled = await bridgeMessage(page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    await navigate(page, '/chat');
    await page.getByRole('heading', { name: 'This device is not in Chat yet' }).waitFor({ timeout: 180_000 });

    // In the background it is told nothing of a message the browser gets.
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    const waiting = `While the phone waits ${stamp}`;
    await write(waiting);
    await browserSees.getByText(waiting, { exact: true }).waitFor({ timeout: 120_000 });
    await sleep(20_000);
    assert.deepEqual(chatNotifications(), [], 'a waiting app gets no chat notification');

    // It asks; the browser shows the same code and approves; the app has the chat with its history.
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await page.getByRole('button', { name: 'Ask for approval' }).click({ timeout: 60_000 });
    const code = await page.getByText(CODE).textContent({ timeout: 60_000 });
    const asks = mine.getByRole('dialog', { name: 'A device asks to join your chats' });
    assert.equal(await asks.getByText(CODE).textContent({ timeout: 120_000 }), code, 'both show the same code');
    await asks.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${blairName}`) }).click({ timeout: 180_000 });
    const appSees = page.getByRole('list', { name: `Messages with ${blairName}` });
    for (const text of [first, waiting]) await appSees.getByText(text, { exact: true }).waitFor({ timeout: 120_000 });

    // And from now on it is notified.
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    const later = `After the approval ${stamp}`;
    await write(later);
    const end = Date.now() + 120_000;
    while (!chatNotifications().some(n => n.text === later)) {
      if (Date.now() > end) throw new Error(`no notification of the message: ${JSON.stringify(shownNotifications())}`);
      await sleep(2000);
    }
  } finally {
    if (app) await bridgeMessage(app.page, 'notifications', 'disable').catch(() => {});
    await chrome.close().catch(() => {});
    await app?.device.close();
  }
});
