// Builds the current frontend with the repository's own Vite config into
// .build/dist. Nothing is written outside tools/ui-regression except the
// classic workers in /.worker-dist, which `npm run dev` and `npm run build`
// emit the same way and the Vite config reads from there.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildDir, distDir, repoRoot, sourceIdentity, toolRoot, type SourceIdentity } from './env.mts';

const identityFile = path.join(distDir, '.ui-regression-source.json');

export async function buildFrontend(): Promise<SourceIdentity> {
  const source = sourceIdentity();
  if (process.env.UNIHUB_UI_REUSE_BUILD === '1' && fs.existsSync(identityFile)) {
    const built = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as SourceIdentity;
    if (built.digest === source.digest) return built;
  }
  const vite = path.join(repoRoot, 'node_modules/vite/dist/node/index.js');
  const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
  for (const file of [vite, tsc]) {
    if (!fs.existsSync(file)) throw new Error(`Frontend dependencies are not installed (${path.relative(repoRoot, file)} is missing). Run npm ci in the repository root first.`);
  }
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.workers.json'], { cwd: repoRoot, stdio: 'inherit' });

  // An empty env directory keeps a developer's .env.local (for example a
  // VITE_API_URL pointing at a real server) out of the test bundle.
  const envDir = path.join(buildDir, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')));
  execFileSync(process.execPath, [path.join(toolRoot, 'support/vite-build.mts'), distDir, envDir], { cwd: repoRoot, env, stdio: 'inherit' });
  fs.writeFileSync(identityFile, JSON.stringify(source, null, 2));
  return source;
}
