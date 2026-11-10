import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge } from './app-lock-helpers.ts';

// 0.29 devices (F5): another signed-in browser of alex appears
// under Settings → Security → Devices; Sign out ends its session at once;
// blair sees only their own devices.

interface Device { id: string; current: boolean; user_agent: string | null }

test('a second browser of alex is listed, can be signed out, and is never blair\'s', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await acknowledge(['alex']);
  const second = await signIn('alex', { fresh: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0 e2e-second' });
  await app.open('/settings?section=security');
  await expect(screen.getByRole('heading', 'Devices', { exact: true })).toBeVisible();
  await expect(screen.getByText('This device', { exact: true })).toBeVisible();
  const row = screen.getByText('Firefox on Linux', { exact: true }).first();
  await expect(row).toBeVisible();

  const mine = ok(await pageApi<{ devices: Device[] }>(browser, 'GET', '/api/devices'), 'alex devices').devices;
  expect(mine.filter((device) => device.current).length, 'this device is marked once').toBe(1);
  const blair = await signIn('blair');
  const theirs = ok(await blair<{ devices: Device[] }>('GET', '/api/devices'), 'blair devices').devices;
  expect(theirs.some((device) => mine.some((own) => own.id === device.id)), 'no device of alex is blair\'s').toBe(false);
  const other = mine.find((device) => !device.current && device.user_agent?.includes('e2e-second'));
  expect(other, 'the second browser is a device of alex').toBeTruthy();
  expect((await blair('DELETE', `/api/devices/${other!.id}`)).status, 'blair cannot sign it out').toBe(404);

  await screen.getByRole('button', 'Sign out Firefox on Linux').first().tap();
  const dialog = screen.getByRole('alertdialog', /^Sign out Firefox on Linux\?/);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', 'Sign out', { exact: true }).tap();
  await expect(screen.getByText('Device signed out', { exact: true })).toBeVisible();
  await expect.poll(async () => (await second('GET', '/api/auth/me')).status, { timeout: 20_000 }).toBe(401);
  await expect.poll(async () => ok(await pageApi<{ devices: Device[] }>(browser, 'GET', '/api/devices'), 'alex devices').devices.some((device) => device.id === other!.id), { timeout: 20_000 }).toBe(false);
  // This device has no Sign out of its own; the account menu signs it out.
  await expect(screen.getByRole('button', /^Sign out .*/).filter({ hasText: 'This device' })).toHaveCount(0);
});
