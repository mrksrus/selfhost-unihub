import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';

// One signed-in session per synthetic user; other tests start with { session: 'admin' }.
for (const name of ['admin', 'alex'] as const) {
  test.setup(`sign in as ${name}`, { sessions: [name] }, async ({ app, screen, session, browser }) => {
    const user = credentials.user(name);
    await app.open('/auth');
    await screen.getByLabel('Email').fill(user.username);
    await screen.getByLabel('Password').fill(user.password);
    await screen.getByRole('button', 'Sign in').click();
    await expect(browser).toHaveURL(/\/(mail|dashboard)/);
    await session.save(name);
  });
}
