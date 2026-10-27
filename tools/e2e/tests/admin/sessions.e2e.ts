import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

// A second device, recognisable in the list as "Firefox on Linux".
const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

// 0-19 / 23-11: Settings → Security lists the signed-in devices; signing out another
// device there ends that device's session at once (its next request is refused), while
// this device stays signed in.
test('[0-19 23-11] signing out another device from Signed-in devices ends its session', { session: 'blair', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  // Earlier runs that stopped half-way may have left such a device; this one is the only one.
  const own = await signIn('blair');
  const { sessions } = ok(await own<{ sessions: { id: string; userAgent: string | null }[] }>('GET', '/api/auth/sessions'), 'list sessions');
  for (const session of sessions.filter((s) => s.userAgent === firefox)) await own('DELETE', `/api/auth/sessions/${session.id}`);
  const other = await signIn('blair', { userAgent: firefox, fresh: true });
  expect((await other('GET', '/api/auth/me')).status).toBe(200);

  await app.open('/settings?section=security');
  await expect(screen.getByText('Signed-in devices', { exact: true })).toBeVisible();
  await screen.getByRole('button', 'Sign out Firefox on Linux').tap();
  await expect(screen.getByText('Device signed out', { exact: true }).first()).toBeVisible();
  await expect(screen.getByRole('button', 'Sign out Firefox on Linux')).toHaveCount(0);

  expect((await other('GET', '/api/auth/me')).status, 'the signed-out device is refused').toBe(401);
  await app.open('/settings?section=security');
  await expect(screen.getByText('Signed-in devices', { exact: true })).toBeVisible();
  expect(new URL(await browser.url()).pathname, 'this device is still signed in').not.toBe('/auth');
});
