import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { restartApi, runId, signInPassword, stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

// 30-09: the sign-in limit survives a restart of the API (0.30 keeps it in
// the database). Ten wrong passwords use up a person's budget; after the API
// restarts, even the right password is refused on the sign-in page until the
// window ends. The person is the test's own (the `e2e-org-` prefix of the
// organisation tests), so no seeded account is locked out.

const attempt = async (email: string, password: string) => {
  const response = await fetch(`${stack.url}/api/auth/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'UniHub e2e helper' }, body: JSON.stringify({ email, password }),
  });
  return response.status;
};

test('[30-09] ten wrong passwords lock a person out, and an API restart does not let them in', { timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const admin = await signIn('admin');
  const email = `e2e-org-limit-${runId()}@example.com`;
  const { user } = ok(await admin<{ user: { id: string } }>('POST', '/api/admin/users', {
    email, full_name: 'Limit Example', role: 'user', password: signInPassword, current_password: signInPassword,
  }), 'add a person');
  try {
    for (let i = 0; i < 10; i++) expect(await attempt(email, 'not-the-password'), `wrong password ${i + 1}`).toBe(401);
    expect(await attempt(email, 'not-the-password'), 'the eleventh guess').toBe(429);

    restartApi();

    expect(await attempt(email, signInPassword), 'the right password, after the restart').toBe(429);
    await app.open('/auth');
    await screen.getByLabel('Email').fill(email);
    await screen.getByLabel('Password').fill(signInPassword);
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByText(/Too many attempts/).first()).toBeVisible();
    await expect(browser).toHaveURL(/\/auth/);
  } finally {
    ok(await (await signIn('admin'))('DELETE', `/api/admin/users/${user.id}`, { current_password: signInPassword }), 'remove the person');
  }
});
