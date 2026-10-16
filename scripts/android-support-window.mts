// Checks android/support-window.json and collects the apps it names.
//
//   node scripts/android-support-window.mts [--out <dir>] [--candidate <dir with unihub.apk and unihub-android.json>]
//
// - The window is exactly this version (package.json) and the three releases
//   tagged before it; a new release without an updated window fails.
// - Each earlier release's app is read from its published image and must be
//   byte-identical to the recorded hash, signed with the release key.
// - The server's handshake (api/dist, so build the API first) must still serve
//   every app in the window.
// With --out, the apps and plan.tsv (version, apk, expectation per emulator
// API level) are written for android/scripts/window-test.sh. Nothing here
// claims an app works: the emulator runs do.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readPublishedFiles, writeFiles } from './published-image.mts';

interface Release { version: string; apk: { versionCode: number; sha256: string | null; signing: string }; shell: 'supported' | 'broken' | 'unavailable';
  broken?: { fromApi: number; symptom: string; fixedIn: string; upgrade: string }; unavailable?: string }
interface Window { emulators: { android: string; api: number; imageApiLevel: string }[]; releases: Release[]; handshake: { shellReads: string[] } }

const repo = path.resolve(import.meta.dirname, '..');
const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const out = argument('--out'), candidateDir = argument('--candidate');
const window = JSON.parse(fs.readFileSync(path.join(repo, 'android/support-window.json'), 'utf8')) as Window;
const parse = (version: string) => version.split('.').map(Number);
const compare = (a: string, b: string) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const problems: string[] = [];

const current = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string }).version;
const tags = execFileSync('git', ['-C', repo, 'tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n')
  .map(tag => tag.trim().slice(1)).filter(version => /^\d+\.\d+\.\d+$/.test(version)).sort(compare);
if (tags.length === 0) problems.push('No release tags in this checkout; fetch them (git fetch --tags, or actions/checkout with fetch-depth: 0).');
const expected = [current, ...tags.filter(version => compare(version, current) < 0).reverse().slice(0, 3)];
const listed = window.releases.map(release => release.version);
if (JSON.stringify(listed) !== JSON.stringify(expected)) problems.push(`android/support-window.json must list ${expected.join(', ')} (this version and the three published before it), not ${listed.join(', ')}.`);

const rows: string[][] = [];
const apks = new Map<string, string>();
for (const release of window.releases) {
  const isCurrent = release.version === current;
  if (release.shell === 'broken' && !(release.broken?.fromApi && release.broken.fixedIn && release.broken.upgrade)) problems.push(`${release.version}: a broken app needs fromApi, fixedIn and upgrade`);
  if (release.shell === 'unavailable' && !release.unavailable) problems.push(`${release.version}: say why the app is unavailable`);
  if (isCurrent) {
    if (release.shell !== 'supported') problems.push(`${release.version}: the current app must be supported`);
    if (candidateDir) apks.set(release.version, path.join(candidateDir, 'unihub.apk'));
    continue;
  }
  if (release.shell === 'unavailable') continue;
  const published = await readPublishedFiles(release.version, 'android');
  if (!published) { problems.push(`${release.version}: the published image has no Android app; mark it unavailable with a reason`); continue; }
  const apk = published.files.get('unihub.apk'), meta = JSON.parse(published.files.get('unihub-android.json')?.toString() || '{}');
  const sha256 = apk && crypto.createHash('sha256').update(apk).digest('hex');
  if (!apk || sha256 !== meta.sha256 || apk.length !== meta.size) problems.push(`${release.version}: the published app does not match its own metadata`);
  if (sha256 !== release.apk.sha256) problems.push(`${release.version}: published app ${sha256} is not the recorded ${release.apk.sha256} (was the tag re-pushed?)`);
  if (meta.versionCode !== release.apk.versionCode || meta.signing !== 'release' || release.apk.signing !== 'release') problems.push(`${release.version}: version code or release signing differs`);
  console.log(`${release.version}: ${published.image}@${published.digest} app ${sha256}`);
  if (out && apk) {
    writeFiles(new Map([[`${release.version}/unihub.apk`, apk]]), out);
    apks.set(release.version, path.join(path.resolve(out), release.version, 'unihub.apk'));
  }
}

// The candidate server must keep serving the oldest app in the window.
const { versionInfo } = createRequire(import.meta.url)(path.join(repo, 'api/dist/src/services/app-version.js')) as { versionInfo(dir?: string): { app: string; minApp: string; protocol: number; features: string[] } };
const handshake = versionInfo(path.join(repo, 'android'));
const oldest = window.releases.filter(release => release.shell !== 'unavailable').map(release => release.version).sort(compare)[0];
if (handshake.app !== 'unihub') problems.push(`GET /api/version must answer app = "unihub" (apps in the window read only that)`);
if (compare(handshake.minApp, oldest) > 0) problems.push(`minApp ${handshake.minApp} would refuse ${oldest}, which is still in the support window`);
// From 0.22.1 the app offers notifications only while the server lists them.
const usesNotifications = window.releases.some(release => release.shell !== 'unavailable' && compare(release.version, '0.22.1') >= 0);
if (usesNotifications && !handshake.features.includes('android-notifications')) problems.push('features must list android-notifications: an app in the window turns notifications on only then');
if (JSON.stringify(window.handshake.shellReads) !== JSON.stringify(['app', 'features'])) problems.push('A shell now reads more of the handshake: extend this check for it');

for (const release of window.releases) {
  for (const emulator of window.emulators) {
    const expectation = release.shell === 'unavailable' ? 'unavailable'
      : release.shell === 'broken' && emulator.api >= release.broken!.fromApi ? 'crash' : 'launch';
    rows.push([release.version, String(emulator.api), expectation, apks.get(release.version) || '-']);
  }
}
console.log('\nApp  Android(API)  Expected on the emulator');
for (const [version, api, expectation] of rows) console.log(`${version.padEnd(8)} ${String(window.emulators.find(item => String(item.api) === api)?.android).padStart(2)} (${api})   ${expectation === 'crash' ? 'closes on start (known broken; upgrade: install the current app)' : expectation}`);
if (out) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'plan.tsv'), rows.map(row => row.join('\t')).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'upgrade-from'), `${window.releases[1]?.version || ''}\n`);
}
if (problems.length) {
  console.error(`\nAndroid support window check failed:\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
} else console.log('\nAndroid support window: manifest, published apps and handshake checked. Emulator runs decide whether they start.');
