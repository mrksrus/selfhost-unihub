import type { ConnectionOptions, PeerCertificate, TLSSocket } from 'node:tls';

import net from 'node:net';
import tls from 'node:tls';
import { resolveMailConnectionTarget } from './outbound-network';

// A mail server the user confirmed (mail_accounts.allow_self_signed) is trusted
// while its certificate either verifies normally or is exactly the one the user
// confirmed: trusted_imap_fingerprint256 / trusted_smtp_fingerprint256 hold its
// SHA-256 fingerprint. A renewed certificate from a public authority keeps
// working; any other certificate is refused.
//
// Node runs checkServerIdentity only on a chain that already verified, and a
// pinned `ca` cannot accept an expired or privately issued certificate, so the
// fingerprint has to be compared on the connected socket. ImapFlow and
// nodemailer both open their sockets with tls.connect and our tls options;
// tls.connect is wrapped once and acts only on options that carry PIN_OPTION.
// The comparison runs before the library's own secureConnect callback, so a
// refused server never receives a reply, let alone a login.
const PIN_OPTION = 'unihubConfirmedCertificate';
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PROBE_TIMEOUT_MS = 10_000;

interface ConfirmedCertificate {
  /** The fingerprint the user confirmed; null for an account confirmed before fingerprints were kept. */
  fingerprint256: string | null;
  /** Called with the presented fingerprint when none is stored yet (that one is trusted from then on). */
  record?: (fingerprint256: string) => void;
}

function normalizeFingerprint(value: unknown) {
  const hex = String(value ?? '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 64) return null;
  const formatted = hex.match(/../g)!.join(':');
  return FINGERPRINT.test(formatted) ? formatted : null;
}

function mismatch(presented: string | null) {
  return Object.assign(new Error(`The server presented a different certificate (${presented || 'none'}) than the confirmed one`),
    { code: 'CERT_FINGERPRINT_MISMATCH' });
}

/** Why this socket must be refused, or null when its certificate is acceptable. */
function refusal(socket: TLSSocket, confirmed: ConfirmedCertificate) {
  const presented = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
  const pinned = normalizeFingerprint(confirmed.fingerprint256);
  if (pinned) return socket.authorized || presented === pinned ? null : mismatch(presented);
  if (!confirmed.record || !presented) return mismatch(presented);
  confirmed.record(presented);
  return null;
}

let installed = false;
function installPinCheck() {
  if (installed) return;
  installed = true;
  const original = tls.connect;
  const connect = function (this: unknown, ...args: unknown[]) {
    const options = args[0] as (ConnectionOptions & { [PIN_OPTION]?: ConfirmedCertificate }) | undefined;
    const confirmed = options && typeof options === 'object' ? options[PIN_OPTION] : undefined;
    if (!confirmed) return (original as (...a: unknown[]) => TLSSocket).apply(tls, args);
    const callback = typeof args[1] === 'function' ? args[1] as () => void : undefined;
    const socket = (original as (options: ConnectionOptions) => TLSSocket).call(tls, options as ConnectionOptions);
    socket.once('secureConnect', () => {
      const error = refusal(socket, confirmed);
      if (error) socket.destroy(error);
      else callback?.call(socket);
    });
    return socket;
  };
  tls.connect = connect as typeof tls.connect;
}

/**
 * TLS options for a mail connection. Unconfirmed servers are verified strictly;
 * a confirmed one is accepted by the pin check above instead of by hostname.
 */
function mailTlsOptions(hostname: string, { confirmed, fingerprint256 = null, record }: {
  confirmed: boolean; fingerprint256?: string | null; record?: (fingerprint256: string) => void;
}): ConnectionOptions {
  const servername = net.isIP(hostname) ? undefined : hostname;
  if (!confirmed) return { rejectUnauthorized: true, servername };
  installPinCheck();
  return { rejectUnauthorized: false, servername, [PIN_OPTION]: { fingerprint256: normalizeFingerprint(fingerprint256), record } } as ConnectionOptions;
}

interface CertificateReport {
  authorized: boolean;
  authorizationError: string | null;
  subject: Record<string, string> | null;
  issuer: Record<string, string> | null;
  valid_to: string | null;
  fingerprint256: string | null;
  error?: string;
}

const names = (value: PeerCertificate['subject'] | undefined) => value ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])) : null;

function report(socket: TLSSocket): CertificateReport {
  const certificate = socket.getPeerCertificate();
  return {
    authorized: socket.authorized,
    authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
    subject: names(certificate?.subject),
    issuer: names(certificate?.issuer),
    valid_to: certificate?.valid_to || null,
    fingerprint256: normalizeFingerprint(certificate?.fingerprint256),
  };
}

// Reads SMTP replies until the final line of one (`250 ...` after `250-...`).
function smtpReply(socket: net.Socket) {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (buffer.length > 64 * 1024) return done(new Error('SMTP reply too long'));
      const lines = buffer.split('\r\n');
      const last = lines.slice(0, -1).reverse().find(Boolean);
      if (last && /^\d{3} /.test(last)) done(null, last);
    };
    // A timeout destroys the socket, which emits 'close' without 'end'.
    const onClose = () => done(new Error('SMTP server closed the connection'));
    const done = (error: Error | null, line?: string) => {
      socket.off('data', onData).off('error', done).off('end', onClose).off('close', onClose);
      if (error) reject(error); else resolve(line!);
    };
    socket.on('data', onData).once('error', done).once('end', onClose).once('close', onClose);
  });
}

/**
 * The certificate a mail server presents, for the user to confirm. Port 465
 * (SMTP) and IMAP use implicit TLS; other SMTP ports are upgraded with
 * STARTTLS first. Nothing but EHLO and STARTTLS is sent.
 */
async function inspectMailCertificate(host: unknown, port: number, protocol: 'imap' | 'smtp', { timeoutMs = PROBE_TIMEOUT_MS } = {}): Promise<CertificateReport> {
  const target = await resolveMailConnectionTarget(host);
  const servername = net.isIP(target.hostname) ? undefined : target.hostname;
  const implicit = protocol === 'imap' || port === 465;
  let plain: net.Socket | null = null, secure: TLSSocket | null = null;
  const timer = setTimeout(() => { plain?.destroy(); secure?.destroy(); }, timeoutMs);
  try {
    if (!implicit) {
      plain = net.connect({ host: target.address, port });
      plain.setTimeout(timeoutMs, () => plain?.destroy(new Error('SMTP certificate check timed out')));
      const greeting = await smtpReply(plain);
      if (!greeting.startsWith('220')) throw new Error(`SMTP greeting: ${greeting}`);
      plain.write('EHLO unihub.invalid\r\n');
      await smtpReply(plain);
      plain.write('STARTTLS\r\n');
      const ready = await smtpReply(plain);
      if (!ready.startsWith('220')) throw new Error(`STARTTLS refused: ${ready}`);
    }
    const options: ConnectionOptions = { rejectUnauthorized: false, servername, ...(plain ? { socket: plain } : { host: target.address, port }) };
    return await new Promise<CertificateReport>((resolve, reject) => {
      secure = tls.connect(options, () => resolve(report(secure!)));
      secure.once('error', reject);
      secure.once('close', () => reject(new Error('Connection closed before the certificate was read')));
    });
  } finally {
    clearTimeout(timer);
    (secure as TLSSocket | null)?.destroy();
    plain?.destroy();
  }
}

async function inspectMailCertificates({ imap_host, imap_port, smtp_host, smtp_port }: { imap_host: unknown; imap_port: unknown; smtp_host: unknown; smtp_port: unknown }) {
  const inspect = (host: unknown, port: number, protocol: 'imap' | 'smtp') => inspectMailCertificate(host, port, protocol)
    .catch((error: Error) => ({ authorized: false, authorizationError: null, subject: null, issuer: null, valid_to: null, fingerprint256: null,
      error: `Could not read the certificate: ${error.message}` }) as CertificateReport);
  const [imap, smtp] = await Promise.all([
    inspect(imap_host, Number(imap_port) || 993, 'imap'),
    inspect(smtp_host, Number(smtp_port) || 587, 'smtp'),
  ]);
  return { imap, smtp };
}

export {
  PIN_OPTION,
  normalizeFingerprint,
  mailTlsOptions,
  inspectMailCertificate,
  inspectMailCertificates,
};
export type { CertificateReport };
