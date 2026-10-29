import type { FixtureValue } from './helpers/test-types.cts';
import type { UploadBody } from '../src/http/route';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const http: typeof import('node:http') = require('node:http');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const net: typeof import('node:net') = require('node:net');

// The 'upload' body kind through the real boundary on a real socket: the raw
// body is spooled to a private file under the spool root, bounded by the
// route's limit, handed to the handler and removed afterwards, whatever the
// handler or the client does. Authentication, module and restore lookups are
// stubbed; a refusal must come before any byte is spooled.

const LIMIT = 64 * 1024;

async function uploadServer(t: import('node:test').TestContext, { route, moduleEnabled = true, restoring = [] as string[] }: { route: (req: FixtureValue, userId: string, body: UploadBody) => Promise<FixtureValue>; moduleEnabled?: boolean; restoring?: string[] }) {
  const spool = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-spool-'));
  const previousRoot = process.env.UPLOAD_SPOOL_ROOT;
  process.env.UPLOAD_SPOOL_ROOT = path.join(spool, 'root');
  const paths = ['../dist/src/request-handler', '../dist/src/auth', '../dist/src/routes', '../dist/src/services/module-settings', '../dist/src/services/restore-locks'].map(name => require.resolve(name));
  const previous = paths.map(name => require.cache[name]);
  const stub = (name: string, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  delete require.cache[paths[0]];
  stub(paths[1], { verifyToken: async () => 'u1', validateCsrfToken: () => true, refreshSessionCookies: () => {} });
  stub(paths[3], { isModuleEnabled: async () => moduleEnabled });
  stub(paths[4], { getActiveRestoreSections: async () => new Set(restoring) });
  const { defineRoutes } = require('../dist/src/http/route') as typeof import('../src/http/route');
  stub(paths[2], defineRoutes({
    'PUT /api/contacts/:id/photo': { auth: 'user', module: 'contacts', restoreSection: 'contacts', body: { kind: 'upload', limit: LIMIT }, handler: route as FixtureValue },
  }));
  const { handleRequest } = require(paths[0]) as typeof import('../src/request-handler');
  const server = http.createServer((req, res) => { void handleRequest(req as FixtureValue, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; });
    if (previousRoot === undefined) delete process.env.UPLOAD_SPOOL_ROOT; else process.env.UPLOAD_SPOOL_ROOT = previousRoot;
    fs.rmSync(spool, { recursive: true, force: true });
  });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const spoolFiles = () => { try { return fs.readdirSync(process.env.UPLOAD_SPOOL_ROOT!); } catch { return []; } };
  async function send(body: Buffer | null, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; json: FixtureValue }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/contacts/c1/photo', headers: { host: 'localhost', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
      });
      req.on('error', reject);
      if (body) req.end(body); else req.end();
    });
  }
  return { port, send, spoolFiles, spoolRoot: process.env.UPLOAD_SPOOL_ROOT! };
}

// The boundary removes the spool file in its finally block, just after the
// response is written, so the client may see the answer first.
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(label);
}

test('a raw upload reaches its handler as a private spool file that is removed afterwards', async (t) => {
  let seen: (UploadBody & { bytes: Buffer; mode: number }) | null = null;
  const server = await uploadServer(t, { route: async (_req, _user, body) => {
    seen = { ...body, bytes: fs.readFileSync(body.path), mode: fs.statSync(body.path).mode & 0o777 };
    return { ok: true };
  } });
  const payload = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x0d, 0x0a]);
  const result = await server.send(payload, { 'content-type': 'Image/JPEG; name="x.jpg"' });
  assert.equal(result.status, 200);
  assert.ok(seen);
  const body = seen as UploadBody & { bytes: Buffer; mode: number };
  assert.deepEqual(body.bytes, payload);
  assert.equal(body.size, payload.length);
  assert.equal(body.contentType, 'Image/JPEG; name="x.jpg"');
  assert.equal(body.mediaType, 'image/jpeg');
  assert.equal(body.mode, 0o600);
  assert.equal(path.dirname(body.path), server.spoolRoot);
  await until(() => server.spoolFiles().length === 0, 'the spool file is removed after the response');

  // Chunked, without a type: the same file, an empty type.
  const chunked = await server.send(payload, { 'transfer-encoding': 'chunked' });
  assert.equal(chunked.status, 200);
  assert.equal((seen as UploadBody | null)?.contentType, '');
  assert.equal((seen as UploadBody | null)?.mediaType, '');
});

test('an upload over the limit is refused with 413 and leaves nothing behind, with or without Content-Length', async (t) => {
  let called = 0;
  const server = await uploadServer(t, { route: async () => { called++; return { ok: true }; } });
  const declared = await server.send(Buffer.alloc(LIMIT + 1, 1), { 'content-type': 'image/png' });
  assert.equal(declared.status, 413);
  const streamed = await server.send(Buffer.alloc(LIMIT + 1, 1), { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
  assert.equal(streamed.status, 413);
  assert.equal(called, 0);
  await until(() => server.spoolFiles().length === 0, 'the spool file is removed after the response');
  assert.equal((await server.send(Buffer.alloc(LIMIT, 1))).status, 200, 'exactly the limit is accepted');
});

test('an empty upload never reaches the handler', async (t) => {
  let called = 0;
  const server = await uploadServer(t, { route: async () => { called++; return { ok: true }; } });
  const result = await server.send(null, { 'content-length': '0', 'content-type': 'image/jpeg' });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, 'UPLOAD_EMPTY');
  assert.equal(called, 0);
  await until(() => server.spoolFiles().length === 0, 'the spool file is removed after the response');
});

test('a disabled module or a running restore refuses the upload before anything is spooled', async (t) => {
  let called = 0;
  const route = async () => { called++; return { ok: true }; };
  const disabled = await uploadServer(t, { route, moduleEnabled: false });
  const off = await disabled.send(Buffer.alloc(100, 1));
  assert.equal(off.status, 403);
  assert.equal(off.json.code, 'MODULE_DISABLED');
  assert.equal(fs.existsSync(disabled.spoolRoot), false);
  const restoring = await uploadServer(t, { route, restoring: ['contacts'] });
  const locked = await restoring.send(Buffer.alloc(100, 1));
  assert.equal(locked.status, 409);
  assert.equal(locked.json.code, 'RESTORE_IN_PROGRESS');
  assert.equal(fs.existsSync(restoring.spoolRoot), false);
  assert.equal(called, 0);
});

test('a client that disconnects mid-body leaves no spool file and never reaches the handler', async (t) => {
  let called = 0;
  const server = await uploadServer(t, { route: async () => { called++; return { ok: true }; } });
  const socket = net.connect(server.port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`PUT /api/contacts/c1/photo HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/jpeg\r\nContent-Length: ${LIMIT}\r\n\r\n`);
  socket.write(Buffer.alloc(1024, 7));
  await until(() => server.spoolFiles().length === 1, 'the body starts spooling');
  socket.destroy();
  await until(() => server.spoolFiles().length === 0, 'the partial spool file is removed');
  assert.equal(called, 0);
});

test('the spool file is removed when the handler throws, and when the client left while it ran', async (t) => {
  let release: () => void = () => {};
  let mode: 'throw' | 'slow' = 'throw';
  let spooledPath = '';
  const server = await uploadServer(t, { route: async (_req, _user, body) => {
    spooledPath = body.path;
    if (mode === 'throw') throw Object.assign(new Error('This picture could not be read.'), { status: 400 });
    await new Promise<void>(resolve => { release = resolve; });
    return { ok: true };
  } });
  const thrown = await server.send(Buffer.alloc(10, 1));
  assert.equal(thrown.status, 400);
  await until(() => !fs.existsSync(spooledPath), 'the file is removed after the handler threw');

  mode = 'slow';
  spooledPath = '';
  const socket = net.connect(server.port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('PUT /api/contacts/c1/photo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n');
  socket.write(Buffer.alloc(10, 2));
  await until(() => spooledPath !== '', 'the handler runs');
  socket.destroy();
  assert.equal(fs.existsSync(spooledPath), true, 'the file stays while the handler still uses it');
  release();
  await until(() => !fs.existsSync(spooledPath), 'the file is removed once the handler returns');
});

test('spool files left by a dead process are swept after an hour; recent ones and other files stay', async () => {
  const { sweepStaleSpool } = require('../dist/src/http/request') as typeof import('../src/http/request');
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-sweep-'));
  try {
    const now = Date.now();
    const write = (name: string, ageMs: number) => {
      const target = path.join(root, name);
      fs.writeFileSync(target, 'x');
      fs.utimesSync(target, (now - ageMs) / 1000, (now - ageMs) / 1000);
    };
    write('old.upload', 2 * 60 * 60 * 1000);
    write('fresh.upload', 60 * 1000);
    write('old.other', 2 * 60 * 60 * 1000);
    await sweepStaleSpool(root, now);
    assert.deepEqual(fs.readdirSync(root).sort(), ['fresh.upload', 'old.other']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
