// A voice call in the app's own call WebView under Android's call handling
// (Telecom, through Jetpack's Core-Telecom), against a desktop Chromium,
// through the throwaway server of support/call-stub.mjs (the server's call
// routes are not used). It shows, with numbers:
// 1. with the app closed and the phone locked, a `call` message over the
//    notification connection rings through Telecom, full screen;
// 2. answered from the notification, sound flows both ways (WebRTC's counters;
//    the desk sends a tone, the app receives its energy);
// 3. it still flows after five minutes with the screen off and the phone in
//    Doze (the app exempt, as "Allow in background" makes it);
// 4. Telecom takes a change of route and the WebView does not undo it;
// 5. hanging up on either side ends the call, the service and the screen, and
//    the microphone is released;
// 6. answered by a headset's button (Telecom's own answer, not the app's
//    screen or notification) with the app in the background and the phone
//    locked, the call runs with the microphone and sound both ways: (a) over
//    the call screen the ring put on the lock screen; (b) with full-screen
//    call screens off, where Android refuses the call screen and the
//    microphone until the person unlocks and opens the call notification.
// And an `end` right behind its `ring` leaves nothing ringing.
// Needs a desktop Chromium (PLAYWRIGHT_BROWSERS_PATH); skipped without one.
// About fifteen minutes: UNIHUB_E2E_CALL_MINUTES shortens the wait of 3.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { _android as android, chromium } from 'playwright-core';
import {
  PACKAGE, adb, answerSlowDialogs, bridgeMessage, dumpScreen, screenNodes, clearDevicePin, keyguardShowing, setDevicePin, sleep, sleepScreen, tapNative, unlockKeyguard,
} from '../support/android.mjs';
import { startCallStub } from '../support/call-stub.mjs';

const minutes = Number(process.env.UNIHUB_E2E_CALL_MINUTES ?? 5);
const launched = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] }).catch(() => null);
const browserMissing = !launched && 'no desktop Chromium for the far end of the call';
const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
const results = {};
const browser = launched;
let stub, savedServer, shadeTitle;

const shell = (...args) => adb('shell', ...args);
// Telecom's live calls (mCalls), not its history.
const liveCalls = () => { const text = shell('dumpsys', 'telecom'); return text.slice(text.indexOf('mCalls:'), text.indexOf('mCallAudioManager:')); };
const ourCall = (state = '\\w+') => new RegExp(`state=${state}, tpac=ComponentInfo\\{io\\.github\\.mrksrus\\.unihub/`).test(liveCalls());
const callService = () => shell('dumpsys', 'activity', 'services', `${PACKAGE}/.CallService`);
const callServiceRunning = () => /ServiceRecord\{\w+ u0 io\.github\.mrksrus\.unihub\/\.CallService\}/.test(callService());
// The microphone's last state in Android's recording log: "not silenced" while the app may record.
const microphone = () => [...shell('dumpsys', 'audio').matchAll(/rec (\w+) riid:\d+ uid:\d+ session:\d+ src:(\w+) (not silenced|silenced) pack:io\.github\.mrksrus\.unihub/g)].at(-1)?.slice(1).join(' ') ?? '';
// After a hang-up the log's last entry for the app is the recording's end.
const released = () => { const last = microphone(); return /^(stop|release)\b/.test(last) && last; };
const serviceForeground = () => /isForeground=true/.test(callService());
// The service's foreground types: phoneCall is 0x4, microphone 0x80.
const serviceTypes = () => Number(/isForeground=true\b[^\n]*?\btypes=(0x[0-9a-f]+)/i.exec(callService())?.[1] ?? 0);
const fullScreenIntents = allowed => shell('appops', 'set', PACKAGE, 'USE_FULL_SCREEN_INTENT', allowed ? 'allow' : 'deny');
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
  await until(() => stub.stats(call, 'desk').length, 'the desk\'s call', 15_000);
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

/**
 * Rings, lets `ready` check the screen, sends a headset's hook key and waits for Telecom's answer;
 * `then` may bring the sound in; then a minute of sound is measured and the desk hangs up.
 */
async function headsetAnswer(name, ready, then) {
  const ring = await startCall(name);
  const result = await ready(ring.call);
  adb('logcat', '-c');
  const hooked = Date.now();
  adb('shell', 'input', 'keyevent', 'KEYCODE_HEADSETHOOK');
  try {
    await until(() => ourCall('ACTIVE'), 'Telecom making the call active', 30_000, 250);
    result.secondsToActive = (Date.now() - hooked) / 1000;
    Object.assign(result, await then(ring.call));
    result.secondsFromHookToSound = await soundFlows(ring.call, hooked);
    await sleep(60_000);
    const app = window(ring.call, 'app', 60), desk = window(ring.call, 'desk', 60);
    Object.assign(result, { appReceived60s: app.received, appEnergy60s: +app.energy.toFixed(3), deskReceived60s: desk.received,
      microphone: microphone(), serviceTypes: `0x${serviceTypes().toString(16)}`, keyguard: /isKeyguardShowing=true/.test(adb('shell', 'dumpsys', 'window')) });
  } finally {
    result.telecom = liveCalls().split('\n').filter(line => /Call id=/.test(line)).map(line => line.trim().slice(0, 140));
    result.events = stub.events(ring.call, 'app').map(e => `${e.event} ${e.detail}`.trim().slice(0, 80)).slice(-8);
    console.log(`${name}: ${JSON.stringify(result)}`);
  }
  const hung = Date.now();
  await ring.desk.evaluate(() => window.hangUp());
  result.hangUpSeconds = await ended(ring.call, hung);
  return result;
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
  fullScreenIntents(true);
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
    serviceTypes: `0x${serviceTypes().toString(16)}` };
  assert.equal(serviceTypes() & 0x84, 0x84, `phoneCall and microphone: ${callService().split('\n').filter(line => /isForeground|types=/.test(line)).join('\n')}`);

  console.log('step 2 done');
  // 4. Speaker through Telecom; the WebView keeps it while the sound goes on.
  const before4 = routes();
  stub.command(first.call, 'speaker');
  await sleep(3000);
  const speaker = routes();
  await sleep(20_000);
  results.point4 = { offered: offeredRoutes(), before: before4, speaker, after20s: { ...routes(), flowing: window(first.call, 'app', 10).received > 0 },
    requested: /Route 4: (.*)/.exec(adb('logcat', '-d', '-s', 'UniHubCalls:I'))?.[1] };

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
  results.point5desk = { seconds: await ended(first.call, hung), microphone: await until(released, 'the microphone released', 15_000) };

  console.log('step 5a done');
  // 5b. Another call on the unlocked phone, answered with the call notification's Answer; the app hangs up on its call screen.
  await unlockKeyguard();
  const second = await startCall('Blair Example');
  await until(() => shownCallNotification(), 'the call notification', 30_000);
  shell('cmd', 'statusbar', 'expand-notifications');
  await sleep(1500);
  // Where the shade shows the call's name: uiautomator cannot read the shade once a call's timer runs in it (6b).
  shadeTitle = screenNodes().find(n => n.text === 'Blair Example');
  await tapNative(/^Answer$/i, { timeoutMs: 30_000 });
  const tapped = Date.now();
  const secondSound = await soundFlows(second.call, tapped);
  await until(() => topIsCall(), 'the call screen', 30_000);
  const appHung = await tapCallPage(second.call, 'Hang up');
  results.point2.unlockedSecondsFromNotificationAnswerToSound = secondSound;
  results.point5app = { seconds: await ended(second.call, appHung), microphone: await until(released, 'the microphone released', 15_000) };
  await until(() => stub.events(second.call, 'desk').some(e => e.event === 'ended'), 'the desk hearing the hang-up', 30_000);

  console.log('step 5b done');
  // 6a. A headset answers on the locked, dark phone: the ring put the call screen over the lock screen by itself.
  shell('input', 'keyevent', 'KEYCODE_HOME');
  await sleepScreen();
  results.point6 = { sent: 'adb shell input keyevent KEYCODE_HEADSETHOOK' };
  results.point6.lockScreen = await headsetAnswer('Casey Example', async call => {
    await until(() => topIsCall(), 'the call screen on top', 30_000, 250);
    return { callScreenBeforeHook: true };
  }, async () => ({}));
  console.log('step 6a done');

  // 6b. Full-screen call screens off, so nothing of the app is on screen when the headset answers. Android then
  // refuses the call screen and the microphone; the person gets them by unlocking (or from the call notification).
  fullScreenIntents(false);
  await sleepScreen();
  // Past the seconds in which Android still lets an app that was just on screen open one.
  await sleep(15_000);
  results.point6.nothingOnScreen = await headsetAnswer('Drew Example', async () => {
    await until(() => shownCallNotification(), 'the call notification', 30_000);
    await sleep(2000);
    return { callScreenBeforeHook: callScreen() };
  }, async call => {
    await sleep(5000);
    const answered = { callScreen: callScreen(), serviceTypes: `0x${serviceTypes().toString(16)}`,
      log: adb('logcat', '-d', '-s', 'ActivityTaskManager:E', 'ActivityManager:W', 'UniHubCalls:W').split('\n')
        .filter(line => /unihub/i.test(line)).map(line => line.replace(/^.*?: /, '').slice(0, 220)) };
    await unlockKeyguard();
    const unlocked = Date.now();
    const screenAfterUnlock = await until(() => topIsCall(), 'the call screen after unlocking', 10_000).catch(() => false);
    if (!screenAfterUnlock) {
      shell('cmd', 'statusbar', 'expand-notifications');
      await sleep(1500);
      assert.ok(shadeTitle, 'the call notification\'s place in the shade');
      shell('input', 'tap', `${shadeTitle.x}`, `${shadeTitle.y}`);
      await until(() => topIsCall(), 'the call screen', 30_000);
    }
    const secondsFromUnlockToSound = await soundFlows(call, unlocked);
    await until(() => (serviceTypes() & 0x84) === 0x84, 'the microphone type once the call screen is up', 15_000);
    await sleepScreen();
    return { answered, callScreenAfterUnlock: screenAfterUnlock, secondsFromUnlockToSound, serviceTypesWithScreen: `0x${serviceTypes().toString(16)}` };
  });
  fullScreenIntents(true);

  // An `end` right behind its `ring`, before Telecom has the call: nothing keeps ringing.
  const brief = crypto.randomUUID();
  stub.ring(brief, 'Eli Example');
  stub.stopRing(brief);
  await sleep(10_000);
  results.endRightAfterRing = { telecom: ourCall(), notification: shownCallNotification() };
  assert.deepEqual(results.endRightAfterRing, { telecom: false, notification: false });

  // The checks of 3 and 4, after the numbers are kept.
  assert.ok(last.appReceived30s > 500 && last.deskReceived30s > 500, `packets at ${minutes} minutes: ${JSON.stringify(last)}`);
  assert.ok(last.appEnergy30s > 0, `the tone's energy at ${minutes} minutes: ${JSON.stringify(last)}`);
  assert.equal(dozed, 'IDLE');
  assert.deepEqual(samples.map(s => s.doze), samples.map(() => 'IDLE'), JSON.stringify(samples));
  for (const [name, six] of Object.entries(results.point6).filter(([, v]) => typeof v === 'object')) {
    assert.ok(six.appReceived60s > 1000 && six.deskReceived60s > 1000 && six.appEnergy60s > 0, `${name}: ${JSON.stringify(six)}`);
    assert.match(six.microphone, /not silenced$/, name);
    assert.equal(Number(six.serviceTypes) & 0x84, 0x84, name);
  }
  assert.equal(results.point6.lockScreen.callScreenBeforeHook, true);
  assert.equal(results.point6.nothingOnScreen.callScreenBeforeHook, false, 'nothing of the app on screen before the headset answers');
  assert.match(results.point3.microphone, /not silenced$/);
  assert.equal(results.point4.requested, 'CallControlResult(Success)', JSON.stringify(results.point4));
  for (const state of [results.point4.speaker, results.point4.after20s]) {
    assert.equal(state.telecom, 'TYPE_SPEAKER', JSON.stringify(results.point4));
    assert.equal(state.device, 'speaker', JSON.stringify(results.point4));
    assert.equal(state.modeOwner, 'com.android.server.telecom', JSON.stringify(results.point4));
  }
});
