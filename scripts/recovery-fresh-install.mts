// Release gate: a user's full backup moves to a new, independent installation,
// and the provider data it leaves out comes back from the providers.
//
//   node scripts/recovery-fresh-install.mts --image unihub:ci   (CI, Docker)
//   node scripts/recovery-fresh-install.mts --local             (npm --prefix api run build first)
//
// Two disposable installations with separate MariaDB servers, uploads and
// keys, and test providers (scripts/test-providers.mts: GreenMail and
// Radicale behind proxies that log what the installations send). The source
// gets synthetic data in every recovery section (scripts/recovery-data.mts),
// exports a full encrypted backup through the browser's workflow and is then
// deleted with its keys. The backup holds UniHub's own data by data class
// (F2, docs/DATA_RECOVERY.md): no Sync-mode mail with a provider copy, no
// CalDAV event, but the Download-mode mail and UniHub's state on the synced
// task. The destination imports it with its recovery password; its data is
// compared with the source's (less the provider data) through the API and on
// the server (api/tests/helpers/fresh-install-inspect.cts), again after a
// restart. Then the providers come up holding what the source's providers
// held: the restored passwords sign in, the Sync-mode mail and the CalDAV
// event come back from them, the task gets its state back, no destructive
// IMAP command is sent, and a provider outage removes nothing.
// Optional: UNIHUB_RECOVERY_EVIDENCE=<file> writes a JSON summary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerCertificates, installationFactory, Session, type Installation } from './fresh-installations.mts';
import { inspect, providerAccounts, providerSecrets, publicView, seedProviders, seedSource, sleep, waitForJob, type PublicView, type Row } from './recovery-data.mts';
import { startProviders, type Providers } from './test-providers.mts';

const factory = installationFactory();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-recovery-gate-'));
const certificates = createPeerCertificates(work);
const secrets = providerSecrets();
const SECTIONS = ['settings', 'contacts', 'calendar', 'mail', 'recordings'];
// Provider evidence the mail engine records while syncing; their restore rules
// have their own tests (backup-mail-engine, account-mail-engine-recovery).
// Overlays exist only after a restore, while a synced task waits for its sync.
const UNSEEDED_TABLES = new Set(['mail.mail_gmail_messages', 'mail.mail_operation_attempts',
  'mail.mail_command_receipts', 'mail.mail_engine_quarantine', 'calendar.calendar_overlay_restores']);
const SYNC_ACCOUNT = 'fresh-mail-1@example.test', SYNCED_CALENDAR = 'Research Calendar';
const evidence: Record<string, unknown> = { kind: factory.describe, started_at: new Date().toISOString() };

/** The mail of every folder as its list shows it: cheap enough to poll, and readable while a provider is down. */
async function mailList(session: Session) {
  const accounts = (await session.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  const rows: { folder: unknown; account: unknown; message_id: unknown; subject: unknown; from: unknown }[] = [];
  for (const folder of (await session.json<{ folders: Row[] }>('GET', '/api/mail/folders')).folders) {
    for (const email of (await session.json<{ emails: Row[] }>('GET', `/api/mail/emails?folder=${encodeURIComponent(String(folder.slug))}`)).emails) {
      rows.push({ folder: folder.slug, account: accounts.find(account => account.id === email.mail_account_id)?.email_address ?? null,
        message_id: email.message_id, subject: email.subject, from: email.from_address });
    }
  }
  return rows.map(row => JSON.stringify(row)).sort();
}
const eventList = async (session: Session) => (await session.json<{ events: Row[] }>('GET',
  '/api/calendar/events?include_todos=true&include_done=true&range_start=2000-01-01T00:00:00Z&range_end=2100-01-01T00:00:00Z')).events;

const installations: Installation[] = [];
let providers: Providers | null = null;
let failed = true;
try {
  const peerHost = factory.describe.startsWith('container') ? '0.0.0.0' : '127.0.0.1';
  // The providers stay down while the source runs: its accounts are active,
  // and nothing of it may reach them.
  providers = await startProviders({ work, certificates, host: peerHost, ...providerAccounts(secrets) });
  providers.outage(true);
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

  // 1. Source data in every section.
  const owner = new Session(source.url);
  const ownerId = (await owner.signIn(sourceAdmin.email, sourceAdmin.password)).user.id;
  const capabilities = await owner.json<{ sections: { id: string }[] }>('GET', '/api/backup/capabilities');
  assert.deepEqual(capabilities.sections.map(section => section.id).sort(), [...SECTIONS].sort(),
    'A recovery section was added or removed: seed and compare it in this gate (and fresh-install-seed.cts) before releasing.');
  const seeded = await seedSource(source, owner, ownerId, secrets, providers);

  const before = await publicView(owner);
  const sourceServer = inspect(source, ownerId, secrets);
  assert.deepEqual(sourceServer.problems, [], 'Source data must be consistent before export');
  for (const [table, count] of Object.entries(sourceServer.tables)) {
    if (!UNSEEDED_TABLES.has(table)) assert.ok(count > 0, `${table} has no source data; seed it so the gate covers it`);
  }
  assert.equal(sourceServer.sourceEmailLinks, 1);
  // The class rules see the seed as the gate does: the Sync account's mail and the CalDAV event are provider data.
  assert.equal(sourceServer.mirror['mail.emails'], seeded.providerMail.length, 'The Sync account\'s mail is provider data');
  assert.equal(sourceServer.mirror['calendar.calendar_events'], 1, 'The CalDAV event is provider data');
  console.log(`Source: ${Object.values(sourceServer.tables).reduce((sum, count) => sum + count, 0)} rows in ${Object.keys(sourceServer.tables).length} tables, ${sourceServer.files.length} files`);

  // 2. Full encrypted export through the browser's workflow, then the source and its keys are gone.
  const job = (await owner.json<{ job: Row }>('POST', '/api/backup/jobs', { sections: 'full', encrypt: true }, { expected: 202 })).job;
  const ready = await waitForJob(owner, `/api/backup/jobs/${job.id}`, 'ready');
  const { recovery_password: recoveryPassword } = await owner.json<{ recovery_password: string }>('POST', `/api/backup/jobs/${job.id}/recovery-password/reveal`, {});
  const archive = await owner.bytes(`/api/backup/jobs/${job.id}/download`);
  assert.equal(crypto.createHash('sha256').update(archive).digest('hex'), ready.file_sha256);
  for (const secret of [...secrets.mail, secrets.calendar, sourceAdmin.password]) assert.equal(archive.includes(Buffer.from(secret)), false, 'The archive must not contain a plain password');
  evidence.archive = { sha256: ready.file_sha256, bytes: archive.length };
  await source.destroy();
  installations.splice(installations.indexOf(source), 1);
  console.log(`Exported ${archive.length} bytes; the source installation, its database and keys are deleted.`);

  // 3. Import as a different user of a different installation, with the recovery password.
  const user = new Session(destination.url);
  const userId = (await user.signIn(destinationAdmin.email, destinationAdmin.password)).user.id;
  const destinationBefore = inspect(destination, userId, secrets);
  const imported = (await user.json<{ job: Row }>('POST', '/api/backup/import?sections=full&conflict_mode=replace&credentials_mode=restore', archive,
    { expected: 202, raw: true, headers: { 'Content-Type': 'application/vnd.unihub.backup' } })).job;
  assert.equal(imported.status, 'awaiting_password', 'Another installation cannot open the archive without its recovery password');
  await user.json('POST', `/api/backup/restore-jobs/${imported.id}/unlock`, { password: 'not-the-recovery-password' }, { expected: 400 });
  await user.json('POST', `/api/backup/restore-jobs/${imported.id}/unlock`, { password: recoveryPassword }, { expected: 202 });
  const validated = await waitForJob(user, `/api/backup/restore-jobs/${imported.id}`, 'validated');
  // What the archive says it holds and left out (the restore shows it to the person).
  const contents = (validated.validation_result as { contents?: { included: string[]; left_out: { section: string; what: string; count?: number }[] } } | null)?.contents;
  assert.ok(contents, 'The validated restore states the archive\'s contents');
  assert.ok(['local', 'config', 'local-by-policy'].every(dataClass => contents.included.includes(dataClass)), `Included classes: ${JSON.stringify(contents.included)}`);
  assert.ok(!contents.included.includes('mirror'), 'Provider data is not in a user backup');
  const leftOut = (section: string) => contents.left_out.filter(entry => entry.section === section).reduce((sum, entry) => sum + (entry.count ?? 0), 0);
  assert.equal(leftOut('mail'), seeded.providerMail.length, `Left out of mail: ${JSON.stringify(contents.left_out)}`);
  assert.equal(leftOut('calendar'), 1, `Left out of calendar: ${JSON.stringify(contents.left_out)}`);
  evidence.classes = contents;
  await user.json('POST', `/api/backup/restore-jobs/${imported.id}/start`, {}, { expected: 202 });
  await waitForJob(user, `/api/backup/restore-jobs/${imported.id}`, 'completed', job => !job.archive_available);

  // 4. The same data less the provider data, under new IDs, owned by the destination user.
  // The list shows a message under the account it is filed to: the Download
  // message filed into the Sync account's folder is shown there but is UniHub's own.
  const isProviderMail = (email: Row) => email.account === SYNC_ACCOUNT && email.filing !== SYNC_ACCOUNT;
  const isProviderEvent = (event: Row) => event.calendar === SYNCED_CALENDAR;
  const withoutIds = ({ ids: _ids, ...view }: PublicView) => view;
  const expected = { ...withoutIds(before), emails: before.emails.filter(email => !isProviderMail(email)), events: before.events.filter(event => !isProviderEvent(event)) };
  assert.equal(before.emails.filter(isProviderMail).length, seeded.providerMail.length);
  const check = async (label: string) => {
    const after = await publicView(user);
    // A restored account is paused until its owner reconnects it (docs/DATA_RECOVERY.md).
    assert.deepEqual(withoutIds(after), expected, `${label}: restored data differs from the source's own data`);
    assert.notEqual(after.ids.user, before.ids.user);
    assert.equal(after.ids.accounts.filter(id => before.ids.accounts.includes(id)).length, 0, 'Restored accounts get new IDs');
    assert.equal(after.ids.recordings.filter(id => before.ids.recordings.includes(id)).length, 0, 'Restored recordings get new IDs');
    const server = inspect(destination, userId, secrets);
    assert.deepEqual(server.problems, [], `${label}: stored files and references`);
    for (const [table, count] of Object.entries(sourceServer.tables)) {
      const fresh = destinationBefore.tables[table] ?? 0;
      // Failed transcriptions are not recovery data; local defaults merge with
      // the restored ones; the synced task's state waits as one overlay.
      let wanted = count - (sourceServer.mirror[table] ?? 0);
      if (table === 'recordings.recording_transcription_jobs') wanted -= 1;
      if (table === 'calendar.calendar_overlay_restores') wanted = 1;
      if (['calendar.calendar_accounts', 'calendar.calendar_calendars', 'mail.mail_folders'].includes(table)) assert.ok(server.tables[table] >= wanted, `${label}: ${table}`);
      else assert.equal(server.tables[table] - fresh, wanted, `${label}: ${table} rows`);
    }
    assert.deepEqual(server.files.map(file => `${file.kind}:${file.sha256}`).sort(),
      sourceServer.files.filter(file => !file.mirror).map(file => `${file.kind}:${file.sha256}`).sort(), `${label}: file bytes`);
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
  console.log('Restore matches the source\'s own data; checking isolation and a restart.');

  // 5. Another user of the destination sees none of it.
  await user.json('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' });
  const otherEmail = 'fresh-other@example.test', otherPassword = `other-${crypto.randomBytes(9).toString('hex')}`;
  await new Session(destination.url).json('POST', '/api/auth/signup', { email: otherEmail, password: otherPassword, full_name: 'Other user' }, { expected: [200, 201] });
  const other = new Session(destination.url);
  await other.signIn(otherEmail, otherPassword);
  const otherView = await publicView(other);
  assert.equal(otherView.contacts.length + otherView.emails.length + otherView.recordings.length + otherView.mailAccounts.length + otherView.bin.length, 0, 'Another user sees nothing restored');
  await other.send('GET', `/api/recordings/${first.after.ids.recordings[0]}/file`, undefined, { expected: 404 });

  // 6. A restart keeps everything, and the signed-in session.
  await destination.restart();
  await check('After restart');

  // 7. The providers come up with what the source's providers held. The
  // restored passwords sign in; the provider data comes back from them.
  await seedProviders(providers, seeded, secrets);
  providers.outage(false);
  const accounts = (await user.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  for (const account of accounts) await user.json('PUT', `/api/mail/accounts/${account.id}`, { is_active: true });
  assert.deepEqual([...new Set(providers.log.logins.filter(login => login.ok).map(login => login.user))].sort(),
    accounts.map(account => String(account.email_address)).sort(), 'Every restored mail password signs in');
  assert.equal(providers.log.logins.filter(login => !login.ok).length, 0, 'No wrong password was sent');
  const syncAccount = accounts.find(account => account.email_address === SYNC_ACCOUNT)!;
  const wantedMail = before.emails.filter(isProviderMail).map(email => JSON.stringify({ folder: email.folder, account: email.account, message_id: email.message_id, subject: email.subject, from: email.from })).sort();
  const deadline = Date.now() + 240000;
  let synced: string[] = [];
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    if (attempt % 20 === 0) await user.json('POST', '/api/mail/sync', { account_id: syncAccount.id }, { expected: [200, 202, 409] });
    synced = (await mailList(user)).filter(row => JSON.parse(row).account === SYNC_ACCOUNT);
    if (wantedMail.every(row => synced.includes(row))) break;
    await sleep(1500);
  }
  assert.deepEqual(synced.filter(row => wantedMail.includes(row)), wantedMail, `The Sync-mode mail comes back from its provider into its folders: ${JSON.stringify(synced)}`);
  const calendarAccount = (await user.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.find(account => account.provider === 'caldav')!;
  const calendarSync = await user.json<{ result: Row }>('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
  assert.equal(calendarSync.result.ok, true, `The restored calendar account syncs: ${JSON.stringify(calendarSync.result)}`);
  assert.ok(providers.log.dav.some(request => request.ok), 'The restored calendar password authenticates');
  assert.equal(providers.log.dav.filter(request => !request.ok && request.method !== 'OPTIONS').length, 0, 'No wrong calendar password was sent');
  const resynced = await publicView(user);
  assert.deepEqual(resynced.emails.filter(email => !isProviderMail(email)), first.after.emails, 'Reconnecting changes no restored mail');
  assert.deepEqual(resynced.events.filter(event => !isProviderEvent(event)), first.after.events, 'Syncing changes no restored event');
  const sourceTask = before.events.find(isProviderEvent)!;
  const syncedTask = resynced.events.filter(isProviderEvent);
  assert.equal(syncedTask.length, 1, `The CalDAV event comes back once: ${JSON.stringify(syncedTask)}`);
  for (const field of ['title', 'description', 'start', 'end', 'all_day', 'location', 'attendees'] as const) {
    assert.deepEqual(syncedTask[0][field], sourceTask[field], `The CalDAV event's ${field} comes from the provider`);
  }
  // 8. A provider outage after reconnecting removes nothing, and nothing was destructive.
  const settledMail = await mailList(user), settledEvents = JSON.stringify(await eventList(user));
  providers.outage(true);
  await user.json('POST', '/api/mail/sync', { account_id: syncAccount.id }, { expected: [200, 202, 409] });
  await user.json('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
  await sleep(15000);
  assert.deepEqual(await mailList(user), settledMail, 'A provider outage removes no mail');
  assert.equal(JSON.stringify(await eventList(user)), settledEvents, 'A calendar outage removes no event');
  assert.deepEqual(providers.log.destructive, [], 'No provider change is replayed after restore');
  // 9. UniHub's own state on the synced task: its overlay is applied by the sync that brought the task back.
  assert.deepEqual({ todo_status: syncedTask[0].todo_status, subtasks: syncedTask[0].subtasks }, { todo_status: sourceTask.todo_status, subtasks: sourceTask.subtasks },
    'The synced task gets its ToDo state and subtasks back');
  assert.equal(inspect(destination, userId, secrets).tables['calendar.calendar_overlay_restores'], 0, 'The applied overlay is used up');
  evidence.providers = { logins: providers.log.logins.length, imapCommands: [...new Set(providers.log.commands)], davRequests: providers.log.dav.length,
    resynced: { mail: wantedMail.length, events: syncedTask.length, overlayApplied: true } };
  evidence.restored = { tables: first.server.tables, files: first.server.files.length, leftOut: sourceServer.mirror };
  failed = false;
  console.log('Recovery gate passed: a full backup restored into an independent installation without provider data, verified through the API and on the server, after a restart, and the provider data came back from the providers.');
} finally {
  if (failed && providers) console.error('Provider log:', JSON.stringify(providers.log, null, 1));
  await providers?.close().catch(error => console.error(error));
  if (failed) for (const installation of installations) console.error(`--- ${installation.name} log ---\n${installation.logs()}`);
  for (const installation of installations) await installation.destroy().catch(error => console.error(error));
  fs.rmSync(work, { recursive: true, force: true });
  evidence.result = failed ? 'failed' : 'passed';
  evidence.finished_at = new Date().toISOString();
  if (process.env.UNIHUB_RECOVERY_EVIDENCE) fs.writeFileSync(process.env.UNIHUB_RECOVERY_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
}
