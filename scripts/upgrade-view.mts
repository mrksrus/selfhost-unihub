// What the upgrade check (scripts/upgrade-check.mts) reads back from an
// installation, in fields every release in the support window has, and the
// synthetic mail it seeds at the providers. Mail is read in full: the body,
// each attachment's bytes, and the original message as the server keeps it
// (api/tests/helpers/upgrade-mail-raw.cts), so mail that keeps its folder,
// Message-ID and subject but loses its contents reads differently.
// assertSeededMail() fails closed: every seeded message must be there once,
// with its text, its attachment's exact bytes and its exact original octets.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

type Row = Record<string, unknown>;
const sha256 = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The requests a view needs (fresh-installations.mts Session). */
export interface ViewSession {
  json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, options?: Record<string, unknown>): Promise<T>;
  bytes(path: string): Promise<Buffer>;
}
/** The original message of an email as the server keeps it, by email id. */
export interface RawEntry { format: string | null; verified: boolean; recorded: string | null; bytes: number | null; stored: string | null }
export type RawReader = () => Record<string, RawEntry>;

export interface MailSeed {
  account: string; folder: string; messageId: string; subject: string; text: string;
  attachment: { filename: string; bytes: Buffer };
  raw: Buffer;
}

/** A MIME message with a text part and a binary attachment, as a provider stores it. */
export function seedMessage({ account, folder, id, subject, to = account }: { account: string; folder: string; id: string; subject: string; to?: string }): MailSeed {
  const text = `Grüße, ${subject}. A second line of synthetic text.`;
  const attachment = { filename: `${id}.bin`, bytes: crypto.randomBytes(900) };
  const boundary = `unihub-${crypto.randomBytes(6).toString('hex')}`;
  const raw = Buffer.from([`From: Sender <sender@example.test>`, `To: ${to}`, `Message-ID: <${id}@example.test>`, `Subject: ${subject}`,
    'Date: Tue, 01 Jan 2030 10:00:00 +0000', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text,
    `--${boundary}`, `Content-Type: application/octet-stream; name="${attachment.filename}"`, `Content-Disposition: attachment; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64', '', ...attachment.bytes.toString('base64').match(/.{1,76}/g)!, `--${boundary}--`, ''].join('\r\n'));
  return { account, folder, messageId: `<${id}@example.test>`, subject, text, attachment, raw };
}

/** The person's mail, each message with its contents. */
export async function mailView(session: ViewSession, readRaw: RawReader) {
  const accounts = (await session.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  const raw = readRaw();
  const emails = [];
  for (const folder of (await session.json<{ folders: Row[] }>('GET', '/api/mail/folders')).folders) {
    for (const listed of (await session.json<{ emails: Row[] }>('GET', `/api/mail/emails?folder=${encodeURIComponent(String(folder.slug))}`)).emails) {
      const { email } = await session.json<{ email: Row & { attachments?: Row[] } }>('GET', `/api/mail/emails/${listed.id}`);
      const attachments = [];
      for (const attachment of email.attachments || []) {
        const bytes = await session.bytes(`/api/mail/attachments/${attachment.id}`);
        attachments.push({ filename: attachment.filename, size: Number(attachment.size_bytes), sha256: sha256(bytes) });
      }
      const original = raw[String(listed.id)] ?? null;
      emails.push({ folder: folder.slug, account: accounts.find(account => account.id === listed.mail_account_id)?.email_address ?? null,
        message_id: email.message_id ?? listed.message_id, subject: email.subject ?? listed.subject, body_text: email.body_text ?? null,
        // Inline references name this installation's attachment ids.
        html: email.body_html ? sha256(String(email.body_html).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID')) : null,
        attachments: attachments.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        original: original && { format: original.format, verified: original.verified, recorded: original.recorded, bytes: original.bytes, stored: original.stored } });
    }
  }
  return { accounts, emails: emails.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

/** What the person sees, by what each item is, in fields every release in the window has. */
export async function coreView(session: ViewSession, readRaw: RawReader) {
  const contacts = [];
  for (const listed of (await session.json<{ contacts: Row[] }>('GET', '/api/contacts')).contacts) {
    const { contact } = await session.json<{ contact: Row & { name: Row; emails: Row[]; phones: Row[]; photo: Row | null } }>('GET', `/api/contacts/${listed.id}`);
    contacts.push({ uid: contact.uid, display_name: contact.display_name, given: contact.name?.given ?? null, family: contact.name?.family ?? null, notes: contact.notes ?? null,
      emails: (contact.emails || []).map(entry => entry.value).sort(), phones: (contact.phones || []).map(entry => entry.value).sort(),
      photo: contact.photo ? sha256(await session.bytes(`/api/contacts/${listed.id}/photo?size=full`)) : null });
  }
  const calendars = (await session.json<{ calendars: Row[] }>('GET', '/api/calendar/calendars')).calendars;
  const events = (await session.json<{ events: Row[] }>('GET', '/api/calendar/events?include_todos=true&include_done=true&range_start=2000-01-01T00:00:00Z&range_end=2100-01-01T00:00:00Z')).events
    .map(event => ({ title: event.title, start: event.start_time ?? null, end: event.end_time ?? null, all_day: Boolean(event.all_day), location: event.location ?? null,
      todo_status: event.todo_status ?? null, todo_only: Boolean(event.is_todo_only), calendar: calendars.find(calendar => calendar.id === event.calendar_id)?.name ?? null,
      subtasks: ((event.subtasks as Row[]) || []).map(subtask => ({ title: subtask.title, done: Boolean(subtask.is_done) })) }));
  const recordings = [];
  for (const recording of (await session.json<{ recordings: Row[] }>('GET', '/api/recordings')).recordings) {
    recordings.push({ title: recording.title, size: Number(recording.size_bytes), bytes: sha256(await session.bytes(`/api/recordings/${recording.id}/file?download=1`)) });
  }
  const { accounts, emails } = await mailView(session, readRaw);
  const sort = <T,>(rows: T[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    contacts: sort(contacts), events: sort(events), recordings: sort(recordings), emails,
    mailAccounts: sort(accounts.map(account => ({ email: account.email_address, sync_mode: account.sync_mode }))),
    calendarAccounts: sort((await session.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.map(account => ({ provider: account.provider, username: account.username ?? null }))),
  };
}
export type CoreView = Awaited<ReturnType<typeof coreView>>;
export type MailEntry = CoreView['emails'][number];

/** Why the seeded mail is not all there in full; empty when it is. */
export function seededMailProblems(emails: readonly MailEntry[], seeds: readonly MailSeed[]) {
  const problems: string[] = [];
  for (const seed of seeds) {
    const label = `${seed.account} ${seed.folder} ${seed.messageId}`;
    const found = emails.filter(email => email.account === seed.account && email.folder === seed.folder && email.message_id === seed.messageId);
    if (found.length !== 1) { problems.push(`${label}: ${found.length} copies`); continue; }
    const [email] = found;
    if (email.subject !== seed.subject) problems.push(`${label}: subject ${JSON.stringify(email.subject)}`);
    if (typeof email.body_text !== 'string' || !email.body_text.includes(seed.text)) problems.push(`${label}: the body text is missing or changed`);
    const wanted = [{ filename: seed.attachment.filename, size: seed.attachment.bytes.length, sha256: sha256(seed.attachment.bytes) }];
    if (JSON.stringify(email.attachments) !== JSON.stringify(wanted)) problems.push(`${label}: attachments ${JSON.stringify(email.attachments)}`);
    const original = email.original, octets = sha256(seed.raw);
    if (!original) problems.push(`${label}: no original message is kept`);
    else {
      if (original.format !== 'exact_octets' || !original.verified) problems.push(`${label}: the original is not kept as verified exact octets (${original.format})`);
      if (original.recorded !== octets || original.stored !== octets || original.bytes !== seed.raw.length) {
        problems.push(`${label}: the original differs from the provider's bytes (recorded ${original.recorded}, stored ${original.stored}, ${original.bytes} bytes)`);
      }
    }
  }
  return problems;
}

export function assertSeededMail(emails: readonly MailEntry[], seeds: readonly MailSeed[], label: string) {
  const problems = seededMailProblems(emails, seeds);
  assert.deepEqual(problems, [], `${label}: the seeded mail is not all there in full`);
}
