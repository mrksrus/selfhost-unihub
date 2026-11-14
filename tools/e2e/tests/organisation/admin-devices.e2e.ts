import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { signInPassword } from '../support/env.ts';
import { signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, dialogPassword, passwordSignIn, sweep } from './organisation-helpers.ts';

// 30-07: on a person's page the owner signs out one of their devices, then
// all of them. Each device is refused at its next request, nothing is
// deleted, and the person signs in again with their password. The person is
// the test's own, so no seeded session ends. (The Android app's side is
// tools/e2e/android/admin-signout.test.mjs.)

const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('[30-07] the owner signs out one device of a person, then all; each is refused at once, and a member cannot do it', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const person = await addPerson('devices');
    const laptop = await signIn(person.email, { userAgent: firefox, fresh: true });
    const desk = await signIn(person.email, { userAgent: chrome, fresh: true });

    for (const member of ['alex', 'blair'] as const) {
      const api = await signIn(member);
      expect((await api('GET', `/api/admin/users/${person.id}/devices`)).status, `${member} sees nobody's devices`).toBe(403);
      expect((await api('DELETE', `/api/admin/users/${person.id}/devices`, { current_password: signInPassword })).status, `${member} signs nobody out`).toBe(403);
    }
    expect((await laptop('GET', '/api/auth/me')).status).toBe(200);

    await app.open(`/admin/users/${person.id}`);
    await screen.getByRole('button', 'Sign out Firefox on Linux').tap();
    const one = screen.getByRole('dialog', 'Sign out Firefox on Linux?');
    // Not without the owner's own password.
    await expect(one.getByRole('button', 'Sign out', { exact: true })).toBeDisabled();
    await one.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await one.getByRole('button', 'Sign out', { exact: true }).tap();
    await expect(screen.getByText('Device signed out', { exact: true }).first()).toBeVisible();
    await expect(screen.getByRole('button', 'Sign out Firefox on Linux')).toHaveCount(0);
    expect((await laptop('GET', '/api/auth/me')).status, 'that device is refused').toBe(401);
    expect((await desk('GET', '/api/auth/me')).status, 'the other one stays').toBe(200);

    await screen.getByRole('button', 'Sign out all', { exact: true }).tap();
    const all = screen.getByRole('dialog', `Sign out every device of ${person.name}?`);
    await all.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await all.getByRole('button', 'Sign out all', { exact: true }).tap();
    await expect(screen.getByText(`${person.name} is not signed in anywhere.`, { exact: true })).toBeVisible();
    expect((await desk('GET', '/api/auth/me')).status, 'every device is refused').toBe(401);
    // Signed out, not locked out.
    expect(await passwordSignIn(person.email), 'the password still lets them in').toBe(200);
  } finally {
    await sweep();
  }
});
