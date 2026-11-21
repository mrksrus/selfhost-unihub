// A voice call in the app's own call WebView under Android's call handling
// (Telecom, a self-managed ConnectionService), against a desktop Chromium,
// through the throwaway server of support/call-stub.mjs (the server's call
// routes are not used). It shows, with numbers:
// 1. with the app closed and the phone locked, a `call` message over the
//    notification connection rings through Telecom, full screen;
// 2. answered from the notification, sound flows both ways (WebRTC's counters;
//    the desk sends a tone, the app receives its energy);
// 3. it still flows after five minutes with the screen off and the phone in
//    Doze (the app exempt, as "Allow in background" makes it);
// 4. Telecom takes a change of route and the WebView does not undo it;
// 5. hanging up on either side ends the call, the service and the screen.
// Needs a desktop Chromium (PLAYWRIGHT_BROWSERS_PATH); skipped without one.
// About twelve minutes: UNIHUB_E2E_CALL_MINUTES shortens the wait of 3.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { _android as android, chromium } from 'playwright-core';
import {
  PACKAGE, adb, answerSlowDialogs, bridgeMessage, dumpScreen, clearDevicePin, keyguardShowing, setDevicePin, sleep, sleepScreen, tapNative, unlockKeyguard,
} from '../support/android.mjs';
import { startCallStub } from '../support/call-stub.mjs';

const minutes = Number(process.env.UNIHUB_E2E_CALL_MINUTES ?? 5);
const launched = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] }).catch(() => null);
const browserMissing = !launched && 'no desktop Chromium for the far end of the call';
const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const results = {};
const browser = launched;
let stub, savedServer;

const shell = (...args) => adb('shell', ...args);
const telecomCalls = () => shell('dumpsys', 'telecom').split('\n').filter(line => /^\s*Call TC@/.test(line) || /state=|mState=/.test(line));
// Telecom's live calls (mCalls), not its history.
const liveCalls = () => { const text = shell('dumpsys', 'telecom'); return text.slice(text.indexOf('mCalls:'), text.indexOf('mCallAudioManager:')); };
const ourCall = () => /TC@/.test(liveCalls()) && liveCalls().includes('io.github.mrksrus.unihub');
const callService = () => shell('dumpsys', 'activity', 'services', `${PACKAGE}/.CallService`);
const callServiceRunning = () => /ServiceRecord\{\w+ u0 io\.github\.mrksrus\.unihub\/\.CallService\}/.test(callService());
// The microphone's last state in Android's recording log: "not silenced" while the app may record.
const microphone = () => [...shell('dumpsys', 'audio').matchAll(/rec (\w+) riid:\d+ uid:\d+ session:\d+ src:(\w+) (not silenced|silenced) pack:io\.github\.mrksrus\.unihub/g)].at(-1)?.slice(1).join(' ') ?? '';
const serviceForeground = () => /isForeground=true/.test(callService());
const callScreen = () => shell('dumpsys', 'activity', 'activities').split('\n').some(line => /Hist.*CallActivity/.test(line));
const shownCallNotification = () => shell('dumpsys', 'notification', '--noredact').split(/\n\s*NotificationRecord\(/).some(r => r.includes(`pkg=${PACKAGE}`) && /category=call/.test(r));
const topIsCall = () => shell('dumpsys', 'activity', 'activities').split('\n').some(line => /topResumedActivity.*CallActivity/.test(line));

async function until(check, what, timeoutMs = 60_000, every = 500) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(every);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms${last ? `: ${last.message}` : ''}`);
}

const latest = (call, side) => stub.stats(call, side).at(-1);
/** The counters `seconds` ago and now, for one side. */
function window(call, side, seconds) {
  const all = stub.stats(call, side);
  const now = all.at(-1);
  const then = [...all].reverse().find(s => s.at <= now.at - seconds * 1000) ?? all[0];
  return { then, now, received: (now.received ?? 0) - (then.received ?? 0), sent: (now.sent ?? 0) - (then.sent ?? 0), energy: (now.energy ?? 0) - (then.energy ?? 0) };
}

/** Telecom's route for the call, and Android's communication device: which one it chose and who asked for which. */
function routes() {
  const telecom = [...shell('dumpsys', 'telecom').matchAll(/Entering audio route: AudioRoute\[Type=(\w+)/g)].at(-1)?.[1] ?? '';
  const audio = shell('dumpsys', 'audio');
  return {
    telecom,
    device: /Computed Preferred communication device:.*?type:(\w+)/.exec(audio)?.[1] ?? '',
    modeOwner: /Mode owner:[\s\S]*?Package: (\S+)/.exec(audio)?.[1] ?? '',
    clients: [...audio.matchAll(/CommunicationRouteClient: .*?packageName = (\S+),.*?type:(\w+).*?mIsPrivileged: (\w+)/g)].map(m => `${m[1]}=${m[2]}${m[3] === 'true' ? ' (privileged)' : ''}`),
  };
}
const offeredRoutes = () => [...adb('logcat', '-d', '-s', 'UniHubCalls:I').matchAll(/Routes: (\[[^\]]*\])/g)].at(-1)?.[1] ?? '';

/** Opens the app's main page on the stub and turns its notification connection on, as Settings does. */
async function connectApp() {
  shell('am', 'force-stop', PACKAGE);
  savedServer = shell(`run-as ${PACKAGE} cat shared_prefs/server.xml 2>/dev/null || true`);
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="origin">${stub.origin}</string></map>`;
  shell(`echo "${prefs.replace(/"/g, '\\"')}" > /data/local/tmp/unihub-call-server.xml`);
  shell(`run-as ${PACKAGE} mkdir -p shared_prefs && run-as ${PACKAGE} cp /data/local/tmp/unihub-call-server.xml shared_prefs/server.xml`);
  shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  const devices = await android.devices();
  const device = devices.find(d => d.serial() === `emulator-${process.env.UNIHUB_E2E_EMULATOR_PORT ?? '5560'}`);
  await Promise.all(devices.filter(d => d !== device).map(d => d.close().catch(() => {})));
  try {
    const page = await until(async () => {
      const current = await (await device.webView({ pkg: PACKAGE }, { timeout: 60_000 })).page();
      return (await current.evaluate(() => location.pathname)) === '/' && current;
    }, 'the app opening the stub', 180_000, 2000);
    const enabled = await bridgeMessage(page, 'notifications', 'enable', {}, { timeoutMs: 120_000 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    await until(() => stub.connected(), 'the notification connection to the stub', 120_000);
  } finally {
    await device.close().catch(() => {});
  }
}

/** The desk starts a call: its page makes the offer; the stub rings the phone. */
async function startCall(name) {
  const call = crypto.randomUUID();
  const desk = await browser.newPage();
  await desk.goto(`${stub.origin}/desk?id=${call}`);
  await until(() => stub.events(call, 'desk').length || stub.stats(call, 'desk').length || true, 'the desk', 5000);
  const rang = Date.now();
  stub.ring(call, name);
  await until(() => ourCall(), 'Telecom holding the ringing call', 60_000, 250);
  return { call, desk, rang, ringing: (Date.now() - rang) / 1000 };
}

/** Seconds from `since` until both sides count received sound and the app's side hears the tone. */
async function soundFlows(call, since, timeoutMs = 60_000) {
  await until(() => {
    const app = latest(call, 'app'), desk = latest(call, 'desk');
    return app?.received > 0 && app.energy > 0 && desk?.received > 0;
  }, `sound both ways in call ${call} (app ${JSON.stringify(latest(call, 'app'))}, events ${JSON.stringify(stub.events(call))})`, timeoutMs, 250);
  return (stub.stats(call, 'app').find(s => s.received > 0 && s.energy > 0).at - since) / 1000;
}

/** Touches a button of the call screen's page where the page says it is. */
async function tapCallPage(call, name) {
  const layout = await until(() => stub.events(call, 'app').filter(e => e.event === 'layout').at(-1), 'the call page', 60_000);
  const { ratio, buttons } = JSON.parse(layout.detail);
  const web = await until(() => /class="android\.webkit\.WebView" package="io\.github\.mrksrus\.unihub"[^>]*bounds="\[(\d+),(\d+)\]/.exec(dumpScreen()), 'the call screen\'s WebView', 30_000);
  adb('shell', 'input', 'tap', `${Math.round(+web[1] + buttons[name].x * ratio)}`, `${Math.round(+web[2] + buttons[name].y * ratio)}`);
  return Date.now();
}

async function ended(call, since) {
  await until(() => !ourCall() && !callServiceRunning() && !callScreen(), 'the call, its service and its screen ending', 30_000, 250);
  return (Date.now() - since) / 1000;
}

before(async () => {
  if (browserMissing) return;
  stub = await startCallStub();
  adb('reverse', `tcp:${stub.port}`, `tcp:${stub.port}`);
  if (sdk >= 33) shell('pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  shell('pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
  // "Allow in background" in the app's set-up.
  shell('cmd', 'deviceidle', 'whitelist', `+${PACKAGE}`);
  await connectApp();
});

after(async () => {
  if (browserMissing) return;
  console.log(`call proof: ${JSON.stringify(results)}`);
  shell('dumpsys', 'deviceidle', 'unforce');
  shell('dumpsys', 'battery', 'reset');
  try { await unlockKeyguard(); } catch { /* not locked */ }
  clearDevicePin();
  shell('svc', 'power', 'stayon', 'true');
  shell('am', 'force-stop', PACKAGE);
  // The stack's server again, as tools/e2e/android.sh set it.
  if (/<map>/.test(savedServer ?? '')) {
    shell(`echo "${savedServer.trim().replace(/"/g, '\\"')}" > /data/local/tmp/unihub-call-server.xml`);
    shell(`run-as ${PACKAGE} cp /data/local/tmp/unihub-call-server.xml shared_prefs/server.xml`);
  }
  adb('reverse', '--remove', `tcp:${stub.port}`);
  await browser?.close();
  await stub?.close();
}, { timeout: 120_000 });

test('a WebView call rings through Telecom on a locked phone and holds with the screen off and in Doze', { skip: browserMissing, timeout: (minutes + 15) * 60_000 }, async () => {
  // 1. The app closed (its task gone, its notification connection running), the phone locked and dark.
  shell('input', 'keyevent', 'KEYCODE_HOME');
  for (const [, id] of shell('dumpsys', 'activity', 'recents').matchAll(/Task\{\w+ #(\d+) type=standard A=\d+:io\.github\.mrksrus\.unihub\}/g)) shell('am', 'stack', 'remove', id);
  await until(() => !/A=\d+:io\.github\.mrksrus\.unihub\}/.test(shell('dumpsys', 'activity', 'recents')), 'the app\'s task gone', 10_000);
  setDevicePin();
  await sleepScreen();
  assert.ok(stub.connected(), 'the notification connection survives the app closing');
  const first = await startCall('Alex Example');
  results.ringSeconds = first.ringing;
  await until(() => topIsCall(), 'the call screen on top', 30_000, 250);
  const lock = shell('dumpsys', 'window');
  const fullScreen = { keyguardShowing: /isKeyguardShowing=true/.test(lock), topResumed: 'CallActivity' };
  results.keyguard = shell('dumpsys', 'activity', 'activities').split('\n').filter(line => /occluded|KeyguardShowing/i.test(line)).map(line => line.trim()).slice(0, 4);
  const notification = shell('dumpsys', 'notification', '--noredact').split(/\n\s*NotificationRecord\(/).find(r => r.includes(`pkg=${PACKAGE}`) && /category=call/.test(r)) ?? '';
  fullScreen.fullScreenIntent = /fullscreenIntent=PendingIntent/i.test(notification);
  assert.deepEqual(fullScreen, { keyguardShowing: true, topResumed: 'CallActivity', fullScreenIntent: true }, notification.slice(0, 1500));
  results.point1 = { ringSeconds: first.ringing, fullScreen };

  console.log('step 1 done');
  // 2. Answered on the full-screen call screen, the call notification's form on a locked phone
  // (its Answer button in the shade would ask for the PIN first, as Android does for any app's screen).
  await answerSlowDialogs();
  const answered = await tapCallPage(first.call, 'Answer');
  const toSound = await soundFlows(first.call, answered);
  await until(() => serviceForeground(), 'the call service in the foreground', 10_000);
  results.point2 = { lockedSecondsFromAnswerToSound: toSound, app: latest(first.call, 'app'), desk: latest(first.call, 'desk'),
    service: /types=0x\w+|foregroundServiceType=0x\w+/.exec(callService())?.[0] };

  console.log('step 2 done');
  // 4. Speaker through Telecom; the WebView keeps it while the sound goes on.
  const before4 = routes();
  stub.command(first.call, 'speaker');
  await sleep(3000);
  const speaker = routes();
  await sleep(20_000);
  results.point4 = { offered: offeredRoutes(), before: before4, speaker, after20s: { ...routes(), flowing: window(first.call, 'app', 10).received > 0 } };

  console.log('step 4 done');
  // 3. Screen off, Doze forced, for `minutes`.
  await sleepScreen();
  shell('dumpsys', 'battery', 'unplug');
  shell('dumpsys', 'deviceidle', 'force-idle');
  const dozed = shell('dumpsys', 'deviceidle', 'get', 'deep').trim();
  const samples = [];
  for (let minute = 1; minute <= minutes; minute++) {
    await sleep(60_000);
    const app = window(first.call, 'app', 30), desk = window(first.call, 'desk', 30);
    samples.push({ minute, doze: shell('dumpsys', 'deviceidle', 'get', 'deep').trim(), appReceived30s: app.received, appEnergy30s: +app.energy.toFixed(3), appSent: latest(first.call, 'app')?.sent, deskReceived30s: desk.received });
    console.log(`minute ${minute}: ${JSON.stringify(samples.at(-1))}`);
  }
  const last = samples.at(-1);
  results.point3 = { dozeAtStart: dozed, samples, microphone: microphone() };
  shell('dumpsys', 'deviceidle', 'unforce');
  shell('dumpsys', 'battery', 'reset');

  console.log('step 3 done');
  // 5a. The desk hangs up.
  const hung = Date.now();
  await first.desk.evaluate(() => window.hangUp());
  results.point5desk = { seconds: await ended(first.call, hung) };

  console.log('step 5a done');
  // 5b. Another call on the unlocked phone, answered with the call notification's Answer; the app hangs up on its call screen.
  await unlockKeyguard();
  const second = await startCall('Blair Example');
  await until(() => shownCallNotification(), 'the call notification', 30_000);
  shell('cmd', 'statusbar', 'expand-notifications');
  await sleep(1500);
  await tapNative(/^Answer$/i, { timeoutMs: 30_000 });
  const tapped = Date.now();
  const secondSound = await soundFlows(second.call, tapped);
  await until(() => topIsCall(), 'the call screen', 30_000);
  const appHung = await tapCallPage(second.call, 'Hang up');
  results.point2.unlockedSecondsFromNotificationAnswerToSound = secondSound;
  results.point5app = { seconds: await ended(second.call, appHung) };
  await until(() => stub.events(second.call, 'desk').some(e => e.event === 'ended'), 'the desk hearing the hang-up', 30_000);

  // The checks of 3 and 4, after the numbers are kept.
  assert.ok(last.appReceived30s > 500 && last.deskReceived30s > 500, `packets at ${minutes} minutes: ${JSON.stringify(last)}`);
  assert.ok(last.appEnergy30s > 0, `the tone's energy at ${minutes} minutes: ${JSON.stringify(last)}`);
  assert.equal(dozed, 'IDLE');
  assert.match(results.point3.microphone, /not silenced$/);
  for (const state of [results.point4.speaker, results.point4.after20s]) {
    assert.equal(state.telecom, 'TYPE_SPEAKER', JSON.stringify(results.point4));
    assert.equal(state.device, 'speaker', JSON.stringify(results.point4));
    assert.equal(state.modeOwner, 'com.android.server.telecom', JSON.stringify(results.point4));
  }
});
