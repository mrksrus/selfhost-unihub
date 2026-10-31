// Helpers for tests of the real Android app (tools/e2e/android/*.test.mjs).
// The page inside the app is driven through Playwright's Android driver (the
// debug build enables WebView debugging); Android's own screens (file picker,
// permission dialogs, notifications) through adb and uiautomator.
import { execFileSync } from 'node:child_process';
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
      adb('shell', 'uiautomator', 'dump', '/data/local/tmp/unihub-ui.xml');
      break;
    } catch (error) {
      if (/dumped to/.test(String(error.stdout ?? ''))) break;
      if (attempt >= 3) throw error;
    }
  }
  return adb('shell', 'cat', '/data/local/tmp/unihub-ui.xml');
}

/** Android's on-screen nodes: text, description and centre. */
export function screenNodes() {
  const xml = dumpScreen();
  return [...xml.matchAll(/<node [^>]*>/g)].map(match => {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    return { text: attrs.text ?? '', desc: attrs['content-desc'] ?? '', id: attrs['resource-id'] ?? '', pkg: attrs.package ?? '',
      x: box ? (+box[1] + +box[3]) / 2 : 0, y: box ? (+box[2] + +box[4]) / 2 : 0 };
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
export async function dismissFirstRunOffers() {
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
  const device = (await android.devices()).find(d => d.serial() === serial);
  if (!device) throw new Error(`${serial} not found; run tools/e2e/android.sh up`);
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
        await dismissFirstRunOffers();
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
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  const xml = dumpScreen();
  const node = [...xml.matchAll(/<node [^>]*>/g)].map(match => match[0]).find(tag => tag.includes('class="android.webkit.WebView"'));
  const web = node && /bounds="\[(\d+),(\d+)\]/.exec(node);
  if (!web) throw new Error('the WebView is not on screen');
  return { x: Math.round(+web[1] + (box.x + box.width / 2) * ratio), y: Math.round(+web[2] + (box.y + box.height / 2 + dy) * ratio), ratio };
}
