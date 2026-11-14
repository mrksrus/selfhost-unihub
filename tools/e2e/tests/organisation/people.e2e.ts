import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId, signInPassword } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { dialogPassword, newEmail, passwordSignIn, personByEmail, sweep } from './organisation-helpers.ts';

// 30-01, Server › People: the owner adds a person who gets in with a setup
// link (the default) or with an initial password. The person arrives in a
// browser of their own; alex, a member, cannot add anyone.

test('[30-01] the owner adds a person with a setup link; their own browser opens it, chooses a password and is signed in; the link works once', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  const email = newEmail('link');
  const name = `Casey ${runId()}`;
  try {
    await app.open('/admin/users');
    await screen.getByRole('button', 'Add person', { exact: true }).tap();
    const add = screen.getByRole('dialog', 'Add person');
    await add.getByLabel('Email', { exact: true }).fill(email);
    await add.getByLabel('Name', { exact: true }).fill(name);
    await add.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await add.getByRole('button', 'Add person', { exact: true }).tap();
    const shown = screen.getByRole('dialog', `Setup link for ${name}`);
    const link = new URL(await shown.getByRole('textbox', 'Setup link').inputValue());
    expect(link.pathname).toBe('/invite');
    await shown.getByRole('button', 'Done', { exact: true }).tap();

    // The account exists at once, without a password: listed as invited, and it cannot sign in.
    await expect(screen.getByRole('list', 'People')).toContainText(name);
    expect((await personByEmail(email)).status).toBe('invited');
    expect(await passwordSignIn(email), 'no password yet, no sign-in').toBeGreaterThanOrEqual(400);

    // The person's own browser: nothing stored, nobody signed in.
    await app.clearState();
    await app.open(`${link.pathname}${link.hash}`);
    await expect(screen.getByRole('heading', 'Set up your UniHub account')).toBeVisible();
    await expect(screen.getByText(email, { exact: true })).toBeVisible();
    await screen.getByLabel('Password', { exact: true }).fill(signInPassword);
    await screen.getByLabel('Password again', { exact: true }).fill(signInPassword);
    await screen.getByRole('button', 'Set password and sign in').tap();
    await expect(browser).toHaveURL(/\/(mail|dashboard)/);
    expect(ok(await pageApi<{ user: { email: string; role: string } }>(browser, 'GET', '/api/auth/me'), 'the new person').user).toMatchObject({ email, role: 'user' });
    expect((await personByEmail(email)).status).toBe('active');

    // Used once: the same link in another fresh browser is refused.
    await app.clearState();
    await app.open(`${link.pathname}${link.hash}`);
    await expect(screen.getByRole('heading', 'This setup link does not work')).toBeVisible();
  } finally {
    await sweep();
  }
});

test('[30-01] a person added with an initial password signs in with it; a member cannot add people', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  const email = newEmail('password');
  const name = `Robin ${runId()}`;
  try {
    await app.open('/admin/users');
    await screen.getByRole('button', 'Add person', { exact: true }).tap();
    const add = screen.getByRole('dialog', 'Add person');
    await add.getByLabel('Email', { exact: true }).fill(email);
    await add.getByLabel('Name', { exact: true }).fill(name);
    // The row is the tap target; the radio itself is drawn, not shown.
    await add.getByText('Initial password', { exact: true }).tap();
    await expect(add.getByRole('radio', /^Initial password/)).toBeChecked();
    await add.getByLabel('Their password', { exact: true }).fill(signInPassword);
    await add.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await add.getByRole('button', 'Add person', { exact: true }).tap();
    await expect(screen.getByText(`${name} added`, { exact: true }).first()).toBeVisible();
    // No link to hand over: the password is the way in.
    await expect(screen.getByRole('dialog', /^Setup link/)).toHaveCount(0);
    expect((await personByEmail(email)).status).toBe('active');

    for (const member of ['alex', 'blair'] as const) {
      const refused = await (await signIn(member))('POST', '/api/admin/users', { email: newEmail('refused'), role: 'user', current_password: signInPassword });
      expect(refused.status, `${member} is no administrator`).toBe(403);
    }

    await app.clearState();
    await app.open('/auth');
    await screen.getByLabel('Email').fill(email);
    await screen.getByLabel('Password').fill(signInPassword);
    await screen.getByRole('button', 'Sign in').tap();
    await expect(browser).toHaveURL(/\/(mail|dashboard)/);
  } finally {
    await sweep();
  }
});
