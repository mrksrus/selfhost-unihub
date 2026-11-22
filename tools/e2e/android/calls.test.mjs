// Voice calls between the app and a desktop browser through the real server:
// its ring by the app's notification connection, its signals and the call's
// entry in the chat. The phone's person ("me") is in the app; the other
// ("desk") in a desktop Chromium whose microphone is a sound file the test
// writes. The app's WebViews get Chromium's generated tone (WebView's
// command-line file on this debuggable emulator): never the same signal on
// both ends, which the phone's echo cancellation would take for an echo and
// remove. Both sides count received sound in the connection's statistics:
// energy above a floor, not packets.
//
// A browser calls the locked phone (answered on the call screen, sound both
// ways, a speaker route through Telecom, the call notification after a
// minute, the browser hangs up, both chats show the entry); the phone calls
// the browser from the app's "Call"; the same locked phone called by a browser that cannot
// connect directly, so the sound goes through UniHub (five minutes with the screen off); both
// call at once; Decline on the notification; a call
// cancelled while it rings; UniHub's app lock on; the app's notifications off
// with the app open; a headset's answer with nothing of the app on screen; an
// answer without the microphone permission.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  PACKAGE, adb, answerPromptWithPin, answerSlowDialogs, appLockMessage, bridgeMessage, clearDevicePin, lockCoverShown, navigate, openApp, setDevicePin,
  shownNotifications, signOutApp, sleep, sleepScreen, tapNative, touch, unlockKeyguard, unlockPromptShown, waitForUnlockPrompt,
} from '../support/android.mjs';
import { PASSWORD, acknowledge, addPerson, ok, resetPeople } from '../support/people.mjs';

const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;
const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const FAKE_MICROPHONE = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
// Received sound energy in three seconds: a sent tone gives about 0.3 to 0.9, silence or a cancelled echo near 0.
const SOUND = 0.05;
const minutes = Number(process.env.UNIHUB_E2E_CALL_MINUTES ?? 5);
const WEBVIEW_FLAGS = '/data/local/tmp/webview-command-line';
const shell = (...args) => adb('shell', ...args);
const results = {};
let chrome, desk, app, me, other, myName, deskName, conversation;

// Telecom's live calls (mCalls), not its history.
const liveCalls = () => { const text = shell('dumpsys', 'telecom'); return text.slice(text.indexOf('mCalls:'), text.indexOf('mCallAudioManager:')); };
const ourCall = (state = '\\w+') => new RegExp(`state=${state}, tpac=ComponentInfo\\{io\\.github\\.mrksrus\\.unihub/`).test(liveCalls());
const telecomRoute = () => [...shell('dumpsys', 'telecom').matchAll(/Entering audio route: AudioRoute\[Type=(\w+)/g)].at(-1)?.[1] ?? '';
const callScreenUp = () => shell('dumpsys', 'activity', 'activities').split('\n').some(line => /Hist.*CallActivity/.test(line));
const topActivity = () => /topResumedActivity=[^\n]*\/\.(\w+)/.exec(shell('dumpsys', 'activity', 'activities'))?.[1] ?? '';
const callNotification = () => shell('dumpsys', 'notification', '--noredact').split(/\n\s*NotificationRecord\(/).find(r => r.includes(`pkg=${PACKAGE}`) && /category=call/.test(r)) ?? '';
const fullScreenIntents = allowed => shell('appops', 'set', PACKAGE, 'USE_FULL_SCREEN_INTENT', allowed ? 'allow' : 'deny');
const seconds = since => +((Date.now() - since) / 1000).toFixed(2);

/** The desk's microphone: a 16-bit WAV of a tone sliding between 100 and 500 Hz, in bursts of 0.6 s every 0.8 s. */
function deskSound() {
  const rate = 48_000, samples = rate * 4, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    phase += 2 * Math.PI * (300 + 200 * Math.sin(2 * Math.PI * 0.7 * t)) / rate;
    wav.writeInt16LE(t % 0.8 < 0.6 ? Math.round(16_000 * Math.sin(phase)) : 0, 44 + i * 2);
  }
  fs.writeFileSync(DESK_SOUND, wav);
  return DESK_SOUND;
}
const DESK_SOUND = path.join(os.tmpdir(), `unihub-calls-desk-${process.pid}.wav`);

async function until(check, what, timeoutMs = 60_000, every = 500) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(every);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms${last ? `: ${last.message}` : ''}`);
}

const PASSPHRASE = 'synthetic chat passphrase';
const pageApi = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const { csrfToken } = await (await fetch('/api/auth/me')).json();
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}, [method, path, body]);

/**
 * Chat set up through the page's engine (src/lib/chat/test-hook.ts); a device
 * that enrolled after the passphrase made the account waits, and joins by the
 * proof of the history key, as tools/e2e/tests/chat/chat-helpers.ts does.
 */
async function joinChat(page) {
  await page.waitForFunction(() => 'chatTest' in window, null, { timeout: 120_000 });
  await page.evaluate(passphrase => window.chatTest.passphrase(passphrase), PASSPHRASE);
  const device = await until(async () => { const got = await pageApi(page, 'GET', '/api/chat/devices/current'); return got.status === 200 && got.data; }, 'the chat device', 60_000, 1000);
  if (device.state !== 'waiting') return;
  const { account } = (await pageApi(page, 'GET', '/api/chat/account')).data;
  const wrapped = Buffer.from(account.key_backup.wrapped, 'base64url');
  const key = crypto.pbkdf2Sync(PASSPHRASE.normalize('NFC'), Buffer.from(account.key_backup.salt, 'base64url'), account.key_backup.rounds, 32, 'sha256');
  const unwrap = crypto.createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12));
  unwrap.setAuthTag(wrapped.subarray(wrapped.length - 16));
  const history = crypto.createECDH('prime256v1');
  history.setPrivateKey(Buffer.from(JSON.parse(Buffer.concat([unwrap.update(wrapped.subarray(12, wrapped.length - 16)), unwrap.final()]).toString('utf8')).d, 'base64url'));
  const sealed = Buffer.from((await pageApi(page, 'POST', '/api/chat/devices/current/challenge')).data.sealed, 'base64url');
  const salt = sealed.subarray(0, 16), sender = sealed.subarray(21, 21 + sealed[20]), record = sealed.subarray(21 + sealed[20]);
  const hkdf = (k, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, k, info, length));
  const ikm = hkdf(Buffer.alloc(16), history.computeSecret(sender), Buffer.concat([Buffer.from('WebPush: info\0'), history.getPublicKey(), sender]), 32);
  const open = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12));
  open.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([open.update(record.subarray(0, record.length - 16)), open.final()]);
  const proof = await pageApi(page, 'POST', '/api/chat/devices/current/proof', { value: padded.subarray(0, padded.lastIndexOf(2)).toString('base64url') });
  assert.equal(proof.status, 200, JSON.stringify(proof));
}

/**
 * Keeps every connection a page makes where its statistics can be read (`window.callConnections`).
 * The call's own is made with servers (the sound through UniHub plays through a pair made without):
 * while `window.noDirect` is set it gets none and may use only the relay, so it has no candidates;
 * `window.directConnected` tells whether one connected.
 */
const KEEP_CONNECTIONS = () => {
  if (window.callConnections) return;
  const Real = window.RTCPeerConnection;
  const call = configuration => configuration?.iceServers && window.noDirect ? { ...configuration, iceServers: [], iceTransportPolicy: 'relay' } : configuration;
  window.callConnections = [];
  window.RTCPeerConnection = class extends Real {
    constructor(configuration) {
      super(call(configuration));
      window.callConnections.push(this);
      if (configuration?.iceServers) this.addEventListener('connectionstatechange', () => { if (this.connectionState === 'connected') window.directConnected = true; });
    }
    setConfiguration(configuration) { super.setConfiguration(call(configuration)); }
  };
};

/** Sound packets and their energy received in three seconds on all of the page's connections. */
async function heard(page) {
  const read = () => page.evaluate(async () => {
    let packets = 0, energy = 0;
    for (const connection of window.callConnections ?? []) {
      (await connection.getStats()).forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') { packets += report.packetsReceived ?? 0; energy += report.totalAudioEnergy ?? 0; }
      });
    }
    return { packets, energy };
  });
  const before = await read();
  await sleep(3000);
  const now = await read();
  return { packets: now.packets - before.packets, energy: +(now.energy - before.energy).toFixed(4) };
}
const flows = async (page, what) => until(async () => { const got = await heard(page); return got.energy >= SOUND && got; }, `sound reaching ${what}`, 60_000, 0);

/** The call screen's page: the app's process has one WebView debugging socket for both WebViews, so it is found among the main page's targets. */
async function callPage() {
  const page = await until(() => app.page.context().pages().find(p => { try { return new URL(p.url()).pathname === '/call'; } catch { return false; } }), 'the call screen\'s page', 60_000);
  await page.evaluate(KEEP_CONNECTIONS);
  return page;
}

/** The app's main page, again after its screen was recreated (the process, and so the debugging connection, stayed). */
async function mainPage() {
  app.page = await until(() => app.page.context().pages().find(p => { try { return !p.isClosed() && new URL(p.url()).pathname !== '/call'; } catch { return false; } }),
    'the app\'s main page', 60_000);
  app.page.setDefaultTimeout(60_000);
  return app.page;
}

/** The desk calls me from our chat; a call an earlier test left running is hung up first. */
async function deskCalls() {
  const hangUp = desk.getByRole('button', { name: 'Hang up', exact: true });
  if (await hangUp.isVisible()) { await hangUp.click(); await callOver().catch(() => {}); }
  const close = desk.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) await close.click();
  await desk.getByRole('button', { name: `Call ${myName}`, exact: true }).click();
  return Date.now();
}
const deskSays = (text, timeout = 30_000) => desk.getByText(text, { exact: true }).waitFor({ timeout });
const deskScreenGone = () => until(async () => (await desk.getByRole('dialog').count()) + (await desk.getByRole('alertdialog').count()) === 0, 'the desk\'s call screen closing', 30_000);
const callOver = () => until(() => !ourCall() && !callScreenUp(), 'the call, its service and its screen ending', 30_000);

before(async () => {
  await resetPeople();
  await signOutApp();
  if (sdk >= 33) shell('pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  shell('pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
  shell('cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
  fullScreenIntents(true);
  // The generated tone as the WebViews' microphone; read when the app's process starts.
  shell(`echo "_ ${FAKE_MICROPHONE[0]}" > ${WEBVIEW_FLAGS}`);
  shell('am', 'force-stop', PACKAGE);

  [me, other] = [await addPerson('phone'), await addPerson('desk')];
  const sessions = await Promise.all([me, other].map(person => person.session()));
  await acknowledge(sessions);
  [myName, deskName] = await Promise.all(sessions.map(async api => (await ok(api('GET', '/api/auth/me'), 'me')).user.full_name));

  // The desk: Chat set up through the page's engine (src/lib/chat/test-hook.ts), our chat open.
  chrome = await chromium.launch({ ...(process.env.UNIHUB_E2E_CHROMIUM ? { executablePath: process.env.UNIHUB_E2E_CHROMIUM } : { channel: 'chrome' }),
    args: [...FAKE_MICROPHONE, `--use-file-for-fake-audio-capture=${deskSound()}`, '--autoplay-policy=no-user-gesture-required'] });
  const context = await chrome.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  await context.addInitScript(KEEP_CONNECTIONS);
  assert.equal((await context.request.post(`${base}/api/auth/signin`, { data: { email: other.email, password: PASSWORD } })).status(), 200, 'the desk signs in');
  desk = await context.newPage();
  await desk.goto(`${base}/chat#chat-test`);
  await joinChat(desk);

  // Me in the app: notifications on, Chat set up, which joins the app's chat device.
  app = await openApp({ email: me.email });
  const enabled = await bridgeMessage(app.page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  await app.page.goto(new URL('/#chat-test', app.page.url()).href);
  await joinChat(app.page);
  await app.page.goto(new URL('/chat', app.page.url()).href);
  await desk.goto(`${base}/contacts?book=company&contact=${me.id}`);
  await desk.getByRole('button', { name: 'Message', exact: true }).click();
  await desk.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
  conversation = new URL(desk.url()).searchParams.get('c');
});

after(async () => {
  console.log(`calls: ${JSON.stringify(results)}`);
  shell(`rm -f ${WEBVIEW_FLAGS}`);
  fs.rmSync(DESK_SOUND, { force: true });
  fullScreenIntents(true);
  try { await unlockKeyguard(); } catch { /* not locked */ }
  clearDevicePin();
  shell('svc', 'power', 'stayon', 'true');
  await appLockMessage(app?.page, 'configure', { scope: [], relockAfterMs: 0, onDeviceLock: false, blockScreenshots: false }).catch(() => {});
  await bridgeMessage(app?.page, 'notifications', 'disable').catch(() => {});
  await app?.device.close().catch(() => {});
  await chrome?.close();
  shell('am', 'force-stop', PACKAGE);
  await resetPeople();
}, { timeout: 120_000 });

test('a browser calls the locked phone: it rings, is answered on the call screen, sound flows both ways, the speaker is Telecom\'s, the browser hangs up, both chats show it', { timeout: 600_000 }, async () => {
  // The app closed (its task gone, its notification connection running): only the server's `call` message can ring it,
  // which the server sends only to an app whose lock report said it takes calls.
  shell('input', 'keyevent', 'KEYCODE_HOME');
  const appTasks = () => [...shell('dumpsys', 'activity', 'recents').matchAll(/Task\{\w+ #(\d+)[^\n]*?A=\d+:io\.github\.mrksrus\.unihub\}/g)].map(m => m[1]);
  for (const id of appTasks()) { try { shell('am', 'stack', 'remove', id); } catch { /* not on this Android */ } }
  // Where the task cannot be removed, the app is still in the background with its page paused.
  const appClosed = await until(() => appTasks().length === 0, 'the app\'s task gone', 10_000).catch(() => false);
  setDevicePin();
  await sleepScreen();
  const called = await deskCalls();
  await until(() => ourCall('RINGING'), 'Telecom ringing', 60_000, 250);
  const ring = seconds(called);
  await until(() => topActivity() === 'CallActivity', 'the call screen over the lock screen', 30_000, 250);
  const page = await callPage();
  await answerSlowDialogs();
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  const answered = Date.now();
  const toPhone = await flows(page, 'the phone');
  const toDesk = await flows(desk, 'the desk');
  results.locked = { appClosed, ringSeconds: ring, secondsFromAnswerToSound: seconds(answered), phoneHeard3s: toPhone, deskHeard3s: toDesk };
  assert.ok(ourCall('ACTIVE'), 'Telecom has the call active');

  // The routes come from Telecom; each choice goes to Telecom, which takes it. The emulator has the speaker only,
  // so "back to the earpiece" runs where Telecom offers one.
  adb('logcat', '-c');
  await page.getByRole('button', { name: /^Sound: / }).click();
  const offered = await page.getByRole('menuitemradio').allTextContents();
  await page.getByRole('menuitemradio', { name: 'Speaker' }).click();
  await until(() => /Route 4: CallControlResult\(Success\)/.test(adb('logcat', '-d', '-s', 'UniHubCalls:I')) && telecomRoute() === 'TYPE_SPEAKER', 'Telecom taking the speaker', 15_000);
  const earpiece = offered.find(name => /^(Earpiece|Phone)$/.test(name));
  if (earpiece) {
    await page.getByRole('button', { name: 'Sound: Speaker' }).click();
    await page.getByRole('menuitemradio', { name: earpiece }).click();
    await until(() => telecomRoute() === 'TYPE_EARPIECE', 'Telecom back on the earpiece', 15_000);
  }
  results.locked.routes = { offered, speaker: 'taken by Telecom', earpiece: earpiece ? 'taken by Telecom' : 'not offered' };

  // The ring's notification times out after 45 seconds; the running call's, in its place, does not.
  await sleep(Math.max(0, 65_000 - (Date.now() - answered)));
  assert.match(callNotification(), /category=call/, 'the call notification after a minute of the call');
  assert.ok((await heard(page)).energy >= SOUND, 'sound after a minute');

  const hung = Date.now();
  await desk.getByRole('button', { name: 'Hang up', exact: true }).click();
  await callOver();
  results.locked.hangUpSeconds = seconds(hung);
  await unlockKeyguard();
  await desk.getByRole('list', { name: `Messages with ${myName}` }).getByText(/^Voice call, \d+ min$/).first().waitFor({ timeout: 60_000 });
  shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await sleep(3000);
  await mainPage();
  await navigate(app.page, '/chat');
  await app.page.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${deskName}`) }).click({ timeout: 120_000 });
  await app.page.getByRole('list', { name: `Messages with ${deskName}` }).getByText(/^Voice call, \d+ min$/).first().waitFor({ timeout: 60_000 });
});

test('through UniHub: a browser that cannot connect directly calls the locked phone; sound flows both ways, the speaker is Telecom\'s, and it holds with the screen off', { timeout: (minutes + 10) * 60_000 }, async () => {
  await desk.evaluate(() => { window.noDirect = true; window.directConnected = false; });
  try {
    shell('input', 'keyevent', 'KEYCODE_HOME');
    setDevicePin();
    await sleepScreen();
    await deskCalls();
    await until(() => ourCall('RINGING'), 'Telecom ringing', 60_000, 250);
    await until(() => topActivity() === 'CallActivity', 'the call screen over the lock screen', 30_000, 250);
    const page = await callPage();
    await answerSlowDialogs();
    await page.getByRole('button', { name: 'Answer', exact: true }).click();
    const answered = Date.now();
    const toPhone = await flows(page, 'the phone');
    const toDesk = await flows(desk, 'the desk');
    results.throughUniHub = { secondsFromAnswerToSound: seconds(answered), phoneHeard3s: toPhone, deskHeard3s: toDesk };

    adb('logcat', '-c');
    await page.getByRole('button', { name: /^Sound: / }).click();
    await page.getByRole('menuitemradio', { name: 'Speaker' }).click();
    await until(() => /Route 4: CallControlResult\(Success\)/.test(adb('logcat', '-d', '-s', 'UniHubCalls:I')) && telecomRoute() === 'TYPE_SPEAKER', 'Telecom taking the speaker', 15_000);

    await sleepScreen();
    await sleep(minutes * 60_000);
    Object.assign(results.throughUniHub, { minutes, phoneHeardAfter: await flows(page, 'the phone with the screen off'), deskHeardAfter: await flows(desk, 'the desk') });
    assert.equal(await desk.evaluate(() => window.directConnected), false, 'the direct connection never came');
    assert.ok(ourCall('ACTIVE'), 'Telecom has the call active');

    await desk.getByRole('button', { name: 'Hang up', exact: true }).click();
    await callOver();
  } finally {
    await desk.evaluate(() => { window.noDirect = false; });
    await unlockKeyguard().catch(() => {});
    clearDevicePin();
  }
});

test('the phone calls the browser from the app\'s "Call"; the browser answers; the phone hangs up', { timeout: 300_000 }, async () => {
  shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await sleep(3000);
  await mainPage();
  await app.page.goto(new URL(`/chat?c=${conversation}`, app.page.url()).href);
  await app.page.getByRole('button', { name: `Call ${deskName}`, exact: true }).click();
  const placed = Date.now();
  await until(() => ourCall(), 'Telecom holding the outgoing call', 30_000, 250);
  const ringing = desk.getByRole('alertdialog', { name: `${myName} is calling` });
  await ringing.waitFor({ timeout: 60_000 });
  const ring = seconds(placed);
  await ringing.getByRole('button', { name: 'Answer', exact: true }).click();
  const answered = Date.now();
  const toDesk = await flows(desk, 'the desk');
  await until(() => ourCall('ACTIVE'), 'Telecom making the call active', 30_000);
  const page = await callPage();
  results.outgoing = { ringSeconds: ring, secondsFromAnswerToSound: seconds(answered), deskHeard3s: toDesk };
  const hung = Date.now();
  await page.getByRole('button', { name: 'Hang up', exact: true }).click();
  await callOver();
  await deskScreenGone();
  results.outgoing.hangUpSeconds = seconds(hung);
});

test('both call at once: the phone\'s "Call" meets the browser\'s ringing call and answers it', { timeout: 300_000 }, async () => {
  shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await sleep(3000);
  await mainPage();
  await app.page.goto(new URL(`/chat?c=${conversation}`, app.page.url()).href);
  await app.page.getByRole('button', { name: `Call ${deskName}`, exact: true }).click();
  // The desk's call reaches the server and rings the phone while the phone's call screen still loads.
  await deskCalls();
  await desk.getByRole('dialog').getByRole('timer', { name: 'Call time' }).waitFor({ timeout: 60_000 });
  results.bothAtOnce = { deskHeard3s: await flows(desk, 'the desk') };
  await (await callPage()).getByRole('button', { name: 'Hang up', exact: true }).click();
  await callOver();
  await deskScreenGone();
});

test('Decline on the phone\'s notification: the caller reads "declined" within seconds', { timeout: 300_000 }, async () => {
  shell('input', 'keyevent', 'KEYCODE_HOME');
  await deskCalls();
  await until(() => /category=call/.test(callNotification()), 'the call notification', 60_000, 250);
  shell('cmd', 'statusbar', 'expand-notifications');
  await tapNative(/^Decline$/i, { timeoutMs: 30_000 });
  const declined = Date.now();
  await deskSays(`${myName} declined the call.`);
  results.declined = { secondsToTheCaller: seconds(declined) };
  shell('cmd', 'statusbar', 'collapse');
  await callOver();
  await desk.getByRole('button', { name: 'Close', exact: true }).click();
});

test('a call cancelled while it rings stops the ring and leaves a missed-call notification that opens the chat', { timeout: 300_000 }, async () => {
  shell('input', 'keyevent', 'KEYCODE_HOME');
  await deskCalls();
  await until(() => ourCall('RINGING'), 'Telecom ringing', 60_000, 250);
  const cancelled = Date.now();
  await desk.getByRole('button', { name: 'Hang up', exact: true }).click();
  await until(() => !ourCall() && !/category=call/.test(callNotification()), 'the ring stopping', 30_000, 250);
  results.cancelled = { secondsToStopRinging: seconds(cancelled) };
  const missed = await until(() => shownNotifications().find(n => n.title === `Missed call from ${deskName}`), 'the missed-call notification', 120_000, 2000);
  assert.ok(missed);
  assert.match(shell('dumpsys', 'notification', '--noredact'), /channel=calls-missed/);
  shell('cmd', 'statusbar', 'expand-notifications');
  await tapNative(new RegExp(`^Missed call from ${deskName}$`), { timeoutMs: 30_000 });
  await until(() => topActivity() === 'MainActivity', 'the app opening', 30_000);
  await mainPage();
  await until(async () => /^\/chat$/.test(new URL(app.page.url()).pathname) && new URL(app.page.url()).searchParams.get('c'), 'the chat opening', 60_000);
});

/** Settings › App lock: a row of "Lock", touched in the middle of the screen (the bottom bar covers the lower edge); the phone's PIN confirms. */
async function appLock(page, row) {
  await page.goto(new URL('/settings?section=app-lock', page.url()).href);
  const radio = page.getByRole('radio', { name: row });
  await radio.waitFor({ state: 'attached' });
  if (await radio.isChecked()) return;
  const label = page.getByRole('radiogroup', { name: 'Lock' }).getByText(row, { exact: true });
  await label.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await touch(page, label);
  await waitForUnlockPrompt();
  await answerPromptWithPin();
  await until(() => radio.isChecked(), `the lock "${row}"`, 30_000);
}

test('with UniHub\'s app lock on, answering shows only the call; "Open chat" shows UniHub locked while the call goes on; unlocking opens the chat', { timeout: 400_000 }, async () => {
  shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await sleep(2500);
  setDevicePin();
  await appLock(await mainPage(), 'Whole app');
  shell('input', 'keyevent', 'KEYCODE_HOME');
  await sleepScreen();
  await deskCalls();
  await until(() => topActivity() === 'CallActivity', 'the call screen over the lock screen', 60_000, 250);
  const page = await callPage();
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await flows(desk, 'the desk');
  // Only the call: while UniHub is locked the caller's name is not shown either.
  assert.equal((await page.locator('body').innerText()).includes(deskName), false, 'no name on the locked call screen');
  await page.getByRole('button', { name: 'Open chat' }).click();
  // Android's own unlock comes first; then the app opens behind its own lock.
  await sleep(2000);
  shell('input', 'text', '1111');
  shell('input', 'keyevent', '66');
  await until(() => topActivity() === 'MainActivity', 'the app after the unlock', 30_000);
  const main = await mainPage();
  const lockScreen = main.getByText('UniHub is locked', { exact: true });
  await until(async () => lockCoverShown() || await lockScreen.isVisible(), 'UniHub\'s own lock', 30_000);
  assert.ok(ourCall('ACTIVE'), 'the call goes on behind the app');
  assert.ok(callScreenUp(), 'the call screen stays');
  const back = Date.now();
  const toDesk = await flows(desk, 'the desk after "Open chat"');
  const toPhone = await flows(page, 'the phone after "Open chat"');
  results.appLock = { secondsUntilSound: seconds(back), deskHeard3s: toDesk, phoneHeard3s: toPhone };
  await lockScreen.waitFor({ timeout: 30_000 });
  if (!unlockPromptShown()) await touch(main, main.getByRole('button', { name: 'Unlock' }));
  await waitForUnlockPrompt();
  await answerPromptWithPin();
  await lockScreen.waitFor({ state: 'hidden', timeout: 30_000 });
  await until(() => new URL(main.url()).pathname === '/chat' && new URL(main.url()).searchParams.get('c') === conversation, 'the chat opening after the unlock', 30_000);
  await desk.getByRole('button', { name: 'Hang up', exact: true }).click();
  await callOver();
  await appLock(main, 'Off');
  clearDevicePin();
});

test('with the app\'s notifications off, the open app still rings', { timeout: 300_000 }, async () => {
  const off = await bridgeMessage(app.page, 'notifications', 'disable');
  assert.equal(off.ok, true, JSON.stringify(off));
  shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  await navigate(app.page, '/settings');
  const called = await deskCalls();
  await until(() => ourCall('RINGING'), 'Telecom ringing from the open page\'s hand-over', 60_000, 250);
  results.notificationsOff = { ringSeconds: seconds(called) };
  await desk.getByRole('button', { name: 'Hang up', exact: true }).click();
  await callOver();
  const on = await bridgeMessage(app.page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
  assert.equal(on.ok, true, JSON.stringify(on));
});

test('a headset answers with nothing of the app on screen: the notification says to open UniHub, and sound flows once it is opened', { timeout: 400_000 }, async () => {
  fullScreenIntents(false);
  shell('input', 'keyevent', 'KEYCODE_HOME');
  // Past the seconds in which Android still lets an app that was just on screen open one.
  await sleep(15_000);
  await deskCalls();
  await until(() => ourCall('RINGING'), 'Telecom ringing', 60_000, 250);
  shell('input', 'keyevent', 'KEYCODE_HEADSETHOOK');
  await until(() => ourCall('ACTIVE'), 'Telecom answering for the headset', 30_000, 250);
  const words = await until(() => shownNotifications().find(n => n.title === deskName && /Open UniHub|Not connected/.test(n.text)), 'the notification\'s words', 30_000, 1000);
  // Not answered at the server: the caller still hears it ring.
  await deskSays('Calling…');
  results.headset = { notification: words.text, callScreenBefore: callScreenUp() };
  const opened = Date.now();
  shell('cmd', 'statusbar', 'expand-notifications');
  await tapNative(/^Open UniHub to talk$/i, { timeoutMs: 30_000 });
  await until(() => topActivity() === 'CallActivity', 'the call screen', 30_000);
  const toDesk = await flows(desk, 'the desk');
  Object.assign(results.headset, { secondsFromOpeningToSound: seconds(opened), deskHeard3s: toDesk });
  await desk.getByRole('button', { name: 'Hang up', exact: true }).click();
  await callOver();
  fullScreenIntents(true);
});

test('an answer without the microphone permission ends the call at once: the caller reads that it failed, not a ring until the limit', { timeout: 300_000 }, async () => {
  // A revoke stops the app's process: the app opens again, and its notification connection with it.
  shell('pm', 'revoke', PACKAGE, 'android.permission.RECORD_AUDIO');
  await app.device.close().catch(() => {});
  app = await openApp({ email: me.email });
  await sleep(5000);
  shell('input', 'keyevent', 'KEYCODE_HOME');
  setDevicePin();
  await sleepScreen();
  try {
    await deskCalls();
    await until(() => topActivity() === 'CallActivity', 'the call screen over the lock screen', 60_000, 250);
    const page = await callPage();
    await page.getByRole('button', { name: 'Answer', exact: true }).click();
    const answered = Date.now();
    const phoneSays = await page.getByText(/Allow the microphone/).first().innerText({ timeout: 10_000 }).catch(() => '');
    // The caller's call ends (its screen offers "Close"), well before the 45 seconds of the ring.
    await desk.getByRole('button', { name: 'Close', exact: true }).waitFor({ timeout: 15_000 });
    results.microphoneRefused = { secondsToTheCaller: seconds(answered), phoneSays, deskSays: (await desk.getByRole('dialog').innerText().catch(() => '')).slice(0, 200) };
    await desk.getByRole('button', { name: 'Close', exact: true }).click();
    await desk.getByRole('list', { name: `Messages with ${myName}` }).getByText(/^Call failed/).last().waitFor({ timeout: 30_000 });
    await callOver();
  } finally {
    shell('pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
    await unlockKeyguard().catch(() => {});
    clearDevicePin();
  }
});
