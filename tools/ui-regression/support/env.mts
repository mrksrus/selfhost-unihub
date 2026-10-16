// Paths, identity and the baseline manifest. Shared by scripts/run.mts (plain
// Node with type stripping) and the Playwright config, so erasable syntax only.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(toolRoot, '../..');
export const buildDir = path.join(toolRoot, '.build');
export const distDir = path.join(buildDir, 'dist');
export const browsersDir = path.join(toolRoot, '.browsers');
export const baselineDir = path.join(toolRoot, 'baselines');
export const manifestPath = path.join(baselineDir, 'manifest.json');
export const fontPackages = ['@fontsource/inter', '@fontsource/jetbrains-mono'];

// Everything the production frontend bundle is built from.
export const FRONTEND_INPUTS = [
  'src', 'public', 'workers', 'index.html', 'vite.config.ts', 'tailwind.config.ts',
  'postcss.config.mts', 'components.json', 'tsconfig.app.json', 'tsconfig.workers.json', 'package-lock.json',
];

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

export interface SourceIdentity {
  commit: string;
  branch: string;
  /** Frontend inputs differ from the commit (tracked edits or untracked files). */
  dirty: boolean;
  /** Hash of the commit plus every uncommitted frontend input; equal digests build the same bundle. */
  digest: string;
}

export function sourceIdentity(): SourceIdentity {
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
  const diff = git(['diff', 'HEAD', '--binary', '--', ...FRONTEND_INPUTS]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...FRONTEND_INPUTS])
    .toString().split('\0').filter(Boolean).sort();
  const hash = createHash('sha256').update(commit).update(diff);
  for (const file of untracked) hash.update(file).update(fs.readFileSync(path.join(repoRoot, file)));
  return { commit, branch, dirty: diff.length > 0 || untracked.length > 0, digest: hash.digest('hex') };
}

const packageVersion = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(toolRoot, 'node_modules', name, 'package.json'), 'utf8')).version as string;

/** Conditions that must match for two screenshots to be comparable pixel for pixel. */
export interface RenderIdentity {
  playwright: string;
  browser: string;
  platform: string;
  fonts: Record<string, string>;
  fontconfig: 'isolated';
  deviceScaleFactor: 1;
  browserArgs: string[];
}

export function renderIdentity(browserVersion: string, browserArgs: string[]): RenderIdentity {
  return {
    playwright: packageVersion('@playwright/test'),
    browser: `chromium-headless-shell ${browserVersion}`,
    browserArgs,
    platform: `${process.platform}-${process.arch}`,
    fonts: Object.fromEntries(fontPackages.map(name => [name, packageVersion(name)])),
    fontconfig: 'isolated',
    deviceScaleFactor: 1,
  };
}

/** Recorded for the reader; differences here do not block a comparison. Machine names and kernels stay out. */
export function hostNotes() {
  return { node: process.version, ci: !!process.env.CI };
}

export interface BaselineEntry { sha256: string; bytes: number }
export interface Approval {
  date: string;
  reason: string;
  source: SourceIdentity;
  render: RenderIdentity;
  host: ReturnType<typeof hostNotes>;
  added: string[];
  changed: string[];
  removed: string[];
}
export interface Manifest {
  schema: 1;
  status: string;
  render: RenderIdentity;
  baselines: Record<string, BaselineEntry>;
  approvals: Approval[];
}

export function readManifest(): Manifest | null {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

export function baselineFiles(): Record<string, BaselineEntry> {
  if (!fs.existsSync(baselineDir)) return {};
  const entries: Record<string, BaselineEntry> = {};
  for (const name of fs.readdirSync(baselineDir).filter(file => file.endsWith('.png')).sort()) {
    const data = fs.readFileSync(path.join(baselineDir, name));
    entries[name] = { sha256: sha256(data), bytes: data.length };
  }
  return entries;
}

/** Problems that make a verify run meaningless; each one fails the run. */
export function manifestProblems(manifest: Manifest | null, render: RenderIdentity): string[] {
  if (!manifest) return [`No approved baselines: ${path.relative(repoRoot, manifestPath)} is missing. Capture them with an explicit --update and review the pictures.`];
  const problems: string[] = [];
  const expected = JSON.stringify(manifest.render);
  if (JSON.stringify(render) !== expected) {
    problems.push(`Render environment differs from the one the baselines were approved in.\n  approved: ${expected}\n  current:  ${JSON.stringify(render)}\nPixels from different browsers, fonts or platforms are not comparable; use the approved environment or approve new baselines with --update.`);
  }
  const files = baselineFiles();
  for (const [name, entry] of Object.entries(manifest.baselines)) {
    if (!files[name]) problems.push(`Approved baseline ${name} is missing from ${path.relative(repoRoot, baselineDir)}/.`);
    else if (files[name].sha256 !== entry.sha256) problems.push(`Baseline ${name} was changed outside an approved --update (hash differs from manifest.json).`);
  }
  for (const name of Object.keys(files)) {
    if (!manifest.baselines[name]) problems.push(`Baseline ${name} is not listed in manifest.json; it was added outside an approved --update.`);
  }
  return problems;
}
