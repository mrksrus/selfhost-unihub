// Synthetic mail and calendar providers for the release checks
// (recovery-fresh-install.mts, instance-backup-drill.mts, upgrade-check.mts):
// GreenMail (IMAP, SMTP) and Radicale (CalDAV) on loopback ports of their own,
// each behind a TLS proxy of this script on <host>:<port> with a certificate
// for PEER_HOST from the test CA (fresh-installations.mts). Only the
// installations' traffic passes the proxies, so their log is what the
// installations sent: IMAP commands (without arguments), logins and whether
// the provider accepted them, and CalDAV requests. Seeding (mailboxes,
// messages, calendars, events) goes to the providers directly.
//
// outage(true) makes every proxy answer as a provider that is temporarily
// down (IMAP BYE, SMTP 421, HTTP 503) until outage(false).
//
// Needs the providers the e2e harness uses (tools/e2e/README.md):
// UNIHUB_E2E_GREENMAIL_JAR, UNIHUB_E2E_RADICALE (or radicale on PATH) and
// JAVA (or java on PATH).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { freePort, PEER_HOST, repo } from './fresh-installations.mts';

/** A provider sign-in: the mail address for GreenMail, the user name for Radicale. */
export interface ProviderAccount { user: string; password: string }
export interface ProviderLog {
  /** IMAP commands by name (UID FETCH, SELECT, ...), in arrival order. */
  commands: string[];
  /** Commands that change or remove mail at the provider. */
  destructive: string[];
  logins: { user: string; ok: boolean }[];
  smtp: { connections: number };
  dav: { method: string; path: string; status: number; ok: boolean }[];
}
export interface Providers {
  imapPort: number;
  smtpPort: number;
  davPort: number;
  /** The CalDAV URL of a user's principal as the installations reach it, with a trailing slash. */
  davUrl(user: string): string;
  log: ProviderLog;
  outage(on: boolean): void;
  createMailbox(account: ProviderAccount, mailbox: string): Promise<void>;
  append(account: ProviderAccount, mailbox: string, raw: Buffer, flags?: string[]): Promise<void>;
  /** Message-ID and subject of every message in a mailbox. */
  messages(account: ProviderAccount, mailbox: string): Promise<{ messageId: string; subject: string }[]>;
  createCalendar(account: ProviderAccount, slug: string, displayName: string): Promise<string>;
  putEvent(account: ProviderAccount, slug: string, uid: string, ics: string): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Commands that change or remove mail or mailboxes at the provider. */
export const DESTRUCTIVE_IMAP = /^(UID )?(STORE|MOVE|COPY|EXPUNGE)\b|^(EXPUNGE|DELETE|RENAME|APPEND)\b/i;

/**
 * Reads client lines of an IMAP stream: the command name of each tagged
 * command (with UID's subcommand), never its arguments, and the user of a
 * LOGIN or AUTHENTICATE PLAIN with its tag. Literals ({n} and {n+}) are
 * skipped by length, so message bytes are never read as commands.
 */
export function imapCommandReader(onCommand: (command: { tag: string; name: string; user?: string }) => void) {
  let buffer = Buffer.alloc(0), literal = 0, authenticating: string | null = null;
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (literal) {
        const take = Math.min(literal, buffer.length);
        buffer = buffer.subarray(take); literal -= take;
        if (literal) return;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 2);
      const length = /\{(\d+)\+?\}$/.exec(line);
      if (length) literal = Number(length[1]);
      if (authenticating) {
        // AUTHENTICATE PLAIN's response: authzid \0 authcid \0 password.
        const parts = Buffer.from(line.trim(), 'base64').toString('utf8').split('\0');
        onCommand({ tag: authenticating, name: 'AUTHENTICATE', user: parts[1] || '' });
        authenticating = null;
        continue;
      }
      const match = /^(\S+) (UID \S+|\S+)(?: (.*))?$/i.exec(line);
      if (!match) continue;
      const [, tag, rawName, rest = ''] = match;
      const name = rawName.toUpperCase();
      if (name === 'LOGIN') {
        const user = /^("(?:[^"\\]|\\.)*"|\S+)/.exec(rest)?.[1] || '';
        onCommand({ tag, name, user: user.startsWith('"') ? user.slice(1, -1).replace(/\\(.)/g, '$1') : user });
      } else if (name === 'AUTHENTICATE') {
        const initial = /^PLAIN (\S+)$/i.exec(rest);
        if (initial) onCommand({ tag, name, user: Buffer.from(initial[1], 'base64').toString('utf8').split('\0')[1] || '' });
        else if (/^PLAIN$/i.test(rest)) authenticating = tag;
        else onCommand({ tag, name });
      } else onCommand({ tag, name });
    }
  };
}

/** Tagged results (OK, NO, BAD) of a server's IMAP stream. */
export function imapResultReader(onResult: (tag: string, status: string) => void) {
  let buffer = '';
  return (chunk: Buffer) => {
    // Results are short ASCII lines; a large literal only delays them.
    buffer = (buffer + chunk.toString('latin1')).slice(-65536);
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const match = /^(\S+) (OK|NO|BAD)\b/i.exec(line);
      if (match && match[1] !== '*' && match[1] !== '+') onResult(match[1], match[2].toUpperCase());
    }
  };
}

function binary(variable: string, command: string) {
  const configured = process.env[variable];
  if (configured) return configured;
  const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
  if (!found) throw new Error(`${command} not found: set ${variable} (tools/e2e/README.md)`);
  return found;
}

async function waitForPort(port: number, name: string, alive: () => boolean, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error(`${name} stopped before it listened on ${port}`);
    const open = await new Promise<boolean>(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await sleep(500);
  }
  throw new Error(`${name} did not listen on ${port} within ${seconds} seconds`);
}

async function waitForMailLogin(ImapFlow: typeof import('imapflow').ImapFlow, port: number, account: ProviderAccount, alive: () => boolean, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (!alive()) throw new Error('GreenMail stopped before its accounts could sign in');
    const client = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: account.user, pass: account.password }, logger: false });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.logout().catch(() => client.close());
      return;
    } catch (error) {
      client.close();
      if (Date.now() > deadline) throw new Error(`GreenMail did not accept ${account.user} within ${seconds} seconds: ${(error as Error).message}`);
      await sleep(250);
    }
  }
}

/**
 * Starts GreenMail and Radicale with these accounts and the proxies in front
 * of them. `host` is where the proxies listen (0.0.0.0 when containers reach
 * them through the host gateway). `smtpPort` defaults to a free port; the
 * API uses implicit TLS for SMTP only on 465.
 */
export async function startProviders({ work, certificates, host, mail, calendar, smtpPort }: {
  work: string; certificates: { cert: Buffer; key: Buffer }; host: string;
  mail: readonly ProviderAccount[]; calendar: readonly ProviderAccount[]; smtpPort?: number;
}): Promise<Providers> {
  const jar = process.env.UNIHUB_E2E_GREENMAIL_JAR;
  if (!jar || !fs.existsSync(jar)) throw new Error('Set UNIHUB_E2E_GREENMAIL_JAR to greenmail-standalone.jar (tools/e2e/README.md)');
  const java = binary('JAVA', 'java'), radicale = binary('UNIHUB_E2E_RADICALE', 'radicale');
  for (const account of [...mail, ...calendar]) {
    if (/[:@,\s]/.test(account.password) || /[,\s]/.test(account.user)) throw new Error(`Provider account ${account.user}: passwords must not contain : @ , or spaces`);
  }
  const { ImapFlow } = createRequire(path.join(repo, 'api/package.json'))('imapflow') as typeof import('imapflow');
  const dir = path.join(work, 'providers');
  fs.mkdirSync(path.join(dir, 'collections'), { recursive: true });
  const ports = { imap: await freePort(), smtp: await freePort(), api: await freePort(), dav: await freePort() };
  const children: ChildProcess[] = [];
  const servers: (net.Server | http.Server)[] = [];
  const sockets = new Set<net.Socket>();
  const log: ProviderLog = { commands: [], destructive: [], logins: [], smtp: { connections: 0 }, dav: [] };
  let down = false;
  const startChild = (name: string, command: string, args: string[]) => {
    const output = fs.openSync(path.join(dir, `${name}.log`), 'a');
    const child = spawn(command, args, { stdio: ['ignore', output, output] });
    fs.closeSync(output);
    children.push(child);
    return child;
  };
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode) continue;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(10000)]);
      if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    }
  };
  try {
    // GreenMail's user format is local:password@domain; users.login=email
    // signs in with the whole address, as the installations do.
    const users = mail.map(account => `${account.user.replace('@', ':' + account.password + '@')}`).join(',');
    const greenmail = startChild('greenmail', java, ['-Xmx256m', '-Dgreenmail.startup.timeout=60000', '-Dgreenmail.hostname=127.0.0.1',
      `-Dgreenmail.imap.port=${ports.imap}`, `-Dgreenmail.smtp.port=${ports.smtp}`, '-Dgreenmail.api.hostname=127.0.0.1', `-Dgreenmail.api.port=${ports.api}`,
      ...(users ? [`-Dgreenmail.users=${users}`] : []), '-Dgreenmail.users.login=email', '-jar', jar]);
    fs.writeFileSync(path.join(dir, 'users'), calendar.map(account => `${account.user}:${account.password}\n`).join(''), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'radicale.conf'), `[server]
hosts = 127.0.0.1:${ports.dav}
[auth]
type = htpasswd
htpasswd_filename = ${path.join(dir, 'users')}
htpasswd_encryption = plain
[storage]
filesystem_folder = ${path.join(dir, 'collections')}
[logging]
level = warning
`);
    const dav = startChild('radicale', radicale, ['--config', path.join(dir, 'radicale.conf')]);
    const alive = (child: ChildProcess) => () => child.exitCode === null && !child.signalCode;
    await waitForPort(ports.imap, 'GreenMail', alive(greenmail));
    await waitForPort(ports.smtp, 'GreenMail', alive(greenmail));
    await waitForPort(ports.dav, 'Radicale', alive(dav));
    // GreenMail opens its ports before it creates the configured users
    // (GreenMail.start: the services, then doConfigure), so a sign-in right
    // after the port opens can be refused. Wait until every account signs in.
    for (const account of mail) await waitForMailLogin(ImapFlow, ports.imap, account, alive(greenmail));

    const track = (socket: net.Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
    const listen = async (server: net.Server, port: number) => {
      servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
    };
    const pipeTo = (client: net.Socket, port: number, tap?: { up?: (chunk: Buffer) => void; down?: (chunk: Buffer) => void }) => {
      const upstream = net.connect(port, '127.0.0.1');
      track(upstream);
      client.on('data', chunk => { tap?.up?.(chunk); upstream.write(chunk); });
      upstream.on('data', chunk => { tap?.down?.(chunk); client.write(chunk); });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    };
    const imapPort = await freePort();
    await listen(tls.createServer({ cert: certificates.cert, key: certificates.key }, client => {
      track(client);
      if (down) { client.end('* BYE [UNAVAILABLE] disposable test provider: temporarily unavailable\r\n'); return; }
      const pending = new Map<string, string>();
      pipeTo(client, ports.imap, {
        up: imapCommandReader(command => {
          log.commands.push(command.name);
          if (DESTRUCTIVE_IMAP.test(command.name)) log.destructive.push(command.name);
          if (command.user !== undefined) pending.set(command.tag, command.user);
        }),
        down: imapResultReader((tag, status) => {
          const user = pending.get(tag);
          if (user === undefined) return;
          pending.delete(tag);
          log.logins.push({ user, ok: status === 'OK' });
        }),
      });
    }), imapPort);
    const smtp = smtpPort ?? await freePort();
    await listen(tls.createServer({ cert: certificates.cert, key: certificates.key }, client => {
      track(client);
      if (down) { client.end('421 disposable test provider: temporarily unavailable\r\n'); return; }
      log.smtp.connections += 1;
      pipeTo(client, ports.smtp);
    }), smtp);
    const davPort = await freePort();
    const davServer = https.createServer({ cert: certificates.cert, key: certificates.key }, (request, response) => {
      if (down) {
        request.resume();
        log.dav.push({ method: request.method || '', path: request.url || '', status: 503, ok: true });
        response.writeHead(503, { 'Retry-After': '3600' }).end('disposable test provider: temporarily unavailable');
        return;
      }
      const forwarded = http.request({ host: '127.0.0.1', port: ports.dav, method: request.method, path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${ports.dav}` } }, upstream => {
        const status = upstream.statusCode || 502;
        log.dav.push({ method: request.method || '', path: request.url || '', status, ok: status !== 401 && status !== 403 });
        response.writeHead(status, upstream.headers);
        upstream.pipe(response);
      });
      forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502).end(); });
      request.pipe(forwarded);
    });
    davServer.on('connection', track);
    servers.push(davServer);
    await new Promise<void>((resolve, reject) => { davServer.once('error', reject); davServer.listen(davPort, host, () => resolve()); });

    // Seeding talks to the providers directly, outside the proxies' log.
    const imap = async <T,>(account: ProviderAccount, work_: (client: import('imapflow').ImapFlow) => Promise<T>) => {
      const client = new ImapFlow({ host: '127.0.0.1', port: ports.imap, secure: false, auth: { user: account.user, pass: account.password }, logger: false });
      await client.connect();
      try { return await work_(client); } finally { await client.logout().catch(() => client.close()); }
    };
    const createMailbox = (account: ProviderAccount, mailbox: string) => imap(account, async client => {
      if (!(await client.list()).some(entry => entry.path === mailbox)) await client.mailboxCreate(mailbox);
    });
    const davBase = `http://127.0.0.1:${ports.dav}`;
    const dav_ = async (account: ProviderAccount, method: string, url: string, body: string, contentType: string) => {
      const response = await fetch(davBase + url, { method, body, headers: { 'Content-Type': contentType,
        Authorization: `Basic ${Buffer.from(`${account.user}:${account.password}`).toString('base64')}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    };
    const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return {
      imapPort, smtpPort: smtp, davPort, log,
      davUrl: user => `https://${PEER_HOST}:${davPort}/${encodeURIComponent(user)}/`,
      outage(on) {
        down = on;
        // Connections already open break as a provider's would.
        if (on) for (const socket of sockets) socket.destroy();
      },
      createMailbox,
      async append(account, mailbox, raw, flags = []) {
        if (mailbox !== 'INBOX') await createMailbox(account, mailbox);
        await imap(account, client => client.append(mailbox, raw, flags));
      },
      messages: (account, mailbox) => imap(account, async client => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const found: { messageId: string; subject: string }[] = [];
          if (client.mailbox && client.mailbox.exists) {
            for await (const message of client.fetch('1:*', { envelope: true })) found.push({ messageId: message.envelope?.messageId || '', subject: message.envelope?.subject || '' });
          }
          return found;
        } finally { lock.release(); }
      }),
      async createCalendar(account, slug, displayName) {
        const url = `/${encodeURIComponent(account.user)}/${slug}/`;
        await dav_(account, 'MKCALENDAR', url, `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>`
          + `<D:displayname>${escapeXml(displayName)}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>`
          + `</D:prop></D:set></C:mkcalendar>`, 'application/xml');
        return url;
      },
      putEvent: (account, slug, uid, ics) => dav_(account, 'PUT', `/${encodeURIComponent(account.user)}/${slug}/${encodeURIComponent(uid)}.ics`, ics, 'text/calendar; charset=utf-8'),
      close,
    };
  } catch (error) {
    await close();
    for (const name of ['greenmail', 'radicale']) {
      const file = path.join(dir, `${name}.log`);
      if (fs.existsSync(file)) console.error(`--- ${name} ---\n${fs.readFileSync(file, 'utf8').slice(-3000)}`);
    }
    throw error;
  }
}

/** A plain iCalendar event (UTC times), as a provider stores it. */
export function icsEvent({ uid, title, start, end, description = '', location = '', attendees = [] }: {
  uid: string; title: string; start: string; end: string; description?: string; location?: string;
  attendees?: { email: string; name: string; status: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NEEDS-ACTION' }[];
}) {
  const time = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub release checks//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${time(start)}`,
    `DTSTART:${time(start)}`, `DTEND:${time(end)}`, `SUMMARY:${text(title)}`,
    ...(description ? [`DESCRIPTION:${text(description)}`] : []), ...(location ? [`LOCATION:${text(location)}`] : []),
    ...attendees.map(attendee => `ATTENDEE;CN=${text(attendee.name)};PARTSTAT=${attendee.status}:mailto:${attendee.email}`),
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
