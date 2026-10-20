import type { FixtureValue } from './test-types.cts';
// Synthetic mail servers on loopback for tests that need the real wire:
// a self-signed certificate (openssl), a listener that closes its open
// sockets, and an SMTP peer with STARTTLS or implicit TLS.
const net = require('node:net') as typeof import('node:net');
type Server = import('node:net').Server;
type Socket = import('node:net').Socket;
type AddressInfo = import('node:net').AddressInfo;
const tls = require('node:tls') as typeof import('node:tls');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { execFileSync } = require('node:child_process') as typeof import('node:child_process');

function selfSigned(name: string) {
  const { normalizeFingerprint } = require('../../dist/src/security/mail-certificates') as typeof import('../../src/security/mail-certificates');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-mail-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
      '-addext', `subjectAltName=DNS:${name}`, '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert, fingerprint256: normalizeFingerprint(new crypto.X509Certificate(cert).fingerprint256)! };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A certificate, or null where openssl is missing (the test then skips). */
function trySelfSigned(name: string) {
  try { return selfSigned(name); } catch { return null; }
}

async function listen(server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

/**
 * SMTP on one port: implicit TLS when `implicit`, otherwise STARTTLS. The
 * verbs it received go into `commands`. `afterData` says what happens once
 * the message body has arrived: accept it (250), refuse it (554), or close
 * the connection without a reply. `refuseRecipients` answers RCPT with 550.
 * `pipelining` advertises PIPELINING. The messages it received go into `messages`.
 */
function smtpPeer(cert: FixtureValue, commands: string[], { implicit = false, afterData = 'accept', refuseRecipients = false, pipelining = false, messages = [] }:
  { implicit?: boolean; afterData?: 'accept' | 'refuse' | 'drop'; refuseRecipients?: boolean; pipelining?: boolean; messages?: string[] } = {}) {
  const serve = (socket: Socket, secure: boolean) => {
    socket.on('error', () => {});
    let buffer = '', inData = false, message = '';
    const onData = (data: Buffer) => {
      buffer += data.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (inData) {
          if (line !== '.') { message += `${line}\r\n`; continue; }
          inData = false;
          messages.push(message); message = '';
          commands.push('.');
          if (afterData === 'drop') { socket.destroy(); return; }
          socket.write(afterData === 'refuse' ? '554 5.7.1 message refused\r\n' : '250 queued\r\n');
          continue;
        }
        commands.push(line.split(' ')[0].toUpperCase());
        const verb = commands[commands.length - 1];
        if (verb === 'EHLO') socket.write(`250-mail.example.test\r\n${secure ? '' : '250-STARTTLS\r\n'}${pipelining ? '250-PIPELINING\r\n' : ''}250 AUTH PLAIN LOGIN\r\n`);
        else if (verb === 'STARTTLS') {
          socket.off('data', onData);
          socket.write('220 go ahead\r\n', () => serve(new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert }), true));
          return;
        } else if (verb === 'AUTH') socket.write('235 accepted\r\n');
        else if (verb === 'RCPT' && refuseRecipients) socket.write('550 5.1.1 no such user\r\n');
        // With every recipient refused, DATA is refused too (as pipelined servers answer).
        else if (verb === 'DATA' && refuseRecipients) socket.write('503 5.5.1 no valid recipients\r\n');
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

export type MailPeerHelpers = { selfSigned: typeof selfSigned; trySelfSigned: typeof trySelfSigned; listen: typeof listen; smtpPeer: typeof smtpPeer };
module.exports = { selfSigned, trySelfSigned, listen, smtpPeer };
