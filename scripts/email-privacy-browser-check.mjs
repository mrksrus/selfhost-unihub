// Synthetic requests only. No server, account, live profile or external fetches.
// Run: node scripts/email-privacy-browser-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const profile = await mkdtemp(join(tmpdir(), 'unihub-email-privacy-'));
const browser = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
browser.stderr.on('data', chunk => { stderr += chunk; });
const pending = new Map();
browser.on('exit', () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error(`Chromium exited before the check completed:\n${stderr}`));
  }
  pending.clear();
});
for (const pipe of [browser.stdio[3], browser.stdio[4]]) {
  pipe.on('error', error => { stderr += `\n${error.message}`; });
}
let sequence = 0;
let buffer = '';
let session;
const requests = [];
const errors = [];
const diagnostics = [];
const frameSetups = [];
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9xkAAAAASUVORK5CYII=';
const origin = 'https://email-privacy.invalid';
const external = 'https://images.email-privacy.invalid';
const fixture = `<link rel="prefetch" href="${external}/prefetch"><style>.hidden { display:none } @import url(${external}/stylesheet);</style>
  <h1 style="color:blue">Synthetic mail</h1><img src="${external}/photo" width="600" height="400">
  <img src="${external}/pixel"><img src="${external}/tiny" width="1"><div class="hidden"><img src="${external}/concealed"></div>
  <img src="/api/mail/attachments/synthetic-inline"><img src="data:image/png;base64,${pixel}">
  <picture><source srcset="${external}/source"><img srcset="${external}/srcset 2x"></picture>
  <div style="background-image:url(${external}/background)">Background</div>
  <svg><image href="${external}/svg"/></svg><iframe src="${external}/frame"></iframe><object data="${external}/object"></object>
  <video poster="${external}/poster" src="${external}/video"></video><img src="/api/not-an-attachment">
  <a href="${external}/link" ping="${external}/ping">Link</a>`;

function command(method, params = {}, sessionId = session) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}\n${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}

browser.stdio[4].on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
    } else if (message.method === 'Target.attachedToTarget') {
      diagnostics.push(`Attached ${JSON.stringify(message.params.targetInfo)}`);
      const childSession = message.params.sessionId;
      const setup = (async () => {
        await command('Network.enable', {}, childSession);
        await command('Network.setCacheDisabled', { cacheDisabled: true }, childSession);
        await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, childSession);
        await command('Log.enable', {}, childSession);
        await command('Runtime.runIfWaitingForDebugger', {}, childSession);
      })().catch(error => errors.push(error));
      frameSetups.push(setup);
    } else if (message.method === 'Log.entryAdded') {
      diagnostics.push(message.params.entry.text);
    } else if (message.method === 'Network.requestWillBeSent') {
      diagnostics.push(`Network ${message.params.request.url}`);
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const harness = request.url === `${origin}/harness`;
      if (!harness) requests.push(request);
      command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [
        { name: 'Content-Type', value: harness ? 'text/html' : 'image/png' },
        { name: 'Cache-Control', value: 'no-store' },
      ], body: harness ? Buffer.from('<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>').toString('base64') : pixel }, message.sessionId).catch(error => errors.push(error));
    }
  }
});

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

try {
  const version = await command('Browser.getVersion');
  const target = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable');
  await command('Log.enable');
  await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await command('Network.enable');
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  // Intercept *all* page requests and fulfill locally, including unexpected ones.
  await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await command('Page.navigate', { url: `${origin}/harness` });
  await evaluate('new Promise(resolve => { if(document.readyState === "complete") resolve(); else window.addEventListener("load", resolve, {once:true}); })');
  const source = await readFile(new URL('../src/lib/email-privacy.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  await evaluate(`(() => { const exports = {}; ${compiled}\nwindow.privacy = exports; window.fixture = ${JSON.stringify(fixture)}; })()`);
  // Parsing alone, even with remote images permitted, must remain inert.
  await evaluate('privacy.prepareEmailHtml(fixture, {allowRemoteImages:true, blockSuspectedTrackers:false})');
  assert.deepEqual(requests.map(request => request.url), [], 'inert classification made a request');
  // First attach to an empty sandboxed frame, so its preload scanner cannot
  // race CDP interception setup in a newly created isolated renderer process.
  await evaluate(`(async () => {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-popups allow-popups-to-escape-sandbox';
    iframe.referrerPolicy = 'no-referrer';
    const loaded = new Promise(resolve => iframe.onload = resolve);
    iframe.srcdoc = privacy.emailSrcDoc('', false);
    document.body.append(iframe);
    await loaded;
  })()`);
  await Promise.all(frameSetups);
  await evaluate(`window.show = async options => {
    const iframe = document.querySelector('iframe');
    const loaded = new Promise(resolve => iframe.onload = resolve);
    iframe.srcdoc = privacy.emailSrcDoc(privacy.prepareEmailHtml(fixture, options).html, options.allowRemoteImages);
    await loaded;
    await new Promise(resolve => setTimeout(resolve, 200));
  }`);
  async function check(label, options, expected) {
    requests.length = 0;
    await evaluate(`show(${JSON.stringify(options)})`);
    assert.deepEqual(requests.map(request => request.url).sort(), expected.sort(), `${label}: ${diagnostics.join('\n')}`);
    for (const request of requests) {
      assert.equal(Object.keys(request.headers).some(header => header.toLowerCase() === 'referer'), false, 'request leaked a referrer');
    }
    console.log(`${label}: ${requests.length} expected request(s), no referrer`);
  }
  const attachment = `${origin}/api/mail/attachments/synthetic-inline`;
  await check('default/original view', { allowRemoteImages: false, blockSuspectedTrackers: true }, [attachment]);
  await check('consent with tracker filter', { allowRemoteImages: true, blockSuspectedTrackers: true }, [attachment, `${external}/photo`]);
  await check('explicit filter override', { allowRemoteImages: true, blockSuspectedTrackers: false }, [attachment, `${external}/photo`, `${external}/pixel`, `${external}/tiny`, `${external}/concealed`]);
  await check('re-block', { allowRemoteImages: false, blockSuspectedTrackers: false }, [attachment]);
  assert.deepEqual(errors, []);
  console.log(`PASS ${version.product}: inert parsing, allowed requests, blocked alternate paths and re-block verified.`);
} finally {
  browser.kill('SIGTERM');
  await new Promise(resolve => { if (browser.exitCode !== null || browser.signalCode !== null) resolve(); else browser.once('exit', resolve); });
  for (const waiter of pending.values()) clearTimeout(waiter.timeout);
  await rm(profile, { recursive: true, force: true });
}
