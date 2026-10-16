import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { launchOptions, prepareFonts } from './browser.mts';
import { buildFrontend } from './build.mts';
import { buildDir, manifestProblems, readManifest, renderIdentity } from './env.mts';
import { startServer } from './server.mts';

export default async function globalSetup() {
  const update = process.env.UNIHUB_UI_MODE === 'update';
  const source = await buildFrontend();
  prepareFonts();

  const browser = await chromium.launch(launchOptions);
  const render = renderIdentity(browser.version(), launchOptions.args);
  await browser.close();

  if (!update) {
    const problems = manifestProblems(readManifest(), render);
    if (problems.length) throw new Error(`UI baselines cannot be verified:\n- ${problems.join('\n- ')}`);
  }
  fs.writeFileSync(path.join(buildDir, 'run.json'), JSON.stringify({ mode: update ? 'update' : 'verify', source, render }, null, 2));

  const server = await startServer();
  process.env.UNIHUB_UI_ORIGIN = server.origin;
  console.log(`ui-regression: ${update ? 'UPDATE' : 'verify'} ${source.commit.slice(0, 12)}${source.dirty ? ' + uncommitted frontend changes' : ''} on ${render.browser}, serving ${server.origin}`);
  return () => server.close();
}
