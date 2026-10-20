// Release check: an open UniHub web app updates to another build in a real
// browser.
//
//   node scripts/pwa-update-check.mts --local|--image <image> [--old <version|dir>] [--new <version|dir|next>]
//
// --old is the build the browser has open: a published release (read from its
// image) or a directory; default dist/ (npm run build). --new is the build
// deployed next; the default "next" is the old build with a changed page, as
// the following release will be, so this build's own service worker is what
// hands over. A small server stands in for Nginx: it serves one build,
// switches to the other as a deployment does, and forwards /api to a
// disposable installation (scripts/fresh-installations.mts). In Chromium:
//
// - tab A, signed in and controlled by the old service worker, has a request
//   to the server that never finishes;
// - tab B has a new contact typed but not saved, and a recording upload in
//   progress;
// - the new build is deployed, tab A shows "UniHub update ready" and its
//   "Refresh now" is pressed.
//
// Tab A must load the new version. Tab B must not reload (the typed contact
// stays), must be told about the update, its upload must complete, and the
// contact must save afterwards.
//
// Builds up to 0.21.2 send API requests through their worker, so the open
// request blocks the update (CHANGELOG 0.21.3). From those the check expects
// the failure notice, then that closing the tabs, as the notice says, loads
// the new version. --expect-failure demands the failure from any build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { freePort, installationFactory, repo, type Installation } from './fresh-installations.mts';
import { readPublishedFiles, writeFiles } from './published-image.mts';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
// The last release whose worker answered /api requests itself.
const LAST_BLOCKING_WORKER = '0.21.2';
const compare = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const oldArgument = argument('--old') || path.join(repo, 'dist'), newArgument = argument('--new') || 'next';
const isVersion = (value: string) => /^\d+\.\d+\.\d+$/.test(value);
const blocking = isVersion(oldArgument) && compare(oldArgument, LAST_BLOCKING_WORKER) <= 0;
const expectFailure = process.argv.includes('--expect-failure') || blocking;
const browserBinary = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(file => file && fs.existsSync(file));
if (!browserBinary) throw new Error('No Chromium or Chrome found; set CHROMIUM_BIN.');
const factory = installationFactory();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-pwa-update-'));
/** What identifies a build in the open page: the test marker of a "next" build, and the entry script. */
const buildId = (directory: string) => {
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  return `${/<meta name="unihub-test-build" content="([^"]+)"/.exec(html)?.[1] || ''}|${/<script type="module"[^>]*src="([^"]+)"/.exec(html)?.[1]}`;
};
const loadedBuild = '`${document.querySelector(\'meta[name="unihub-test-build"]\')?.content || ""}|${document.querySelector(\'script[type="module"]\')?.getAttribute("src")}`';

async function buildDir(value: string, name: string) {
  if (!isVersion(value)) {
    const directory = path.resolve(value);
    if (!fs.existsSync(path.join(directory, 'sw.js'))) throw new Error(`${directory} has no built web app; run npm run build first.`);
    return { directory, label: directory };
  }
  const published = await readPublishedFiles(value, 'web');
  if (!published) throw new Error(`The published ${value} image has no web build`);
  const directory = path.join(work, name);
  writeFiles(published.files, directory);
  return { directory, label: `${published.image}@${published.digest}` };
}

/** The same build with a changed page and precache entry: what a following release deploys. */
function nextBuild(from: string) {
  const directory = path.join(work, 'next');
  fs.cpSync(from, directory, { recursive: true });
  const index = path.join(directory, 'index.html'), worker = path.join(directory, 'sw.js');
  const html = fs.readFileSync(index, 'utf8').replace('<head>', '<head><meta name="unihub-test-build" content="next">');
  const sw = fs.readFileSync(worker, 'utf8');
  if (!/url:"index\.html",revision:"[0-9a-f]+"/.test(sw)) throw new Error('sw.js has no precache entry for index.html');
  fs.writeFileSync(index, html);
  fs.writeFileSync(worker, sw.replace(/(url:"index\.html",revision:")[0-9a-f]+"/, `$1${crypto.createHash('md5').update(html).digest('hex')}"`));
  return { directory, label: `${from} with a changed page` };
}

// ── A stand-in for Nginx ─────────────────────────────────────────────────

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain' };
let root = '';
let backend = '';
const stalled = new Set<() => void>();
const seen: string[] = [];
const answered: string[] = [];
function serve(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url || '/', 'http://localhost');
  seen.push(`${request.method} ${url.pathname}`);
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    // Test requests marked __unihub_stall wait until the scenario releases them.
    const forward = () => {
      url.searchParams.delete('__unihub_stall');
      const upstream = http.request(`${backend}${url.pathname}${url.search}`, { method: request.method, headers: { ...request.headers, host: new URL(backend).host } }, answer => {
        answered.push(`${request.method} ${url.pathname} ${answer.statusCode}`);
        response.writeHead(answer.statusCode || 502, answer.headers);
        answer.pipe(response);
      });
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
    };
    if (url.searchParams.has('__unihub_stall')) stalled.add(forward); else forward();
    return;
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep) && file !== root) { response.writeHead(400).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (url.pathname.startsWith('/assets/')) { response.writeHead(404).end(); return; }
    file = path.join(root, 'index.html');
  }
  const stat = fs.statSync(file);
  const headers: Record<string, string> = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Last-Modified': stat.mtime.toUTCString(),
    ETag: `"${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')}"` };
  // As docker/nginx/default.conf.
  if (url.pathname === '/sw.js') Object.assign(headers, { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' });
  else if (url.pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, immutable, max-age=31536000';
  else if (url.pathname === '/manifest.webmanifest') headers['Cache-Control'] = 'no-cache';
  if (request.headers['if-none-match'] === headers.ETag) { response.writeHead(304, headers).end(); return; }
  response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : fs.readFileSync(file));
}

// ── Chromium over the DevTools pipe ──────────────────────────────────────

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const profile = path.join(work, 'profile');
const browser = spawn(browserBinary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--no-sandbox', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
// Its own process group, so its helpers can be ended with it.
{ stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true });
let browserLog = '';
browser.stderr!.on('data', chunk => { browserLog = (browserLog + chunk).slice(-4000); });
// A Chrome killed after it stopped answering closes the pipe with an error;
// the commands still waiting time out on their own.
for (const stream of [browser.stdio[3], browser.stdio[4]]) stream?.on('error', () => {});
const pending = new Map<number, Pending>();
let sequence = 0, buffer = '';
(browser.stdio[4] as Readable).on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const waiter = message.id ? pending.get(message.id) : undefined;
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
  }
});
// A browser-level command (no page session) that gets no answer means Chrome
// itself stopped answering, not that the app failed (CI runs 39285675264 and
// 39483538018). The check then exits with STUCK and CI runs it once more.
class BrowserStuck extends Error {}
const STUCK = 75;
function command(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const message = `Timed out: ${method}\n${browserLog}`;
      reject(sessionId ? new Error(message) : new BrowserStuck(message));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    (browser.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate<T = unknown>(session: string, expression: string): Promise<T> {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session) as { result: { value: T }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
  return result.result.value;
}
/** Polls an expression; navigation in between is not an error. */
async function waitFor<T>(session: string, expression: string, description: string, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await evaluate<T>(session, expression); if (value) return value; last = value; } catch (error) { last = (error as Error).message; }
    await sleep(250);
  }
  throw new Error(`${description} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}
// Headless Chrome sometimes never answers Target.createTarget (CI run
// 39285675264). Ask again, and use a blank page an unanswered request may
// still have opened.
async function createBlankTab() {
  const known = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    try {
      const { targetId } = await command('Target.createTarget', { url: 'about:blank' }, undefined, 15000) as { targetId: string };
      return targetId;
    } catch (error) {
      if (attempt === 3) throw error;
      console.log(`Opening a tab timed out (attempt ${attempt}); trying again.`);
      const { targetInfos } = await command('Target.getTargets') as { targetInfos: { targetId: string; type: string; url: string; attached: boolean }[] };
      const blank = targetInfos.find(item => item.type === 'page' && item.url === 'about:blank' && !item.attached && !known.has(item.targetId));
      if (blank) return blank.targetId;
      for (const item of targetInfos) known.add(item.targetId);
    }
  }
}
async function openTab(url: string) {
  const targetId = await createBlankTab();
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  await command('Page.enable', {}, sessionId);
  await command('Page.navigate', { url }, sessionId);
  await waitFor(sessionId, 'document.readyState === "complete" && location.href !== "about:blank"', `${url} did not load`);
  return sessionId;
}
const signedInUi = 'Boolean(document.querySelector(\'nav[aria-label="Main"]\'))';

// ── The scenario ─────────────────────────────────────────────────────────

let installation: Installation | null = null;
const server = http.createServer(serve);
let outcome: 'updated' | 'failed' | null = null;
try {
  scenario: {
    const old = await buildDir(oldArgument, 'old');
    const next = newArgument === 'next' ? nextBuild(old.directory) : await buildDir(newArgument, 'new');
    const oldDir = old.directory, newDir = next.directory;
    if (buildId(oldDir) === buildId(newDir)) {
      // A browser sees no update between identical builds, so there is nothing to check.
      if (newArgument === 'next') throw new Error('The changed page was not detected');
      console.log(`Not run: ${old.label} has the same web build as ${next.label}; the browser has nothing to update.`);
      break scenario;
    }
    console.log(`Updating the web app from ${old.label} to ${next.label}${expectFailure ? ' (expected to fail first: old worker)' : ''} (${factory.describe})`);
    const admin = { email: 'pwa-update@example.test', password: `pwa-${crypto.randomBytes(9).toString('hex')}` };
    const port = await freePort();
    // http://localhost is a secure context, so the service worker runs as over HTTPS.
    const origin = `http://localhost:${port}`;
    installation = await factory.start({ name: 'pwa', adminEmail: admin.email, adminPassword: admin.password, allowedOrigins: origin });
    backend = installation.url;
    root = oldDir;
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));

    const a = await openTab(`${origin}/`);
    await evaluate(a, `fetch('/api/auth/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(admin)}) }).then(response => response.status)`)
      .then(status => assert.equal(status, 200, 'sign-in'));
    await evaluate(a, 'navigator.serviceWorker.ready.then(() => true)');
    await command('Page.navigate', { url: `${origin}/contacts` }, a);
    await waitFor(a, `navigator.serviceWorker.controller !== null && ${signedInUi}`, 'Tab A: the old service worker controls a signed-in page');
    assert.equal(await evaluate(a, loadedBuild), buildId(oldDir), 'Tab A runs the old build');
    const b = await openTab(`${origin}/contacts`);
    await waitFor(b, `navigator.serviceWorker.controller !== null && ${signedInUi}`, 'Tab B: signed in under the old service worker');
    await evaluate(b, 'window.__unihubTestTab = "still the same page"');

    // Tab B: a new contact typed but not saved, and a recording upload whose chunk is in flight.
    const draft = { first: 'Unsaved Zoë', notes: 'Typed before the update, Grüße' };
    await waitFor(b, '(() => { const button = [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "New contact"); button?.click(); return Boolean(document.getElementById("contact-first-name")); })()', 'Tab B: no new contact form');
    for (const [id, text] of [['contact-first-name', draft.first], ['contact-notes', draft.notes]]) {
      await evaluate(b, `document.getElementById(${JSON.stringify(id)}).focus()`);
      await command('Input.insertText', { text }, b);
    }
    const typed = 'document.getElementById("contact-first-name")?.value + "|" + document.getElementById("contact-notes")?.value';
    assert.equal(await evaluate(b, typed), `${draft.first}|${draft.notes}`);
    // The upload takes the path the service worker uses to finish uploads, so the page's own CSRF token stays untouched.
    const audio = Buffer.alloc(44 + 1600);
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(1600, 40);
    for (let index = 0; index < 800; index++) audio.writeInt16LE(Math.round(2000 * Math.sin(index / 3)), 44 + index * 2);
    await evaluate(b, `(async () => {
      window.__unihubAudio = ${JSON.stringify(audio.toString('base64'))};
      const headers = { 'Content-Type': 'application/json', 'X-Background-Sync': '1' };
      const start = await fetch('/api/recordings/uploads/start', { method: 'POST', headers, body: JSON.stringify({ title: 'Upload during update', original_filename: 'update.wav', content_type: 'audio/wav', total_bytes: ${audio.length}, duration_seconds: 0.1, source: 'imported' }) });
      if (start.status !== 200) throw new Error('upload start ' + start.status + ' ' + await start.text());
      window.__unihubUpload = (await start.json()).upload.id;
      window.__unihubChunk = fetch('/api/recordings/uploads/' + window.__unihubUpload + '/chunk?__unihub_stall=1', { method: 'POST', headers, body: JSON.stringify({ offset: 0, data_base64: window.__unihubAudio }) })
        .then(response => response.status, error => 'error: ' + error.message);
      return true;
    })()`);
    // Tab A: a request to the server that does not finish.
    await evaluate(a, 'window.__unihubStalled = fetch("/api/contacts?__unihub_stall=1").then(response => response.status, error => "error: " + error.message); true');
    await sleep(500);
    assert.equal(stalled.size, 2, 'Both test requests are held open by the server');

    // Deploy the new build; the open tabs find it.
    root = newDir;
    const eventsBefore = seen.filter(entry => entry === 'GET /api/events').length;
    await evaluate(a, 'navigator.serviceWorker.getRegistration().then(registration => registration.update()).then(() => true)');
    await waitFor(a, 'window.__unihubUpdateAvailable === true', 'Tab A was not told about the new version', 60);
    await waitFor(a, '(() => { const button = document.querySelector(\'button[aria-label^="Attention,"]\'); button?.click(); return Boolean(button); })()', 'Tab A has no attention button');
    await waitFor(a, '(() => { const button = [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "Refresh now"); button?.click(); return Boolean(button); })()', 'No "Refresh now" in tab A');
    const deadline = Date.now() + 45000;
    while (!outcome && Date.now() < deadline) {
      try {
        if (await evaluate(a, loadedBuild) === buildId(newDir)) outcome = 'updated';
        else if (await evaluate(a, 'document.body.innerText.includes("could not be applied")')) outcome = 'failed';
      } catch { /* tab A is reloading */ }
      await sleep(250);
    }
    console.log(`Tab A: ${outcome === 'updated' ? 'loaded the new version' : outcome === 'failed' ? 'showed "The update could not be applied"' : 'neither updated nor reported a failure in 45 seconds'}`);
    if (expectFailure) {
      assert.equal(outcome, 'failed', 'Expected the update to fail with the notice while a request was open');
      assert.equal(await evaluate(b, 'window.__unihubTestTab'), 'still the same page', 'The failed update must not reload tab B');
      // What the notice asks for: close the tabs, then open UniHub again.
      for (const release of stalled) release();
      stalled.clear();
      const { targetInfos } = await command('Target.getTargets') as { targetInfos: { targetId: string; type: string; url: string }[] };
      await createBlankTab();
      for (const target of targetInfos.filter(item => item.type === 'page' && item.url.startsWith(origin))) await command('Target.closeTarget', { targetId: target.targetId });
      await sleep(2000);
      const reopened = await openTab(`${origin}/contacts`);
      await waitFor(reopened, `${loadedBuild} === ${JSON.stringify(buildId(newDir))} && ${signedInUi}`, 'After closing the tabs, UniHub opens in the new version', 60);
      console.log('PWA update check passed: the old worker reported the blocked update, and reopening loaded the new version, still signed in.');
    } else {
      assert.equal(outcome, 'updated', 'Tab A must load the new version');
      await waitFor(a, signedInUi, 'Tab A is signed in after the update');
      assert.equal(await evaluate(a, 'navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js")'), true);
      await waitFor(a, 'true', 'settle', 1);
      assert.ok(seen.filter(entry => entry === 'GET /api/events').length > eventsBefore, 'Tab A reconnected its server events');
      // Tab B kept its page and the typed contact, and was told about the update.
      assert.equal(await evaluate(b, 'window.__unihubTestTab'), 'still the same page', 'Tab B must not reload while it has unsaved input');
      assert.equal(await evaluate(b, typed), `${draft.first}|${draft.notes}`, 'Tab B kept the typed contact');
      await waitFor(b, 'window.__unihubUpdateAvailable === true', 'Tab B was not told about the new version', 20);
      // The upload continues after the switch.
      for (const release of stalled) release();
      stalled.clear();
      assert.equal(await evaluate(b, 'window.__unihubChunk'), 200, 'The upload chunk completes after the update');
      const completed = await evaluate<number>(b, `(async () => {
        const digest = ${JSON.stringify(crypto.createHash('sha256').update(audio).digest('hex'))};
        const response = await fetch('/api/recordings/uploads/' + window.__unihubUpload + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Background-Sync': '1' }, body: JSON.stringify({ sha256: digest }) });
        return response.status;
      })()`);
      assert.equal(completed, 200, 'The upload completes after the update');
      // The typed contact saves from the tab that kept it.
      const saved = answered.length;
      await evaluate(b, '[...document.querySelectorAll("button[type=submit]")].find(item => item.textContent.trim() === "Add contact").click()');
      const result = await waitFor<string>(b, 'true', 'settle', 1).then(async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
          const answer = answered.slice(saved).find(entry => entry.startsWith('POST /api/contacts '));
          if (answer) return answer;
          await sleep(250);
        }
        return 'no request';
      });
      assert.match(result, /^POST \/api\/contacts 20[01]$/, `Saving the typed contact in tab B after the update answered: ${result}`);
      // Tab B moves to the new version when it refreshes.
      await command('Page.reload', {}, b);
      await waitFor(b, `${loadedBuild} === ${JSON.stringify(buildId(newDir))} && ${signedInUi}`, 'Tab B loads the new version after a refresh');
      console.log('PWA update check passed: updated with a stalled request, a second tab with unsaved text and an upload in flight.');
    }
  }
} catch (error) {
  if (!(error instanceof BrowserStuck)) throw error;
  console.error(`Chrome stopped answering; the check did not run to the end (exit ${STUCK}).\n${error.message}`);
  process.exitCode = STUCK;
} finally {
  for (const release of stalled) release();
  browser.kill('SIGTERM');
  // A Chrome that stopped answering may ignore SIGTERM too.
  const killer = setTimeout(() => { try { process.kill(-browser.pid!, 'SIGKILL'); } catch { /* gone */ } }, 5000);
  await new Promise<void>(resolve => { if (browser.exitCode !== null || browser.signalCode !== null) resolve(); else browser.once('exit', () => resolve()); });
  clearTimeout(killer);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  server.closeAllConnections();
  server.close();
  if (installation) await installation.destroy();
  fs.rmSync(work, { recursive: true, force: true });
}
