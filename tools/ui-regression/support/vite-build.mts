// Runs in a child process with the repository root as working directory:
// Tailwind and PostCSS find their config files and content globs from there.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [outDir, envDir] = process.argv.slice(2);
const root = process.cwd();
const { build } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
await build({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  mode: 'production',
  envDir,
  logLevel: 'warn',
  build: { outDir, emptyOutDir: true },
});
