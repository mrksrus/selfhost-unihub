// Release gate: an installation of an earlier release upgrades to the
// candidate with its data, and that release's export imports into a fresh
// candidate installation.
//
//   node scripts/upgrade-check.mts --previous <k> --image <candidate> [--evidence <file>]
//   node scripts/upgrade-check.mts --from <version> --image <candidate> [--evidence <file>]
//   node scripts/upgrade-check.mts --list-previous <count>
//
// --previous k takes the k-th newest published release up to the candidate's
// version (package.json): previousReleases() in scripts/published-image.mts.
// The release's image is pulled by its version tag from the registry. Needs
// Docker, the test providers of scripts/test-providers.mts, and port 465 for
// their SMTP (the API uses implicit TLS for SMTP only there).
//
//  1. The earlier release starts as in production with its own MariaDB,
//     storage and keys, and gets synthetic data through its API: contacts with
//     a photo, local tasks with done state and subtasks (one moved to another
//     list, from 0.27.0), a recording, a Sync and a Download mail account and a
//     CalDAV account at the test providers, and UniHub's state on the synced
//     event. It makes an encrypted full export.
//  2. The app stops; the database and the storage are copied with the
//     database stopped (a snapshot, kept until the end for diagnosis).
//  3. The candidate starts on the same database, storage, keys and settings:
//     every upgrade step runs, the data inventory check passes, the session
//     from before the upgrade still works, and everything the person saw reads
//     the same. Writes work: a contact, an event, a task with a subtask, a
//     recording, and a message sent through the Sync account that arrives at
//     the provider. A new full backup restores into a second person.
//  4. A fresh candidate installation imports the earlier release's export:
//     its contents and what it left out are stated, UniHub's own data is
//     there, the Sync-mode mail and the CalDAV event come back from the
//     providers with the task's state, and no destructive IMAP command is sent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerCertificates, PEER_HOST, repo, Session, startContainerInstallation, type Installation } from './fresh-installations.mts';
import { compareVersions, IMAGE_REPOSITORY, isPublished, previousReleases } from './published-image.mts';
import { helper, png, sha256, sleep, uploadRecording, waitForJob, wav, type Row } from './recovery-data.mts';
import { icsEvent, startProviders, type ProviderAccount, type Providers } from './test-providers.mts';
import { assertSeededMail, coreView as readView, seedMessage, seededMailProblems, type CoreView, type RawEntry } from './upgrade-view.mts';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const candidateVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version as string;

function releaseTags() {
  const result = spawnSync('git', ['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*'], { cwd: repo, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(`Listing the release tags failed: ${result.stderr}`);
  return result.stdout.split('\n').map(line => line.split('refs/tags/')[1]).filter((tag): tag is string => !!tag);
}
const releasesUpToCandidate = (count: number) => previousReleases(candidateVersion, releaseTags(), count, version => isPublished(version));

if (argument('--list-previous')) {
  console.log((await releasesUpToCandidate(Number(argument('--list-previous')))).join(' '));
  process.exit(0);
}
const candidateImage = argument('--image');
if (!candidateImage) throw new Error('usage: --previous <k> | --from <version>, and --image <candidate image>');
let from = argument('--from');
if (!from) {
  const k = Number(argument('--previous'));
  if (!Number.isInteger(k) || k < 1) throw new Error('--previous needs 1, 2, 3, ...');
  const releases = await releasesUpToCandidate(k);
  if (releases.length < k) throw new Error(`Only ${releases.length} published releases up to ${candidateVersion}: ${releases.join(', ')}`);
  from = releases[k - 1];
}
const oldImage = `${IMAGE_REPOSITORY}:${from}`;
const atLeast = (version: string) => compareVersions(from!, version) >= 0;

const work = fs.mkdtempSync(path.join(os.tmpdir(), `unihub-upgrade-${from}-`));
const certificates = createPeerCertificates(work);
const evidence: Record<string, unknown> & { steps: { step: string; seconds: number; result: string }[] } = {
  check: 'upgrade', from, candidate: { version: candidateVersion, image: candidateImage }, started_at: new Date().toISOString(), steps: [],
};
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  console.log(`· ${name}`);
  try {
    const value = await run();
    evidence.steps.push({ step: name, seconds: Math.round((Date.now() - started) / 1000), result: 'passed' });
    return value;
  } catch (error) {
    evidence.steps.push({ step: name, seconds: Math.round((Date.now() - started) / 1000), result: `failed: ${(error as Error).message.split('\n')[0].slice(0, 300)}` });
    throw error;
  }
}
const imageId = (image: string) => spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).stdout.trim();
const repoDigest = (image: string) => spawnSync('docker', ['image', 'inspect', '--format', '{{join .RepoDigests " "}}', image], { encoding: 'utf8' }).stdout.trim();

const random = (prefix: string) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
const mail = { sync: { user: 'upgrade-sync@example.test', password: random('imap') }, download: { user: 'upgrade-download@example.test', password: random('imap') } };
const dav: ProviderAccount = { user: 'upgrade-dav', password: random('dav') };
const SYNCED_CALENDAR = 'Team calendar';
// Inside the CalDAV sync window of every release (a year back, two years
// ahead): a later date never reaches the installations.
const eventStart = new Date(Date.now() + 30 * 86400000); eventStart.setUTCHours(9, 0, 0, 0);
const providerEvent = { uid: 'upgrade-team-event@example.test', title: 'Team review', start: eventStart.toISOString(), end: new Date(eventStart.getTime() + 3600000).toISOString(),
  description: 'Synthetic agenda', location: 'Room 1', attendees: [{ email: 'colleague@example.test', name: 'Colleague', status: 'ACCEPTED' as const }] };
// MIME mail with an attachment at the providers, by the folder it lands in.
const seeds = {
  sync: [
    { mailbox: 'INBOX', seed: seedMessage({ account: mail.sync.user, folder: 'inbox', id: 'upgrade-sync-1', subject: 'Quarterly numbers' }) },
    { mailbox: 'INBOX', seed: seedMessage({ account: mail.sync.user, folder: 'inbox', id: 'upgrade-sync-2', subject: 'Lunch on Friday' }) },
    { mailbox: 'Projects', seed: seedMessage({ account: mail.sync.user, folder: 'projects', id: 'upgrade-sync-3', subject: 'Project plan' }) },
  ],
  download: [
    { mailbox: 'INBOX', seed: seedMessage({ account: mail.download.user, folder: 'inbox', id: 'upgrade-download-1', subject: 'Invoice 42' }) },
    { mailbox: 'INBOX', seed: seedMessage({ account: mail.download.user, folder: 'inbox', id: 'upgrade-download-2', subject: 'Travel booking' }) },
  ],
};
const syncSeeds = seeds.sync.map(entry => entry.seed), downloadSeeds = seeds.download.map(entry => entry.seed), allSeeds = [...syncSeeds, ...downloadSeeds];

/** What the person sees, with each message's original as the installation keeps it. */
const coreView = (session: Session, installation: Installation, person: string) => readView(session,
  () => JSON.parse(installation.exec(helper('upgrade-mail-raw.cts'), { RAW_USER_EMAIL: person })) as Record<string, RawEntry>);
/** The person's own data: what a user backup holds (no Sync-mode mail with a provider copy, no CalDAV event). */
const ownData = (view: CoreView) => ({ ...view, emails: view.emails.filter(email => email.account !== mail.sync.user), events: view.events.filter(event => event.calendar !== SYNCED_CALENDAR) });
/** The same data as a restore gives it back: each original kept, not yet verified at the provider again. */
const asRestored = (view: CoreView): CoreView => ({ ...view, emails: view.emails.map(email => email.original ? { ...email, original: { ...email.original, verified: false } } : email) });

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, { seconds = 180, nudge }: { seconds?: number; nudge?: () => Promise<unknown> } = {}) {
  const deadline = Date.now() + seconds * 1000;
  let value = await read();
  for (let attempt = 1; !done(value); attempt++) {
    if (Date.now() > deadline) throw new Error(`${what} within ${seconds} seconds: ${JSON.stringify(value).slice(0, 1500)}`);
    if (nudge && attempt % 15 === 0) await nudge();
    await sleep(1500);
    value = await read();
  }
  return value;
}
const syncMail = (session: Session, accountId: unknown) => session.json('POST', '/api/mail/sync', { account_id: accountId }, { expected: [200, 202, 409] });

async function exportFull(session: Session) {
  const job = (await session.json<{ job: Row }>('POST', '/api/backup/jobs', { sections: 'full', encrypt: true }, { expected: 202 })).job;
  const ready = await waitForJob(session, `/api/backup/jobs/${job.id}`, 'ready');
  const { recovery_password: password } = await session.json<{ recovery_password: string }>('POST', `/api/backup/jobs/${job.id}/recovery-password/reveal`, {});
  const archive = await session.bytes(`/api/backup/jobs/${job.id}/download`);
  assert.equal(sha256(archive), ready.file_sha256, 'The download is the archive the job made');
  return { archive, password, sha256: sha256(archive) };
}
async function importFull(session: Session, archive: Buffer, password: string) {
  const imported = (await session.json<{ job: Row }>('POST', '/api/backup/import?sections=full&conflict_mode=replace&credentials_mode=restore', archive,
    { expected: 202, raw: true, headers: { 'Content-Type': 'application/vnd.unihub.backup' } })).job;
  assert.equal(imported.status, 'awaiting_password');
  await session.json('POST', `/api/backup/restore-jobs/${imported.id}/unlock`, { password }, { expected: 202 });
  const validated = await waitForJob(session, `/api/backup/restore-jobs/${imported.id}`, 'validated');
  await session.json('POST', `/api/backup/restore-jobs/${imported.id}/start`, {}, { expected: 202 });
  await waitForJob(session, `/api/backup/restore-jobs/${imported.id}`, 'completed', job => !job.archive_available);
  return (validated.validation_result as { contents?: { included: string[]; left_out: { section: string; what: string; count?: number }[]; notes: string[] } } | null)?.contents;
}

const installations: Installation[] = [];
let providers: Providers | null = null;
let failed = true;
try {
  assert.ok(imageId(candidateImage), `The candidate image ${candidateImage} is not available`);
  await step(`Pull ${oldImage}`, async () => {
    const pulled = spawnSync('docker', ['pull', '--quiet', oldImage], { encoding: 'utf8', timeout: 600000 });
    if (pulled.status !== 0) throw new Error(`docker pull ${oldImage}: ${pulled.stderr}`);
  });
  evidence.old = { version: from, image: oldImage, digest: repoDigest(oldImage), id: imageId(oldImage) };
  (evidence.candidate as Row).id = imageId(candidateImage);
  (evidence.candidate as Row).digest = repoDigest(candidateImage) || null;

  providers = await step('Start the test providers', async () => {
    const started = await startProviders({ work, certificates, host: '0.0.0.0', mail: [mail.sync, mail.download], calendar: [dav], smtpPort: 465 });
    for (const [account, entries] of [[mail.sync, seeds.sync], [mail.download, seeds.download]] as const) {
      for (const { mailbox, seed } of entries) await started.append(account, mailbox, seed.raw);
    }
    await started.createCalendar(dav, 'team', SYNCED_CALENDAR);
    await started.putEvent(dav, 'team', providerEvent.uid, icsEvent(providerEvent));
    return started;
  });
  const peers = providers;
  const admin = { email: 'upgrade-admin@example.test', password: random('admin') };

  // 1. The earlier release with data.
  const installation = await step(`Start ${from}`, async () => {
    const started = await startContainerInstallation(oldImage, { name: `upgrade-${from}`, adminEmail: admin.email, adminPassword: admin.password, caFile: certificates.ca });
    installations.push(started);
    return started;
  });
  const owner = new Session(installation.url);
  await owner.signIn(admin.email, admin.password);
  const seeded = await step(`Add data through the ${from} API`, async () => {
    await owner.json('PUT', '/api/auth/profile', { full_name: 'Upgrade Grüße', timezone: 'Europe/Vienna' });
    const { contact: zoe } = await owner.json<{ contact: Row }>('POST', '/api/contacts', { first_name: 'Zoë', last_name: 'Upgrade', email: 'zoe.upgrade@example.test', phone: '+43 1234', notes: 'Grüße\nSecond line' });
    await owner.json('PUT', `/api/contacts/${zoe.id}/photo`, png(32, 24, [20, 120, 220]), { raw: true, headers: { 'Content-Type': 'image/png' } });
    await owner.json('POST', '/api/contacts', { first_name: 'Ana', last_name: 'Upgrade', email: 'ana.upgrade@example.test' });
    const { event: task } = await owner.json<{ event: Row }>('POST', '/api/calendar/events', { title: 'Write the report', is_todo_only: true }, { expected: [200, 201] });
    for (const title of ['Outline', 'Draft']) await owner.json('POST', `/api/calendar/events/${task.id}/subtasks`, { title }, { expected: [200, 201] });
    const { event: done } = await owner.json<{ event: Row }>('POST', '/api/calendar/events', { title: 'Book the room', is_todo_only: true }, { expected: [200, 201] });
    await owner.json('PUT', `/api/calendar/events/${done.id}/todo-status`, { todo_status: 'done' });
    await owner.json('POST', '/api/calendar/events', { title: 'Local meeting', start_time: '2030-05-07T12:00:00.000Z', end_time: '2030-05-07T13:00:00.000Z', location: 'Graz' }, { expected: [200, 201] });
    if (atLeast('0.27.0')) {
      // A task moved to another list (0.27): the move must survive the upgrade and the restore.
      const local = (await owner.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.find(account => account.provider === 'local');
      assert.ok(local, 'The person has a local calendar account');
      const { calendar: errands } = await owner.json<{ calendar: Row }>('POST', '/api/calendar/calendars', { account_id: local.id, name: 'Errands' }, { expected: [200, 201] });
      const { event: moving } = await owner.json<{ event: Row }>('POST', '/api/calendar/events', { title: 'Pick up the parcel', is_todo_only: true }, { expected: [200, 201] });
      await owner.json('POST', `/api/calendar/events/${moving.id}/move`, { calendar_id: errands.id }, { expected: [200, 202] });
      await until('The moved task is in its new list', () => coreView(owner, installation, admin.email), view => view.events.some(event => event.title === 'Pick up the parcel' && event.calendar === 'Errands'));
    }
    await uploadRecording(owner, 'Upgrade tone', 'upgrade-tone.wav', wav(0.5, 523));
    const ids: Record<string, unknown> = {};
    for (const [mode, account] of [['sync', mail.sync], ['download', mail.download]] as const) {
      const created = await owner.json<{ account?: Row; id?: unknown }>('POST', '/api/mail/accounts', { email_address: account.user, display_name: `Upgrade ${mode}`, provider: 'custom',
        username: account.user, encrypted_password: account.password, imap_host: PEER_HOST, imap_port: peers.imapPort, smtp_host: PEER_HOST, smtp_port: peers.smtpPort,
        sync_mode: mode, sync_fetch_limit: 'all' }, { expected: [200, 201] });
      ids[mode] = created.account?.id ?? created.id;
    }
    // In full: bodies, attachments and originals, so the comparisons below compare contents.
    await until('Both mail accounts download their mail in full', () => coreView(owner, installation, admin.email),
      view => seededMailProblems(view.emails, allSeeds).length === 0,
      { nudge: async () => { await syncMail(owner, ids.sync); await syncMail(owner, ids.download); } });
    const { account: calendarAccount } = await owner.json<{ account: Row }>('POST', '/api/calendar/accounts', { provider: 'caldav', username: dav.user, account_email: 'upgrade-dav@example.test',
      password: dav.password, url: peers.davUrl(dav.user), display_name: 'Upgrade CalDAV' }, { expected: [200, 201] });
    const synced = await owner.json<{ result: Row }>('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
    assert.equal(synced.result.ok, true, `The CalDAV account syncs: ${JSON.stringify(synced.result)}`);
    // UniHub's own state on the synced event: done, with a subtask.
    const events = (await owner.json<{ events: Row[] }>('GET', '/api/calendar/events?include_todos=true&include_done=true&range_start=2000-01-01T00:00:00Z&range_end=2100-01-01T00:00:00Z')).events;
    const team = events.find(event => event.title === providerEvent.title);
    assert.ok(team, 'The CalDAV event arrived');
    await owner.json('PUT', `/api/calendar/events/${team.id}/todo-status`, { todo_status: 'done' });
    await owner.json('POST', `/api/calendar/events/${team.id}/subtasks`, { title: 'Send the minutes' }, { expected: [200, 201] });
    return { ids };
  });
  const before = await coreView(owner, installation, admin.email);
  assertSeededMail(before.emails, allSeeds, from);
  const beforeSteps = JSON.parse(installation.exec(helper('upgrade-inspect.cts'))) as { latestApplied: number; latestKnown: number };
  assert.equal(beforeSteps.latestApplied, beforeSteps.latestKnown, `${from} finished its own upgrade steps`);
  const oldExport = await step(`Export a full backup with ${from}`, () => exportFull(owner));
  evidence.seeded = { contacts: before.contacts.length, events: before.events.length, recordings: before.recordings.length, emails: before.emails.length, archive: { sha256: oldExport.sha256, bytes: oldExport.archive.length } };

  // 2. A copy of the database and the storage, taken with both stopped.
  evidence.snapshot = await step('Snapshot the database and the storage', () => installation.snapshot());

  // 3. The candidate on the same database, storage and keys.
  await step(`Upgrade ${from} to the candidate`, () => installation.upgrade(candidateImage));
  const afterSteps = JSON.parse(installation.exec(helper('upgrade-inspect.cts'))) as { applied: number[]; latestApplied: number; latestKnown: number; inventory: string };
  assert.equal(afterSteps.latestApplied, afterSteps.latestKnown, `Every upgrade step ran: ${JSON.stringify(afterSteps.applied)}`);
  assert.equal(afterSteps.inventory, 'passed', 'The data inventory check passes on the upgraded database');
  evidence.migrations = { before: beforeSteps.latestApplied, after: afterSteps.latestApplied, latest: afterSteps.latestKnown, inventory: afterSteps.inventory };
  await step('The session from before the upgrade still works', () => owner.json('GET', '/api/auth/me'));
  await step('Everything reads the same after the upgrade', async () => {
    const after = await coreView(owner, installation, admin.email);
    assertSeededMail(after.emails, allSeeds, 'After the upgrade');
    assert.deepEqual(after, before);
  });
  await step('Writes work after the upgrade', async () => {
    await owner.json('POST', '/api/contacts', { first_name: 'Neo', last_name: 'After', email: 'neo.after@example.test' });
    await owner.json('POST', '/api/calendar/events', { title: 'After the upgrade', start_time: '2030-06-01T08:00:00.000Z', end_time: '2030-06-01T09:00:00.000Z' }, { expected: [200, 201] });
    const { event: task } = await owner.json<{ event: Row }>('POST', '/api/calendar/events', { title: 'New task after the upgrade', is_todo_only: true }, { expected: [200, 201] });
    await owner.json('POST', `/api/calendar/events/${task.id}/subtasks`, { title: 'First step' }, { expected: [200, 201] });
    await uploadRecording(owner, 'After the upgrade', 'after.wav', wav(0.5, 660));
    const subject = `Sent after the upgrade from ${from}`;
    await owner.json('POST', '/api/mail/send', { account_id: seeded.ids.sync, to: mail.download.user, subject, body: 'Synthetic message', isHtml: false }, { expected: [200, 201, 202] });
    await until('The message arrives at the provider', () => peers.messages(mail.download, 'INBOX'), messages => messages.some(entry => entry.subject === subject), { seconds: 120 });
    // And in the Download account, so the backup below and the view it is compared with hold the same mail.
    const view = await until('The Download account downloads it', () => coreView(owner, installation, admin.email),
      current => current.emails.some(email => email.account === mail.download.user && email.subject === subject && typeof email.body_text === 'string'
        && email.original?.format === 'exact_octets' && !!email.original.stored && email.original.stored === email.original.recorded),
      { nudge: () => syncMail(owner, seeded.ids.download) });
    for (const title of ['After the upgrade', 'New task after the upgrade']) assert.ok(view.events.some(event => event.title === title), `${title} reads back`);
    assert.ok(view.contacts.some(contact => contact.family === 'After') && view.recordings.some(recording => recording.title === 'After the upgrade'));
  });
  const upgradedView = await coreView(owner, installation, admin.email);
  await step('A new backup restores into a second person', async () => {
    const fresh = await exportFull(owner);
    for (const secret of [mail.sync.password, mail.download.password, dav.password, admin.password]) assert.equal(fresh.archive.includes(Buffer.from(secret)), false, 'No plain password in the backup');
    await owner.json('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' });
    const second = { email: 'upgrade-second@example.test', password: random('second') };
    await new Session(installation.url).json('POST', '/api/auth/signup', { email: second.email, password: second.password, full_name: 'Second person' }, { expected: [200, 201] });
    const person = new Session(installation.url);
    await person.signIn(second.email, second.password);
    const contents = await importFull(person, fresh.archive, fresh.password);
    assert.ok(contents && !contents.included.includes('mirror'), `The new backup holds the person's own data: ${JSON.stringify(contents)}`);
    const restored = await coreView(person, installation, second.email);
    assertSeededMail(restored.emails, downloadSeeds, 'Restored into a second person', { restored: true });
    assert.deepEqual(ownData(restored), ownData(asRestored(upgradedView)), 'The second person has the first person\'s own data, with its contents');
    evidence.newBackup = { sha256: fresh.sha256, bytes: fresh.archive.length, contents };
  });
  // Only the fresh installation below may talk to the providers from here on.
  await installation.destroy();
  installations.splice(installations.indexOf(installation), 1);

  // 4. The earlier release's export in a fresh candidate installation.
  const freshAdmin = { email: 'upgrade-fresh@example.test', password: random('fresh') };
  const fresh = await step('Start a fresh candidate installation', async () => {
    const started = await startContainerInstallation(candidateImage, { name: `fresh-from-${from}`, adminEmail: freshAdmin.email, adminPassword: freshAdmin.password, caFile: certificates.ca });
    installations.push(started);
    return started;
  });
  const freshOwner = new Session(fresh.url);
  await freshOwner.signIn(freshAdmin.email, freshAdmin.password);
  const destructiveBefore = peers.log.destructive.length, failedLoginsBefore = peers.log.logins.filter(login => !login.ok).length;
  await step(`Import the ${from} export`, async () => {
    const contents = await importFull(freshOwner, oldExport.archive, oldExport.password);
    assert.ok(contents, 'The restore states what the older archive holds');
    const leftOut = (section: string) => contents.left_out.filter(entry => entry.section === section).reduce((sum, entry) => sum + (entry.count ?? 0), 0);
    assert.equal(leftOut('mail'), before.emails.filter(email => email.account === mail.sync.user).length, `Sync-mode mail is left out: ${JSON.stringify(contents.left_out)}`);
    assert.equal(leftOut('calendar'), before.events.filter(event => event.calendar === SYNCED_CALENDAR).length, `CalDAV events are left out: ${JSON.stringify(contents.left_out)}`);
    assert.ok(contents.included.includes('local-by-policy'), 'Downloaded mail is in the restore');
    const restored = await coreView(freshOwner, fresh, freshAdmin.email);
    assertSeededMail(restored.emails, downloadSeeds, `The ${from} export`, { restored: true });
    assert.deepEqual(ownData(restored), ownData(asRestored(before)), 'The person\'s own data from the older release is there, with its contents');
    evidence.oldExportImport = { contents };
  });
  await step('The provider data comes back from the providers', async () => {
    const accounts = (await freshOwner.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
    for (const account of accounts) await freshOwner.json('PUT', `/api/mail/accounts/${account.id}`, { is_active: true });
    const sync = accounts.find(account => account.email_address === mail.sync.user)!;
    const wanted = before.emails.filter(email => email.account === mail.sync.user).map(email => JSON.stringify(email));
    // In full: the same bodies, attachments and original octets as before the export.
    const back = await until('The Sync-mode mail comes back', () => coreView(freshOwner, fresh, freshAdmin.email), view => wanted.every(row => view.emails.some(email => JSON.stringify(email) === row)),
      { seconds: 240, nudge: () => syncMail(freshOwner, sync.id) });
    assertSeededMail(back.emails, syncSeeds, 'Back from the provider');
    const calendarAccount = (await freshOwner.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.find(account => account.provider === 'caldav')!;
    const synced = await freshOwner.json<{ result: Row }>('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
    assert.equal(synced.result.ok, true, `The restored CalDAV account syncs: ${JSON.stringify(synced.result)}`);
    const providerFields = ({ todo_status: _state, subtasks: _subtasks, ...fields }: CoreView['events'][number]) => fields;
    const event = (await coreView(freshOwner, fresh, freshAdmin.email)).events.filter(entry => entry.calendar === SYNCED_CALENDAR);
    assert.deepEqual(event.map(providerFields), before.events.filter(entry => entry.calendar === SYNCED_CALENDAR).map(providerFields), 'The CalDAV event comes back once');
    assert.deepEqual(peers.log.destructive.slice(destructiveBefore), [], 'No destructive IMAP command after the restore');
    assert.equal(peers.log.logins.filter(login => !login.ok).length, failedLoginsBefore, 'Every restored password signs in');
    evidence.resynced = { mail: wanted.length, events: event.length };
  });
  await step('The synced task gets its state back', async () => {
    // The older archive's state on the synced task is an overlay matched by title and start, applied by the sync.
    const event = (await coreView(freshOwner, fresh, freshAdmin.email)).events.filter(entry => entry.calendar === SYNCED_CALENDAR);
    assert.deepEqual(event, before.events.filter(entry => entry.calendar === SYNCED_CALENDAR), 'The CalDAV event has its ToDo state and subtask');
  });
  evidence.providers = { imapCommands: [...new Set(peers.log.commands)], logins: peers.log.logins.length, smtp: peers.log.smtp.connections, davRequests: peers.log.dav.length };
  failed = false;
  console.log(`Upgrade check passed: ${from} upgraded to the candidate with its data, and its export imported into a fresh installation.`);
} finally {
  if (failed && providers) console.error('Provider log:', JSON.stringify(providers.log, null, 1));
  await providers?.close().catch(error => console.error(error));
  if (failed) for (const installation of installations) console.error(`--- ${installation.name} log ---\n${installation.logs()}`);
  for (const installation of installations) await installation.destroy().catch(error => console.error(error));
  fs.rmSync(work, { recursive: true, force: true });
  evidence.result = failed ? 'failed' : 'passed';
  evidence.finished_at = new Date().toISOString();
  const file = argument('--evidence');
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
  }
}
