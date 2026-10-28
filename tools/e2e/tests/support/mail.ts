import { readFileSync } from 'node:fs';
import { apiRequire, outside, people, stack } from './env.ts';

// GreenMail is the stack's IMAP/SMTP provider: its REST API shows what was
// delivered to a mailbox, and its SMTPS port takes synthetic mail from
// correspondents outside UniHub. Only the instance's loopback provider is used.
const nodemailer = apiRequire('nodemailer');
const { simpleParser } = apiRequire('mailparser');
const ca = readFileSync(stack.caFile, 'utf8');

export interface Delivered {
  uid: string;
  messageId: string;
  subject: string;
  raw: string;
}

export interface Parsed {
  messageId?: string;
  subject?: string;
  from?: string;
  to: string[];
  cc: string[];
  inReplyTo?: string;
  references: string[];
  date?: Date;
  text?: string;
  html?: string | false;
  /** Top-level Content-Type, e.g. text/plain or multipart/mixed. */
  contentType: string;
  attachments: { filename?: string; contentType: string; size: number }[];
  headers: Map<string, unknown>;
}

/** Every message GreenMail holds for a mailbox (any address; unknown ones are empty). */
export async function delivered(mailbox: string): Promise<Delivered[]> {
  const response = await fetch(`${stack.greenmailApi}/api/user/${encodeURIComponent(mailbox)}/messages`);
  if (response.status === 404 || response.status === 400) return [];
  if (!response.ok) throw new Error(`GreenMail ${response.status} for ${mailbox}`);
  const list = await response.json() as { uid: string; 'Message-ID': string; subject: string; mimeMessage: string }[];
  return list.map((m) => ({ uid: m.uid, messageId: m['Message-ID'], subject: m.subject, raw: m.mimeMessage }));
}

/**
 * A provider mailbox that exists only for one test (GreenMail's REST API
 * creates it; it is gone when the stack restarts). Same password as the
 * seeded ones, so UniHub can connect it.
 */
export async function createProviderMailbox(address: string) {
  const response = await fetch(`${stack.greenmailApi}/api/user`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: address, login: address, password: stack.providerPassword }),
  });
  if (!response.ok) throw new Error(`GreenMail could not create ${address}: ${response.status} ${await response.text()}`);
  providerUsers.add(address);
}

export async function deliveredWithSubject(mailbox: string, subject: string) {
  return (await delivered(mailbox)).filter((message) => message.subject === subject);
}

/**
 * Waits until a mailbox holds at least `count` messages with this subject and
 * returns them (fewer when the time runs out, so the caller's assertion names
 * what is missing).
 */
export async function waitForDelivery(mailbox: string, subject: string, { count = 1, timeout = 60_000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const found = await deliveredWithSubject(mailbox, subject);
    if (found.length >= count || Date.now() > end) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The single delivered message with this subject, parsed; fails when it does not arrive in time. */
export async function receive(mailbox: string, subject: string, timeout = 60_000): Promise<Parsed & { raw: string }> {
  const [message] = await waitForDelivery(mailbox, subject, { timeout });
  if (!message) throw new Error(`no message "${subject}" reached ${mailbox} within ${timeout / 1000} s`);
  return { ...(await parse(message.raw)), raw: message.raw };
}

const addresses = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((group: { value: { address?: string }[] }) => group.value.map((a) => (a.address ?? '').toLowerCase()));
};

export async function parse(raw: string): Promise<Parsed> {
  const mail = await simpleParser(raw);
  const references = mail.references ? (Array.isArray(mail.references) ? mail.references : String(mail.references).split(/\s+/)) : [];
  return {
    messageId: mail.messageId,
    subject: mail.subject,
    from: addresses(mail.from)[0],
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    inReplyTo: mail.inReplyTo,
    references,
    date: mail.date,
    text: mail.text,
    html: mail.html,
    contentType: String((mail.headers.get('content-type') as { value?: string })?.value ?? 'text/plain'),
    attachments: mail.attachments.map((a: { filename?: string; contentType: string; size: number }) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    headers: mail.headers,
  };
}

const providerUsers = new Set<string>([...Object.values(people).map((p) => p.mailbox), ...Object.values(outside)]);

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; path?: string; content?: Buffer | string; contentType?: string }[];
  date?: Date;
}

/**
 * Sends a synthetic message through the provider's SMTPS, as a correspondent's
 * own mail program would; returns its Message-ID. A sender without a provider
 * mailbox authenticates as sam@example.org.
 */
export async function sendMail(message: OutgoingMail): Promise<string> {
  const bare = message.from.replace(/^.*<([^>]+)>.*$/, '$1').toLowerCase();
  const login = providerUsers.has(bare) ? bare : outside.sam;
  const transport = nodemailer.createTransport({
    host: stack.providerHost, port: stack.smtpsPort, secure: true,
    auth: { user: login, pass: stack.providerPassword },
    tls: { ca },
  });
  try {
    const info = await transport.sendMail({
      from: message.from, to: message.to, cc: message.cc, subject: message.subject,
      text: message.text ?? 'Synthetic test message.', html: message.html,
      inReplyTo: message.inReplyTo, references: message.references,
      attachments: message.attachments, date: message.date,
    });
    return info.messageId as string;
  } finally {
    transport.close();
  }
}

/** Plain text of a parsed message: its text part, or its HTML with tags removed. */
export const plainText = (mail: Parsed) => mail.text ?? (mail.html ? String(mail.html).replace(/<[^>]+>/g, ' ') : '');

const { ImapFlow } = apiRequire('imapflow');

export interface ImapLogin { host: string; port: number; user: string; pass: string; ca?: string }
const stackImap = (mailbox: string): ImapLogin => ({ host: stack.providerHost, port: stack.imapsPort, user: mailbox, pass: stack.providerPassword, ca });

export interface ImapMessage { uid: number; subject: string; flags: Set<string>; messageId?: string; inReplyTo?: string }

const bareSubject = (subject: string) => subject.replace(/^((re|fwd?|aw|wg):\s*)+/i, '');

/**
 * Messages as the provider holds them, over IMAP as another mail program sees
 * them: flags (\Seen, \Flagged, …) and threading headers; newest first. Every
 * message whose subject is this one, ignoring Re:/Fwd: prefixes. Takes a stack
 * mailbox or a real provider's login.
 */
export async function imapMessages(who: string | ImapLogin, subject: string, folder = 'INBOX'): Promise<ImapMessage[]> {
  const login = typeof who === 'string' ? stackImap(who) : who;
  const client = new ImapFlow({ host: login.host, port: login.port, secure: true, logger: false,
    auth: { user: login.user, pass: login.pass }, ...(login.ca ? { tls: { ca: login.ca } } : {}) });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      // Some servers (Stalwart) index the subject without its "Re:" prefix.
      const uids = await client.search({ subject: bareSubject(subject) }, { uid: true });
      const found: ImapMessage[] = [];
      for (const uid of [...(uids || [])].reverse()) {
        const message = await client.fetchOne(String(uid), { envelope: true, flags: true }, { uid: true });
        if (message && bareSubject(message.envelope?.subject ?? '') === bareSubject(subject)) {
          found.push({ uid, subject: message.envelope.subject, flags: new Set(message.flags), messageId: message.envelope.messageId, inReplyTo: message.envelope.inReplyTo });
        }
      }
      return found;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** The newest message with exactly this subject, or null. */
export async function imapMessage(who: string | ImapLogin, subject: string, folder = 'INBOX'): Promise<ImapMessage | null> {
  return (await imapMessages(who, subject, folder)).find((message) => message.subject === subject) ?? null;
}

/** Flags of the stack mailbox's message with this subject, or null. */
export async function providerFlags(mailbox: string, subject: string, folder = 'INBOX') {
  return (await imapMessage(mailbox, subject, folder))?.flags ?? null;
}

/**
 * Polls IMAP until a message with this subject passes the check; returns it, or the
 * newest such message (null if none) when the time runs out. With anyPrefix, a
 * subject that differs only in Re:/Fwd: prefixes counts too.
 */
export async function waitForImap(who: string | ImapLogin, subject: string, check: (m: ImapMessage) => boolean = () => true,
  { folder = 'INBOX', timeout = 60_000, anyPrefix = false } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const candidates = (await imapMessages(who, subject, folder)).filter((m) => anyPrefix || m.subject === subject);
    const match = candidates.find(check);
    if (match) return match;
    if (Date.now() > end) return candidates[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Polls the stack provider until a flag is set (true) or cleared (false) on the message. */
export async function waitForProviderFlag(mailbox: string, subject: string, flag: string, set: boolean, { folder = 'INBOX', timeout = 60_000 } = {}) {
  return (await waitForImap(mailbox, subject, (m) => m.flags.has(flag) === set, { folder, timeout }))?.flags ?? null;
}

/** Sends through a real provider's SMTP (STARTTLS on 587, TLS on 465) as that account's own mail program would. */
export async function sendViaProvider(login: { host: string; port: number; user: string; pass: string }, message: OutgoingMail) {
  const transport = nodemailer.createTransport({ host: login.host, port: login.port, secure: login.port === 465, requireTLS: login.port !== 465,
    auth: { user: login.user, pass: login.pass } });
  try {
    return (await transport.sendMail({ ...message, text: message.text ?? 'Synthetic test message.' })).messageId as string;
  } finally {
    transport.close();
  }
}
