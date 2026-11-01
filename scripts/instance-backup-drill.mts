// Release gate: an instance backup restores the whole installation
// (docs/DATA_RECOVERY.md "Instance backup").
//
//   node scripts/instance-backup-drill.mts --image unihub:ci   (CI, Docker)
//   node scripts/instance-backup-drill.mts --local             (npm --prefix api run build first)
//
// The source is an installation with the instance backup on (a destination of
// its own and a key file) and the synthetic data of every recovery section
// (scripts/recovery-data.mts). An administrator presses "Back up now"; the
// file is copied off the source, and the source is deleted with its database
// and storage. The restore command, as an administrator runs it in the image,
// refuses a wrong key, checks the file with --verify-only, and restores into
// a new, empty installation that has the source's ENCRYPTION_KEY and
// BACKUP_MASTER_KEY but a JWT secret of its own. That installation must hold
// exactly the source's data (same ids, rows, files and stored passwords), with
// no session of the old installation; its owner signs in again, and the
// restored mail and calendar passwords sign in to the test providers.
// Optional: UNIHUB_INSTANCE_DRILL_EVIDENCE=<file> writes a JSON summary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerCertificates, installationFactory, Session, type Installation } from './fresh-installations.mts';
import { inspect, providerAccounts, providerSecrets, publicView, seedProviders, seedSource, sleep, type Row } from './recovery-data.mts';
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
  for (;;) {
    const status = await admin.json<{ running: boolean; last_run: Row | null; key_fingerprint: string | null }>('GET', '/api/admin/instance-backup');
    const run = status.last_run;
    if (run && run.id === started.id && run.status === 'failed') throw new Error(`The instance backup failed: ${run.error}`);
    if (run && run.id === started.id && run.status === 'succeeded') return { run, fingerprint: status.key_fingerprint };
    if (Date.now() > deadline + 480000) throw new Error(`The instance backup did not finish: ${JSON.stringify(status)}`);
    await sleep(1000);
  }
}

const installations: Installation[] = [];
let providers: Providers | null = null;
let failed = true;
try {
  const peerHost = factory.describe.startsWith('container') ? '0.0.0.0' : '127.0.0.1';
  // Down while the source runs: its accounts are active, and nothing may change their data between the backup and the comparison.
  providers = await startProviders({ work, certificates, host: peerHost, ...providerAccounts(secrets) });
  providers.outage(true);
  const admin = { email: 'drill-admin@example.test', password: `drill-${crypto.randomBytes(9).toString('hex')}` };
  console.log(`Starting the source installation (${factory.describe}) with the instance backup on`);
  const source = await factory.start({ name: 'drill-source', adminEmail: admin.email, adminPassword: admin.password, caFile: certificates.ca, instanceBackupKeyFile: keyFile });
  installations.push(source);
  const owner = new Session(source.url);
  const ownerId = (await owner.signIn(admin.email, admin.password)).user.id;
  const seeded = await seedSource(source, owner, ownerId, secrets, providers);
  const before = await publicView(owner);
  const sourceServer = inspect(source, ownerId, secrets);
  assert.deepEqual(sourceServer.problems, [], 'Source data must be consistent before the backup');
  assert.ok(sourceServer.sessions > 0, 'The owner is signed in on the source');

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
  const sourceAfter = inspect(source, ownerId, secrets);
  assert.deepEqual(sourceAfter.tables, sourceServer.tables, 'The source did not change during the backup');
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
  const restored = target.instanceRestore({ file: copied, keyFile });
  assert.equal(restored.status, 0, `The restore succeeds:\n${restored.output}`);
  console.log(restored.output.trim());
  const again = target.instanceRestore({ file: copied, keyFile });
  assert.equal(again.status, 1, `A second restore into the now full installation is refused:\n${again.output}`);
  await target.start();

  // 3. The whole installation is back: same ids, rows, files and stored passwords; no old session.
  const targetServer = inspect(target, ownerId, secrets);
  assert.equal(targetServer.sessions, 0, 'No session of the old installation is restored');
  assert.deepEqual(targetServer.problems, [], 'Restored files and references');
  assert.deepEqual(targetServer.tables, sourceServer.tables, 'Every table holds the source\'s rows');
  assert.deepEqual(targetServer.files.map(file => `${file.kind}:${file.sha256}:${file.size}`).sort(),
    sourceServer.files.map(file => `${file.kind}:${file.sha256}:${file.size}`).sort(), 'Every stored file has its bytes');
  if (target.kind === 'container') assert.ok(targetServer.files.every(file => file.uid === 10001) && targetServer.uploadsOwner === 10001, 'Restored files belong to the API user');
  assert.deepEqual(targetServer.credentials, sourceServer.credentials, 'Stored passwords are the same ciphertexts, readable with the old key');
  const stored = [...targetServer.credentials.mail, ...targetServer.credentials.calendar].filter(account => account.ciphertext_sha256);
  assert.ok(stored.length >= 3 && stored.every(account => account.matches), 'Every stored password reads with the old ENCRYPTION_KEY');
  const user = new Session(target.url);
  await new Session(target.url).send('POST', '/api/auth/signin', { email: admin.email, password: 'not-the-password' }, { expected: [400, 401] });
  const signedIn = await user.signIn(admin.email, admin.password);
  assert.equal(signedIn.user.id, ownerId, 'The owner signs in again as the same person');
  const after = await publicView(user);
  assert.deepEqual(after, before, 'The owner sees exactly the source\'s data, under the same ids');

  // 4. The restored passwords sign in to the providers, which hold what the source's providers held.
  await seedProviders(providers, seeded, secrets);
  providers.outage(false);
  const accounts = (await user.json<{ accounts: Row[] }>('GET', '/api/mail/accounts')).accounts;
  const deadline = Date.now() + 120000;
  const signedInto = () => new Set(providers!.log.logins.filter(login => login.ok).map(login => login.user));
  for (let attempt = 0; accounts.some(account => !signedInto().has(String(account.email_address))) && Date.now() < deadline; attempt++) {
    if (attempt % 10 === 0) for (const account of accounts) await user.json('POST', '/api/mail/sync', { account_id: account.id }, { expected: [200, 202, 409] });
    await sleep(1000);
  }
  assert.deepEqual([...signedInto()].sort(), accounts.map(account => String(account.email_address)).sort(), 'Every restored mail password signs in');
  assert.equal(providers.log.logins.filter(login => !login.ok).length, 0, 'No wrong password was sent');
  const calendarAccount = (await user.json<{ accounts: Row[] }>('GET', '/api/calendar/accounts')).accounts.find(account => account.provider === 'caldav')!;
  const calendarSync = await user.json<{ result: Row }>('POST', `/api/calendar/accounts/${calendarAccount.id}/sync`, {});
  assert.equal(calendarSync.result.ok, true, `The restored calendar account syncs: ${JSON.stringify(calendarSync.result)}`);
  assert.equal(providers.log.dav.filter(request => !request.ok && request.method !== 'OPTIONS').length, 0, 'No wrong calendar password was sent');
  evidence.restored = { recovery_tables: Object.keys(targetServer.tables).length, recovery_rows: Object.values(targetServer.tables).reduce((sum, count) => sum + count, 0),
    files: targetServer.files.length, logins: [...signedInto()].length, output: restored.output.trim().split('\n').slice(-3) };
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
