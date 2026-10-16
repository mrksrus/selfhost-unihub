// Downloads the Chromium headless shell that this package's pinned Playwright
// expects, into tools/ui-regression/.browsers. Extra arguments are passed on,
// e.g. `npm run browsers -- --with-deps` on a CI runner that may install the
// browser's system libraries.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { browsersDir, toolRoot } from '../support/env.mts';

const cli = path.join(toolRoot, 'node_modules/playwright/cli.js');
const result = spawnSync(process.execPath, [cli, 'install', '--only-shell', 'chromium', ...process.argv.slice(2)], {
  cwd: toolRoot,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
});
process.exit(result.status ?? 1);
