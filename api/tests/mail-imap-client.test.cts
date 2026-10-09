'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
// ImapFlow connection setup: config translation, real TLS trust decisions and
// the absence of library-initiated traffic, over loopback sockets.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const net = (require('node:net') as typeof import('node:net'));
const tls = (require('node:tls') as typeof import('node:tls'));
const fs = (require('node:fs') as typeof import('node:fs'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const { execFileSync } = (require('node:child_process') as typeof import('node:child_process'));
const { connectImap, imapFlowOptions, MAX_LITERAL_BYTES } = require('../dist/src/services/mail-imap-client');
const { closeImapConnection } = require('../dist/src/services/mail-imap-guard');
const pool = require('../dist/src/services/mail-engine/connection-pool');
const { isTlsTrustError } = require('../dist/src/services/mail-host-policy');

function session(socket: FixtureValue, commands: FixtureValue) {
  socket.write('* OK synthetic peer\r\n');
  let buffer = '';
  socket.on('error', () => {});
  socket.on('data', (data: FixtureValue) => {
    buffer += data.toString('latin1');
    let index;
    while ((index = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      const match = /^([0-9A-F]+) (.*)$/.exec(line);
      if (!match) continue;
      const [, tag, cmd] = match;
      commands.push(cmd);
      // IDLE and COMPRESS are advertised so that sending them would be visible.
      if (cmd === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 IDLE COMPRESS=DEFLATE UIDPLUS\r\n');
      else if (cmd.startsWith('LIST ')) socket.write('* LIST (\\Noselect) "/" ""\r\n');
      socket.write(`${tag} OK done\r\n`);
    }
  });
}
async function listen(server: FixtureValue) {
  // Closing the server must not wait for client sockets to time out.
  server.on('secureConnection', (socket: FixtureValue) => server.emit('track', socket)).on('connection', (socket: FixtureValue) => server.emit('track', socket));
  const sockets = new Set<import('node:net').Socket>();
  server.on('track', (socket: FixtureValue) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const close = server.close.bind(server);
  server.close = (callback: FixtureValue) => { for (const socket of sockets) socket.destroy(); return close(callback); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
const config = (port: FixtureValue, extra: FixtureValue = {}) => ({ imap: { host: '127.0.0.1', port, user: 'fixture', password: 'fixture-secret', tls: false,
  keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 5000, ...extra } });

test('connection config keeps the pinned address, TLS hostname and trust decision and disables logging', () => {
  const options = imapFlowOptions({ imap: { host: '203.0.113.7', port: 993, user: 'user@example.test', password: 'secret',
    tls: true, tlsOptions: { rejectUnauthorized: true, servername: 'imap.example.test' },
    connTimeout: 60000, authTimeout: 30000, socketTimeout: 60000, keepalive: false } });
  assert.equal(options.host, '203.0.113.7');
  assert.equal(options.servername, 'imap.example.test');
  assert.deepEqual(options.tls, { rejectUnauthorized: true, servername: 'imap.example.test' });
  assert.equal(options.secure, true);
  assert.equal(options.logger, false); assert.equal(options.logRaw, false); assert.equal(options.emitLogs, false);
  assert.equal(options.disableAutoIdle, true); assert.equal(options.disableCompression, true);
  assert.equal(options.maxLiteralSize, MAX_LITERAL_BYTES);
  assert.equal(options.socketTimeout, 60000);
  const selfSigned = imapFlowOptions({ imap: { host: '203.0.113.7', tls: true, tlsOptions: { rejectUnauthorized: false } } });
  assert.equal(selfSigned.tls.rejectUnauthorized, false);
  assert.equal(selfSigned.servername, undefined, 'an IP literal host is verified against itself');
});

test('the library sends nothing on its own after login: no COMPRESS, IDLE or NOOP', async t => {
  const commands: FixtureValue[] = [];
  const server = net.createServer(socket => session(socket, commands));
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connectImap(config(port));
  t.after(() => closeImapConnection(client));
  const settled = commands.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(commands.length, settled);
  assert(!commands.some(cmd => /^(ID|COMPRESS|IDLE|NOOP|STARTTLS)\b/.test(cmd)), commands.join(', '));
  assert(commands.some(cmd => cmd.startsWith('LOGIN ')));
});

test('a stalled greeting is bounded by the connect deadline', async t => {
  const server = net.createServer(socket => socket.on('error', () => {}));
  const port = await listen(server);
  t.after(() => new Promise(resolve => { server.close(resolve); }));
  const started = Date.now();
  await assert.rejects(connectImap(config(port, { connTimeout: 200, authTimeout: 200 })), error => /TIMEOUT/.test((error as FixtureValue).code));
  assert(Date.now() - started < 2000);
});

test('pooled sessions on the wire: one LOGIN, a NOOP probe on reuse, nothing while parked', async t => {
  const commands: FixtureValue[] = [];
  const server = net.createServer(socket => session(socket, commands));
  const port = await listen(server);
  t.after(() => { pool.evictImapConnections(); return new Promise(resolve => server.close(resolve)); });
  const account = { id: 'pool-wire', imap_host: 'imap.example.test', email_address: 'a@example.test', encrypted_password: 'cipher' };
  const first = await pool.acquireImapConnection(account, config(port));
  assert.equal(pool.releaseImapConnection(first, { reusable: true }), true);
  const parked = commands.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(commands.length, parked, 'a parked session stays silent');
  const second = await pool.acquireImapConnection(account, config(port));
  assert.equal(second, first);
  assert.deepEqual(commands.slice(parked), ['NOOP']);
  assert.equal(commands.filter(cmd => cmd.startsWith('LOGIN ')).length, 1);
  pool.releaseImapConnection(second, { reusable: false });
  assert.equal(second.isClosed, true);
});

let certificate = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-imap-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=imap.example.test',
    '-addext', 'subjectAltName=DNS:imap.example.test', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  certificate = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
  fs.rmSync(dir, { recursive: true, force: true });
} catch { /* openssl unavailable: TLS tests are skipped */ }

test('strict TLS refuses a self-signed certificate; only an explicit trust decision accepts it', { skip: !certificate && 'openssl unavailable' }, async t => {
  const commands: FixtureValue[] = [];
  let servername = null;
  const server = tls.createServer((certificate as FixtureValue), socket => { servername = socket.servername; session(socket, commands); });
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const secure = (trust: FixtureValue) => config(port, { tls: true, tlsOptions: { rejectUnauthorized: !trust, servername: 'imap.example.test' } });
  let failure: FixtureValue;
  await assert.rejects(connectImap(secure(false)).catch((error: FixtureValue) => { failure = error; throw error; }));
  assert.equal(isTlsTrustError(failure), true, String(failure?.code || failure?.message));
  assert(!commands.some(cmd => cmd.startsWith('LOGIN ')), 'credentials never cross an unverified channel');
  const client = await connectImap(secure(true));
  t.after(() => closeImapConnection(client));
  assert.equal(servername, 'imap.example.test', 'SNI carries the account hostname, not the pinned address');
  assert(commands.some(cmd => cmd.startsWith('LOGIN ')));
});
