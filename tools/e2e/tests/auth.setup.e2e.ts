import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stack } from './support/env.ts';
import { signIn } from './support/api.ts';

// One signed-in session per synthetic user (tools/e2e/support/seed.mjs); other tests
// start with { session: 'admin' }, 'alex' or 'blair'. The browser takes over the
// helper's server session (support/api.ts), so a run does not use up the account's
// sign-in attempts (10 per 10 minutes, successful ones included). The sign-in form
// itself is covered by tests/settings/follow-account.e2e.ts.
for (const name of ['admin', 'alex', 'blair'] as const) {
  test.setup(`sign in as ${name}`, { sessions: [name] }, async ({ app, session, browser }) => {
    const api = await signIn(name);
    await browser.setCookies(api.cookie.split('; ').map((pair) => {
      const at = pair.indexOf('=');
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stack.url };
    }));
    await app.open('/');
    await expect(browser).toHaveURL(/\/(mail|dashboard)/);
    await session.save(name);
  });
}
