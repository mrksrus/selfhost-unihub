import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { pageApi } from '../support/api.ts';
import { isNarrow, onlyOn } from '../support/ui.ts';
import { acknowledge, chooseRelock, PIN, resetLock, turnOn } from './app-lock-helpers.ts';

// 0.29 module lock (row 29-03): Mail locked, Calendar open. Mail's page shows
// the lock under its own header, Today's Unread mail and Settings → Mail show
// the locked row, the search leaves Mail out with one row to unlock it, and
// one unlock opens everything locked until the next relock.

test('[29-03] Mail locked, Calendar open: the page, Today, the search and Settings → Mail ask; one unlock opens them all', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await acknowledge(['alex']);
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  try {
    await turnOn(app, screen, browser, ['Mail']);
    await expect(screen.getByText('Contacts synced to the phone stay in its Contacts app.', { exact: true })).toBeVisible();
    await chooseRelock(screen, 'Every time UniHub opens');
    await browser.reload();

    await app.open('/mail');
    await expect(screen.getByRole('heading', 'Mail is locked')).toBeVisible();
    await expect(screen.getByRole('heading', 'Mail', { exact: true })).toBeVisible();
    await expect(screen.getByRole('navigation', 'Main').first()).toBeVisible();
    // No mail is asked for while the module is locked.
    await expect(screen.getByRole('navigation', 'Mail folders')).toHaveCount(0);
    expect((await pageApi(browser, 'GET', '/api/mail/accounts')).status, 'the server still answers the device: the lock is the page\'s').toBe(200);

    await app.open('/calendar');
    await expect(screen.getByRole('heading', /is locked/)).toHaveCount(0);

    await app.open('/dashboard');
    await expect(screen.getByText('Mail is locked', { exact: true })).toBeVisible();
    await expect(screen.getByRole('button', 'Unlock', { exact: true })).toBeVisible();

    if (await isNarrow(browser)) await screen.getByRole('button', 'Search', { exact: true }).first().tap();
    else await browser.keyboard.press('Control+K');
    await screen.getByPlaceholder('Search or go to…').fill('al');
    await expect(screen.getByText('Mail is locked: unlock to search it', { exact: true })).toBeVisible();
    await expect(screen.getByText('New email', { exact: true })).toHaveCount(0);
    await browser.keyboard.press('Escape');

    await app.open('/settings?section=mail');
    await expect(screen.getByRole('heading', 'Mail is locked')).toBeVisible();
    await screen.getByLabel('PIN', { exact: true }).fill(PIN);
    await screen.getByRole('button', 'Unlock', { exact: true }).tap();
    await expect(screen.getByRole('heading', 'Mail is locked')).toHaveCount(0);
    // Settings → Mail itself, which the lock stood in for.
    await expect(screen.getByRole('heading', 'Writing', { exact: true })).toBeVisible();
    // The one unlock opened Mail's page too, in this tab: a new load asks
    // again, since this lock asks every time UniHub opens.
    await screen.getByRole('navigation', 'Main').first().getByRole('link', /^Mail\b/).tap();
    await expect(screen.getByRole('heading', 'Mail is locked')).toHaveCount(0);
    await expect(screen.getByRole('navigation', 'Mail folders').or(screen.getByRole('button', 'All accounts')).first()).toBeVisible();
  } finally {
    await resetLock(browser);
  }
});
