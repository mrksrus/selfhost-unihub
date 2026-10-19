'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
// Confirmed mail certificates over real loopback TLS: ImapFlow and nodemailer
// connect only to the certificate the user confirmed (or one that verifies),
// and refuse any other before a login is sent.
process.env.TRUSTED_MAIL_HOSTS = '127.0.0.1';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const net = require('node:net') as typeof import('node:net');
const tls = require('node:tls') as typeof import('node:tls');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
const nodemailer = require('nodemailer') as typeof import('nodemailer');
const { connectImap } = require('../dist/src/services/mail-imap-client') as typeof import('../src/services/mail-imap-client');
const { closeImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
const { isTlsTrustError } = require('../dist/src/services/mail-host-policy') as typeof import('../src/services/mail-host-policy');
const { mailTlsOptions, inspectMailCertificate, normalizeFingerprint } = require('../dist/src/security/mail-certificates') as typeof import('../src/security/mail-certificates');

function selfSigned(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-mail-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
      '-addext', `subjectAltName=DNS:${name}`, '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert, fingerprint256: normalizeFingerprint(new crypto.X509Certificate(cert).fingerprint256)! };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
let confirmedCert: ReturnType<typeof selfSigned> | null = null, otherCert: ReturnType<typeof selfSigned> | null = null;
try { confirmedCert = selfSigned('mail.example.test'); otherCert = selfSigned('mail.example.test'); } catch { /* openssl unavailable */ }
const skip = !confirmedCert && 'openssl unavailable';

async function listen(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

function imapPeer(cert: FixtureValue, commands: string[]) {
  return tls.createServer({ key: cert.key, cert: cert.cert }, socket => {
    socket.on('error', () => {});
    socket.write('* OK synthetic peer\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const match = /^([0-9A-F]+) (.*)$/.exec(line);
        if (!match) continue;
        commands.push(match[2]);
        if (match[2] === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1\r\n');
        socket.write(`${match[1]} OK done\r\n`);
      }
    });
  });
}

// SMTP on one port: implicit TLS when `implicit`, otherwise STARTTLS.
function smtpPeer(cert: FixtureValue, commands: string[], { implicit = false } = {}) {
  const serve = (socket: net.Socket, secure: boolean) => {
    socket.on('error', () => {});
    let buffer = '', inData = false;
    const onData = (data: Buffer) => {
      buffer += data.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (inData) { if (line === '.') { inData = false; socket.write('250 queued\r\n'); } continue; }
        commands.push(line.split(' ')[0].toUpperCase());
        const verb = commands[commands.length - 1];
        if (verb === 'EHLO') socket.write(`250-mail.example.test\r\n${secure ? '' : '250-STARTTLS\r\n'}250 AUTH PLAIN LOGIN\r\n`);
        else if (verb === 'STARTTLS') {
          socket.off('data', onData);
          socket.write('220 go ahead\r\n', () => serve(new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert }), true));
          return;
        } else if (verb === 'AUTH') socket.write('235 accepted\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    };
    socket.on('data', onData);
    if (!secure || implicit) socket.write('220 mail.example.test ESMTP\r\n');
  };
  return implicit
    ? tls.createServer({ key: cert.key, cert: cert.cert }, socket => serve(socket, true))
    : net.createServer(socket => serve(socket, false));
}

const imapConfig = (port: number, tlsOptions: FixtureValue) => ({ imap: { host: '127.0.0.1', port, user: 'fixture', password: 'fixture-secret',
  tls: true, tlsOptions, keepalive: false, connTimeout: 2000, authTimeout: 2000, socketTimeout: 5000 } });

test('IMAP connects to the confirmed certificate only, and refuses another one before the login', { skip }, async t => {
  const commands: string[] = [];
  const peer = await listen(imapPeer(confirmedCert, commands));
  t.after(peer.close);

  const pinned = (fingerprint256: string | null, record?: (fingerprint: string) => void) =>
    imapConfig(peer.port, mailTlsOptions('mail.example.test', { confirmed: true, fingerprint256, record }));
  const client = await connectImap(pinned(confirmedCert!.fingerprint256));
  assert(commands.some(cmd => cmd.startsWith('LOGIN ')), 'the confirmed certificate signs in');
  await closeImapConnection(client);

  commands.length = 0;
  let failure: FixtureValue;
  await assert.rejects(connectImap(pinned(otherCert!.fingerprint256)).catch(error => { failure = error; throw error; }));
  assert.equal(isTlsTrustError(failure), true, 'a changed certificate asks for a new confirmation');
  assert.deepEqual(commands, [], 'nothing is sent to a server with a different certificate');

  // Without confirmation the certificate is refused as before.
  await assert.rejects(connectImap(imapConfig(peer.port, mailTlsOptions('mail.example.test', { confirmed: false }))));
  assert.deepEqual(commands, []);

  // An account confirmed before fingerprints were kept trusts the first certificate it sees.
  let recorded: string | null = null;
  const legacy = await connectImap(pinned(null, fingerprint => { recorded = fingerprint; }));
  await closeImapConnection(legacy);
  assert.equal(recorded, confirmedCert!.fingerprint256);
  await assert.rejects(connectImap(pinned(null)), 'no stored fingerprint and nothing to record is refused');
});

test('SMTP over STARTTLS and implicit TLS sends only to the confirmed certificate', { skip }, async t => {
  for (const implicit of [false, true]) {
    const commands: string[] = [];
    const peer = await listen(smtpPeer(confirmedCert, commands, { implicit }));
    t.after(peer.close);
    const send = (fingerprint256: string) => nodemailer.createTransport({
      host: '127.0.0.1', port: peer.port, secure: implicit, requireTLS: !implicit, auth: { user: 'fixture', pass: 'fixture-secret' },
      tls: mailTlsOptions('mail.example.test', { confirmed: true, fingerprint256 }), connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 5000,
    }).sendMail({ from: 'ada@example.test', to: 'grace@example.test', subject: 'Synthetic', text: 'Hello' });

    await send(confirmedCert!.fingerprint256);
    assert(commands.includes('AUTH') && commands.includes('DATA'), `${implicit ? 'implicit' : 'STARTTLS'}: the confirmed certificate sends`);
    commands.length = 0;
    await assert.rejects(send(otherCert!.fingerprint256), /different certificate/);
    assert(!commands.includes('AUTH') && !commands.includes('MAIL'), `${implicit ? 'implicit' : 'STARTTLS'}: no login or message for another certificate`);
  }
});

test('the certificate check reports what IMAP and STARTTLS SMTP servers present', { skip }, async t => {
  const imap = await listen(imapPeer(confirmedCert, []));
  const smtp = await listen(smtpPeer(otherCert, []));
  t.after(imap.close); t.after(smtp.close);
  const [imapReport, smtpReport] = await Promise.all([
    inspectMailCertificate('127.0.0.1', imap.port, 'imap'),
    inspectMailCertificate('127.0.0.1', smtp.port, 'smtp'),
  ]);
  assert.equal(imapReport.fingerprint256, confirmedCert!.fingerprint256);
  assert.equal(smtpReport.fingerprint256, otherCert!.fingerprint256);
  assert.equal(imapReport.authorized, false);
  assert.equal(smtpReport.subject?.CN, 'mail.example.test');
});

test('the certificate check gives up on a server that never answers', async t => {
  const silent = await listen(net.createServer(() => {}));
  t.after(silent.close);
  for (const protocol of ['smtp', 'imap'] as const) {
    const started = Date.now();
    await assert.rejects(inspectMailCertificate('127.0.0.1', silent.port, protocol, { timeoutMs: 200 }));
    assert.ok(Date.now() - started < 5000, `${protocol}: bounded by the timeout`);
  }
});
