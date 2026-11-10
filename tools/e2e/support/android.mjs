// Helpers for tests of the real Android app (tools/e2e/android/*.test.mjs).
// The page inside the app is driven through Playwright's Android driver (the
// debug build enables WebView debugging); Android's own screens (file picker,
// permission dialogs, notifications) through adb and uiautomator.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { _android as android } from 'playwright-core';

const SDK = process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/Sdk`;
export const serial = `emulator-${process.env.UNIHUB_E2E_EMULATOR_PORT ?? '5560'}`;
export const PACKAGE = 'io.github.mrksrus.unihub';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function adb(...args) {
  return execFileSync(`${SDK}/platform-tools/adb`, ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
}

/**
 * Android's view hierarchy as uiautomator's XML. On a slow emulator the dump
 * is sometimes killed (exit 137) after or before writing the file: retry.
 */
export function dumpScreen() {
  for (let attempt = 1; ; attempt++) {
    try {
      try {
        adb('shell', 'uiautomator', 'dump', '/data/local/tmp/unihub-ui.xml');
      } catch (error) {
        if (!/dumped to/.test(String(error.stdout ?? ''))) throw error;
      }
      // The dump can also report success and leave no file.
      return adb('shell', 'cat', '/data/local/tmp/unihub-ui.xml');
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** Android's on-screen nodes: text, description and centre. */
export function screenNodes() {
  const xml = dumpScreen();
  return [...xml.matchAll(/<node [^>]*>/g)].map(match => {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    return { text: attrs.text ?? '', desc: attrs['content-desc'] ?? '', id: attrs['resource-id'] ?? '', pkg: attrs.package ?? '',
      password: attrs.password === 'true', x: box ? (+box[1] + +box[3]) / 2 : 0, y: box ? (+box[2] + +box[4]) / 2 : 0 };
  });
}

/** Answers "isn't responding" dialogs of a slow emulator with Wait, so they do not cover the app. */
export async function answerSlowDialogs() {
  for (let i = 0; i < 5; i++) {
    const nodes = screenNodes();
    if (!nodes.some(n => /isn't responding|keeps stopping/.test(n.text))) return;
    const wait = nodes.find(n => n.text === 'Wait') ?? nodes.find(n => n.text === 'Close app');
    if (wait) adb('shell', 'input', 'tap', `${wait.x}`, `${wait.y}`);
    await sleep(2000);
  }
}

/**
 * Taps the first native node whose text or description matches. A slow
 * emulator shows "isn't responding" dialogs for system processes; they are
 * answered with Wait and the search goes on.
 */
export async function tapNative(pattern, { long = false, timeoutMs = 60_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const nodes = screenNodes();
    if (nodes.some(n => /isn't responding|keeps stopping/.test(n.text))) {
      const wait = nodes.find(n => n.text === 'Wait') ?? nodes.find(n => n.text === 'Close app');
      if (wait) adb('shell', 'input', 'tap', `${wait.x}`, `${wait.y}`);
      await sleep(2000);
      continue;
    }
    const node = nodes.find(n => pattern.test(n.text) || pattern.test(n.desc));
    if (node) {
      if (long) adb('shell', 'input', 'swipe', `${node.x}`, `${node.y}`, `${node.x}`, `${node.y}`, '900');
      else adb('shell', 'input', 'tap', `${node.x}`, `${node.y}`);
      return node;
    }
    await sleep(1000);
  }
  throw new Error(`no native element matching ${pattern} within ${timeoutMs} ms`);
}

/** The names MediaStore lists in Downloads (what the picker shows). */
export function downloadsIndex() {
  return [...adb('shell', 'content', 'query', '--uri', 'content://media/external/file', '--projection', '_display_name',
    // adb joins the arguments into one shell line on the device, which would drop plain quotes.
    '--where', "relative_path=\\'Download/\\'").matchAll(/_display_name=([^,\r\n]+)/g)].map(match => match[1].trim());
}

/**
 * Copies synthetic files into the emulator's Downloads, where the picker shows
 * them. Each file is scanned on its own: a whole-volume scan takes minutes on a
 * two-core Android 16 emulator.
 */
export async function pushToDownloads(...files) {
  adb('push', ...files, '/sdcard/Download/');
  const names = files.map(file => file.split('/').pop());
  for (const name of names) adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file:///sdcard/Download/${name}`);
  for (let attempt = 0; attempt < 90; attempt++) {
    const listed = downloadsIndex();
    if (names.every(name => listed.includes(name))) return;
    await sleep(2000);
  }
  throw new Error(`MediaStore did not list ${names.join(', ')}`);
}

/** Picks files in Android's document picker from Downloads; several files use its selection mode. */
export async function pickFromDownloads(names) {
  await tapNative(/^Show roots$/);
  await tapNative(/^Downloads$/);
  await sleep(2000);
  if (names.length === 1) {
    await tapNative(new RegExp(`^${names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 14)}`));
  } else {
    await tapNative(new RegExp(`^${names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 14)}`), { long: true });
    for (const name of names.slice(1)) await tapNative(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 14)}`));
  }
  // With `multiple` the picker waits for Select even for one file.
  const select = screenNodes().find(n => /^Select$|^SELECT$/.test(n.text));
  if (select) adb('shell', 'input', 'tap', `${select.x}`, `${select.y}`);
}

/**
 * The app's own first-run questions (contacts on the phone, notifications)
 * appear over the page whenever it meets a server for the first time; tests
 * that are not about them answer Not now.
 */
export async function dismissFirstRunOffers({ waitMs = 0 } = {}) {
  // Right after signing in, an offer can still be on its way: look for it a little while.
  const until = Date.now() + waitMs;
  while (!screenNodes().some(n => /contacts on this phone|notifications on this phone/i.test(n.text))) {
    if (Date.now() >= until) return;
    await sleep(1000);
  }
  for (let i = 0; i < 3; i++) {
    const nodes = screenNodes();
    if (!nodes.some(n => /contacts on this phone|notifications on this phone/i.test(n.text))) return;
    const notNow = nodes.find(n => /^not now$/i.test(n.text));
    if (!notNow) return;
    adb('shell', 'input', 'tap', `${notNow.x}`, `${notNow.y}`);
    await sleep(1500);
  }
}

/** The app's page, signed in as the given synthetic user. */
export async function openApp({ email = 'admin@example.com', password = 'local-dev-admin-password', restart = true } = {}) {
  // Each test starts from a freshly launched app, not from what an earlier test left open.
  if (restart) {
    adb('shell', 'am', 'force-stop', PACKAGE);
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  }
  // An open device handle keeps the test process running: close every one this call does not return.
  const devices = await android.devices();
  const device = devices.find(d => d.serial() === serial);
  await Promise.all(devices.filter(d => d !== device).map(d => d.close().catch(() => {})));
  if (!device) throw new Error(`${serial} not found; run tools/e2e/android.sh up`);
  try {
    return await signedInPage(device, { email, password });
  } catch (error) {
    await device.close().catch(() => {});
    throw error;
  }
}

async function signedInPage(device, { email, password }) {
  await device.webView({ pkg: PACKAGE }, { timeout: 180_000 });
  // The page may still be on its way to /auth or to the start page (slow
  // emulators), and signing in reloads it, which replaces the WebView's page
  // target: look at the current page until it is signed in, signing in
  // whenever it shows the sign-in form.
  let signIns = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const current = await (await device.webView({ pkg: PACKAGE }, { timeout: 60_000 })).page();
      current.setDefaultTimeout(60_000);
      await current.waitForLoadState();
      const path = await current.evaluate(() => location.pathname);
      if (path.startsWith('/auth')) {
        if (signIns < 3 && await current.getByLabel('Email').isVisible()) {
          await answerSlowDialogs();
          await current.getByLabel('Email').fill(email);
          await current.getByLabel('Password').fill(password);
          // A form still rendering may clear what was typed; then try again.
          if (await current.getByLabel('Email').inputValue() === email) {
            signIns++;
            await current.getByRole('button', { name: 'Sign in' }).last().click();
            await current.waitForURL(url => !url.pathname.startsWith('/auth'), { timeout: 60_000 }).catch(() => {});
          }
        }
      } else if (path !== '/') {
        await answerSlowDialogs();
        await dismissFirstRunOffers({ waitMs: signIns > 0 ? 10_000 : 0 });
        return { device, page: current };
      }
    } catch { /* the target went away mid-check; take the next one */ }
    await sleep(2000);
  }
  throw new Error('the app did not reach a signed-in page');
}

/** Opens a path of the app the way a person would land there, without a new page target. */
export async function navigate(page, path) {
  if (new URL(page.url()).pathname === path) return;
  await page.evaluate(target => { window.history.pushState({}, '', target); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  await page.waitForURL(url => url.pathname === path);
}

/** A screenshot of the whole device (native screens included) for evidence. */
export function deviceScreenshot(path) {
  adb('shell', 'screencap', '-p', '/data/local/tmp/unihub-screen.png');
  adb('pull', '/data/local/tmp/unihub-screen.png', path);
}

/**
 * Touches a page element with a real tap on the screen, as a finger would:
 * some controls (Radix pickers in the WebView) do not open on Playwright's
 * synthetic click. Page pixels become screen pixels from the WebView's place.
 */
export async function touch(page, locator) {
  await answerSlowDialogs();
  await locator.scrollIntoViewIfNeeded();
  const { x, y } = await screenPoint(page, locator);
  adb('shell', 'input', 'tap', `${x}`, `${y}`);
}

/**
 * Where a page element's centre (moved by `dy` page pixels) is on the screen,
 * in screen pixels for `adb shell input`, once the element stays put (the
 * page may still be moving: the on-screen keyboard opening, a scroll ending).
 * Fails when that point is outside the visible WebView, or when something
 * else (a header, a bar, another row) is on top of it there: a finger put
 * there would touch something else, and the test would fail later for a
 * reason it does not name.
 */
export async function screenPoint(page, locator, { dy = 0 } = {}) {
  let box = await locator.boundingBox();
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(400);
    const next = await locator.boundingBox();
    if (box && next && Math.abs(next.x - box.x) < 1 && Math.abs(next.y - box.y) < 1) break;
    box = next;
  }
  if (!box) throw new Error('the element is not on screen');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy };
  const seen = await locator.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return { inside: point.x >= 0 && point.y >= 0 && point.x < window.innerWidth && point.y < window.innerHeight,
      own: !!hit && (hit === element || element.contains(hit)),
      other: hit ? `${hit.tagName.toLowerCase()} "${(hit.textContent ?? '').trim().slice(0, 40)}"` : 'nothing',
      ratio: window.devicePixelRatio };
  }, at);
  const where = `page point (${Math.round(at.x)}, ${Math.round(at.y)})`;
  if (!seen.inside) throw new Error(`the element's ${where} is outside the visible page; bring it into view first`);
  if (!seen.own) throw new Error(`the element's ${where} is covered by ${seen.other}; a touch there would not reach it`);
  const xml = dumpScreen();
  const node = [...xml.matchAll(/<node [^>]*>/g)].map(match => match[0]).find(tag => tag.includes('class="android.webkit.WebView"'));
  const web = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  if (!web) throw new Error('the WebView is not on screen');
  const point = { x: Math.round(+web[1] + at.x * seen.ratio), y: Math.round(+web[2] + at.y * seen.ratio), ratio: seen.ratio };
  if (point.x < +web[1] || point.x >= +web[3] || point.y < +web[2] || point.y >= +web[4])
    throw new Error(`the element's screen point (${point.x}, ${point.y}) is outside the WebView [${web[1]},${web[2]}][${web[3]},${web[4]}]`);
  return point;
}

/** This instance's state folder (tools/e2e/stack.sh). */
export function stackState() {
  const instance = process.env.UNIHUB_E2E_INSTANCE ?? '1';
  return process.env.UNIHUB_E2E_STATE ?? `${process.env.HOME}/.local/state/unihub-e2e${instance === '1' ? '' : `-${instance}`}`;
}

/**
 * The stack's nginx log of download ticket requests (tools/e2e/stack.sh), in
 * order: the token's first eight characters, status, Range and whether a
 * Cookie header came. `ticketOf(url)` gives the prefix of a ticket URL.
 */
export function ticketLog() {
  let text = '';
  try { text = readFileSync(`${stackState()}/log/nginx-tickets.log`, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return text.split('\n').map(line => /ticket=(\S+) (\d+) bytes=(\d+) range="([^"]*)" cookie=(absent|present)$/.exec(line)).filter(Boolean)
    .map(([, ticket, status, bytes, range, cookie]) => ({ ticket, status: Number(status), bytes: Number(bytes), range, cookie }));
}

export const ticketOf = url => new URL(url, 'http://ticket.invalid').pathname.split('/').pop().slice(0, 8);

// ── The phone's own lock, for the app lock (0.29.0) ──────────────────
// The CI emulator (API 36 google_apis) has a virtual fingerprint sensor driven
// by `adb emu finger`; it has no face unlock. The 0.29 CI spike measured these
// steps: the PIN in about a second, enrolment in three touches and about 50 s,
// an unlock about 2 s after a touch. More than one or two wrong fingers in a
// row can lock the whole phone ("Device was locked, too many authentication
// attempts"), so tests use at most one at a time.

export const DEVICE_PIN = '1111';

/** Sets the emulator's screen-lock PIN and keeps the screen on, so the keyguard only appears when a test asks for it. */
export function setDevicePin(pin = DEVICE_PIN) {
  let out = '';
  try { out = adb('shell', 'locksettings', 'set-pin', pin); } catch (error) { out = String(error.stdout ?? ''); }
  // A PIN left by an earlier attempt of the file: replace it with itself.
  if (!/Pin set/.test(out)) out = adb('shell', 'locksettings', 'set-pin', '--old', pin, pin);
  if (!/Pin set/.test(out)) throw new Error(`locksettings set-pin: ${out.trim()}`);
  adb('shell', 'svc', 'power', 'stayon', 'true');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '2147483647');
}

/** Removes the PIN again, so later files run without a screen lock. On Android 16 this also deletes the enrolled fingerprints. */
export function clearDevicePin(pin = DEVICE_PIN) {
  try { adb('shell', 'locksettings', 'clear', '--old', pin); } catch { /* no PIN set */ }
}

/** How many fingerprints are enrolled (dumpsys fingerprint's "count"). */
export function enrolledFingerprints() {
  const counts = [...adb('shell', 'dumpsys', 'fingerprint').matchAll(/"count"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
  return counts.length ? Math.max(...counts) : 0;
}

/** One touch of the virtual sensor: finger 1 is the enrolled one, any other id a stranger's. */
export async function touchFinger(id = 1) {
  adb('emu', 'finger', 'touch', `${id}`);
  await sleep(800);
  adb('emu', 'finger', 'remove');
  await sleep(500);
}

/**
 * Enrols finger 1 through Settings as a person would: the PIN, the
 * introduction (More, I agree / Next), then touches until "Fingerprint added".
 * Needs setDevicePin first. Does nothing when a finger is already enrolled.
 */
export async function enrollFingerprint({ pin = DEVICE_PIN, finger = 1, timeoutMs = 180_000 } = {}) {
  if (enrolledFingerprints() > 0) return;
  const tap = node => adb('shell', 'input', 'tap', `${node.x}`, `${node.y}`);
  const until = Date.now() + timeoutMs;
  // A Settings screen left by an earlier attempt would be brought back and
  // end at once (cancelled): Settings starts fresh, and again when it stops
  // moving for a minute.
  let started = 0, changed = 0, last = '';
  while (Date.now() < until) {
    if (Date.now() - changed > 60_000 && Date.now() - started > 60_000) {
      adb('shell', 'am', 'force-stop', 'com.android.settings');
      adb('shell', 'am', 'start', '-a', 'android.settings.FINGERPRINT_ENROLL');
      started = changed = Date.now();
    }
    await sleep(1000);
    let nodes;
    try { nodes = screenNodes(); } catch { continue; }
    const seen = nodes.map(n => n.text).join('|');
    if (seen !== last) { last = seen; changed = Date.now(); }
    const text = nodes.map(n => n.text).join('\n');
    if (/isn't responding|keeps stopping/.test(text)) { await answerSlowDialogs(); continue; }
    if (/fingerprint added/i.test(text)) {
      const done = nodes.find(n => /^done$/i.test(n.text));
      if (done) tap(done);
      break;
    }
    if (nodes.some(n => n.password) && /PIN/.test(text)) {
      adb('shell', 'input', 'text', pin);
      adb('shell', 'input', 'keyevent', '66');
      await sleep(1500);
      continue;
    }
    // Settings writes its buttons in capitals: MORE, I AGREE, NEXT.
    const button = [/^i agree$/i, /^next$/i, /^more$/i].map(re => nodes.find(n => re.test(n.text))).find(Boolean);
    if (button) { tap(button); continue; }
    if (/touch the sensor|lift, then touch/i.test(text)) await touchFinger(finger);
  }
  for (let i = 0; i < 10 && enrolledFingerprints() === 0; i++) await sleep(1000);
  adb('shell', 'am', 'force-stop', 'com.android.settings');
  if (enrolledFingerprints() === 0) throw new Error(`fingerprint enrolment did not finish; last screen: ${last.slice(0, 300)}`);
}

/** The app's unlock prompt (BiometricPrompt, or Settings' credential screen on Android 10) is on screen. */
export function unlockPromptShown(title = 'Unlock UniHub') {
  return screenNodes().some(n => n.text === title);
}

/** Waits for the app's unlock prompt. */
export async function waitForUnlockPrompt(title = 'Unlock UniHub', timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (unlockPromptShown(title)) return;
    await sleep(500);
  }
  throw new Error(`no unlock prompt "${title}" within ${timeoutMs} ms`);
}

/** Answers a shown unlock prompt with the phone's PIN through its "Use PIN" button. */
export async function answerPromptWithPin(pin = DEVICE_PIN) {
  if (!screenNodes().some(n => n.password)) await tapNative(/^Use PIN$/i, { timeoutMs: 10_000 });
  const until = Date.now() + 15_000;
  while (!screenNodes().some(n => n.password)) {
    if (Date.now() > until) throw new Error('the PIN field did not appear');
    await sleep(500);
  }
  await sleep(1000);
  adb('shell', 'input', 'text', pin);
  adb('shell', 'input', 'keyevent', '66');
}

/** Whether the app's native cover (AppLock) is over the page. */
export function lockCoverShown() {
  return screenNodes().some(n => n.desc === 'UniHub is locked' && n.pkg === PACKAGE);
}

/** Whether Android's lock screen has the focus. A pulled-down shade looks the same on Android 16; tests do not open it. */
export function keyguardShowing() {
  return /mCurrentFocus=.*\b(NotificationShade|StatusBar)\b/.test(adb('shell', 'dumpsys', 'window'));
}

/** Turns the screen off; with a PIN set, the keyguard is up when it comes back on. */
export async function sleepScreen() {
  adb('shell', 'svc', 'power', 'stayon', 'false');
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  await sleep(3000);
}

/** Wakes the screen and unlocks the keyguard with the PIN, or with a finger when `finger` is given. */
export async function unlockKeyguard({ pin = DEVICE_PIN, finger } = {}) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await sleep(2000);
  if (finger) {
    await touchFinger(finger);
  } else {
    adb('shell', 'wm', 'dismiss-keyguard');
    await sleep(1500);
    const [, w, h] = /(\d+)x(\d+)\s*$/.exec(adb('shell', 'wm', 'size').trim()).map(Number);
    adb('shell', 'input', 'swipe', `${w / 2}`, `${Math.round(h * 0.85)}`, `${w / 2}`, `${Math.round(h * 0.25)}`, '250');
    await sleep(1500);
    adb('shell', 'input', 'text', pin);
    adb('shell', 'input', 'keyevent', '66');
  }
  await sleep(3000);
  adb('shell', 'svc', 'power', 'stayon', 'true');
  if (keyguardShowing()) throw new Error('the keyguard is still showing');
}

/**
 * The share of the screen's middle band in a colour (`[r, g, b]`, each
 * within 40), or `empty` when Android refuses the capture: Android 10
 * gives no picture while a secure window is shown, Android 16 a black one.
 */
export function screenShare(colour) {
  const raw = execFileSync(`${SDK}/platform-tools/adb`, ['-s', serial, 'exec-out', 'screencap'], { maxBuffer: 64 << 20 });
  if (raw.length < 16) return { empty: true, share: 0, black: 0 };
  const width = raw.readUInt32LE(0), height = raw.readUInt32LE(4);
  const header = raw.length - width * height * 4;
  let matching = 0, black = 0, total = 0;
  for (let y = Math.floor(height * 0.3); y < Math.floor(height * 0.7); y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = header + (y * width + x) * 4;
      if (colour.every((value, c) => Math.abs(raw[i + c] - value) <= 40)) matching++;
      if (raw[i] < 16 && raw[i + 1] < 16 && raw[i + 2] < 16) black++;
      total++;
    }
  }
  return { empty: false, share: matching / total, black: black / total };
}

/** Whether the app's window carries FLAG_SECURE (dumpsys window). */
export function windowIsSecure(pkg = PACKAGE) {
  const block = adb('shell', 'dumpsys', 'window', 'windows').split(/\n(?=\s*Window #)/).find(part => part.includes(`${pkg}/`));
  return !!block && /\bfl=[^\n]*\bSECURE\b/.test(block);
}

/**
 * Sends a bridge message straight from the test, as src/lib/platform.ts does
 * (`type` with an `id`), and resolves with the app's reply. The page keeps the
 * app's unsolicited app lock events in `window.__appLockEvents`.
 */
export async function bridgeMessage(page, type, action, fields = {}, { timeoutMs = 60_000 } = {}) {
  return page.evaluate(({ type, action, fields, timeoutMs }) => new Promise((resolve, reject) => {
    const bridge = window.UniHubAndroid;
    if (!bridge) { reject(new Error('no UniHubAndroid bridge in this WebView')); return; }
    if (!window.__bridgeListening) {
      window.__bridgeListening = true;
      window.__appLockEvents = [];
      window.__bridgeReplies = new Map();
      bridge.addEventListener('message', event => {
        let reply;
        try { reply = JSON.parse(event.data); } catch { return; }
        if (reply?.type === 'appLock' && reply.event) window.__appLockEvents.push(reply.event);
        else if (reply?.id) window.__bridgeReplies.get(reply.id)?.(reply);
      });
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.__bridgeReplies.delete(id); reject(new Error(`no reply to ${type} ${action}`)); }, timeoutMs);
    window.__bridgeReplies.set(id, reply => { clearTimeout(timer); window.__bridgeReplies.delete(id); resolve(reply); });
    bridge.postMessage(JSON.stringify({ type, id, action, ...fields }));
  }), { type, action, fields, timeoutMs });
}

/** The page's `appLock` bridge message (bridge level 3). */
export const appLockMessage = (page, action, fields = {}, options = {}) => bridgeMessage(page, 'appLock', action, fields, options);

/** The app's shown notifications as Android lists them, unredacted: title and text per notification. */
export function shownNotifications(pkg = PACKAGE) {
  return adb('shell', 'dumpsys', 'notification', '--noredact').split(/\n\s*NotificationRecord\(/).slice(1)
    .filter(record => record.includes(`pkg=${pkg}`))
    .map(record => ({
      title: /android\.title=\S+ \((.*)\)$/m.exec(record)?.[1] ?? '',
      text: /android\.text=\S+ \((.*)\)$/m.exec(record)?.[1] ?? '',
    }));
}

/** A session of a seeded person against the stack's API, from the test itself. */
export async function stackSession(email = 'admin@example.com', password = 'local-dev-admin-password') {
  const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;
  const response = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`sign-in as ${email}: ${response.status}`);
  const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return async (method, path, data) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken,
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, data: json };
  };
}
