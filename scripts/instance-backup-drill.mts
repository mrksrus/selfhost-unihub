// Release gate: an instance backup restores the whole installation
// (docs/DATA_RECOVERY.md "Instance backup").
//
//   node scripts/instance-backup-drill.mts --image unihub:ci   (CI, Docker)
//   node scripts/instance-backup-drill.mts --local             (npm --prefix api run build first)
//
// The source is an installation with the instance backup on (a destination of
// its own and a key file), three people (the administrator and a second
// person, each with the synthetic data of every recovery section from
// scripts/recovery-data.mts, and a second administrator), an installation
// policy, a sign-up setting, earlier instance backup runs and mail upgrade
// progress. An administrator presses "Back up now"; the
// file is copied off the source, and the source is deleted with its database
// and storage. The restore command, as an administrator runs it in the image,
// refuses a wrong key, checks the file with --verify-only, and restores into
// a new, empty installation that has the source's ENCRYPTION_KEY and
// BACKUP_MASTER_KEY but a JWT secret of its own. That installation must hold
// exactly the source's installation (api/tests/helpers/instance-drill-state.cts:
// the people, the mail accounts and every table the data inventory declares
// as the installation's, compared by scripts/instance-drill-compare.mts) and
// each person's data (same ids, rows, files, original messages
// and stored passwords), with only the documented resets: no session, device,
// ticket, sign-in challenge or lease of the old installation, mail accounts paused
// with provider deletion off, and no provider work left to replay. Each
// person signs in again and sees what they saw; the policy still applies;
// the restored mail and calendar passwords sign in to the test providers.
// Optional: UNIHUB_INSTANCE_DRILL_EVIDENCE=<file> writes a JSON summary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerCertificates, installationFactory, Session, type Installation } from './fresh-installations.mts';
import { helper, inspect, providerAccounts, providerSecrets, publicView, seedProviders, seedSource, sleep, type Inspection, type PublicView, type Row } from './recovery-data.mts';
import { installationProblems, type InstallationReport } from './instance-drill-compare.mts';
import { drillSchedule, waitForQuietSchedule, waitForRun } from './instance-drill-schedule.mts';
import { startProviders, type Providers } from './test-providers.mts';

// The drill never imports or restores a user backup, so it may run without the sandbox locally.
const factory = installationFactory(process.argv.slice(2), { allowWithoutSandbox: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-instance-drill-'));
const certificates = createPeerCertificates(work);
const secrets = providerSecrets();
const evidence: Record<string, unknown> = { check: 'instance-backup-drill', kind: factory.describe, started_at: new Date().toISOString() };
// Test values: the key of the instance backup is 48 random bytes, as the documentation tells an administrator to make it.
const keyFile = path.join(work, 'instance.key'), wrongKeyFile = path.join(work, 'wrong.key');
fs.writeFileSync(keyFile, `${crypto.randomBytes(48).toString('base64')}\n`, { mode: 0o644 });
fs.writeFileSync(wrongKeyFile, `${crypto.randomBytes(48).toString('base64')}\n`, { mode: 0o644 });
// The API user (uid 10001) of the image reads the key file through a bind mount.
fs.chmodSync(keyFile, 0o644);

async function backUpNow(admin: Session) {
  // "Back up now" waits for the worker owner, which a just-started server may not be yet.
  const deadline = Date.now() + 120000;
  let started: Row | null = null;
  while (!started) {
    const response = await admin.send('POST', '/api/admin/instance-backup/run', {}, { expected: [202, 503] });
    if (response.status === 202) started = ((await response.json()) as { run: Row }).run;
    else if (Date.now() > deadline) throw new Error('The server did not start its background work within two minutes');
    else await sleep(2000);
  }
  return waitForRun(admin, String(started.id), { timeoutMs: 480000 });
}

interface InstallationState {
  users: { id: string; email: string; role: string; is_active: number; row: string }[];
  mailAccounts: { id: string; user_id: string; email_address: string; is_active: number; delete_emails_on_server: number; server_delete_enabled_at: string | null;
    server_delete_grace_until: string | null; sync_policy_confirmed_at: string | null; kept: string }[];
  installation: InstallationReport; policies: Row[]; resets: Record<string, number>;
}
const state = (installation: Installation, mode = 'report', extra: Record<string, string> = {}) =>
  JSON.parse(installation.exec(helper('instance-drill-state.cts'), { DRILL_MODE: mode, ...extra })) as InstallationState;
const originals = (installation: Installation, email: string) => JSON.parse(installation.exec(helper('upgrade-mail-raw.cts'), { RAW_USER_EMAIL: email })) as Record<string, unknown>;
interface Person { email: string; password: string; id: string; session: Session; view: PublicView; server: Inspection; originals: Record<string, unknown> }

const installations: Installation[] = [];
let providers: Providers | null = null;
let failed = true;
try {
  const peerHost = factory.describe.startsWith('container') ? '0.0.0.0' : '127.0.0.1';
  // Down while the source runs: its accounts are active, and nothing may change their data between the backup and the comparison.
  providers = await startProviders({ work, certificates, host: peerHost, ...providerAccounts(secrets) });
  providers.outage(true);
  const admin = { email: 'drill-admin@example.test', password: `drill-${crypto.randomBytes(9).toString('hex')}` };
  // The daily run's time is half a day away; the catch-up run for its slot is awaited below.
  const schedule = drillSchedule(new Date());
  evidence.schedule = { time_utc: schedule.time, slot: schedule.slot.toISOString(), next: schedule.next.toISOString() };
  console.log(`Starting the source installation (${factory.describe}) with the instance backup on, daily at ${schedule.time} UTC`);
  const source = await factory.start({ name: 'drill-source', adminEmail: admin.email, adminPassword: admin.password, caFile: certificates.ca,
    instanceBackupKeyFile: keyFile, instanceBackupTime: schedule.time });
  installations.push(source);
  const owner = new Session(source.url);
  const ownerId = (await owner.signIn(admin.email, admin.password)).user.id;
  const seeded = await seedSource(source, owner, ownerId, secrets, providers);
  // The rest of the installation: sign-ups open (a system setting), a second
  // person with data of every section and mail accounts, a second
  // administrator, and an installation policy.
  await owner.json('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' });
  const signUp = async (email: string, full_name: string) => {
    const password = `drill-${crypto.randomBytes(9).toString('hex')}`;
    await new Session(source.url).json('POST', '/api/auth/signup', { email, password, full_name }, { expected: [200, 201] });
    const session = new Session(source.url);
    return { email, password, session, id: (await session.signIn(email, password)).user.id };
  };
  const second = await signUp('drill-person@example.test', 'Drill Person');
  await seedSource(source, second.session, second.id, secrets, providers);
  const secondAdmin = await signUp('drill-second-admin@example.test', 'Drill Second Admin');
  await owner.json('PUT', `/api/admin/users/${secondAdmin.id}/role`, { role: 'admin', current_password: admin.password });
  await secondAdmin.session.json('POST', '/api/contacts', { first_name: 'Admin', last_name: 'Contact', email: 'admin.contact@example.test' });
  state(source, 'seed', { DRILL_ADMIN_ID: ownerId });
  const forced = async (session: Session) => (await session.json<{ download_mail: { forced: boolean } }>('GET', '/api/backup/capabilities')).download_mail.forced;
  assert.equal(await forced(second.session), true, 'The installation policy applies on the source');

  // The schedule's catch-up run for the current slot finishes before anything is compared; then no run starts until the next slot.
  await waitForQuietSchedule(owner, schedule.slot, { timeoutMs: 600000, pollMs: 2000 });

  const people: Person[] = [];
  for (const person of [{ email: admin.email, password: admin.password, id: ownerId, session: owner }, second, secondAdmin]) {
    // The view first: reading the folders makes a person's default ones.
    const view = await publicView(person.session);
    const server = inspect(source, person.id, secrets);
    assert.deepEqual(server.problems, [], `${person.email}: source data must be consistent before the backup`);
    people.push({ ...person, view, server, originals: originals(source, person.email) });
  }
  assert.ok(people.every(person => person.server.sessions > 0), 'Everyone is signed in on the source');
  assert.ok(Object.keys(people[1].originals).length >= 4, 'The second person has mail with originals');

  // 1. Back up now, as an administrator; the file leaves with the backup's destination.
  const { run, fingerprint } = await backUpNow(owner);
  const file = String(run.file_name);
  assert.match(file, /^unihub-instance-.+\.uhib$/, `Backup file name: ${file}`);
  const copied = source.copyInstanceBackup(file, path.join(work, 'off-site'));
  const bytes = fs.readFileSync(copied);
  for (const secret of [...secrets.mail, secrets.calendar, admin.password, source.keys.ENCRYPTION_KEY, source.keys.BACKUP_MASTER_KEY, source.keys.JWT_SECRET]) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, 'The instance backup holds no password or key in plain text');
  }
  evidence.backup = { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), key_fingerprint: fingerprint, app_version: run.app_version };
  const keys = source.keys;
  // Unchanged until the comparison: the providers are down and nobody else signs in.
  for (const person of people) assert.deepEqual(inspect(source, person.id, secrets).tables, person.server.tables, `${person.email}: the source did not change during the backup`);
  const sourceState = state(source);
  assert.ok(Date.now() < schedule.next.getTime() - 3600 * 1000, 'The snapshot is taken well before the next scheduled run');
  assert.equal(sourceState.users.length, 3);
  assert.ok(sourceState.resets.sessions > 0 && sourceState.resets.runnableWritebacks > 0, `The source has sessions and provider work to reset: ${JSON.stringify(sourceState.resets)}`);
  await source.destroy();
  installations.splice(installations.indexOf(source), 1);
  console.log(`Backed up ${bytes.length} bytes; the source installation, its database and storage are deleted.`);

  // 2. The restore command into a new, empty installation with the old keys.
  const target = await factory.start({ name: 'drill-target', adminEmail: 'drill-unused@example.test', adminPassword: `unused-${crypto.randomBytes(9).toString('hex')}`,
    caFile: certificates.ca, keys: { ENCRYPTION_KEY: keys.ENCRYPTION_KEY, BACKUP_MASTER_KEY: keys.BACKUP_MASTER_KEY }, deferStart: true, storage: source.storage });
  installations.push(target);
  assert.notEqual(target.keys.JWT_SECRET, keys.JWT_SECRET);
  const wrong = target.instanceRestore({ file: copied, keyFile: wrongKeyFile });
  assert.equal(wrong.status, 1, `A wrong key is refused:\n${wrong.output}`);
  assert.match(wrong.output, /Instance restore refused/);
  const verified = target.instanceRestore({ file: copied, keyFile, verifyOnly: true });
  assert.equal(verified.status, 0, `--verify-only checks the file:\n${verified.output}`);
  const restoreWindow = { from: new Date() };
  const restored = target.instanceRestore({ file: copied, keyFile });
  const restore = { ...restoreWindow, to: new Date() };
  assert.equal(restored.status, 0, `The restore succeeds:\n${restored.output}`);
  console.log(restored.output.trim());
  const again = target.instanceRestore({ file: copied, keyFile });
  assert.equal(again.status, 1, `A second restore into the now full installation is refused:\n${again.output}`);
  await target.start();

  // 3. The whole installation is back, with only the documented resets.
  const targetState = state(target);
  assert.deepEqual(targetState.users, sourceState.users, 'Every person comes back with their account as it was (role, password, two-step sign-in)');
  assert.ok(sourceState.policies.some(policy => policy.setting_key === 'policy.backup.download_mail' && policy.setting_value === 'always'), 'The seeded policy was there to compare');
  // Read through the driver as the comparison reads it, a BIGINT past 2^53 keeps its last digit.
  const progress = (report: InstallationState) => report.installation.mail_engine_migration_progress?.rows.find(row => row.key === 'emails')?.plain.processed;
  assert.equal(progress(sourceState), '9007199254740993', 'The seeded mail upgrade progress reads with every digit');
  assert.deepEqual(installationProblems(sourceState.installation, targetState.installation, { backupFile: file, restore }), [],
    'What belongs to the installation (activity log, settings, policies, push identity, backup runs, upgrade history) comes back, with only the documented changes');
  assert.deepEqual(targetState.resets, { sessions: 0, devices: 0, fileTickets: 0, signInChallenges: 0, leases: 0, runnableEngineJobs: 0, runnableWritebacks: 0,
    calendarMoves: 0, scheduledSends: 0, providerDeletions: 0 }, 'Nothing of the old installation\'s running life or provider work is left');
  assert.deepEqual(targetState.mailAccounts.map(({ kept, id, user_id, email_address }) => ({ kept, id, user_id, email_address })),
    sourceState.mailAccounts.map(({ kept, id, user_id, email_address }) => ({ kept, id, user_id, email_address })), 'Every mail account comes back as it was, but for the resets');
  assert.ok(targetState.mailAccounts.every(account => account.is_active === 0 && account.delete_emails_on_server === 0 && !account.server_delete_enabled_at
    && !account.server_delete_grace_until && !account.sync_policy_confirmed_at), 'Mail accounts are paused, with provider deletion off, until each person reconnects');
  assert.ok(sourceState.mailAccounts.some(account => account.is_active === 1 && account.delete_emails_on_server === 1), 'The source had an active account deleting at its provider');
  const stored: Inspection['credentials']['mail'] = [];
  for (const person of people) {
    const server = inspect(target, person.id, secrets);
    assert.equal(server.sessions, 0, `${person.email}: no session of the old installation is restored`);
    assert.deepEqual(server.problems, [], `${person.email}: restored files and references`);
    assert.deepEqual(server.tables, person.server.tables, `${person.email}: every table holds the source's rows`);
    assert.deepEqual(server.files.map(file => `${file.kind}:${file.sha256}:${file.size}`).sort(),
      person.server.files.map(file => `${file.kind}:${file.sha256}:${file.size}`).sort(), `${person.email}: every stored file has its bytes`);
    if (target.kind === 'container') assert.ok(server.files.every(file => file.uid === 10001) && server.uploadsOwner === 10001, 'Restored files belong to the API user');
    // The same ciphertexts, readable with the old key; paused with deletion off as documented.
    assert.deepEqual(server.credentials, { ...person.server.credentials,
      mail: person.server.credentials.mail.map(account => ({ ...account, is_active: 0, delete_emails_on_server: 0 })) }, `${person.email}: stored passwords`);
    assert.ok(server.writebacks.every(row => row.status !== 'pending' && !row.is_current), `${person.email}: no accepted provider change can run`);
    assert.deepEqual(originals(target, person.email), person.originals, `${person.email}: every original message comes back byte for byte`);
    stored.push(...server.credentials.mail);
  }
  assert.ok(stored.length >= 4 && stored.every(account => account.matches), 'Every stored mail password reads with the old ENCRYPTION_KEY');
  const user = new Session(target.url);
  await new Session(target.url).send('POST', '/api/auth/signin', { email: admin.email, password: 'not-the-password' }, { expected: [400, 401] });
  for (const person of people) {
    const session = person.email === admin.email ? user : new Session(target.url);
    const signedIn = await session.signIn(person.email, person.password);
    assert.equal(signedIn.user.id, person.id, `${person.email} signs in again as the same person`);
    assert.deepEqual(await publicView(session), person.view, `${person.email} sees exactly the source's data, under the same ids`);
    if (person === people[1]) assert.equal(await forced(session), true, 'The installation policy still applies');
    if (person === people[2]) await session.json('GET', '/api/admin/instance-backup');
  }

  // 4. The restored passwords sign in to the providers, which hold what the source's providers held.
  await seedProviders(providers, seeded, secrets);
  providers.outage(false);
  const accounts = (await user.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  // Paused by the restore: the owner reconnects each, which signs in with the stored password.
  for (const account of accounts) await user.json('PUT', `/api/mail/accounts/${account.id}`, { is_active: true });
  const signedInto = () => new Set(providers!.log.logins.filter(login => login.ok).map(login => login.user));
  for (let waited = 0; accounts.some(account => !signedInto().has(String(account.email_address))) && waited < 60; waited++) await sleep(1000);
  assert.deepEqual([...signedInto()].sort(), accounts.map(account => String(account.email_address)).sort(), 'Every restored mail password signs in');
  assert.equal(providers.log.logins.filter(login => !login.ok).length, 0, 'No wrong password was sent');
  const calendarAccount = (await user.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.find(account => account.provider === 'caldav')!;
  const calendarSync = await user.json<{ result: Row }>('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
  assert.equal(calendarSync.result.ok, true, `The restored calendar account syncs: ${JSON.stringify(calendarSync.result)}`);
  assert.equal(providers.log.dav.filter(request => !request.ok && request.method !== 'OPTIONS').length, 0, 'No wrong calendar password was sent');
  evidence.restored = { people: people.length, installation_rows: Object.fromEntries(Object.entries(targetState.installation).map(([table, { rows }]) => [table, rows.length])),
    mail_accounts: targetState.mailAccounts.length, recovery_rows: people.map(person => Object.values(person.server.tables).reduce((sum, count) => sum + count, 0)),
    files: people.map(person => person.server.files.length), resets_on_source: sourceState.resets, logins: [...signedInto()].length, output: restored.output.trim().split('\n').slice(-3) };
  failed = false;
  console.log('Instance backup drill passed: the whole installation restored into an empty one with the command in the image, and its passwords work.');
} finally {
  if (failed && providers) console.error('Provider log:', JSON.stringify(providers.log, null, 1));
  await providers?.close().catch(error => console.error(error));
  if (failed) for (const installation of installations) console.error(`--- ${installation.name} log ---\n${installation.logs()}`);
  for (const installation of installations) await installation.destroy().catch(error => console.error(error));
  fs.rmSync(work, { recursive: true, force: true });
  evidence.result = failed ? 'failed' : 'passed';
  evidence.finished_at = new Date().toISOString();
  if (process.env.UNIHUB_INSTANCE_DRILL_EVIDENCE) fs.writeFileSync(process.env.UNIHUB_INSTANCE_DRILL_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
}
