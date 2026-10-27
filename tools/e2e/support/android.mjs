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

/** Android's on-screen nodes: text, description and centre. */
export function screenNodes() {
  adb('shell', 'uiautomator', 'dump', '/data/local/tmp/unihub-ui.xml');
  const xml = adb('shell', 'cat', '/data/local/tmp/unihub-ui.xml');
  return [...xml.matchAll(/<node [^>]*>/g)].map(match => {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    return { text: attrs.text ?? '', desc: attrs['content-desc'] ?? '', id: attrs['resource-id'] ?? '', pkg: attrs.package ?? '',
      x: box ? (+box[1] + +box[3]) / 2 : 0, y: box ? (+box[2] + +box[4]) / 2 : 0 };
  });
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

/** Copies synthetic files into the emulator's Downloads, where the picker shows them. */
export function pushToDownloads(...files) {
  adb('push', ...files, '/sdcard/Download/');
  adb('shell', 'content', 'call', '--method', 'scan_volume', '--uri', 'content://media', '--arg', 'external_primary');
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

/** A fresh app asks once whether to show UniHub contacts on the phone; tests that are not about it answer Not now. */
export async function dismissContactsOffer() {
  const nodes = screenNodes();
  if (!nodes.some(n => /contacts on this phone/i.test(n.text))) return;
  const notNow = nodes.find(n => /^not now$/i.test(n.text));
  if (notNow) adb('shell', 'input', 'tap', `${notNow.x}`, `${notNow.y}`);
}

/** The app's page, signed in as the given synthetic user. */
export async function openApp({ email = 'admin@example.com', password = 'local-dev-admin-password' } = {}) {
  const device = (await android.devices()).find(d => d.serial() === serial);
  if (!device) throw new Error(`${serial} not found; run tools/e2e/android.sh up`);
  const webView = await device.webView({ pkg: PACKAGE }, { timeout: 180_000 });
  const page = await webView.page();
  page.setDefaultTimeout(60_000);
  await page.waitForLoadState();
  if (new URL(page.url()).pathname.startsWith('/auth')) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(url => !url.pathname.startsWith('/auth'), { timeout: 120_000 }).catch(() => {});
  }
  // Signing in reloads the app, which replaces the WebView's page target:
  // wait for a page that is signed in and answers.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const current = await (await device.webView({ pkg: PACKAGE }, { timeout: 60_000 })).page();
      const path = await current.evaluate(() => location.pathname);
      if (!path.startsWith('/auth')) {
        await current.waitForLoadState();
        await dismissContactsOffer();
        current.setDefaultTimeout(60_000);
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
