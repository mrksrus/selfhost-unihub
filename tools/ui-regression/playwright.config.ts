import { defineConfig } from '@playwright/test';
import { launchOptions, requirePinnedBrowserPath } from './support/browser.mts';

requirePinnedBrowserPath();

const update = process.env.UNIHUB_UI_MODE === 'update';

export default defineConfig({
  testDir: './tests',
  // Baselines are named by the scenario, not by test title or platform: a
  // platform change must fail the identity check, not start a second set.
  snapshotPathTemplate: '{testDir}/../baselines/{arg}{ext}',
  // Verify never writes a baseline, not even a missing one; only
  // `npm run update -- --reason "..."` (scripts/run.mts) does.
  updateSnapshots: update ? 'changed' : 'none',
  globalSetup: './support/global-setup.ts',
  outputDir: './test-results',
  forbidOnly: true,
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.UNIHUB_UI_WORKERS || 2),
  timeout: 60_000,
  reporter: [['list'], ['html', { outputFolder: './report', open: 'never' }]],
  expect: {
    // Zero tolerance: rendering noise is fixed in the conditions, never by
    // accepting more difference (docs/UI_ACCEPTANCE.md approval policy 3).
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions,
    locale: 'en-GB',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    serviceWorkers: 'block',
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
});
