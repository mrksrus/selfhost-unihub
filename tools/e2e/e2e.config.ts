import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// The stack from ./stack.sh: nginx in front of the API, as in the image.
// Instance N serves on port 8087 + N.
const instance = Number(process.env.UNIHUB_E2E_INSTANCE ?? '1');
const app = { url: process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + instance}`, identity: 'unihub-local' };

// The Android shell is a Chromium WebView that appends this marker
// (android/.../MainActivity.kt); src/lib/platform.ts switches to app mode on it.
// It has no native bridge here, so keyboard insets, notifications, file
// pickers and downloads still need a real device.
const androidAppUserAgent =
  'Mozilla/5.0 (Linux; Android 16; Pixel 8a; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36 UniHubAndroid/0.24.2 (24002)';
const androidBrowserUserAgent =
  'Mozilla/5.0 (Linux; Android 16; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

export default {
  tests: ['tests/**/*.e2e.ts'],
  workers: 1,
  retries: 0,
  // The shared development host is slow; a signed-in page can take 10 s to appear.
  assertionTimeout: 20_000,
  targets: [
    { name: 'desktop', engine: web({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'UTC' }), app },
    { name: 'phone', engine: web({ viewport: { width: 412, height: 915 }, userAgent: androidBrowserUserAgent, colorScheme: 'dark', timezoneId: 'UTC' }), app },
    { name: 'android-app', engine: web({ viewport: { width: 412, height: 915 }, userAgent: androidAppUserAgent, colorScheme: 'dark', timezoneId: 'UTC' }), app },
  ],
  // Synthetic users seeded by scripts/local-db.sh dev; never real accounts.
  credentials: {
    admin: { username: 'admin@example.com', password: 'local-dev-admin-password' },
    alex: { username: 'alex@example.com', password: 'local-dev-admin-password' },
  },
} satisfies E2EConfig;
