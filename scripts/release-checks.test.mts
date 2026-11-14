// Tests of the release checks' own logic, without Docker or providers:
//   node --test scripts/release-checks.test.mts
// The checks themselves run in CI (.github/workflows/docker-image.yml).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localSandboxMode } from './fresh-installations.mts';
import { drillSchedule, scheduleProblem, waitForQuietSchedule, waitForRun, type BackupStatus, type StatusSession } from './instance-drill-schedule.mts';
import { INSTALLATION_RULES, installationProblems, type InstallationReport, type ReportedRow } from './instance-drill-compare.mts';
import { compareVersions, previousReleases } from './published-image.mts';
import { DESTRUCTIVE_IMAP, imapCommandReader, imapResultReader } from './test-providers.mts';
import { coreView, seededMailProblems, seedMessage, type RawEntry, type ViewSession } from './upgrade-view.mts';

const lines = (...parts: string[]) => Buffer.from(parts.join(''), 'latin1');

test('the IMAP log reads command names and sign-ins, never arguments or message bytes', () => {
  const seen: { tag: string; name: string; user?: string }[] = [];
  const read = imapCommandReader(command => seen.push(command));
  const body = 'Subject: x\r\na9 EXPUNGE\r\nb1 UID STORE 1 +FLAGS (\\Deleted)\r\n';
  // Split mid-line and mid-literal, as TCP may deliver it.
  const stream = lines('a1 CAPABILITY\r\na2 LOGIN "fresh-mail-0@example.test" "pa\\"ss"\r\na3 SELECT INBOX\r\n',
    `a4 APPEND Sent (\\Seen) {${Buffer.byteLength(body, 'latin1')}}\r\n`, body, '\r\na5 UID FETCH 1:* (FLAGS)\r\n',
    'a6 AUTHENTICATE PLAIN\r\n', `${Buffer.from('\0second@example.test\0secret').toString('base64')}\r\n`,
    `a7 AUTHENTICATE PLAIN ${Buffer.from('\0third@example.test\0secret').toString('base64')}\r\na8 uid move 3 Trash\r\n`);
  for (let offset = 0; offset < stream.length; offset += 7) read(stream.subarray(offset, offset + 7));
  assert.deepEqual(seen.map(command => command.name), ['CAPABILITY', 'LOGIN', 'SELECT', 'APPEND', 'UID FETCH', 'AUTHENTICATE', 'AUTHENTICATE', 'UID MOVE']);
  assert.deepEqual(seen.filter(command => command.user !== undefined).map(command => [command.tag, command.user]),
    [['a2', 'fresh-mail-0@example.test'], ['a6', 'second@example.test'], ['a7', 'third@example.test']]);
  assert.ok(!JSON.stringify(seen).includes('pa') && !JSON.stringify(seen).includes('secret'), 'No password is logged');
  assert.deepEqual(seen.map(command => command.name).filter(name => DESTRUCTIVE_IMAP.test(name)), ['APPEND', 'UID MOVE']);
  for (const name of ['UID STORE', 'STORE', 'EXPUNGE', 'COPY', 'UID COPY', 'MOVE', 'DELETE', 'RENAME']) assert.match(name, DESTRUCTIVE_IMAP);
  for (const name of ['UID FETCH', 'SELECT', 'EXAMINE', 'LIST', 'STATUS', 'IDLE', 'CREATE']) assert.doesNotMatch(name, DESTRUCTIVE_IMAP);
});

test('the IMAP log takes a sign-in result from its tagged answer only', () => {
  const results: [string, string][] = [];
  const read = imapResultReader((tag, status) => results.push([tag, status]));
  read(lines('* OK [CAPABILITY IMAP4rev1] ready\r\n* 3 EXISTS\r\na2 O'));
  read(lines('K LOGIN completed\r\n+ go ahead\r\na3 NO [AUTHENTICATIONFAILED] invalid\r\na4 bad command\r\n'));
  assert.deepEqual(results, [['a2', 'OK'], ['a3', 'NO'], ['a4', 'BAD']]);
});

test('the upgrade check starts from the newest published releases up to the candidate', async () => {
  const tags = ['v0.24.3', 'v0.25.0', 'v0.25.1', 'v0.26.0', 'v0.27.0', 'v0.27.1', 'v0.28.0-rc.1', 'latest', 'v0.9.23'];
  const published = (versions: string[]) => async (version: string) => versions.includes(version);
  const all = published(tags.map(tag => tag.replace(/^v/, '')));
  // A candidate whose version is not bumped yet is newer code than that release.
  assert.deepEqual(await previousReleases('0.27.1', tags, 3, all), ['0.27.1', '0.27.0', '0.26.0']);
  // The version's own pull request or release run: its tag is not published yet.
  assert.deepEqual(await previousReleases('0.28.0', [...tags, 'v0.28.0'], 3, published(['0.27.1', '0.27.0', '0.26.0', '0.25.1'])), ['0.27.1', '0.27.0', '0.26.0']);
  // A tag without a published image does not count.
  assert.deepEqual(await previousReleases('0.28.0', tags, 3, published(['0.27.1', '0.26.0', '0.25.1'])), ['0.27.1', '0.26.0', '0.25.1']);
  // The next patch after a release upgrades from it.
  assert.deepEqual(await previousReleases('0.28.1', [...tags, 'v0.28.0'], 3, published(['0.28.0', '0.27.1', '0.27.0'])), ['0.28.0', '0.27.1', '0.27.0']);
  assert.deepEqual(await previousReleases('0.25.0', tags, 3, all), ['0.25.0', '0.24.3', '0.9.23']);
  assert.ok(compareVersions('0.10.0', '0.9.23') > 0 && compareVersions('v1.0.0', '0.30.9') > 0 && compareVersions('0.27.1', '0.27.1') === 0);
  assert.throws(() => compareVersions('0.28.0-rc.1', '0.28.0'), /Not a release version/);
});

function collect(layout: Record<string, Record<string, unknown>>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-evidence-test-'));
  try {
    for (const [file, content] of Object.entries(layout)) {
      fs.mkdirSync(path.dirname(path.join(root, 'parts', file)), { recursive: true });
      fs.writeFileSync(path.join(root, 'parts', file), JSON.stringify(content));
    }
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'collect-release-evidence.mts'), '--parts', path.join(root, 'parts'), '--out', path.join(root, 'out')],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    return { status: result.status, output: result.stdout + result.stderr, manifest: JSON.parse(fs.readFileSync(path.join(root, 'out/manifest.json'), 'utf8')) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const complete = () => ({
  'unihub-evidence-part-container-attempt1/recovery.json': { result: 'passed' },
  'unihub-evidence-part-container-attempt1/instance-drill.json': { result: 'passed' },
  ...Object.fromEntries([1, 2, 3, 4].map(k => [`unihub-evidence-part-android-server-${k}-attempt1/android-server/android-36-part${k}of4.json`, { passed: true }])),
  ...Object.fromEntries(['0.27.1', '0.27.0', '0.26.0'].map((from, index) => [`unihub-evidence-part-upgrade-${index + 1}-attempt1/upgrade/previous-${index + 1}.json`, { result: 'passed', from }])),
} as Record<string, Record<string, unknown>>);

test('the release evidence is complete only with the drill and an upgrade from each of three releases', () => {
  const ok = collect(complete());
  assert.equal(ok.status, 0, ok.output);
  assert.equal(ok.manifest.complete, true);
  assert.deepEqual(['upgrade-1', 'upgrade-2', 'upgrade-3'].map(part => ok.manifest.parts[part].release), ['0.27.1', '0.27.0', '0.26.0']);

  const withoutDrill = complete();
  delete withoutDrill['unihub-evidence-part-container-attempt1/instance-drill.json'];
  const noDrill = collect(withoutDrill);
  assert.equal(noDrill.status, 1);
  assert.match(noDrill.manifest.parts.container.problem, /missing instance-drill\.json/);

  const failedUpgrade = complete();
  failedUpgrade['unihub-evidence-part-upgrade-2-attempt1/upgrade/previous-2.json'] = { result: 'failed', from: '0.27.0' };
  assert.match(collect(failedUpgrade).manifest.parts['upgrade-2'].problem, /does not record a pass/);

  const twice = complete();
  twice['unihub-evidence-part-upgrade-3-attempt1/upgrade/previous-3.json'] = { result: 'passed', from: '0.27.1' };
  const duplicate = collect(twice);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.manifest.parts['upgrade-3'].problem, /checks 0\.27\.1 again/);

  const withoutUpgrade = complete();
  delete withoutUpgrade['unihub-evidence-part-upgrade-1-attempt1/upgrade/previous-1.json'];
  const missing = collect(withoutUpgrade);
  assert.equal(missing.status, 1);
  assert.match(missing.manifest.parts['upgrade-1'].problem, /missing: no upload/);
});

test('only the instance backup drill may run without the sandbox, and never in CI', () => {
  const mode = (bwrap: boolean, env: NodeJS.ProcessEnv, allowWithoutSandbox: boolean) => localSandboxMode({ bwrap, env, allowWithoutSandbox });
  const flag = { UNIHUB_LOCAL_WITHOUT_SANDBOX: '1' };
  assert.equal(mode(true, flag, false), 'sandbox');
  assert.equal(mode(true, { ...flag, CI: 'true' }, true), 'sandbox');
  assert.equal(mode(false, flag, true), 'unsandboxed');
  assert.throws(() => mode(false, {}, true), /need bubblewrap/);
  assert.throws(() => mode(false, { UNIHUB_LOCAL_WITHOUT_SANDBOX: 'yes' }, true), /need bubblewrap/);
  assert.throws(() => mode(false, flag, false), /does not apply/);
  for (const CI of ['true', '1', 'false', '']) assert.throws(() => mode(false, { ...flag, CI }, true), /refused in CI/);

  // The scripts themselves, on a machine without bwrap: refused before they make anything.
  const run = (script: string, env: NodeJS.ProcessEnv) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-sandbox-test-'));
    try {
      const result = spawnSync(process.execPath, [path.join(import.meta.dirname, script), '--local'], { encoding: 'utf8', timeout: 60000,
        env: { PATH: path.dirname(process.execPath), TMPDIR: tmp, ...env } });
      return { status: result.status, output: result.stdout + result.stderr, left: fs.readdirSync(tmp) };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
  const gate = run('recovery-fresh-install.mts', flag);
  assert.notEqual(gate.status, 0);
  assert.match(gate.output, /does not apply/);
  assert.deepEqual(gate.left, [], 'The user-restore gate made nothing');
  const drillInCi = run('instance-backup-drill.mts', { ...flag, CI: 'true' });
  assert.notEqual(drillInCi.status, 0);
  assert.match(drillInCi.output, /refused in CI/);
  assert.deepEqual(drillInCi.left, [], 'The drill made nothing in CI');
});

test('the upgrade check reads mail in full and fails closed when its contents are lost', async () => {
  const crypto = await import('node:crypto');
  const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const seed = seedMessage({ account: 'sync@example.test', folder: 'inbox', id: 'view-1', subject: 'Quarterly numbers' });
  // An installation's answers for one message; each change below loses part of it.
  const installation = (change: { body?: string | null; attachment?: Buffer | null; stored?: string | null; format?: string } = {}) => {
    const attachment = change.attachment === undefined ? seed.attachment.bytes : change.attachment;
    const routes: Record<string, unknown> = {
      '/api/contacts': { contacts: [] }, '/api/calendar/calendars': { calendars: [] }, '/api/recordings': { recordings: [] },
      '/api/calendar/accounts': { accounts: [] }, '/api/mail/accounts': { accounts: [{ id: 'a1', email_address: seed.account, sync_mode: 'sync' }] },
      '/api/mail/folders': { folders: [{ slug: 'inbox' }] },
      '/api/mail/emails?folder=inbox': { emails: [{ id: 'e1', mail_account_id: 'a1', message_id: seed.messageId, subject: seed.subject }] },
      '/api/mail/emails/e1': { email: { message_id: seed.messageId, subject: seed.subject, body_text: change.body === undefined ? `${seed.text}\n` : change.body, body_html: null,
        attachments: attachment ? [{ id: 'f1', filename: seed.attachment.filename, size_bytes: attachment.length }] : [] } },
    };
    const session: ViewSession = {
      async json<T>(_method: string, url: string) {
        if (url.startsWith('/api/calendar/events')) return { events: [] } as T;
        if (!(url in routes)) throw new Error(`unexpected ${url}`);
        return routes[url] as T;
      },
      async bytes(url: string) { if (url === '/api/mail/attachments/f1' && attachment) return attachment; throw new Error(`unexpected ${url}`); },
    };
    const raw: Record<string, RawEntry> = { e1: { format: change.format ?? 'exact_octets', verified: true, recorded: sha(seed.raw), bytes: seed.raw.length,
      stored: change.stored === undefined ? sha(seed.raw) : change.stored } };
    return coreView(session, () => raw);
  };
  const intact = await installation();
  assert.deepEqual(seededMailProblems(intact.emails, [seed]), []);
  const changed = Buffer.from(seed.attachment.bytes); changed[0] ^= 1;
  const gutted = {
    'an empty body': { body: '' }, 'no body': { body: null }, 'changed attachment bytes': { attachment: changed }, 'a lost attachment': { attachment: null },
    'a lost original': { stored: null }, 'a changed original': { stored: sha(Buffer.from('other')) }, 'a normalized original': { format: 'legacy_normalized' },
  };
  for (const [what, change] of Object.entries(gutted)) {
    const view = await installation(change);
    assert.notDeepEqual(view, intact, `${what} reads differently`);
    assert.notDeepEqual(seededMailProblems(view.emails, [seed]), [], `${what} fails the seeded mail check`);
  }
  // A restore gives the exact original back unverified: that passes as restored, and a verified one does not.
  const unverified = intact.emails.map(email => ({ ...email, original: email.original && { ...email.original, verified: false } }));
  assert.deepEqual(seededMailProblems(unverified, [seed], { restored: true }), []);
  assert.match(seededMailProblems(unverified, [seed])[0], /not verified/);
  assert.match(seededMailProblems(intact.emails, [seed], { restored: true })[0], /verified after a restore/);
  // Missing or duplicated messages fail too, whatever the others hold.
  assert.match(seededMailProblems([], [seed])[0], /0 copies/);
  assert.match(seededMailProblems([...intact.emails, ...intact.emails], [seed])[0], /2 copies/);
});

const columnHash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('the instance drill compares every installation-owned row in full and allows only the documented changes', () => {
  const file = 'unihub-instance-20261101T000000Z-0.28.0.uhib';
  const row = (key: string, columns: Record<string, string>, plain: Record<string, string | null> = {}): ReportedRow => ({ key, columns, plain });
  // One row per table the rules know, as instance-drill-state.cts reports them.
  const source = (): InstallationReport => ({
    ...Object.fromEntries(Object.keys(INSTALLATION_RULES).map(table => [table, { owner: 'installation', rows: [row('r1', { id: 'h-id', value: 'h-value' })] }])),
    audit_log: { owner: 'installation', rows: [row('a1', { id: 'h-a1', actor_id: 'h-admin', action: 'h-role', details: 'h-details' }, { action: 'admin.role_change' })] },
    instance_backups: { owner: 'installation', rows: [
      row('b1', { id: 'h-b1', status: 'h-succeeded', finished_at: 'h-backup-end' }, { status: 'succeeded', file_name: file, finished_at: '2026-11-01 10:00:05' }),
      row('b0', { id: 'h-b0', status: 'h-failed', finished_at: 'h-old-end' }, { status: 'failed', file_name: null, finished_at: '2026-10-01 03:31:00' })] },
    notification_config: { owner: 'installation', rows: [row('1', { public_key: 'h-key', encrypted_private_key: 'h-private', reminder_revision: 'h-3' })] },
  });
  // The restore command ran from 10:20:00.400 to 10:20:03.700.
  const context = { backupFile: file, restore: { from: new Date('2026-11-01T10:20:00.400Z'), to: new Date('2026-11-01T10:20:03.700Z') } };
  // The restore clears the sign-in attempt budgets.
  const check = (change: (report: InstallationReport) => void) => { const target = source(); target.login_attempts.rows = []; change(target); return installationProblems(source(), target, context); };
  const finishedAt = (report: InstallationReport, value: string | null) => {
    report.instance_backups.rows[0].columns.finished_at = `h-${value}`;
    report.instance_backups.rows[0].plain.finished_at = value;
  };
  assert.deepEqual(check(() => {}), []);
  // The documented changes: this backup's run is finished by the restore (to the second), the push reminder cursors move.
  for (const at of ['2026-11-01 10:20:00', '2026-11-01 10:20:04']) {
    assert.deepEqual(check(report => { finishedAt(report, at); report.notification_config.rows[0].columns.reminder_revision = 'h-4'; }), [], at);
  }
  const fails: Record<string, (report: InstallationReport) => void> = {
    'an activity entry with its id kept but another actor': report => { report.audit_log.rows[0].columns.actor_id = 'h-stranger'; },
    'an activity entry with other details': report => { report.audit_log.rows[0].columns.details = 'h-other'; },
    'a lost activity entry': report => { report.audit_log.rows = []; },
    'an activity entry added by the restore': report => { report.audit_log.rows.push(row('a2', { id: 'h-a2' }, { action: 'admin.role_change' })); },
    'an earlier backup run finished at another time': report => { report.instance_backups.rows[1].columns.finished_at = 'h-other'; },
    'this backup run with another status': report => { report.instance_backups.rows[0].columns.status = 'h-failed'; },
    'a changed push key': report => { report.notification_config.rows[0].columns.encrypted_private_key = 'h-other'; },
    'a changed upgrade history': report => { report.schema_migrations.rows[0].columns.value = 'h-other'; },
    'reset mail upgrade progress': report => { report.mail_engine_migration_progress.rows[0].columns.value = 'h-default'; },
    'a changed setting': report => { report.system_settings.rows[0].columns.value = 'h-other'; },
    'a lost policy': report => { report.setting_policies.rows = []; },
    'an installation table the restored release does not report': report => { delete report.setting_policies; },
    'a newly declared organisation table without a rule': report => { report.org_address_books = { owner: 'organisation', rows: [] }; },
    'a lost group membership': report => { report.org_group_members.rows = []; },
    'a sign-in attempt budget kept by the restore': report => { report.login_attempts.rows = source().login_attempts.rows; },
    'this backup run without a completion time': report => finishedAt(report, null),
    'this backup run finished before the restore': report => finishedAt(report, '2026-11-01 10:19:59'),
    'this backup run finished after the restore': report => finishedAt(report, '2026-11-01 10:20:05'),
    'this backup run with a malformed completion time': report => finishedAt(report, '2026-11-01T10:20:01Z'),
    'an earlier run finished during the restore': report => {
      report.instance_backups.rows[1].columns.finished_at = 'h-restore'; report.instance_backups.rows[1].plain.finished_at = '2026-11-01 10:20:01';
    },
  };
  for (const [what, change] of Object.entries(fails)) assert.notDeepEqual(check(change), [], `${what} fails the drill`);
  // A BIGINT at the precision boundary, hashed as instance-drill-state.cts hashes a column: read as a string
  // (bigNumberStrings) it keeps its last digit; read as a JavaScript number the two would hash alike, so the
  // helper refuses unsafe integers.
  const progress = (value: unknown) => { const report = source(); report.mail_engine_migration_progress.rows[0].columns.processed = columnHash(value); return report; };
  assert.match(installationProblems(progress('9007199254740992'), progress('9007199254740993'), context).join('\n'), /mail_engine_migration_progress r1: processed changed/);
  assert.equal(columnHash(Number('9007199254740992')), columnHash(Number('9007199254740993')));
  // A table with nothing in it on the source proves nothing.
  const empty = source(); empty.system_settings.rows = [];
  assert.match(installationProblems(empty, empty, context).join('\n'), /system_settings: the source has no rows/);
});

test('the instance drill waits out the schedule and follows its own run by id', async () => {
  const HOUR = 3600 * 1000;
  for (const at of ['2026-11-01T00:05:30Z', '2026-11-01T11:59:59Z', '2026-11-01T12:00:00Z', '2026-12-31T23:59:59Z']) {
    const now = new Date(at), { time, slot, next } = drillSchedule(now);
    assert.equal(slot.toISOString().slice(11, 16), time, at);
    const since = now.getTime() - slot.getTime();
    assert.ok(since >= 12 * HOUR && since < 12 * HOUR + 60000 && next.getTime() - now.getTime() > 12 * HOUR - 60000, `${at}: the slot was half a day ago, the next is half a day away`);
  }
  const { slot } = drillSchedule(new Date('2026-11-01T14:00:00Z'));
  const run = (id: string, trigger: string, status: string, started_at: string) => ({ id, trigger, status, started_at });
  const sessionOf = (statuses: BackupStatus[]): StatusSession & { polls: number } => ({
    polls: 0,
    async json<T>(_method: string, url: string) {
      assert.equal(url, '/api/admin/instance-backup');
      return statuses[Math.min(this.polls++, statuses.length - 1)] as T;
    },
  });
  const now = { timeoutMs: 60000, sleep: async () => {} }, expired = { timeoutMs: -1, sleep: async () => {} };
  // A new installation's scheduled history is older than the slot (the seeded runs are from January): the catch-up is still to come.
  const stale: BackupStatus = { running: false, key_fingerprint: 'k', runs: [run('m0', 'manual', 'succeeded', '2026-11-01T13:58:00Z'), run('s0', 'schedule', 'succeeded', '2026-01-03T03:30:00Z')] };
  assert.match(String(scheduleProblem(stale, slot)), /no scheduled run since the slot/);
  await assert.rejects(waitForQuietSchedule(sessionOf([stale]), slot, expired), /did not settle \(no scheduled run since the slot/);
  // It waits through the catch-up run and returns once it has succeeded.
  const catchUp = sessionOf([stale, { ...stale, running: true, runs: [run('s1', 'schedule', 'running', '2026-11-01T14:01:00Z'), ...stale.runs] },
    { ...stale, runs: [run('s1', 'schedule', 'succeeded', '2026-11-01T14:01:00Z'), ...stale.runs] }]);
  await waitForQuietSchedule(catchUp, slot, now);
  assert.equal(catchUp.polls, 3);
  await assert.rejects(waitForQuietSchedule(sessionOf([{ ...stale, runs: [run('s1', 'schedule', 'failed', '2026-11-01T14:01:00Z')] }]), slot, now), /scheduled instance backup of this slot failed/);
  // The drill's run stays found when a later run is listed first, as last_run: it returns once nothing runs.
  const manual = run('m1', 'manual', 'running', '2026-11-01T14:05:00Z');
  const overtaken = sessionOf([{ running: true, key_fingerprint: 'k', runs: [manual] },
    { running: true, key_fingerprint: 'k', runs: [run('s2', 'schedule', 'running', '2026-11-01T14:05:30Z'), { ...manual, status: 'succeeded' }] },
    { running: false, key_fingerprint: 'k', runs: [run('s2', 'schedule', 'succeeded', '2026-11-01T14:05:30Z'), { ...manual, status: 'succeeded' }] }]);
  const followed = await waitForRun(overtaken, 'm1', now);
  assert.deepEqual([followed.run.id, followed.run.status, followed.fingerprint, overtaken.polls], ['m1', 'succeeded', 'k', 3]);
  await assert.rejects(waitForRun(sessionOf([{ running: false, key_fingerprint: 'k', runs: [{ ...manual, status: 'failed', error: 'disk full' }] }]), 'm1', now), /failed: disk full/);
  await assert.rejects(waitForRun(sessionOf([stale]), 'm1', expired), /m1 did not finish/);
});
