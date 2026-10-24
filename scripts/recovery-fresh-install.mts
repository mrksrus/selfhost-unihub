// Release gate: a user's full backup moves to a new, independent installation.
//
//   node scripts/recovery-fresh-install.mts --image unihub:ci   (CI, Docker)
//   node scripts/recovery-fresh-install.mts --local             (npm --prefix api run build first)
//
// Two disposable installations with separate MariaDB servers, uploads and
// keys. The source gets synthetic data in every recovery section, partly
// through the API and partly as stored mail, provider credentials and older
// releases' data (api/tests/helpers/fresh-install-seed.cts). It exports a
// full encrypted backup through the browser's workflow and is then deleted
// with its keys. The destination imports the file with its recovery password;
// its data is compared with the source's through the API and checked on the
// server (api/tests/helpers/fresh-install-inspect.cts), again after a restart.
// Finally the restored provider passwords must log in to test peers this
// script controls, while no provider change from the source is replayed.
// Optional: UNIHUB_RECOVERY_EVIDENCE=<file> writes a JSON summary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createPeerCertificates, freePort, installationFactory, PEER_HOST, repo, Session, type Installation } from './fresh-installations.mts';

const factory = installationFactory();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-recovery-gate-'));
const certificates = createPeerCertificates(work);
const helper = (name: string) => fs.readFileSync(path.join(repo, 'api/tests/helpers', name), 'utf8');
const sha256 = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Synthetic provider passwords. Only the peers below accept them.
const secrets = { mail: [`fresh-imap-${crypto.randomBytes(6).toString('hex')}`, `fresh-imap-${crypto.randomBytes(6).toString('hex')}`], calendar: `fresh-dav-${crypto.randomBytes(6).toString('hex')}` };
const SECTIONS = ['settings', 'contacts', 'calendar', 'mail', 'recordings'];
// Provider evidence the mail engine records while syncing; their restore rules
// have their own tests (backup-mail-engine, account-mail-engine-recovery).
const UNSEEDED_TABLES = new Set(['mail.mail_remote_mailboxes', 'mail.mail_remote_occurrences', 'mail.mail_gmail_messages', 'mail.mail_operation_attempts', 'mail.mail_command_receipts', 'mail.mail_engine_quarantine']);
const evidence: Record<string, unknown> = { kind: factory.describe, started_at: new Date().toISOString() };

interface Inspection {
  tables: Record<string, number>; problems: string[]; files: { kind: string; sha256: string; size: number; uid: number }[]; leftovers: string[];
  credentials: { mail: { email_address: string; ciphertext_sha256: string | null; matches: boolean; is_active: number; delete_emails_on_server: number; sync_mode: string }[]; calendar: { ciphertext_sha256: string | null; matches: boolean; is_active: number }[] };
  writebacks: { status: string; state: string | null; is_current: number; dispatched: number }[]; sessions: number; legacyScores: number; activeJobs: number; sourceEmailLinks: number; uploadsOwner: number;
}
type Row = Record<string, unknown>;

function inspect(installation: Installation, userId: string): Inspection {
  return JSON.parse(installation.exec(helper('fresh-install-inspect.cts'), { INSPECT_USER_ID: userId, INSPECT_SECRETS: JSON.stringify(secrets) }));
}

async function waitForJob(session: Session, url: string, status: string, extra: (job: Row) => boolean = () => true) {
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

function wav(seconds: number, frequency: number) {
  const rate = 8000, samples = Math.round(rate * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * frequency * index / rate)), 44 + index * 2);
  return bytes;
}

/** What a user sees through the API, with installation-specific IDs replaced by what they name. */
async function publicView(session: Session) {
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
    contacts: sort((await session.json<{ contacts: Row[] }>('GET', '/api/contacts')).contacts.map(contact => ({ first_name: contact.first_name, last_name: contact.last_name,
      email: contact.email, email2: contact.email2, phone: contact.phone, company: contact.company, notes: contact.notes, favorite: Boolean(contact.is_favorite) }))),
    mailAccounts: sort(accounts.map(account => ({ email_address: account.email_address, display_name: account.display_name, provider: account.provider, username: account.username,
      imap: `${account.imap_host}:${account.imap_port}`, sync_mode: account.sync_mode, has_saved_password: account.has_saved_password,
      signature_html: account.signature_html, signature_text: account.signature_text }))),
    mailAccountSettings: sort(Object.entries(accountSettings).map(([id, settings]) => ({ account: accountEmail(id),
      ...Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, Array.isArray(setting.value) ? setting.value.map(folderName) : setting.value])) }))),
    calendarSettings: sort(Object.entries(calendarSettings).map(([id, settings]) => ({ calendar: calendars.find(calendar => calendar.id === id)?.name ?? `missing calendar ${id}`,
      ...Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.value])) }))),
    templates: sort((await session.json<{ templates: Row[] }>('GET', '/api/mail/templates')).templates.map(template => ({ name: template.name, subject: template.subject,
      body_html: template.body_html, body_text: template.body_text }))),
    folders: sort(folders.filter(folder => !folder.is_system).map(folder => ({ slug: folder.slug, display_name: folder.display_name, position: folder.position,
      special_use: folder.special_use, account: accountEmail(folder.mail_account_id), total: folder.total_count }))),
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
    recordings: sort(recordings.map(recording => ({ title: recording.title, description: recording.description, original_filename: recording.original_filename,
      content_type: recording.content_type, size: recording.size_bytes, duration: recording.duration_seconds, source: recording.source, recorded_at: recording.recorded_at,
      tags: recording.tags, bytes: recordingBytes.find(item => item.title === recording.title)?.sha256 }))),
    ids: { user: me.id, accounts: accounts.map(account => account.id), emails: emails.length, events: events.map(event => event.id), recordings: recordings.map(recording => recording.id) },
  };
}

// ── Test peers: the only servers restored credentials may reach ─────────

const DESTRUCTIVE = /^(UID )?(STORE|MOVE|COPY|EXPUNGE)\b|^(EXPUNGE|DELETE|RENAME|APPEND)\b/i;
interface PeerLog { logins: { user: string; ok: boolean }[]; commands: string[]; destructive: string[]; dav: { method: string; path: string; ok: boolean }[] }

async function startPeers(host: string, imapPort: number, davPort: number) {
  const log: PeerLog = { logins: [], commands: [], destructive: [], dav: [] };
  const expected = new Map(secrets.mail.map((password, index) => [`fresh-mail-${index}@example.test`, password]));
  const unquote = (value: string) => value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
  // Logins and a read-only INBOX succeed; every other command fails as a
  // temporary provider outage, so a restored account can prove its password
  // without the peer ever confirming or denying mailbox contents.
  const imap = tls.createServer({ cert: certificates.cert, key: certificates.key }, socket => {
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1] disposable UniHub test peer\r\n');
    let buffer = '', authenticated = false;
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const match = /^(\S+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, command] = match;
        const reply = (text: string) => socket.write(`${tag} ${text}\r\n`);
        const login = /^LOGIN ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/i.exec(command);
        log.commands.push(login ? 'LOGIN' : command);
        if (DESTRUCTIVE.test(command)) log.destructive.push(command);
        if (/^CAPABILITY$/i.test(command)) { socket.write('* CAPABILITY IMAP4rev1\r\n'); reply('OK done'); }
        else if (login) {
          const user = unquote(login[1]), ok = expected.get(user) === unquote(login[2]);
          log.logins.push({ user, ok });
          authenticated = ok;
          reply(ok ? 'OK logged in' : 'NO [AUTHENTICATIONFAILED] invalid credentials');
        } else if (/^NOOP$/i.test(command)) reply('OK done');
        else if (/^LOGOUT$/i.test(command)) { socket.write('* BYE bye\r\n'); reply('OK done'); socket.end(); }
        else if (authenticated && /^LIST "" ""$/i.test(command)) { socket.write('* LIST (\\Noselect) "/" ""\r\n'); reply('OK done'); }
        else if (authenticated && /^LIST "" "?INBOX"?$/i.test(command)) { socket.write('* LIST () "/" INBOX\r\n'); reply('OK done'); }
        else if (authenticated && /^EXAMINE "?INBOX"?$/i.test(command)) {
          socket.write('* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT 1] ok\r\n');
          reply('OK [READ-ONLY] examined');
        } else reply('NO [UNAVAILABLE] disposable test peer: temporarily unavailable');
      }
    });
  });
  const davAuth = `Basic ${Buffer.from(`calendar-user:${secrets.calendar}`).toString('base64')}`;
  const dav = https.createServer({ cert: certificates.cert, key: certificates.key }, (request, response) => {
    request.resume();
    const ok = request.headers.authorization === davAuth;
    log.dav.push({ method: request.method || '', path: request.url || '', ok });
    if (!ok) { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end(); return; }
    // Authenticated, then a temporary outage: never a listing that could delete.
    response.writeHead(503, { 'Retry-After': '3600' }).end('disposable test peer: temporarily unavailable');
  });
  await new Promise<void>(resolve => imap.listen(imapPort, host, resolve));
  await new Promise<void>(resolve => dav.listen(davPort, host, resolve));
  return { log, close: () => { imap.close(); dav.close(); } };
}

// ── The scenario ─────────────────────────────────────────────────────────

const installations: Installation[] = [];
let peers: Awaited<ReturnType<typeof startPeers>> | null = null;
let failed = true;
try {
  const peerHost = factory.describe.startsWith('container') ? '0.0.0.0' : '127.0.0.1';
  const imapPort = await freePort(), davPort = await freePort();
  const sourceAdmin = { email: 'fresh-source@example.test', password: `source-${crypto.randomBytes(9).toString('hex')}` };
  const destinationAdmin = { email: 'fresh-destination@example.test', password: `destination-${crypto.randomBytes(9).toString('hex')}` };
  console.log(`Starting two installations (${factory.describe})`);
  // Let both starts settle before cleanup. A sibling may still be starting
  // after the first failure; register every success as soon as it exists.
  const starts = await Promise.allSettled([
    factory.start({ name: 'source', adminEmail: sourceAdmin.email, adminPassword: sourceAdmin.password, caFile: certificates.ca }),
    factory.start({ name: 'destination', adminEmail: destinationAdmin.email, adminPassword: destinationAdmin.password, caFile: certificates.ca }),
  ].map(async start => { const installation = await start; installations.push(installation); return installation; }));
  const failures = starts.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'A disposable installation failed to start');
  const [source, destination] = starts.map(result => (result as PromiseFulfilledResult<Installation>).value);

  // 1. Source data, through the API where a person would create it.
  const owner = new Session(source.url);
  const ownerId = (await owner.signIn(sourceAdmin.email, sourceAdmin.password)).user.id;
  const capabilities = await owner.json<{ sections: { id: string }[] }>('GET', '/api/backup/capabilities');
  assert.deepEqual(capabilities.sections.map(section => section.id).sort(), [...SECTIONS].sort(),
    'A recovery section was added or removed: seed and compare it in this gate (and fresh-install-seed.cts) before releasing.');
  await owner.json('PUT', '/api/auth/profile', { full_name: 'Grüße Fresh Install', timezone: 'Europe/Vienna' });
  await owner.json('PUT', '/api/settings/preferences', { accent_color: 'teal', default_start_page: 'calendar', email_link_behavior: 'internal' });
  for (const contact of [
    { first_name: 'Zoë', last_name: 'Example', email: 'zoe@example.test', email2: 'second@example.test', phone: '+43 12345', company: 'Example GmbH', notes: 'Unicode: Grüße\nSecond line' },
    { first_name: 'Ana', last_name: 'Sample', email: 'ana@example.test', notes: '' },
  ]) {
    const { contact: created } = await owner.json<{ contact: Row }>('POST', '/api/contacts', contact);
    if (contact.first_name === 'Zoë') await owner.json('PUT', `/api/contacts/${created.id}/favorite`, { is_favorite: true });
  }
  const audio = wav(0.5, 440);
  const started = await owner.json<{ upload: { id: string } }>('POST', '/api/recordings/uploads/start', { title: 'Uploaded tone', original_filename: 'tone-upload.wav',
    content_type: 'audio/wav', total_bytes: audio.length, duration_seconds: 0.5, source: 'imported' });
  const half = Math.floor(audio.length / 2);
  await owner.json('POST', `/api/recordings/uploads/${started.upload.id}/chunk`, { offset: 0, data_base64: audio.subarray(0, half).toString('base64') });
  await owner.json('POST', `/api/recordings/uploads/${started.upload.id}/chunk`, { offset: half, data_base64: audio.subarray(half).toString('base64') });
  const recording = (await owner.json<{ recording: Row }>('POST', `/api/recordings/uploads/${started.upload.id}/complete`, { sha256: sha256(audio) })).recording;

  // 2. Stored mail, credentials, history and older releases' data.
  const seeded = JSON.parse(source.exec(helper('fresh-install-seed.cts'), { SEED_USER_ID: ownerId, SEED_RECORDING_ID: String(recording.id), SEED_PEER_HOST: PEER_HOST,
    SEED_IMAP_PORT: String(imapPort), SEED_DAV_PORT: String(davPort), SEED_SECRETS: JSON.stringify(secrets) })) as { emails: string[] };

  // 3. Data that links sections: a ToDo made from an email, with subtasks, and a local event.
  const { event: task } = await owner.json<{ event: Row }>('POST', '/api/calendar/events', { title: 'Answer fresh mail', description: 'From the email',
    start_time: '2030-03-01T09:00:00.000Z', end_time: '2030-03-01T09:30:00.000Z', is_todo_only: true, source_email_id: seeded.emails[0] }, { expected: [200, 201] });
  for (const title of ['Read it', 'Reply']) await owner.json('POST', `/api/calendar/events/${task.id}/subtasks`, { title }, { expected: [200, 201] });
  await owner.json('POST', '/api/calendar/events', { title: 'Local all-day', start_time: '2030-04-01T00:00:00.000Z', end_time: '2030-04-02T00:00:00.000Z', all_day: true,
    location: 'Graz', reminders: [30] }, { expected: [200, 201] });

  const before = await publicView(owner);
  const sourceServer = inspect(source, ownerId);
  assert.deepEqual(sourceServer.problems, [], 'Source data must be consistent before export');
  for (const [table, count] of Object.entries(sourceServer.tables)) {
    if (!UNSEEDED_TABLES.has(table)) assert.ok(count > 0, `${table} has no source data; seed it so the gate covers it`);
  }
  assert.equal(sourceServer.sourceEmailLinks, 1);
  console.log(`Source: ${Object.values(sourceServer.tables).reduce((sum, count) => sum + count, 0)} rows in ${Object.keys(sourceServer.tables).length} tables, ${sourceServer.files.length} files`);

  // 4. Full encrypted export through the browser's workflow, then the source and its keys are gone.
  const job = (await owner.json<{ job: Row }>('POST', '/api/backup/jobs', { sections: 'full', encrypt: true }, { expected: 202 })).job;
  const ready = await waitForJob(owner, `/api/backup/jobs/${job.id}`, 'ready');
  const { recovery_password: recoveryPassword } = await owner.json<{ recovery_password: string }>('POST', `/api/backup/jobs/${job.id}/recovery-password/reveal`, {});
  const archive = await owner.bytes(`/api/backup/jobs/${job.id}/download`);
  assert.equal(sha256(archive), ready.file_sha256);
  for (const secret of [...secrets.mail, secrets.calendar, sourceAdmin.password]) assert.equal(archive.includes(Buffer.from(secret)), false, 'The archive must not contain a plain password');
  evidence.archive = { sha256: ready.file_sha256, bytes: archive.length };
  await source.destroy();
  installations.splice(installations.indexOf(source), 1);
  console.log(`Exported ${archive.length} bytes; the source installation, its database and keys are deleted.`);

  // 5. Import as a different user of a different installation, with the recovery password.
  const user = new Session(destination.url);
  const userId = (await user.signIn(destinationAdmin.email, destinationAdmin.password)).user.id;
  const destinationBefore = inspect(destination, userId);
  const imported = (await user.json<{ job: Row }>('POST', '/api/backup/import?sections=full&conflict_mode=replace&credentials_mode=restore', archive,
    { expected: 202, raw: true, headers: { 'Content-Type': 'application/vnd.unihub.backup' } })).job;
  assert.equal(imported.status, 'awaiting_password', 'Another installation cannot open the archive without its recovery password');
  await user.json('POST', `/api/backup/restore-jobs/${imported.id}/unlock`, { password: 'not-the-recovery-password' }, { expected: 400 });
  await user.json('POST', `/api/backup/restore-jobs/${imported.id}/unlock`, { password: recoveryPassword }, { expected: 202 });
  await waitForJob(user, `/api/backup/restore-jobs/${imported.id}`, 'validated');
  await user.json('POST', `/api/backup/restore-jobs/${imported.id}/start`, {}, { expected: 202 });
  await waitForJob(user, `/api/backup/restore-jobs/${imported.id}`, 'completed', job => !job.archive_available);

  // 6. The same data, under new IDs, owned by the destination user.
  const check = async (label: string) => {
    const after = await publicView(user);
    const { ids: sourceIds, ...expected } = before, { ids: restoredIds, ...actual } = after;
    // A restored account is paused until its owner reconnects it (docs/DATA_RECOVERY.md).
    assert.deepEqual(actual, expected, `${label}: restored data differs from the source`);
    assert.notEqual(restoredIds.user, sourceIds.user);
    assert.equal(restoredIds.accounts.filter(id => sourceIds.accounts.includes(id)).length, 0, 'Restored accounts get new IDs');
    assert.equal(restoredIds.recordings.filter(id => sourceIds.recordings.includes(id)).length, 0, 'Restored recordings get new IDs');
    const server = inspect(destination, userId);
    assert.deepEqual(server.problems, [], `${label}: stored files and references`);
    for (const [table, count] of Object.entries(sourceServer.tables)) {
      const fresh = destinationBefore.tables[table] ?? 0;
      // Failed transcriptions are not recovery data; local defaults merge with the restored ones.
      const wanted = table === 'recordings.recording_transcription_jobs' ? count - 1 : count;
      if (['calendar.calendar_accounts', 'calendar.calendar_calendars', 'mail.mail_folders'].includes(table)) assert.ok(server.tables[table] >= wanted, `${label}: ${table}`);
      else assert.equal(server.tables[table] - fresh, wanted, `${label}: ${table} rows`);
    }
    assert.deepEqual(server.files.map(file => `${file.kind}:${file.sha256}`).sort(), sourceServer.files.map(file => `${file.kind}:${file.sha256}`).sort(), `${label}: file bytes`);
    if (destination.kind === 'container') assert.ok(server.files.every(file => file.uid === 10001) && server.uploadsOwner === 10001, 'Restored files belong to the API user');
    assert.deepEqual(server.leftovers, [], `${label}: no staged or uploaded archive is left behind`);
    assert.equal(server.legacyScores, 0, 'Removed Games scores are not restored');
    assert.equal(server.sourceEmailLinks, 1, 'The ToDo still names its email');
    assert.equal(server.activeJobs, 0, 'No provider job or worker lease is restored');
    assert.ok(server.writebacks.length >= 1 && server.writebacks.every(row => row.status !== 'pending' && !['queued', 'reconciling'].includes(String(row.state)) && !row.is_current),
      `${label}: an archived provider change stays inspectable but cannot run: ${JSON.stringify(server.writebacks)}`);
    for (const account of server.credentials.mail) {
      assert.equal(account.matches, true, `${account.email_address}: the password is readable with this installation's key`);
      assert.ok(!sourceServer.credentials.mail.some(old => old.ciphertext_sha256 === account.ciphertext_sha256), 'Credentials are re-encrypted for this installation');
      assert.equal(account.delete_emails_on_server, 0, 'Restore must not re-enable provider deletion');
    }
    const calendarAccount = server.credentials.calendar.find(account => account.ciphertext_sha256);
    assert.ok(calendarAccount?.matches, 'The calendar password is readable with this installation\'s key');
    return { after, server };
  };
  const first = await check('After restore');
  assert.ok(first.server.credentials.mail.every(account => account.is_active === 0), 'Restored mail accounts stay paused until reconnected');
  const accountsJson = JSON.stringify(await user.json('GET', '/api/mail/accounts')) + JSON.stringify(await user.json('GET', '/api/calendar/accounts'));
  for (const secret of [...secrets.mail, secrets.calendar]) assert.equal(accountsJson.includes(secret), false, 'The API never returns a stored password');
  console.log('Restore matches the source; checking isolation and a restart.');

  // 7. Another user of the destination sees none of it.
  await user.json('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' });
  const otherEmail = 'fresh-other@example.test', otherPassword = `other-${crypto.randomBytes(9).toString('hex')}`;
  await new Session(destination.url).json('POST', '/api/auth/signup', { email: otherEmail, password: otherPassword, full_name: 'Other user' }, { expected: [200, 201] });
  const other = new Session(destination.url);
  await other.signIn(otherEmail, otherPassword);
  const otherView = await publicView(other);
  assert.equal(otherView.contacts.length + otherView.emails.length + otherView.recordings.length + otherView.mailAccounts.length, 0, 'Another user sees nothing restored');
  await other.send('GET', `/api/recordings/${first.after.ids.recordings[0]}/file`, undefined, { expected: 404 });

  // 8. A restart keeps everything, and the signed-in session.
  await destination.restart();
  await check('After restart');

  // 9. Restored credentials work against peers this script controls, and nothing from the source is replayed.
  peers = await startPeers(peerHost, imapPort, davPort);
  const accounts = (await user.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  for (const account of accounts) {
    await user.json('PUT', `/api/mail/accounts/${account.id}`, { is_active: true });
  }
  assert.deepEqual(peers.log.logins.filter(login => login.ok).map(login => login.user).sort().filter((value, index, all) => all.indexOf(value) === index),
    accounts.map(account => String(account.email_address)).sort(), 'Every restored mail password logs in');
  assert.equal(peers.log.logins.filter(login => !login.ok).length, 0, 'No wrong password was sent');
  const calendarAccount = (await user.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.find(account => account.provider === 'caldav')!;
  const synced = await user.json<{ result: Row }>('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
  assert.equal(synced.result.ok, false, 'The test peer answers with a temporary outage');
  assert.ok(peers.log.dav.some(request => request.ok), `The restored calendar password authenticates: ${JSON.stringify(peers.log.dav)}`);
  assert.equal(peers.log.dav.filter(request => !request.ok && request.method !== 'OPTIONS').length, 0, 'No wrong calendar password was sent');
  await sleep(15000);
  assert.deepEqual(peers.log.destructive, [], 'No provider change is replayed after restore');
  const settled = await publicView(user);
  assert.deepEqual(settled.emails, first.after.emails, 'Provider outages after reconnecting do not remove restored mail');
  assert.deepEqual(settled.events, first.after.events, 'Calendar outages after reconnecting do not remove restored events');
  evidence.peer = { logins: peers.log.logins.length, imapCommands: [...new Set(peers.log.commands)], davRequests: peers.log.dav.length };
  evidence.restored = { tables: first.server.tables, files: first.server.files.length };
  failed = false;
  console.log('Recovery gate passed: full backup restored into an independent installation, verified through the API and on the server, after a restart, and with working credentials.');
} finally {
  peers?.close();
  if (failed && peers) console.error('Test peer log:', JSON.stringify(peers.log, null, 1));
  if (failed) for (const installation of installations) console.error(`--- ${installation.name} log ---\n${installation.logs()}`);
  for (const installation of installations) await installation.destroy().catch(error => console.error(error));
  fs.rmSync(work, { recursive: true, force: true });
  evidence.result = failed ? 'failed' : 'passed';
  if (process.env.UNIHUB_RECOVERY_EVIDENCE) fs.writeFileSync(process.env.UNIHUB_RECOVERY_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
}
