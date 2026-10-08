// Emit the API into one isolated runtime tree.
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
const apiRoot = path.resolve(__dirname, '..');
fs.rmSync(path.join(apiRoot, 'dist'), { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(apiRoot, 'tsconfig.json')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const metadata = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
  metadata.main = 'server.js';
  metadata.scripts = { start: 'node server.js' };
  fs.writeFileSync(path.join(apiRoot, 'dist/package.json'), JSON.stringify(metadata, null, 2) + '\n');
}
// Standalone API test commands exercise the actual classic browser worker output.
// The Docker API-only builder has no worker source; its frontend stage builds it.
const workersConfig = path.resolve(apiRoot, '../tsconfig.workers.json');
if (result.status === 0 && fs.existsSync(workersConfig)) {
  const workers = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', workersConfig], { stdio: 'inherit' });
  if (workers.error) throw workers.error;
  process.exitCode = workers.status ?? 1;
}
