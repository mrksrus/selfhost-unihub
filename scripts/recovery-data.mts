// The synthetic source data of the recovery checks and how they read it back:
// recovery-fresh-install.mts (a user backup moves to another installation)
// and instance-backup-drill.mts (an instance backup restores the whole
// installation). The source gets data in every recovery section, partly
// through the API and partly on the server (api/tests/helpers/
// fresh-install-seed.cts); publicView() is what its owner sees through the
// API, inspect() what only the server sees (fresh-install-inspect.cts).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PEER_HOST, repo, type Installation, type Session } from './fresh-installations.mts';
import { icsEvent, type ProviderAccount, type Providers } from './test-providers.mts';

export const helper = (name: string) => fs.readFileSync(path.join(repo, 'api/tests/helpers', name), 'utf8');
export const sha256 = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export type Row = Record<string, unknown>;

/** Synthetic provider passwords; only the test providers accept them. */
export function providerSecrets() {
  return { mail: [`fresh-imap-${crypto.randomBytes(6).toString('hex')}`, `fresh-imap-${crypto.randomBytes(6).toString('hex')}`], calendar: `fresh-dav-${crypto.randomBytes(6).toString('hex')}` };
}
export type Secrets = ReturnType<typeof providerSecrets>;
/** The provider accounts the seed's mail and calendar accounts sign in to. */
export const providerAccounts = (secrets: Secrets) => ({
  mail: secrets.mail.map((password, index): ProviderAccount => ({ user: `fresh-mail-${index}@example.test`, password })),
  calendar: [{ user: 'calendar-user', password: secrets.calendar }] as ProviderAccount[],
});

export interface Inspection {
  tables: Record<string, number>; mirror: Record<string, number>; problems: string[]; files: { kind: string; sha256: string; size: number; uid: number; mirror: boolean }[]; leftovers: string[];
  credentials: { mail: { email_address: string; ciphertext_sha256: string | null; matches: boolean; is_active: number; delete_emails_on_server: number; sync_mode: string }[]; calendar: { ciphertext_sha256: string | null; matches: boolean; is_active: number }[] };
  writebacks: { status: string; state: string | null; is_current: number; dispatched: number }[]; sessions: number; legacyScores: number; activeJobs: number; sourceEmailLinks: number; uploadsOwner: number;
}

export function inspect(installation: Installation, userId: string, secrets: Secrets): Inspection {
  return JSON.parse(installation.exec(helper('fresh-install-inspect.cts'), { INSPECT_USER_ID: userId, INSPECT_SECRETS: JSON.stringify(secrets) }));
}

export async function waitForJob(session: Session, url: string, status: string, extra: (job: Row) => boolean = () => true) {
  const deadline = Date.now() + 180000;
  let job: Row = {};
  while (Date.now() < deadline) {
    job = (await session.json<{ job: Row }>('GET', url)).job;
    assert.notEqual(job.status, 'failed', `${url}: ${job.error}`);
    if (job.status === status && extra(job)) return job;
    await sleep(250);
  }
  throw new Error(`${url} did not reach ${status}: ${JSON.stringify(job)}`);
}

export function wav(seconds: number, frequency: number) {
  const rate = 8000, samples = Math.round(rate * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * frequency * index / rate)), 44 + index * 2);
  return bytes;
}

// A small RGB PNG for the contact photo upload; the server converts it.
export function png(width: number, height: number, [r, g, b]: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]),
    ...Array.from({ length: width }, (_, x) => Buffer.from([(r + x * 3) & 255, (g + y * 3) & 255, b]))])));
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Uploads a recording in two chunks, as the browser does. */
export async function uploadRecording(session: Session, title: string, filename: string, audio: Buffer) {
  const started = await session.json<{ upload: { id: string } }>('POST', '/api/recordings/uploads/start', { title, original_filename: filename,
    content_type: 'audio/wav', total_bytes: audio.length, duration_seconds: 0.5, source: 'imported' });
  const half = Math.floor(audio.length / 2);
  await session.json('POST', `/api/recordings/uploads/${started.upload.id}/chunk`, { offset: 0, data_base64: audio.subarray(0, half).toString('base64') });
  await session.json('POST', `/api/recordings/uploads/${started.upload.id}/chunk`, { offset: half, data_base64: audio.subarray(half).toString('base64') });
  return (await session.json<{ recording: Row }>('POST', `/api/recordings/uploads/${started.upload.id}/complete`, { sha256: sha256(audio) })).recording;
}

export interface SeededSource {
  emails: string[];
  /** The Sync account's messages as its provider holds them. */
  providerMail: { user: string; mailbox: string; raw: string }[];
  /** The CalDAV event (a synced task with UniHub state) as its provider holds it. */
  providerEvent: { user: string; calendar: string; displayName: string; uid: string; title: string; description: string; location: string; start: string; end: string;
    attendees: { email: string; name: string; status: 'ACCEPTED' }[] };
}

/**
 * Fills the source with data in every recovery section: through the API
 * where a person would create it, and on the server (fresh-install-seed.cts)
 * what needs a provider: synced mail with files, credentials, folder history,
 * a CalDAV account and its synced task, transcripts and older releases' data.
 * Its mail and calendar accounts point at the test providers' ports.
 */
export async function seedSource(source: Installation, owner: Session, ownerId: string, secrets: Secrets, ports: { imapPort: number; davPort: number }): Promise<SeededSource> {
  await owner.json('PUT', '/api/auth/profile', { full_name: 'Grüße Fresh Install', timezone: 'Europe/Vienna' });
  await owner.json('PUT', '/api/settings/preferences', { accent_color: 'teal', default_start_page: 'calendar', email_link_behavior: 'internal' });
  for (const contact of [
    { first_name: 'Zoë', last_name: 'Example', email: 'zoe@example.test', email2: 'second@example.test', phone: '+43 12345', company: 'Example GmbH', notes: 'Unicode: Grüße\nSecond line' },
    { first_name: 'Ana', last_name: 'Sample', email: 'ana@example.test', notes: '' },
  ]) {
    const { contact: created } = await owner.json<{ contact: Row }>('POST', '/api/contacts', contact);
    if (contact.first_name === 'Zoë') await owner.json('PUT', `/api/contacts/${created.id}/favorite`, { is_favorite: true });
  }
  // A contact in the vCard model (0.26), with a photo the server converts.
  const { contact: mia } = await owner.json<{ contact: Row }>('POST', '/api/contacts', { name: { given: 'Mia', family: 'Ørsted', prefix: 'Dr.' },
    organization: { name: 'Example GmbH', department: 'Forschung' }, birthday: '--02-29', notes: 'Grüße',
    emails: [{ value: 'mia@example.test', label: 'work', preferred: true }, { value: 'mia.home@example.test', label: 'custom', custom_label: 'Lake house' }, 'three@example.test', 'four@example.test'],
    phones: [{ value: '+43 660 1234567', label: 'mobile' }], addresses: [{ street: 'Hauptplatz 2', postal_code: '8010', locality: 'Graz', country: 'Austria', label: 'work' }],
    urls: ['https://example.test/mia'], nicknames: ['Mimi'], categories: ['Friends'] });
  await owner.json('PUT', `/api/contacts/${mia.id}/photo`, png(40, 30, [200, 40, 90]), { raw: true, headers: { 'Content-Type': 'image/png' } });
  const recording = await uploadRecording(owner, 'Uploaded tone', 'tone-upload.wav', wav(0.5, 440));

  // Stored mail, credentials, history and older releases' data.
  const seeded = JSON.parse(source.exec(helper('fresh-install-seed.cts'), { SEED_USER_ID: ownerId, SEED_RECORDING_ID: String(recording.id), SEED_PEER_HOST: PEER_HOST,
    SEED_IMAP_PORT: String(ports.imapPort), SEED_DAV_PORT: String(ports.davPort), SEED_SECRETS: JSON.stringify(secrets) })) as SeededSource;

  // Data that links sections: a ToDo made from an email, with subtasks, and a local event.
  const { event: task } = await owner.json<{ event: Row }>('POST', '/api/calendar/events', { title: 'Answer fresh mail', description: 'From the email',
    start_time: '2030-03-01T09:00:00.000Z', end_time: '2030-03-01T09:30:00.000Z', is_todo_only: true, source_email_id: seeded.emails[0] }, { expected: [200, 201] });
  for (const title of ['Read it', 'Reply']) await owner.json('POST', `/api/calendar/events/${task.id}/subtasks`, { title }, { expected: [200, 201] });
  await owner.json('POST', '/api/calendar/events', { title: 'Local all-day', start_time: '2030-04-01T00:00:00.000Z', end_time: '2030-04-02T00:00:00.000Z', all_day: true,
    location: 'Graz', reminders: [30] }, { expected: [200, 201] });
  // The hand order (0.27): tasks without a date and a dated one; the newest
  // undated task is placed above the oldest by hand. A restore must give
  // back this order although every task gets a new id.
  for (const title of ['Pack boxes', 'Label boxes']) await owner.json('POST', '/api/calendar/events', { title, is_todo_only: true }, { expected: [200, 201] });
  await owner.json('POST', '/api/calendar/events', { title: 'Book van', start_time: '2030-03-02T08:00:00.000Z', end_time: '2030-03-02T08:30:00.000Z' }, { expected: [200, 201] });
  const undated = (await owner.json<{ events: Row[] }>('GET', '/api/calendar/events?include_todos=true&include_done=false&respect_auto_todo=true')).events
    .filter(event => event.is_todo_only).sort((a, b) => Number(a.sort_rank) - Number(b.sort_rank));
  assert.ok(undated.length >= 3, 'three tasks without a date');
  await owner.json('PUT', `/api/calendar/events/${undated.at(-1)!.id}/position`, { after: null, before: undated[0].id });
  return seeded;
}

/** Puts the seed's provider data at the test providers: the Sync account's messages and the CalDAV event. */
export async function seedProviders(providers: Providers, seeded: SeededSource, secrets: Secrets) {
  const accounts = providerAccounts(secrets);
  for (const message of seeded.providerMail) {
    const account = accounts.mail.find(entry => entry.user === message.user)!;
    await providers.append(account, message.mailbox, Buffer.from(message.raw, 'base64'));
  }
  const event = seeded.providerEvent, calendar = accounts.calendar[0];
  await providers.createCalendar(calendar, event.calendar, event.displayName);
  await providers.putEvent(calendar, event.calendar, event.uid, icsEvent(event));
}

/** What a user sees through the API, with installation-specific IDs replaced by what they name. */
export async function publicView(session: Session) {
  const me = (await session.json<{ user: Row }>('GET', '/api/auth/me')).user;
  const accounts = (await session.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  const accountEmail = (id: unknown) => id == null ? null : accounts.find(account => account.id === id)?.email_address ?? `unknown account ${id}`;
  const sort = <T,>(rows: T[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const folders = (await session.json<{ folders: Row[] }>('GET', '/api/mail/folders')).folders;
  const emails: Row[] = [];
  const emailSubjects = new Map<unknown, string>();
  for (const folder of folders) {
    for (const listed of (await session.json<{ emails: Row[] }>('GET', `/api/mail/emails?folder=${encodeURIComponent(String(folder.slug))}`)).emails) {
      const { email } = await session.json<{ email: Row & { attachments: Row[] } }>('GET', `/api/mail/emails/${listed.id}`);
      // Inline images are listed in the HTML only; each must load this installation's bytes.
      const inline = [...String(email.body_html || '').matchAll(/\/api\/mail\/attachments\/([0-9a-f-]{36})/g)].map(match => match[1]);
      const attachments = [...inline, ...email.attachments.map(attachment => attachment.id as string)];
      const hashes: string[] = [];
      for (const id of attachments) hashes.push(sha256(await session.bytes(`/api/mail/attachments/${id}`)));
      emailSubjects.set(email.id, `${email.subject} ${email.body_text}`);
      emails.push({ folder: folder.slug, account: accountEmail(email.mail_account_id), filing: accountEmail(email.filing_account_id), message_id: email.message_id,
        subject: email.subject, from: email.from_address, to: email.to_addresses, body_text: email.body_text, starred: email.is_starred, read: email.is_read,
        legacy: email.is_legacy, received_at: email.received_at, html: String(email.body_html || '').replace(/[0-9a-f-]{36}/g, 'ID'), attachments: hashes.sort() });
    }
  }
  const events = (await session.json<{ events: Row[] }>('GET', '/api/calendar/events?include_todos=true&include_done=true&range_start=2000-01-01T00:00:00Z&range_end=2100-01-01T00:00:00Z')).events;
  const calendars = (await session.json<{ calendars: Row[] }>('GET', '/api/calendar/calendars')).calendars;
  const recordings = (await session.json<{ recordings: Row[] }>('GET', '/api/recordings')).recordings;
  // Every contact in full (0.26): names, labelled values, dates, kept
  // properties, uid and the photo with its bytes. Installation ids are dropped.
  const withoutIds = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => ['id', 'version', 'created_at', 'updated_at'].includes(key) ? undefined : item));
  const contactDetails: unknown[] = [];
  for (const listed of (await session.json<{ contacts: Row[] }>('GET', '/api/contacts')).contacts) {
    const { contact } = await session.json<{ contact: Row & { photo: Row | null } }>('GET', `/api/contacts/${listed.id}`);
    const photo = contact.photo ? { full: sha256(await session.bytes(`/api/contacts/${listed.id}/photo?size=full`)), thumb: sha256(await session.bytes(`/api/contacts/${listed.id}/photo?size=thumb`)) } : null;
    contactDetails.push({ ...withoutIds(contact) as Row, photo_bytes: photo });
  }
  const recordingBytes: { title: unknown; sha256: string }[] = [];
  for (const recording of recordings) recordingBytes.push({ title: recording.title, sha256: sha256(await session.bytes(`/api/recordings/${recording.id}/file?download=1`)) });
  const preferences = (await session.json<{ preferences: Row }>('GET', '/api/settings/preferences')).preferences;
  // 0.24 settings by record: a folder reference is compared by the folder it names.
  type Resolved = Record<string, { value: unknown }>;
  const folderName = (ref: unknown) => String(ref).startsWith('folder:') ? `folder:${folders.find(folder => folder.id === String(ref).slice(7))?.slug ?? 'missing'}` : ref;
  const accountSettings = (await session.json<{ accounts: Record<string, Resolved> }>('GET', '/api/settings/values/mail-accounts')).accounts;
  const calendarSettings = (await session.json<{ calendars: Record<string, Resolved> }>('GET', '/api/settings/values/calendars')).calendars;
  return {
    profile: { full_name: me.full_name, timezone: me.timezone },
    preferences: { ...preferences, default_mail_account_id: accountEmail(preferences.default_mail_account_id || null) },
    modules: (await session.json<{ modules: Row[] }>('GET', '/api/modules')).modules.map(module => ({ id: module.id, visible: module.visible, enabled: module.enabled })),
    contacts: sort(contactDetails),
    mailAccounts: sort(accounts.map(account => ({ email_address: account.email_address, display_name: account.display_name, provider: account.provider, username: account.username,
      imap: `${account.imap_host}:${account.imap_port}`, sync_mode: account.sync_mode, has_saved_password: account.has_saved_password,
      signature_html: account.signature_html, signature_text: account.signature_text }))),
    mailAccountSettings: sort(Object.entries(accountSettings).map(([id, settings]) => ({ account: accountEmail(id),
      ...Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, Array.isArray(setting.value) ? setting.value.map(folderName) : setting.value])) }))),
    calendarSettings: sort(Object.entries(calendarSettings).map(([id, settings]) => ({ calendar: calendars.find(calendar => calendar.id === id)?.name ?? `missing calendar ${id}`,
      ...Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.value])) }))),
    templates: sort((await session.json<{ templates: Row[] }>('GET', '/api/mail/templates')).templates.map(template => ({ name: template.name, subject: template.subject,
      body_html: template.body_html, body_text: template.body_text }))),
    // A folder's count follows the mail it holds; the emails below are compared one by one.
    folders: sort(folders.filter(folder => !folder.is_system).map(folder => ({ slug: folder.slug, display_name: folder.display_name, position: folder.position,
      special_use: folder.special_use, account: accountEmail(folder.mail_account_id) }))),
    senderRules: sort((await session.json<{ rules: Row[] }>('GET', '/api/mail/sender-rules')).rules.map(rule => ({ account: rule.account_email, match: rule.match_value, target: rule.target_folder, active: rule.is_active }))),
    emails: sort(emails),
    calendarAccounts: sort((await session.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.map(account => ({ provider: account.provider,
      display_name: account.display_name, username: account.username, base_url: account.base_url }))),
    calendars: sort(calendars.map(calendar => ({ name: calendar.name, color: calendar.color, account: calendar.account_display_name, visible: calendar.is_visible }))),
    events: sort(events.map(event => ({ title: event.title, description: event.description, start: event.start_time, end: event.end_time, all_day: event.all_day,
      location: event.location, recurrence: event.recurrence, reminders: event.reminders, todo_status: event.todo_status, todo_only: event.is_todo_only,
      calendar: calendars.find(calendar => calendar.id === event.calendar_id)?.name ?? null,
      source_email: event.source_email_id ? emailSubjects.get(event.source_email_id) ?? `missing email ${event.source_email_id}` : null,
      subtasks: (event.subtasks as Row[]).map(subtask => ({ title: subtask.title, done: Boolean(subtask.is_done), position: subtask.position })),
      attendees: (event.attendees as Row[]).map(attendee => ({ email: attendee.email, name: attendee.display_name, response: attendee.response_status })) }))),
    // The order ToDo shows (0.27): each list's open tasks by rank, then by the
    // stable key (never by title, which could hide a flipped tie), and which
    // were placed by hand. Ranks are compared by the order they give; the
    // task_order row count proves no hand place was lost or added.
    taskOrder: Object.fromEntries(calendars.map(calendar => [String(calendar.name), events
      .filter(event => event.calendar_id === calendar.id && (event.is_todo_only || calendar.auto_todo_enabled) && !['done', 'cancelled'].includes(String(event.todo_status)))
      .sort((a, b) => Number(a.sort_rank) - Number(b.sort_rank) || (String(a.sort_key) < String(b.sort_key) ? -1 : String(a.sort_key) > String(b.sort_key) ? 1 : 0))
      .map(event => [event.title, event.hand_ordered])]).filter(([, tasks]) => (tasks as unknown[]).length)),
    recordings: sort(recordings.map(recording => ({ title: recording.title, description: recording.description, original_filename: recording.original_filename,
      content_type: recording.content_type, size: recording.size_bytes, duration: recording.duration_seconds, source: recording.source, recorded_at: recording.recorded_at,
      tags: recording.tags, bytes: recordingBytes.find(item => item.title === recording.title)?.sha256 }))),
    ids: { user: me.id, accounts: accounts.map(account => account.id), emails: emails.length, events: events.map(event => event.id), recordings: recordings.map(recording => recording.id) },
  };
}
export type PublicView = Awaited<ReturnType<typeof publicView>>;
