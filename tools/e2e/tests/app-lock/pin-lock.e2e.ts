import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stack } from '../support/env.ts';
import { pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge, chooseRelock, hidePage, OTHER_PIN, PIN, pinRecords, resetLock, showPage, turnOn, unlockWith } from './app-lock-helpers.ts';

// 0.29 app lock on the web (rows 29-01 and 29-04): a UniHub PIN kept in
// this browser locks the whole app; "Every time UniHub opens" asks at every
// start and after every hide; a longer time waits that long; wrong PINs are
// counted; "Forgot PIN? Sign out" ends the server session and removes the PIN.

test('[29-01] a PIN for the whole app: the next start asks, wrong PINs say so, the right one opens UniHub', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await acknowledge(['alex']);
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  try {
    await turnOn(app, screen, browser, 'app');
    await expect(screen.getByText('Set for this browser.', { exact: true })).toBeVisible();
    await chooseRelock(screen, 'Every time UniHub opens');
    await browser.reload();
    const heading = screen.getByRole('heading', 'UniHub is locked');
    await expect(heading).toBeVisible();
    // Nothing of the shell is behind the lock screen.
    await expect(screen.getByRole('navigation', 'Main')).toHaveCount(0);
    await expect(screen.getByLabel('PIN', { exact: true })).toBeFocused();
    await unlockWith(screen, OTHER_PIN);
    await expect(screen.getByRole('status').filter({ hasText: 'That is not the PIN.' })).toBeVisible();
    await unlockWith(screen, PIN);
    await expect(heading).toHaveCount(0);
    await expect(screen.getByRole('navigation', 'Main').first()).toBeVisible();
    // Hidden and back: "Every time" asks again whatever the time away.
    await hidePage(browser);
    await showPage(browser, 1_000);
    await expect(heading).toBeVisible();
    await unlockWith(screen, PIN);
    await expect(heading).toHaveCount(0);
  } finally {
    await resetLock(browser);
  }
});

test('[29-04] fifteen minutes in the background: back after two does not ask, after sixteen it does', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await acknowledge(['alex']);
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  try {
    await turnOn(app, screen, browser, 'app');
    // Longer than the default minute: a weakening change, confirmed with the PIN first.
    await chooseRelock(screen, 'After 15 minutes in the background', { confirmWith: PIN });
    await app.open('/todo');
    await hidePage(browser);
    await showPage(browser, 2 * 60_000);
    await expect(screen.getByRole('heading', 'UniHub is locked')).toHaveCount(0);
    await hidePage(browser);
    await showPage(browser, 16 * 60_000);
    await expect(screen.getByRole('heading', 'UniHub is locked')).toBeVisible();
    await unlockWith(screen, PIN);
    await expect(screen.getByRole('heading', 'UniHub is locked')).toHaveCount(0);
  } finally {
    await resetLock(browser);
  }
});

test('"Forgot PIN? Sign out" ends the server session and removes the PIN and the offline copy', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await acknowledge(['alex']);
  // A session of its own, so signing it out leaves the shared one for the other tests.
  const own = await signIn('alex', { fresh: true, userAgent: 'UniHub e2e forgot-pin browser' });
  await browser.setCookies(own.cookie.split('; ').map((pair) => {
    const at = pair.indexOf('=');
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stack.url };
  }));
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  await turnOn(app, screen, browser, 'app');
  await chooseRelock(screen, 'Every time UniHub opens');
  await browser.reload();
  await expect(screen.getByRole('heading', 'UniHub is locked')).toBeVisible();
  await screen.getByRole('button', 'Forgot PIN? Sign out').tap();
  const dialog = screen.getByRole('alertdialog', 'Sign out of this device?');
  await expect(dialog).toContainText('Recordings not uploaded yet stay here.');
  await dialog.getByRole('button', 'Sign out', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/auth/);
  expect((await own('GET', '/api/auth/me')).status, 'the server session ended').toBe(401);
  expect(await pinRecords(browser), 'no PIN is kept').toBe(0);
  expect((await pageApi(browser, 'GET', '/api/auth/me')).status, 'the page is signed out').toBe(401);
});
