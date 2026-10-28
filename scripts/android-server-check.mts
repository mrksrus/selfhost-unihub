// Runs the Android app against a real UniHub server on a booted emulator:
// the release-built app of each version is driven through Android's own
// accessibility tree (uiautomator), as a person would use it, and every step
// is confirmed on the server through its API.
//
//   node scripts/android-server-check.mts --window <dir> --candidate-apk <apk> --candidate-image <image>
//   node scripts/android-server-check.mts --local <url> --apk <apk> [--label <name>]
//
// CI (the first form) needs Docker, the disposable MariaDB service (MYSQL_TEST_*)
// and the support window planned by scripts/android-support-window.mts --out.
// Each pairing gets a fresh server: the image on the host network (Nginx on
// port 80, as in scripts/container-smoke.sh), an empty `_test` database, a new
// uploads volume and synthetic users. Pairings:
// - the candidate app against the candidate server;
// - the candidate app against each earlier server release in the window;
// - each earlier app in the window against the candidate server.
// The second form runs the candidate pairing against a server that is
// already running (tools/e2e/stack.sh), for development; its admin account
// comes from UNIHUB_ANDROID_ADMIN (email:password).
//
// The app reaches the server as http://127.0.0.1:<port> through adb reverse:
// the app allows plain HTTP only for development hosts, and 127.0.0.1 is a
// secure context, so service workers, Secure cookies and the microphone work as
// they do over HTTPS. The production image's cookie settings stay as shipped.
// Every flow and its result is printed; any failed flow fails the run.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const PACKAGE = 'io.github.mrksrus.unihub';
const DEVICE_PORT = 8098;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ---------------------------------------------------------------- device

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const adbPath = sdk && fs.existsSync(path.join(sdk, 'platform-tools/adb')) ? path.join(sdk, 'platform-tools/adb') : 'adb';
const serialArgs = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
function adb(...args: string[]) {
  return execFileSync(adbPath, [...serialArgs, ...args], { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const shell = (command: string) => adb('shell', command);

interface UiNode { text: string; desc: string; cls: string; pkg: string; hint: string; focused: boolean; password: boolean; x: number; y: number; top: number; bottom: number }

/** The screen as Android's accessibility tree sees it, WebView content included. */
function screen(): UiNode[] {
  for (let attempt = 0; attempt < 5; attempt++) {
    // A failed dump leaves no file behind, so an old screen is never read twice.
    shell('rm -f /data/local/tmp/unihub-ui.xml; uiautomator dump /data/local/tmp/unihub-ui.xml >/dev/null 2>&1; true');
    let xml = '';
    try { xml = shell('cat /data/local/tmp/unihub-ui.xml 2>/dev/null; true'); } catch { /* retried */ }
    if (xml.includes('<hierarchy')) {
      return [...xml.matchAll(/<node [^>]*>/g)].map(match => {
        const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '') ?? ['', '0', '0', '0', '0'];
        const decode = (value = '') => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
        return { text: decode(attrs.text), desc: decode(attrs['content-desc']), cls: attrs.class ?? '', pkg: attrs.package ?? '', hint: decode(attrs.hint),
          focused: attrs.focused === 'true', password: attrs.password === 'true', x: Math.round((+box[1] + +box[3]) / 2), y: Math.round((+box[2] + +box[4]) / 2), top: +box[2], bottom: +box[4] };
      });
    }
    execFileSync('sleep', ['1']);
  }
  return [];
}

const label = (node: UiNode) => node.text || node.desc;
const matches = (node: UiNode, pattern: RegExp) => pattern.test(node.text) || pattern.test(node.desc);
const tap = (node: UiNode) => { shell(`input tap ${node.x} ${node.y}`); };

/**
 * Waits until check(screen) returns something. A slow emulator shows "isn't
 * responding" dialogs for the app or system processes; they are answered with
 * Wait, as a person would.
 */
async function waitFor<T>(what: string, check: (nodes: UiNode[]) => T | undefined | null | false, timeoutMs = 90_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let nodes: UiNode[] = [];
  while (Date.now() < until) {
    nodes = screen();
    if (nodes.some(node => /isn't responding|keeps stopping/.test(node.text))) {
      const wait = nodes.find(node => /^wait$/i.test(node.text));
      if (wait) tap(wait);
      await sleep(2000);
      continue;
    }
    // The app's own questions after signing in (contacts or notifications on
    // this phone) cover the page; the flows here answer Not now.
    const notNow = nodes.find(node => /^not now$/i.test(node.text) && node.pkg === PACKAGE);
    if (notNow && nodes.some(node => /contacts|notifications/i.test(node.text))) {
      tap(notNow);
      await sleep(1500);
      continue;
    }
    const found = check(nodes);
    if (found) return found;
    await sleep(1000);
  }
  throw new Error(`${what} did not appear within ${timeoutMs / 1000} s; the screen showed: ${nodes.map(label).filter(Boolean).slice(0, 40).join(' | ') || '(nothing)'}`);
}
const find = (pattern: RegExp, cls?: RegExp) => (nodes: UiNode[]) => nodes.find(node => matches(node, pattern) && (!cls || cls.test(node.cls)));
let display: { width: number; height: number } | undefined;
/** The display's size, after any `wm size` override. */
function displaySize() {
  const size = [...shell('wm size').matchAll(/(\d+)x(\d+)/g)].at(-1);
  display ??= { width: Number(size?.[1] ?? 0), height: Number(size?.[2] ?? 0) };
  return display;
}
/**
 * Taps an element, scrolling the page first when it is not plainly in view:
 * the tree also lists page elements outside the WebView's viewport (with empty
 * bounds or bounds past the screen), and one near the bottom edge can sit
 * behind the navigation bar. Elements of the navigation bar itself are fixed
 * and tapped where they are.
 */
async function tapOn(what: string, pattern: RegExp, { cls, fixed = false, timeoutMs }: { cls?: RegExp; fixed?: boolean; timeoutMs?: number } = {}) {
  let node = await waitFor(what, find(pattern, cls), timeoutMs);
  const { width, height } = displaySize();
  const x = Math.round(width * 0.3);
  const outOfView = (item: UiNode) => item.bottom === 0 || item.y > height * 0.8 || item.y < height * 0.06;
  for (let scroll = 0; scroll < 8 && !fixed && node.pkg === PACKAGE && height && outOfView(node); scroll++) {
    // Towards the element; with empty bounds its place is unknown, so down
    // through the page first (forms grow downwards), then back up.
    const distance = node.bottom === 0 ? (scroll < 5 ? height * 0.4 : -height * 0.4) : Math.max(-height * 0.4, Math.min(height * 0.4, node.y - height / 2));
    shell(`input swipe ${x} ${Math.round(height / 2 + distance / 2)} ${x} ${Math.round(height / 2 - distance / 2)} 500`);
    await sleep(800);
    const before = node;
    node = await waitFor(what, find(pattern, cls), timeoutMs);
    // A page that does not scroll (or is at its end) leaves the element where it was.
    if (before.bottom !== 0 && node.y === before.y) break;
  }
  log(`       tap ${what} at ${node.x},${node.y} of ${width}x${height}`);
  tap(node);
  return node;
}

/** Taps until the screen shows the tap took effect, scrolling between tries (a tap can land behind the navigation bar). */
async function tapUntil(what: string, pattern: RegExp, done: (nodes: UiNode[]) => unknown, options: { cls?: RegExp } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await tapOn(what, pattern, options);
    if (await waitFor(`${what} to take effect`, nodes => nodes.length > 0 && !!done(nodes), 20_000).catch(() => false)) return;
    const { width, height } = displaySize();
    shell(`input swipe ${Math.round(width * 0.3)} ${Math.round(height * 0.6)} ${Math.round(width * 0.3)} ${Math.round(height * 0.35)} 500`);
    await sleep(800);
  }
  throw new Error(`tapping ${what} had no effect`);
}

const appFields = (nodes: UiNode[]) => nodes.filter(node => /EditText/.test(node.cls) && node.pkg === PACKAGE);

/** Whether the on-screen keyboard is shown (it can cover the field below the one being typed in). */
const keyboardShown = () => /mInputShown=true/.test(shell('dumpsys input_method'));
/** Hides the keyboard; Back only while it is shown, since Back otherwise leaves the page. */
async function hideKeyboard() {
  if (!keyboardShown()) return;
  shell('input keyevent 4');
  await sleep(800);
}

/** A field shows what was typed; Android may mask a password field's text in the tree. */
const shows = (node: UiNode | undefined, typed: string) => !!node && (node.text === typed || (node.password && node.text.length === typed.length));

/**
 * Types into the index-th field of the page as key events, a few characters
 * at a time, and reads the field back: a slow emulator can drop key events, so
 * a field that does not show what was typed is cleared and typed again. The
 * field is focused with Tab from the one before it, or by a tap with the
 * keyboard hidden, and typing starts only once the tree shows it focused.
 */
async function typeInto(index: number, text: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let field = await waitFor(`input field ${index + 1}`, nodes => appFields(nodes)[index]);
    if (!field.focused) {
      const previous = appFields(screen())[index - 1];
      if (previous?.focused) shell('input keyevent 61');
      else { await hideKeyboard(); tap(await waitFor(`input field ${index + 1}`, nodes => appFields(nodes)[index])); }
      field = await waitFor(`focus in field ${index + 1}`, nodes => { const node = appFields(nodes)[index]; return node?.focused && node; }, 15_000).catch(() => field);
      if (!field.focused) { log(`       field ${index + 1} did not take focus`); continue; }
    }
    await sleep(500);
    // To the end, then delete what is there.
    if (field.text) shell(`input keyevent 123 ${'67 '.repeat(field.text.length + 4)}`);
    let typed = '';
    let ok = true;
    for (const chunk of text.match(/.{1,6}/g) ?? []) {
      // `input text` splits at spaces and the device shell reads quotes.
      shell(`input text '${chunk.replace(/ /g, '%s').replace(/'/g, '')}'`);
      typed += chunk;
      const shown = await waitFor(`the typed text in field ${index + 1}`, nodes => {
        const node = appFields(nodes)[index];
        if (shows(node, typed)) return { ok: true };
        // Longer than typed, or not focused any more: typing went astray.
        return node && (!node.focused || node.text.length > typed.length) ? { ok: false } : undefined;
      }, 15_000).catch(() => ({ ok: false }));
      if (!shown.ok) { ok = false; break; }
    }
    if (ok) return;
    log(`       retyping field ${index + 1}`);
  }
  throw new Error(`could not type into field ${index + 1}`);
}

function webViewMajor() {
  const provider = /Current WebView package \(name, version\): \(([^,]+), ([\d.]+)\)/.exec(shell('dumpsys webviewupdate'));
  return { name: provider?.[1] ?? 'unknown', version: provider?.[2] ?? '0', major: Number(provider?.[2]?.split('.')[0] ?? 0) };
}

// ---------------------------------------------------------------- server API

class Session {
  cookie = '';
  csrf = '';
  base: string;
  constructor(base: string) { this.base = base; }
  async send(method: string, url: string, body?: unknown, expected = [200]) {
    const response = await fetch(this.base + url, { method, signal: AbortSignal.timeout(60_000), headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(this.csrf && method !== 'GET' ? { 'X-CSRF-Token': this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).filter(pair => !pair.endsWith('='));
    if (cookies.length) this.cookie = cookies.join('; ');
    if (!expected.includes(response.status)) throw new Error(`${method} ${url}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  }
  async json<T = Record<string, unknown>>(method: string, url: string, body?: unknown, expected?: number[]) {
    const data = await (await this.send(method, url, body, expected)).json() as T & { csrfToken?: unknown };
    if (typeof data.csrfToken === 'string') this.csrf = data.csrfToken;
    return data as T;
  }
  async bytes(url: string) { return Buffer.from(await (await this.send('GET', url)).arrayBuffer()); }
  async signIn(email: string, password: string, totpSecret?: string) {
    const first = await this.json<{ requires2fa?: boolean; challengeToken?: string }>('POST', '/api/auth/signin', { email, password });
    if (first.requires2fa) {
      if (!totpSecret) throw new Error(`${email} needs a second factor`);
      await this.json('POST', '/api/auth/2fa/login', { challenge_token: first.challengeToken, code: totp(totpSecret) });
    }
    return this;
  }
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s), as authenticator apps make it. */
function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

interface Person { email: string; password: string; totpSecret?: string }

/** Two synthetic people: one with a password only, one with two-factor sign-in. */
async function seedPeople(base: string, admin: { email: string; password: string }, run: string): Promise<{ plain: Person; twoFactor: Person }> {
  const adminSession = await new Session(base).signIn(admin.email, admin.password);
  const { signup_mode: mode } = await adminSession.json<{ signup_mode: string }>('GET', '/api/admin/settings/signup-mode');
  await adminSession.json('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' });
  const plain: Person = { email: `android-${run}@example.test`, password: `android-ci-${run}-password` };
  const twoFactor: Person = { email: `android-2fa-${run}@example.test`, password: `android-ci-${run}-2fa-password` };
  try {
    for (const [person, name] of [[plain, 'Android Check'], [twoFactor, 'Android Second Factor']] as const) {
      await new Session(base).json('POST', '/api/auth/signup', { email: person.email, password: person.password, full_name: name }, [200, 201]);
    }
  } finally {
    await adminSession.json('PUT', '/api/admin/settings/signup-mode', { signup_mode: mode });
  }
  const session = await new Session(base).signIn(twoFactor.email, twoFactor.password);
  const { secret } = await session.json<{ secret: string }>('POST', '/api/auth/2fa/setup/start', {});
  await session.json('POST', '/api/auth/2fa/setup/confirm', { secret, code: totp(secret), current_password: twoFactor.password });
  twoFactor.totpSecret = secret;
  return { plain, twoFactor };
}

/** The app's own sessions of a person, as the server lists them. */
async function appSessions(session: Session) {
  const { sessions } = await session.json<{ sessions: { id: string; userAgent?: string | null; user_agent?: string | null }[] }>('GET', '/api/auth/sessions');
  return sessions
    .filter(item => /UniHubAndroid\//.test(item.userAgent ?? item.user_agent ?? ''));
}
async function until<T>(what: string, check: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(1000);
  }
  throw new Error(`${what} within ${timeoutMs / 1000} s${last ? ` (${(last as Error).message})` : ''}`);
}

// ---------------------------------------------------------------- the app

/** A one-second synthetic tone as a WAV file: the bytes to upload and download. */
function toneWav() {
  const rate = 8000, samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const authPage = (nodes: UiNode[]) => nodes.some(node => node.text === 'Password') && nodes.find(node => /^Sign in$/.test(label(node)) && /Button/.test(node.cls));
const codePage = find(/^Verify and sign in$/, /Button/);
/** Signed in: the phone's navigation bar is shown. */
const signedIn = (nodes: UiNode[]) => !authPage(nodes) && nodes.find(node => /^More/.test(label(node)) && node.pkg === PACKAGE);

function install(apk: string) {
  try { adb('uninstall', PACKAGE); } catch { /* not installed */ }
  adb('install', apk);
  for (const permission of ['android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS']) {
    try { shell(`pm revoke ${PACKAGE} ${permission}`); } catch { /* not requested by this app or this Android */ }
  }
}

/** Connects the app as a person does from the browser: the "Open in app" link, then Connect. */
async function connect(origin: string) {
  shell(`am force-stop ${PACKAGE}`);
  shell(`am start -a android.intent.action.VIEW -d '${`unihub://connect?server=${encodeURIComponent(origin)}`}' ${PACKAGE}`);
  const host = new URL(origin).hostname;
  await tapOn('the question to connect', /^connect$/i, { cls: /Button/, fixed: true });
  await waitFor(`the sign-in page of ${host}`, authPage, 180_000);
}

async function fillSignIn(person: Person) {
  await waitFor('the sign-in fields', nodes => appFields(nodes).length >= 2);
  await typeInto(0, person.email);
  await typeInto(1, person.password);
  await hideKeyboard();
  await tapOn('Sign in', /^Sign in$/, { cls: /Button/ });
}

async function navigateTo(page: string) {
  await waitFor('the navigation bar', signedIn);
  const direct = screen().find(node => label(node) === page && node.pkg === PACKAGE);
  if (direct) { log(`       tap ${page} at ${direct.x},${direct.y}`); tap(direct); }
  else {
    await tapOn('More', /^More/, { fixed: true });
    await tapOn(page, new RegExp(`^${page}$`));
  }
}

/** Picks a file in Android's document picker from Downloads. */
async function pickFromDownloads(name: string) {
  await waitFor('the document picker', nodes => nodes.some(node => /documentsui|providers\.media|photopicker/.test(node.pkg)), 60_000);
  const visible = screen().find(node => node.text === name);
  if (!visible) {
    await tapOn('the picker\'s roots', /^Show roots$/);
    await tapOn('Downloads', /^Downloads?$/);
  }
  await tapOn(name, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

const deviceSha = (file: string) => shell(`sha256sum '${file}' 2>/dev/null | cut -d' ' -f1; true`).trim();

interface Step { name: string; ok: boolean; detail: string }
interface Pairing { app: string; apk: string; server: string; origin: string; base: string; admin: { email: string; password: string } }

/** Every flow for one app and one server; a failed step ends the pairing. */
async function runPairing(pairing: Pairing, run: string): Promise<Step[]> {
  const steps: Step[] = [];
  const step = async (name: string, action: () => Promise<string>) => {
    const started = Date.now();
    try {
      const detail = await action();
      steps.push({ name, ok: true, detail });
      log(`  ok   ${name}: ${detail} (${Math.round((Date.now() - started) / 1000)} s)`);
    } catch (error) {
      steps.push({ name, ok: false, detail: (error as Error).message.split('\n')[0].slice(0, 300) });
      log(`  FAIL ${name}: ${(error as Error).message}`);
      const shot = path.join(evidence, `${pairing.app}-app-${pairing.server}-server-${name.replace(/\W+/g, '-')}.png`);
      try { shell('screencap -p /data/local/tmp/unihub-screen.png'); adb('pull', '/data/local/tmp/unihub-screen.png', shot); log(`       screen: ${shot}`); } catch { /* best effort */ }
      throw error;
    }
  };

  let people: Awaited<ReturnType<typeof seedPeople>>;
  let plainApi: Session;
  try {
    people = await seedPeople(pairing.base, pairing.admin, run);
    plainApi = await new Session(pairing.base).signIn(people.plain.email, people.plain.password);
  } catch (error) {
    throw new Error(`seeding the synthetic people failed: ${(error as Error).message}`);
  }
  const { plain, twoFactor } = people;
  const tone = toneWav();
  const toneName = `unihub-ci-${run}.wav`;
  const toneSha = crypto.createHash('sha256').update(tone).digest('hex');
  const local = path.join(os.tmpdir(), toneName);
  fs.writeFileSync(local, tone);

  try {
    await step('install and connect', async () => {
      install(pairing.apk);
      adb('reverse', `tcp:${new URL(pairing.origin).port}`, `tcp:${new URL(pairing.base).port || 80}`);
      await connect(pairing.origin);
      return `${pairing.app} app at ${pairing.origin}`;
    });
    await step('sign in', async () => {
      await fillSignIn(plain);
      await waitFor('the signed-in app', signedIn, 120_000);
      const sessions = await until('the app\'s session on the server', async () => { const list = await appSessions(plainApi); return list.length === 1 && list; });
      return `signed in; server lists the app's session (${sessions[0].userAgent ?? sessions[0].user_agent})`;
    });
    await step('reopen', async () => {
      // Left with Home, then ended as Android ends a background app.
      shell('input keyevent 3');
      await sleep(3000);
      shell(`am force-stop ${PACKAGE}`);
      shell(`am start -n ${PACKAGE}/.MainActivity`);
      await waitFor('the signed-in app after a restart', signedIn, 120_000);
      return 'still signed in after the app was left, ended and started again';
    });
    let recordingId = '';
    await step('upload (file picker)', async () => {
      adb('push', local, `/sdcard/Download/${toneName}`);
      shell('content call --method scan_volume --uri content://media --arg external_primary >/dev/null 2>&1; true');
      await navigateTo('Recordings');
      await tapOn('Import audio file', /^Import audio file$/);
      await pickFromDownloads(toneName);
      await waitFor('the imported audio', find(/^Save the imported audio$/), 60_000);
      await hideKeyboard();
      await tapUntil('Save recording', /^Save recording$/, nodes => !find(/^Save the imported audio$/)(nodes), { cls: /Button/ });
      const recording = await until('the uploaded recording on the server', async () => {
        const { recordings } = await plainApi.json<{ recordings: { id: string; title: string }[] }>('GET', '/api/recordings');
        return recordings.find(item => item.title === toneName.replace(/\.wav$/, ''));
      }, 120_000);
      recordingId = recording.id;
      const stored = await plainApi.bytes(`/api/recordings/${recording.id}/file?download=1`);
      if (crypto.createHash('sha256').update(stored).digest('hex') !== toneSha) throw new Error(`the server holds ${stored.length} bytes, not the ${tone.length} picked`);
      shell(`rm -f '/sdcard/Download/${toneName}'`);
      return `${toneName} picked in Android's picker; the server holds the same ${tone.length} bytes (sha256 ${toneSha.slice(0, 12)})`;
    });
    await step('download', async () => {
      const title = toneName.replace(/\.wav$/, '');
      await tapOn(`the actions of ${title}`, new RegExp(`^More actions for ${title}$`));
      await tapOn('Download', /^Download$/);
      const file = await until('the downloaded file in Downloads', async () => {
        const listing = shell(`ls /sdcard/Download/ 2>/dev/null; true`).split(/\r?\n/).map(name => name.trim());
        const name = listing.find(item => item.startsWith(title) && !item.endsWith('.pending'));
        return name && deviceSha(`/sdcard/Download/${name}`) === toneSha && name;
      }, 90_000);
      shell(`rm -f '/sdcard/Download/${file}'`);
      return `saved to Downloads as ${file}, byte-identical to the upload`;
    });
    // 0.25.0 adds Open with…, Save to Downloads and Share for files
    // (feat/0.25.0-android-files): their steps join here, for apps and
    // servers from 0.25.0, and their names join STEP_NAMES below.
    await step('microphone', async () => {
      const before = (await plainApi.json<{ recordings: unknown[] }>('GET', '/api/recordings')).recordings.length;
      await tapOn('Record', /^Record$/, { cls: /Button/ });
      const allow = await waitFor('Android\'s microphone question', find(/^(While using the app|Allow|ALLOW|Only this time)$/), 60_000);
      tap(allow);
      await waitFor('the running recorder', find(/^Stop$/, /Button/), 60_000);
      const granted = shell(`dumpsys package ${PACKAGE}`).includes('android.permission.RECORD_AUDIO: granted=true');
      if (!granted) throw new Error('Android does not list the microphone permission as granted');
      await sleep(3000);
      await tapOn('Stop', /^Stop$/, { cls: /Button/ });
      await waitFor('the recording to save', find(/^Save the recording$/), 60_000);
      await hideKeyboard();
      await tapUntil('Save recording', /^Save recording$/, nodes => !find(/^Save the recording$/)(nodes), { cls: /Button/ });
      const made = await until('the recording on the server', async () => {
        const { recordings: list } = await plainApi.json<{ recordings: { id: string; size_bytes?: number }[] }>('GET', '/api/recordings');
        return list.length > before && list.find(item => item.id !== recordingId);
      }, 120_000);
      if (!(Number(made.size_bytes) > 0)) throw new Error('the recording reached the server empty');
      return `permission asked and granted; ${made.size_bytes} bytes recorded with the microphone reached the server`;
    });
    await step('sign out', async () => {
      await navigateTo('More');
      await tapOn('Sign out', /^Sign out$/);
      await waitFor('the sign-in page after signing out', authPage, 120_000);
      await until('the app\'s session to end on the server', async () => (await appSessions(plainApi)).length === 0);
      return 'back on the sign-in page; the server no longer lists the app\'s session';
    });
    await step('sign in with two-factor code', async () => {
      await fillSignIn(twoFactor);
      await waitFor('the authentication code field', nodes => codePage(nodes) && appFields(nodes).length === 1, 120_000);
      // A fresh code, not one about to expire while it is typed.
      if (Date.now() % 30_000 > 22_000) await sleep(30_000 - (Date.now() % 30_000) + 500);
      await typeInto(0, totp(twoFactor.totpSecret!));
      await hideKeyboard();
      await tapOn('Verify and sign in', /^Verify and sign in$/, { cls: /Button/ });
      await waitFor('the signed-in app', signedIn, 120_000);
      const twoFactorApi = await new Session(pairing.base).signIn(twoFactor.email, twoFactor.password, twoFactor.totpSecret);
      await until('the two-factor session on the server', async () => (await appSessions(twoFactorApi)).length === 1);
      return 'password and authentication code accepted; the server lists the app\'s session';
    });
  } catch { /* recorded in steps */ } finally {
    fs.rmSync(local, { force: true });
  }
  return steps;
}

// ---------------------------------------------------------------- servers (CI)

const MYSQL = { host: process.env.MYSQL_TEST_HOST || '127.0.0.1', port: process.env.MYSQL_TEST_PORT || '3306', database: process.env.MYSQL_TEST_DATABASE || 'unihub_test',
  user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password' };
const ADMIN = { email: 'android-admin@example.test', password: 'android-ci-admin-password-2026' };
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Empties the disposable `_test` database, so an older server never meets a newer schema. */
async function freshDatabase() {
  if (!/^[A-Za-z0-9_]+_test$/.test(MYSQL.database) || !['127.0.0.1', 'localhost'].includes(MYSQL.host)) throw new Error('Only a loopback *_test database may be reset');
  const mysql = createRequire(path.join(repo, 'api/package.json'))('mysql2/promise');
  const connection = await mysql.createConnection({ host: MYSQL.host, port: Number(MYSQL.port), user: MYSQL.user, password: MYSQL.password });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${MYSQL.database}\``);
    await connection.query(`CREATE DATABASE \`${MYSQL.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally { await connection.end(); }
}

async function startServer(image: string, name: string) {
  await freshDatabase();
  docker('volume', 'create', `${name}-uploads`);
  // As scripts/container-smoke.sh: host network for the loopback MariaDB, the
  // reference Compose restrictions, and the image's own NODE_ENV=production.
  docker('run', '-d', '--name', name, '--network', 'host', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'NET_BIND_SERVICE', '--cap-add', 'SETGID', '--cap-add', 'SETUID',
    '--mount', `type=volume,source=${name}-uploads,target=/app/uploads`,
    '-e', `MYSQL_HOST=${MYSQL.host}`, '-e', `MYSQL_PORT=${MYSQL.port}`, '-e', `MYSQL_DATABASE=${MYSQL.database}`, '-e', `MYSQL_USER=${MYSQL.user}`, '-e', `MYSQL_PASSWORD=${MYSQL.password}`,
    // The app's address as the installation guide sets it for a proxy: Nginx
    // forwards the host without the emulator's port.
    '-e', `ALLOWED_ORIGINS=http://127.0.0.1:${DEVICE_PORT}`,
    '-e', `BOOTSTRAP_ADMIN_EMAIL=${ADMIN.email}`, '-e', `BOOTSTRAP_ADMIN_PASSWORD=${ADMIN.password}`,
    '-e', `ENCRYPTION_KEY=android-ci-encryption-key-${name}`, '-e', `BACKUP_MASTER_KEY=android-ci-backup-key-${name}`, '-e', `JWT_SECRET=android-ci-jwt-secret-${name}`,
    image);
  for (let attempt = 0; attempt < 90; attempt++) {
    if (docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') break;
    const healthy = await fetch('http://127.0.0.1/health', { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false);
    if (healthy) return (await (await fetch('http://127.0.0.1/api/version')).json() as { server: string }).server;
    await sleep(2000);
  }
  console.log(spawnSync('docker', ['logs', '--tail', '80', name], { encoding: 'utf8' }).stdout);
  throw new Error(`${image} did not become healthy`);
}
function stopServer(name: string) {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', `${name}-uploads`], { stdio: 'ignore' });
}

// ---------------------------------------------------------------- main

const evidence = path.resolve(argument('--evidence') || process.env.UNIHUB_ANDROID_EVIDENCE || path.join(os.tmpdir(), 'unihub-android-server'));
fs.mkdirSync(evidence, { recursive: true });
const rows: { app: string; server: string; steps: Step[]; error?: string }[] = [];
const webView = webViewMajor();
const sdkLevel = shell('getprop ro.build.version.sdk').trim();
const release = shell('getprop ro.build.version.release').trim();
// The web app is built for current browsers (Vite's default target); an
// emulator image whose WebView is older cannot run it, as no updated phone can.
const MIN_WEBVIEW = 107;
log(`Android ${release} (API ${sdkLevel}), WebView ${webView.name} ${webView.version}`);
if (webView.major < MIN_WEBVIEW) {
  console.error(`This emulator's WebView ${webView.version} is older than ${MIN_WEBVIEW}, which the web app needs; real-server flows cannot run here.`);
  process.exit(1);
}

const localServer = argument('--local');
const run = Date.now().toString(36);
if (localServer) {
  const apk = argument('--apk');
  const [email, ...rest] = (process.env.UNIHUB_ANDROID_ADMIN || '').split(':');
  if (!apk || !email) throw new Error('--local needs --apk and UNIHUB_ANDROID_ADMIN=email:password');
  const base = localServer.replace(/\/$/, '');
  const name = argument('--label') || 'local';
  log(`Pairing: ${name} app with the server at ${base}`);
  try {
    // The stack allows only its own address (ALLOWED_ORIGINS), so the device uses the same port.
    rows.push({ app: name, server: 'local', steps: await runPairing({ app: name, apk, server: 'local', origin: `http://127.0.0.1:${new URL(base).port || 80}`, base, admin: { email, password: rest.join(':') } }, run) });
  } catch (error) {
    rows.push({ app: name, server: 'local', steps: [], error: (error as Error).message.split('\n')[0] });
    log(`  FAIL ${(error as Error).message}`);
  }
} else {
  const windowDir = argument('--window'), candidateApk = argument('--candidate-apk'), candidateImage = argument('--candidate-image');
  if (!windowDir || !candidateApk || !candidateImage) throw new Error('usage: --window <dir> --candidate-apk <apk> --candidate-image <image>');
  const support = JSON.parse(fs.readFileSync(path.join(repo, 'android/support-window.json'), 'utf8')) as { releases: { version: string; shell: string }[] };
  const [current, ...earlier] = support.releases;
  const repository = process.env.UNIHUB_IMAGE_REPOSITORY || 'ghcr.io/mrksrus/selfhost-unihub';
  const pairings: { app: string; apk: string; server: string; image: string }[] = [{ app: current.version, apk: candidateApk, server: current.version, image: candidateImage }];
  for (const item of earlier) pairings.push({ app: current.version, apk: candidateApk, server: item.version, image: `${repository}:${item.version}` });
  for (const item of earlier) {
    const apk = path.join(windowDir, item.version, 'unihub.apk');
    if (item.shell === 'supported' && fs.existsSync(apk)) pairings.push({ app: item.version, apk, server: current.version, image: candidateImage });
    else rows.push({ app: item.version, server: current.version, steps: [], error: `not run: ${item.shell === 'supported' ? 'app not collected' : `app ${item.shell}`}` });
  }
  for (const pairing of pairings) {
    const name = `unihub-android-${process.env.GITHUB_RUN_ID || 'local'}-${pairing.app}-${pairing.server}`.replace(/\./g, '-');
    log(`Pairing: ${pairing.app} app with the ${pairing.server} server (${pairing.image})`);
    try {
      const reported = await startServer(pairing.image, name);
      if (reported !== pairing.server && pairing.image !== candidateImage) throw new Error(`${pairing.image} reports server ${reported}`);
      rows.push({ app: pairing.app, server: pairing.server, steps: await runPairing({ ...pairing, origin: `http://127.0.0.1:${DEVICE_PORT}`, base: 'http://127.0.0.1', admin: ADMIN }, run) });
    } catch (error) {
      rows.push({ app: pairing.app, server: pairing.server, steps: [], error: (error as Error).message.split('\n')[0] });
      log(`  FAIL ${(error as Error).message}`);
    } finally {
      stopServer(name);
    }
  }
}
try { shell(`am force-stop ${PACKAGE}`); adb('reverse', '--remove-all'); } catch { /* already gone */ }

const STEP_NAMES = ['install and connect', 'sign in', 'reopen', 'upload (file picker)', 'download', 'microphone', 'sign out', 'sign in with two-factor code'];
let failed = false;
console.log(`\nAndroid ${release} (API ${sdkLevel}), WebView ${webView.version}: apps against real servers`);
console.log(`App      Server   Result   ${STEP_NAMES.map((_, index) => index + 1).join(' ')}   Detail`);
for (const row of rows) {
  const notRun = row.error?.startsWith('not run');
  const ok = !row.error && row.steps.length === STEP_NAMES.length && row.steps.every(item => item.ok);
  if (!ok && !notRun) failed = true;
  const marks = STEP_NAMES.map(name => { const item = row.steps.find(entry => entry.name === name); return item ? (item.ok ? '✓' : '✗') : '-'; }).join(' ');
  const detail = row.error ?? row.steps.find(item => !item.ok)?.detail ?? 'every flow passed';
  console.log(`${row.app.padEnd(8)} ${row.server.padEnd(8)} ${(notRun ? 'not-run' : ok ? 'ok' : 'FAILED').padEnd(8)} ${marks}   ${detail}`);
}
console.log(`Flows: ${STEP_NAMES.map((name, index) => `${index + 1} ${name}`).join(', ')}.`);
fs.writeFileSync(path.join(evidence, `android-${sdkLevel}.json`), JSON.stringify({ android: release, api: sdkLevel, webView: webView.version, rows }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Android ${release} (API ${sdkLevel}) against real servers`, '',
    `| App | Server | Result | ${STEP_NAMES.join(' | ')} |`, `| --- | --- | --- | ${STEP_NAMES.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.app} | ${row.server} | ${row.error ?? (row.steps.every(item => item.ok) && row.steps.length === STEP_NAMES.length ? 'ok' : 'FAILED')} | ${STEP_NAMES.map(name => { const item = row.steps.find(entry => entry.name === name); return item ? (item.ok ? '✓' : '✗') : '–'; }).join(' | ')} |`),
    ''].join('\n') + '\n');
}
process.exitCode = failed ? 1 : 0;
