// npm run verify             compare the current frontend with the approved baselines
// npm run update -- --reason "why"   capture changed baselines and record the approval
//
// Checks the prerequisites first, so a missing browser, dependency or baseline
// fails with a reason instead of passing or silently creating pictures.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  baselineDir, baselineFiles, browsersDir, buildDir, hostNotes, manifestPath, readManifest, repoRoot, toolRoot,
  type Approval, type Manifest, type RenderIdentity, type SourceIdentity,
} from '../support/env.mts';
import { usedBaselinesDir } from '../support/used-baselines.mts';

const INITIAL_STATUS = 'Initial current-code baseline, captured on request of the maintainer on 2026-10-16 to pin the interface as it is. Synthetic fixture data in a headless browser; not a real device, installation or production check.';

function fail(message: string): never {
  console.error(`\nui-regression: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const update = args[0] === '--update';
let reason = '';
let passThrough = update ? args.slice(1) : args;
if (update) {
  const at = passThrough.indexOf('--reason');
  reason = at >= 0 ? (passThrough[at + 1] ?? '').trim() : '';
  if (at >= 0) passThrough = [...passThrough.slice(0, at), ...passThrough.slice(at + 2)];
  if (!reason) fail('--update needs --reason "<what changed and who approved it>"; the reason is recorded in baselines/manifest.json.');
  if (passThrough.length) fail('--update runs the whole suite so the manifest stays complete; drop the extra arguments.');
}

// Keep verification inside this runner's fixed configuration. In particular,
// Playwright flags must not bypass or update snapshots or select another config.
if (!update) {
  for (let index = 0; index < passThrough.length; index++) {
    const option = passThrough[index];
    const [name, inline] = option.split(/=(.*)/s, 2);
    if (!['-g', '--grep', '--repeat-each', '--workers'].includes(name)) {
      fail(`Unsupported verify option ${option}. Only -g/--grep, --repeat-each and --workers are allowed; baseline updates require update --reason.`);
    }
    const value = inline ?? passThrough[++index];
    if (!value || value.startsWith('-')) fail(`${name} needs a value.`);
    if (['--repeat-each', '--workers'].includes(name) && !/^[1-9][0-9]*$/.test(value)) fail(`${name} needs a positive integer.`);
  }
}

// Prerequisites.
const [major] = process.versions.node.split('.').map(Number);
if (major < 26) fail(`Node.js 26 or newer is required (found ${process.version}).`);
if (!fs.existsSync(path.join(toolRoot, 'node_modules/@playwright/test/package.json'))) {
  fail('Test dependencies are missing. Run `npm ci` in tools/ui-regression.');
}
if (!fs.existsSync(path.join(repoRoot, 'node_modules/vite/package.json'))) {
  fail('Frontend dependencies are missing. Run `npm ci` in the repository root.');
}
const browsers = JSON.parse(fs.readFileSync(path.join(toolRoot, 'node_modules/playwright-core/browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
const shell = browsers.browsers.find(browser => browser.name === 'chromium-headless-shell');
if (!shell || !fs.existsSync(path.join(browsersDir, `chromium_headless_shell-${shell.revision}`, 'INSTALLATION_COMPLETE'))) {
  fail(`The pinned browser (chromium-headless-shell r${shell?.revision ?? '?'}) is not installed. Run \`npm run browsers\` in tools/ui-regression (add \`-- --with-deps\` on a fresh CI runner).`);
}

const manifestBefore = readManifest();
const manifestBytesBefore = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
const baselineFilesBefore = baselineFiles();
if (!update && !manifestBefore) fail(`No approved baselines (${path.relative(repoRoot, manifestPath)} is missing). Capture them with \`npm run update -- --reason "..."\` and review every picture before committing.`);

fs.rmSync(usedBaselinesDir, { recursive: true, force: true });
fs.mkdirSync(usedBaselinesDir, { recursive: true });
const result = spawnSync(process.execPath, [path.join(toolRoot, 'node_modules/@playwright/test/cli.js'), 'test', ...passThrough], {
  cwd: toolRoot,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir, UNIHUB_UI_MODE: update ? 'update' : 'verify' },
});
if (!update && (
  !manifestBytesBefore || !fs.existsSync(manifestPath)
  || !manifestBytesBefore.equals(fs.readFileSync(manifestPath))
  || JSON.stringify(baselineFilesBefore) !== JSON.stringify(baselineFiles())
)) fail('Verification changed baseline files or their approval manifest. No verification pass is valid; restore or review those changes explicitly.');
if (result.status !== 0) {
  fail(update
    ? 'The update run failed, so no baseline was approved and manifest.json is unchanged. Fix the failing checks first; pictures Playwright may have written are not approved until a run passes.'
    : 'Verification failed. Open tools/ui-regression/report/index.html for expected, actual and diff pictures.');
}

const used = new Set(fs.readdirSync(usedBaselinesDir));
if (!update) {
  // Only a full run can tell whether an approved picture lost its test.
  if (!passThrough.length) {
    const orphaned = Object.keys(manifestBefore!.baselines).filter(name => !used.has(name));
    if (orphaned.length) fail(`Approved baselines no test compares any more: ${orphaned.join(', ')}. Remove them with an approved --update.`);
  }
  console.log(`\nui-regression: verified ${used.size} baselines and the behaviour checks against ${path.relative(repoRoot, manifestPath)}.`);
  process.exit(0);
}

// Update: drop pictures no test uses, then record what changed and why.
for (const name of Object.keys(baselineFiles())) {
  if (!used.has(name)) fs.rmSync(path.join(baselineDir, name));
}
const run = JSON.parse(fs.readFileSync(path.join(buildDir, 'run.json'), 'utf8')) as { source: SourceIdentity; render: RenderIdentity };
const files = baselineFiles();
const before = manifestBefore?.baselines ?? {};
const approval: Approval = {
  date: new Date().toISOString(),
  reason,
  source: run.source,
  render: run.render,
  host: hostNotes(),
  added: Object.keys(files).filter(name => !before[name]),
  changed: Object.keys(files).filter(name => before[name] && before[name].sha256 !== files[name].sha256),
  removed: Object.keys(before).filter(name => !files[name]),
};
const touched = approval.added.length + approval.changed.length + approval.removed.length;
const renderChanged = JSON.stringify(manifestBefore?.render) !== JSON.stringify(run.render);
if (!touched && !renderChanged && manifestBefore) {
  console.log('\nui-regression: every baseline already matches; manifest.json is unchanged.');
  process.exit(0);
}
const manifest: Manifest = {
  schema: 1,
  status: manifestBefore?.status ?? INITIAL_STATUS,
  render: run.render,
  baselines: files,
  approvals: [...(manifestBefore?.approvals ?? []), approval],
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nui-regression: recorded approval in ${path.relative(repoRoot, manifestPath)}`);
for (const kind of ['added', 'changed', 'removed'] as const) {
  if (approval[kind].length) console.log(`  ${kind}: ${approval[kind].join(', ')}`);
}
console.log('Review every listed picture (git diff shows them side by side on GitHub) before committing; see docs/UI_BASELINES.md.');
