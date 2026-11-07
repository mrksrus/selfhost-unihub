import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { people, signInPassword, stack } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createProviderMailbox } from '../support/mail.ts';

// 0.28 policies (C, E; F13) with three people: the admin sets a rule with
// their password, alex sees the greyed control with its reason and the
// server refuses the action, blair cannot change rules, and the admin acts
// for alex through Users with an activity-log entry.

// The handle fills the dialogs; API bodies need the value itself (synthetic).
const password = credentials.user('admin').password;
const REASON = 'Your administrator does not allow deleting items from the bin for good.';

// A changed rule leaves the notice due for everyone (D38), and its dialog
// covers the page: each person confirms it here, except where a test is
// about that notice.
async function acknowledge(revision: number, names: readonly string[] = ['admin', 'alex', 'blair']) {
  for (const name of names) ok(await (await signIn(name))('POST', '/api/policies/acknowledge', { revision }), `${name} confirms the rules`);
}

async function setPolicy(values: Record<string, unknown>) {
  const admin = await signIn('admin');
  const saved = ok(await admin<{ revision: number }>('PUT', '/api/admin/policies', { values, current_password: signInPassword }), 'set policy');
  await acknowledge(saved.revision);
}

test('[28-11 28-13] a rule set by the admin greys alex\'s control with its reason, and the server refuses; blair cannot set rules', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/admin/policies');
  try {
    await screen.getByRole('combobox', 'Deleting from the bin for good').tap();
    await screen.getByRole('option', 'Not allowed').tap();
    await expect(screen.getByRole('region', 'Unsaved changes')).toContainText('1 rule changed');
    await screen.getByRole('button', 'Save changes…').tap();
    const dialog = screen.getByRole('dialog', 'Save the changed rules?');
    await dialog.getByLabel('Your password', { exact: true }).fill(password);
    await dialog.getByRole('button', 'Save changes', { exact: true }).tap();
    await expect(screen.getByText('Policies saved', { exact: true })).toBeVisible();

    const alex = await signIn('alex');
    const effective = ok(await alex<{ policies: Record<string, { allowed: boolean; reason: string | null }> }>('GET', '/api/policies/effective'), 'alex rules');
    expect(effective.policies['bin.delete'].allowed).toBe(false);
    expect(effective.policies['bin.delete'].reason).toBe(REASON);
    const refused = await alex<{ code?: string; policy?: string }>('POST', '/api/bin/empty', {});
    expect(refused.status, 'POLICY_FORBIDS').toBe(403);
    expect(refused.data.code).toBe('POLICY_FORBIDS');

    const blair = await signIn('blair');
    expect((await blair('PUT', '/api/admin/policies', { values: { 'bin.delete': 'allowed' }, current_password: 'local-dev-admin-password' })).status, 'a non-admin cannot set rules').toBe(403);

    const log = ok(await (await signIn('admin'))<{ entries: { action: string; details: Record<string, unknown> | null }[] }>('GET', '/api/admin/audit'), 'audit');
    expect(log.entries.some((entry) => entry.action === 'admin.policy_changed' && entry.details?.key === 'bin.delete'), 'recorded').toBe(true);
  } finally {
    await setPolicy({ 'bin.delete': 'allowed' });
  }
});

test('[28-11] alex sees Empty bin and Delete for good greyed out with the reason while the rule is set', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await setPolicy({ 'bin.delete': 'forbidden' });
  try {
    await app.open('/settings?section=bin');
    await expect(screen.getByRole('button', 'Empty bin')).toBeDisabled();
    await expect(screen.getByText(REASON, { exact: true }).first()).toBeVisible();
    await app.open('/settings?section=delete');
    // data.clear follows bin.delete: Delete all is greyed too, with its own reason.
    await expect(screen.getByRole('button', 'Delete all').first()).toBeDisabled();
  } finally {
    await setPolicy({ 'bin.delete': 'allowed' });
  }
  await app.open('/settings?section=bin');
  await expect(screen.getByRole('button', 'Empty bin')).toBeVisible();
  await expect(screen.getByText(REASON, { exact: true })).toHaveCount(0);
});

test('[28-12] the admin adds a mail account for alex with their password; alex has it, blair does not', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const admin = await signIn('admin');
  const { users } = ok(await admin<{ users: { id: string; email: string }[] }>('GET', '/api/admin/users'), 'users');
  const alexId = users.find((user) => user.email === people.alex.email)!.id;
  const address = `alex.admin.${Date.now().toString(36)}@mail.test`;
  await createProviderMailbox(address);
  await app.open(`/admin/users/${alexId}`);
  await screen.getByRole('button', 'Add mail account').tap();
  const dialog = screen.getByRole('dialog', 'Add a mail account');
  await dialog.getByLabel('Email address').fill(address);
  await dialog.getByLabel('Mail password').fill(stack.providerPassword);
  await dialog.getByLabel('IMAP server').fill(stack.providerHost);
  await dialog.getByLabel('IMAP port').fill(String(stack.imapsPort));
  await dialog.getByLabel('SMTP server').fill(stack.providerHost);
  await dialog.getByLabel('SMTP port').fill(String(stack.smtpsPort));
  // The row is the tap target; its input is drawn by the row (RadioRow).
  await dialog.getByText('Sync', { exact: true }).tap();
  await expect(dialog.getByRole('radio', /^Sync/)).toBeChecked();
  await dialog.getByLabel('Your password', { exact: true }).fill(password);
  await dialog.getByRole('button', 'Add account').tap();
  await expect(screen.getByText('Mail account added', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByText(address, { exact: false }).first()).toBeVisible();

  const alex = await signIn('alex');
  const alexAccounts = ok(await alex<{ accounts: { id: string; email_address: string }[] }>('GET', '/api/mail/accounts'), 'alex accounts').accounts;
  const added = alexAccounts.find((account) => account.email_address === address);
  expect(added, 'alex has the account').toBeTruthy();
  const blair = await signIn('blair');
  expect(ok(await blair<{ accounts: { email_address: string }[] }>('GET', '/api/mail/accounts'), 'blair accounts').accounts.some((account) => account.email_address === address), 'blair does not').toBe(false);

  // Removing it with its mail asks for the password too, and the log records both.
  await screen.getByRole('button', `Actions for ${address}`).tap();
  await screen.getByRole('menuitem', 'Remove with its mail').tap();
  const confirm = screen.getByRole('dialog', `Remove ${address} with its mail?`);
  await expect(confirm.getByRole('button', 'Remove with its mail', { exact: true })).toBeDisabled();
  await confirm.getByLabel('Your password', { exact: true }).fill(password);
  await confirm.getByRole('button', 'Remove with its mail', { exact: true }).tap();
  await expect(screen.getByText('Mail account removed with its mail', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(ok(await alex<{ accounts: { email_address: string }[] }>('GET', '/api/mail/accounts'), 'alex accounts').accounts.some((account) => account.email_address === address)).toBe(false);
  const log = ok(await admin<{ entries: { action: string }[] }>('GET', '/api/admin/audit'), 'audit');
  for (const action of ['admin.mail_account_added', 'admin.mail_account_reset']) expect(log.entries.some((entry) => entry.action === action), action).toBe(true);
});
