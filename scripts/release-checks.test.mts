// Tests of the release checks' own logic, without Docker or providers:
//   node --test scripts/release-checks.test.mts
// The checks themselves run in CI (.github/workflows/docker-image.yml).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localSandboxMode } from './fresh-installations.mts';
import { compareVersions, previousReleases } from './published-image.mts';
import { DESTRUCTIVE_IMAP, imapCommandReader, imapResultReader } from './test-providers.mts';

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
