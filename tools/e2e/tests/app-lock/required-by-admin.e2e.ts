import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge, clearLockRecords, resetLock, setPinInDialog, setPolicy } from './app-lock-helpers.ts';

// 0.29 required lock (rows 29-07 and 29-08, F13 with three people): the
// admin requires the lock for Mail with at most 5 minutes; alex and blair see
// the prompt after the rules notice and their Mail requests are refused until
// their device locks; the admin's own browser is prompted too.

const REQUIRED = 'Your administrator requires the app lock for Mail.';
const MAX = 'Your administrator allows at most 5 minutes in the background before UniHub locks again.';

const require = () => setPolicy({ 'app_lock.required': ['mail'], 'app_lock.max_background': '300' });
const release = () => setPolicy({ 'app_lock.required': [], 'app_lock.max_background': 'none' });

test('[29-08] alex is prompted after the notice, Mail is refused until the device locks, blair is refused too, and the longer time is greyed', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  const target = await onlyOn(browser, 'desktop', 'phone', 'android-app');
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  await require();
  try {
    await app.open('/mail');
    const prompt = screen.getByRole('heading', 'Your administrator requires the app lock');
    await expect(prompt).toBeVisible();
    await expect(screen.getByText(REQUIRED, { exact: true })).toBeVisible();
    await expect(screen.getByText('Mail; UniHub locks after 5 minutes in the background at most.', { exact: true })).toBeVisible();
    if (target === 'android-app') {
      await expect(screen.getByText('Update the UniHub app to unlock with your fingerprint. Until then, use a UniHub PIN.', { exact: true })).toBeVisible();
    }
    const refused = await pageApi<{ code?: string; details?: { required?: string[] } }>(browser, 'GET', '/api/mail/accounts');
    expect(refused.status, 'APP_LOCK_REQUIRED before the device locks').toBe(403);
    expect(refused.data.code).toBe('APP_LOCK_REQUIRED');
    expect(refused.data.details?.required).toEqual(['mail']);
    // Contacts and the set-up routes still work.
    expect((await pageApi(browser, 'GET', '/api/contacts?limit=1')).status).toBe(200);
    expect((await pageApi(browser, 'GET', '/api/devices/current')).status).toBe(200);
    const blair = await signIn('blair');
    expect((await blair('GET', '/api/mail/accounts')).status, 'blair\'s device is refused too').toBe(403);

    await screen.getByRole('button', 'Turn on the app lock').tap();
    await setPinInDialog(screen);
    await expect(prompt).toHaveCount(0);
    await expect(screen.getByRole('navigation', 'Mail folders').or(screen.getByRole('button', 'All accounts')).first()).toBeVisible();
    await expect.poll(async () => (await pageApi(browser, 'GET', '/api/mail/accounts')).status, { timeout: 20_000 }).toBe(200);

    await app.open('/settings?section=app-lock');
    await expect(screen.getByText(REQUIRED, { exact: true })).toBeVisible();
    await expect(screen.getByText(MAX, { exact: true })).toBeVisible();
    const mail = screen.getByRole('list', 'Locked modules').getByRole('checkbox', /^Mail/);
    await expect(mail).toBeChecked();
    await expect(mail).toBeDisabled();
    await expect(screen.getByRole('radio', 'Off', { exact: true })).toBeDisabled();
    await screen.getByRole('combobox', 'Ask again').tap();
    await expect(screen.getByRole('option', 'After 15 minutes in the background')).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.getByRole('option', 'After 5 minutes in the background')).not.toHaveAttribute('aria-disabled', 'true');
    await browser.keyboard.press('Escape');
    const weaker = await pageApi<{ code?: string }>(browser, 'PUT', '/api/settings/values/device', { values: { app_lock_relock_after: '900' } });
    expect(weaker.status, 'the server refuses a longer time').toBe(403);
    expect(weaker.data.code).toBe('POLICY_FLOOR');
  } finally {
    await release();
    await resetLock(browser);
  }
});

test('[29-08] the administrator\'s own browser is prompted as well', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  await require();
  try {
    await app.open('/mail');
    await expect(screen.getByRole('heading', 'Your administrator requires the app lock')).toBeVisible();
    expect((await pageApi(browser, 'GET', '/api/mail/accounts')).status, 'no admin bypass on own data').toBe(403);
    // Sign out is the other way out of the prompt.
    await expect(screen.getByRole('button', 'Sign out', { exact: true })).toBeVisible();
  } finally {
    await release();
    await resetLock(browser);
    await clearLockRecords(browser);
    await acknowledge();
  }
});
