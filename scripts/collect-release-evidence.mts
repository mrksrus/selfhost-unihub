// Gathers the release evidence of one CI run into a single directory and
// checks that it is complete (.github/workflows/docker-image.yml, evidence job).
//
//   node scripts/collect-release-evidence.mts --parts <dir> --out <dir> [--previous <dir>]
//
// <parts> holds one directory per uploaded part, named
// unihub-release-evidence-<part>-attempt<n>; --previous is the bundle an
// earlier attempt of the run kept (its manifest.json names each part's attempt
// and files; the parts themselves are deleted once a complete bundle is kept).
// A part re-run in a later attempt replaces that part; parts not re-run keep
// theirs, so a run whose jobs were re-run still yields the whole evidence. The result is
// complete only when every expected part is present and records a pass. It
// writes <out>/manifest.json (which attempt each part came from, its files and
// any problem) and exits 1 when the evidence is incomplete.
import fs from 'node:fs';
import path from 'node:path';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const partsDir = argument('--parts'), out = argument('--out'), previousDir = argument('--previous');
if (!partsDir || !out) throw new Error('usage: --parts <dir> --out <dir> [--previous <dir>]');

const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
// What each part must contain: the job that uploads it and how its pass is recorded.
const SERVER_PARTS = 4;
const expected: Record<string, { file: string; passed: (data: { result?: string; passed?: boolean } | undefined) => boolean }> = {
  container: { file: 'recovery.json', passed: data => data?.result === 'passed' },
  ...Object.fromEntries(Array.from({ length: SERVER_PARTS }, (_, index) => [`android-server-${index + 1}`,
    { file: `android-server/android-36-part${index + 1}of${SERVER_PARTS}.json`, passed: (data: { passed?: boolean } | undefined) => data?.passed === true }])),
};

const files = (dir: string, base = dir): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name))]).sort();
const latest = new Map<string, { attempt: number; dir: string; files: string[] }>();
const offer = (part: string, source: { attempt: number; dir: string; files: string[] }) => {
  if ((latest.get(part)?.attempt ?? 0) < source.attempt) latest.set(part, source);
};
interface Manifest { parts?: Record<string, { attempt?: number; files?: string[] }> }
const previous: Manifest | undefined = previousDir ? readJson(path.join(previousDir, 'manifest.json')) : undefined;
for (const [part, entry] of Object.entries(previous?.parts ?? {})) {
  const kept = (entry.files ?? []).filter(file => fs.existsSync(path.join(previousDir!, file)));
  if (entry.attempt && kept.length) offer(part, { attempt: entry.attempt, dir: previousDir!, files: kept });
}
// Anything else in <parts> means the parts were not laid out per upload, so no
// part's attempt can be trusted.
const unexpected: string[] = [];
for (const entry of fs.existsSync(partsDir) ? fs.readdirSync(partsDir, { withFileTypes: true }) : []) {
  const match = /^unihub-release-evidence-(.+)-attempt(\d+)$/.exec(entry.name);
  if (match && entry.isDirectory()) offer(match[1], { attempt: Number(match[2]), dir: path.join(partsDir, entry.name), files: files(path.join(partsDir, entry.name)) });
  else unexpected.push(entry.name);
}

fs.mkdirSync(out, { recursive: true });
const parts: Record<string, { attempt?: number; files: string[]; problem?: string }> = {};
for (const [part, source] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
  for (const file of source.files) {
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(path.join(source.dir, file), path.join(out, file));
  }
  parts[part] = { attempt: source.attempt, files: source.files };
}
for (const [part, rule] of Object.entries(expected)) {
  const entry = parts[part] ??= { files: [] };
  if (entry.attempt === undefined) entry.problem = 'missing: no upload in any attempt';
  else if (!entry.files.includes(rule.file)) entry.problem = `missing ${rule.file}`;
  else if (!rule.passed(readJson(path.join(latest.get(part)!.dir, rule.file)))) entry.problem = `${rule.file} does not record a pass`;
}
const problems = [...Object.entries(parts).filter(([, entry]) => entry.problem).map(([part, entry]) => `${part}: ${entry.problem}`),
  ...unexpected.map(name => `${partsDir}: unexpected entry ${name} (each part must be a directory named after its upload)`)];
const complete = problems.length === 0;
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, complete, parts }, null, 2) + '\n');

const lines = ['### Release evidence', '', '| Part | Attempt | Files | Result |', '| --- | --- | --- | --- |',
  ...Object.entries(parts).map(([part, entry]) => `| ${part} | ${entry.attempt ?? '-'} | ${entry.files.length} | ${entry.problem ?? 'passed'} |`),
  '', complete ? 'Complete: every expected part is present and passed.' : `Incomplete:\n- ${problems.join('\n- ')}`, ''];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exitCode = complete ? 0 : 1;
