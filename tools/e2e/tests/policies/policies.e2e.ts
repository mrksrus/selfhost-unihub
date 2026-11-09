import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { people, signInPassword, stack } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createProviderMailbox } from '../support/mail.ts';

// 0.28 policies (C, E; F13) with three people: the admin sets a rule with
// their password, alex sees the greyed control with its reason and the
// server refuses the action, blair cannot change rules, and the admin acts
// for alex through Users with an activity-log entry. The 2026-11-07
// decisions: the bin's minimum, backups kept a minimum age (backup.server_retention_days),
// the notices of the rules and the password on self-deletion.

// The handle fills the dialogs; API bodies made from Node need the value itself (synthetic).
const password = credentials.user('admin').password;
const apiPassword = signInPassword;
const REASON = 'Your administrator does not allow deleting items from the bin for good.';
const PEOPLE = ['admin', 'alex', 'blair'] as const;

interface Effective { policies: Record<string, { allowed: boolean; reason: string | null; value: unknown }>; revision: number; acknowledged_revision: number; rules: string[] }

// A changed rule leaves the notice due for everyone, and its dialog
// covers the page: each person confirms it here, except where a test is
// about that notice. Without a revision, the current one is confirmed where
// it is still due.
async function acknowledge(names: readonly (typeof PEOPLE)[number][] = PEOPLE, revision?: number) {
  for (const name of names) {
    const api = await signIn(name);
    const due = revision ?? await (async () => { const effective = ok(await api<Effective>('GET', '/api/policies/effective'), `${name} rules`); return effective.acknowledged_revision < effective.revision ? effective.revision : null; })();
    if (due !== null) ok(await api('POST', '/api/policies/acknowledge', { revision: due }), `${name} confirms the rules`);
  }
}

/** Sets rules as the admin; everyone has seen them afterwards unless `unseen` names who has not. */
async function setPolicy(values: Record<string, unknown>, { binMinimum, unseen = [] as readonly (typeof PEOPLE)[number][] } = {}) {
  const admin = await signIn('admin');
  const saved = ok(await admin<{ revision: number }>('PUT', '/api/admin/policies', { values, ...(binMinimum ? { bin_min_retention: binMinimum } : {}), current_password: apiPassword }), 'set policy');
  await acknowledge(PEOPLE.filter((name) => !unseen.includes(name)), saved.revision);
}

test('[28-11 28-13] a rule set by the admin greys alex\'s control with its reason, and the server refuses; blair cannot set rules', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  // Start from the default, whatever an earlier run left.
  await setPolicy({ 'bin.delete': 'allowed' });
  await app.open('/admin/policies');
  try {
    await screen.getByRole('combobox', 'Users may empty the bin or delete for good').tap();
    await screen.getByRole('option', 'Not allowed').tap();
    await expect(screen.getByRole('region', 'Unsaved changes')).toContainText('1 rule changed');
    await screen.getByRole('button', 'Save changes…').tap();
    const dialog = screen.getByRole('dialog', 'Save the changed rules?');
    await dialog.getByLabel('Your password', { exact: true }).fill(password);
    await dialog.getByRole('button', 'Save changes', { exact: true }).tap();
    await expect(screen.getByText('Policies saved', { exact: true })).toBeVisible();
    // The admin set the rules: no notice nags them about their own change.
    await expect.poll(async () => {
      const rules = ok(await pageApi<Effective>(browser, 'GET', '/api/policies/effective'), 'admin rules');
      return rules.acknowledged_revision === rules.revision;
    }, { timeout: 20_000 }).toBe(true);
    await expect(screen.getByRole('dialog', 'Your administrator changed the data rules')).toHaveCount(0);

    const alex = await signIn('alex');
    const effective = ok(await alex<Effective>('GET', '/api/policies/effective'), 'alex rules');
    expect(effective.policies['bin.delete'].allowed).toBe(false);
    expect(effective.policies['bin.delete'].reason).toBe(REASON);
    expect(effective.rules, 'the rule is told in plain words').toContain(REASON);
    const refused = await alex<{ code?: string; policy?: string }>('POST', '/api/bin/empty', {});
    expect(refused.status, 'POLICY_FORBIDS').toBe(403);
    expect(refused.data.code).toBe('POLICY_FORBIDS');

    const blair = await signIn('blair');
    expect((await blair('PUT', '/api/admin/policies', { values: { 'bin.delete': 'allowed' }, current_password: apiPassword })).status, 'a non-admin cannot set rules').toBe(403);

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

test('[28-11] the admin\'s minimum greys alex\'s shorter retention choices with the reason, and the server refuses a shorter value', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await setPolicy({ 'bin.delete': 'forbidden' }, { binMinimum: '90' });
  try {
    await app.open('/settings?section=bin');
    await expect(screen.getByText('Your administrator keeps deleted items at least 90 days.', { exact: true })).toBeVisible();
    const choice = screen.getByRole('combobox', 'Keep deleted items for');
    await expect(choice).toContainText('90 days');
    await choice.tap();
    await expect(screen.getByRole('option', '7 days')).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.getByRole('option', '30 days')).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.getByRole('option', 'Until I delete them')).not.toHaveAttribute('aria-disabled', 'true');
    await browser.keyboard.press('Escape');
    const shorter = await pageApi<{ code?: string }>(browser, 'PUT', '/api/settings/values', { values: { bin_retention: '7' } });
    expect(shorter.status, 'below the floor').toBe(403);
    expect(shorter.data.code).toBe('POLICY_FLOOR');
    // The rule and its minimum are both told in plain words.
    const effective = ok(await pageApi<Effective>(browser, 'GET', '/api/policies/effective'), 'alex rules');
    expect(effective.rules.some((rule) => /at least 90 days/.test(rule)), 'the minimum is a rule people read').toBe(true);
  } finally {
    await setPolicy({ 'bin.delete': 'allowed' }, { binMinimum: 'forever' });
  }
});

test('[28-11] a backup younger than the admin\'s minimum cannot be deleted by alex: Delete is greyed with the date, the server refuses', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  interface Job { id: string; status: string; scope: string; requested_sections: string[] }
  await app.open('/settings?section=backup');
  const started = ok(await pageApi<{ job: Job }>(browser, 'POST', '/api/backup/jobs', { sections: ['contacts'] }), 'create').job;
  await expect.poll(async () => ok(await pageApi<{ job: Job }>(browser, 'GET', `/api/backup/jobs/${started.id}`), 'read').job.status, { timeout: 180_000 }).toBe('ready');
  await setPolicy({ 'backup.server_retention_days': 30 });
  try {
    await browser.reload();
    await expect(screen.getByText(/keeps each backup at least 30 days/)).toBeVisible();
    await screen.getByRole('button', 'More actions for Contacts backup').first().tap();
    const remove = screen.getByRole('menuitem', /^Delete/);
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(remove).toContainText(/at least 30 days/);
    await expect(remove).toContainText(/can be deleted from/);
    await browser.keyboard.press('Escape');
    const refused = await pageApi<{ code?: string }>(browser, 'DELETE', `/api/backup/jobs/${started.id}`);
    expect(refused.status, 'the server keeps it').toBe(403);
    expect(refused.data.code).toBe('POLICY_FORBIDS');
    // The administrator's path can delete it earlier, with their password.
    const admin = await signIn('admin');
    const me = ok(await pageApi<{ user: { id: string } }>(browser, 'GET', '/api/auth/me'), 'me').user;
    ok(await admin('DELETE', `/api/admin/users/${me.id}/backups/${started.id}`, { current_password: apiPassword }), 'admin deletes');
  } finally {
    await setPolicy({ 'backup.server_retention_days': null });
  }
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
  // Every dialog of this path names the person it acts for.
  await expect(dialog.getByTestId('confirm-target')).toContainText(people.alex.email);
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

  // Removing it with its mail asks for the password too, names alex, and the log records both.
  await screen.getByRole('button', `Actions for ${address}`).tap();
  await screen.getByRole('menuitem', 'Remove with its mail').tap();
  const confirm = screen.getByRole('dialog', `Remove ${address} with its mail?`);
  await expect(confirm.getByTestId('confirm-target')).toContainText(people.alex.email);
  await expect(confirm.getByRole('button', 'Remove with its mail', { exact: true })).toBeDisabled();
  await confirm.getByLabel('Your password', { exact: true }).fill(password);
  await confirm.getByRole('button', 'Remove with its mail', { exact: true }).tap();
  await expect(screen.getByText('Mail account removed with its mail', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(ok(await alex<{ accounts: { email_address: string }[] }>('GET', '/api/mail/accounts'), 'alex accounts').accounts.some((account) => account.email_address === address)).toBe(false);
  const log = ok(await admin<{ entries: { action: string }[] }>('GET', '/api/admin/audit'), 'audit');
  for (const action of ['admin.mail_account_added', 'admin.mail_account_reset']) expect(log.entries.some((entry) => entry.action === action), action).toBe(true);
});

test('[28-14] a changed rule opens the notice for alex once; OK records it; Settings › Profile keeps the rules', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await setPolicy({ 'bin.delete': 'forbidden' }, { unseen: ['alex'] });
  try {
    await app.open('/');
    const dialog = screen.getByRole('dialog', 'Your administrator changed the data rules');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('list', 'Rules in force')).toContainText(REASON);
    await dialog.getByRole('button', 'OK').tap();
    await expect(dialog).toHaveCount(0);
    const effective = ok(await pageApi<Effective>(browser, 'GET', '/api/policies/effective'), 'alex rules');
    expect(effective.acknowledged_revision, 'OK recorded the revision').toBe(effective.revision);
    // The next start opens nothing.
    await browser.reload();
    await expect(screen.getByRole('navigation', 'Main').first()).toBeVisible();
    await expect(screen.getByRole('dialog', 'Your administrator changed the data rules')).toHaveCount(0);
    // The rules stay readable.
    await app.open('/settings?section=account');
    await expect(screen.getByRole('heading', 'Rules on this server')).toBeVisible();
    await expect(screen.getByRole('list', 'Rules in force')).toContainText(REASON);
  } finally {
    await setPolicy({ 'bin.delete': 'allowed' });
  }
});

test('[28-14] the sign-up form lists the rules that limit a new person', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const admin = await signIn('admin');
  const before = ok(await admin<{ signup_mode: string }>('GET', '/api/admin/settings/signup-mode'), 'signup mode').signup_mode;
  ok(await admin('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' }), 'open sign-up');
  await setPolicy({ 'bin.delete': 'forbidden' });
  try {
    const pub = ok(await admin<{ data_rules: string[] }>('GET', '/api/auth/signup-mode'), 'public rules');
    expect(pub.data_rules).toContain(REASON);
    // A new browser with nobody signed in.
    await app.clearState();
    await app.open('/auth');
    await screen.getByRole('tab', 'Create account').tap();
    await expect(screen.getByRole('heading', 'Rules on this server')).toBeVisible();
    await expect(screen.getByText(REASON, { exact: true })).toBeVisible();
  } finally {
    await setPolicy({ 'bin.delete': 'allowed' });
    ok(await admin('PUT', '/api/admin/settings/signup-mode', { signup_mode: before }), 'restore sign-up');
  }
});

test('[28-15] deleting your own account asks for your password, and a wrong one deletes nothing', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  // A rule changed by an earlier run must not leave its notice over this page.
  await acknowledge(['alex']);
  await app.open('/settings?section=delete');
  await screen.getByRole('button', 'Delete account').tap();
  const dialog = screen.getByRole('dialog', 'Delete your account?');
  const confirm = dialog.getByRole('button', 'Delete account');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Your password', { exact: true }).fill('not-alex-password-e2e');
  await confirm.tap();
  await expect(screen.getByText('That is not your password', { exact: true })).toBeVisible();
  // The dialog stays for another try (the field is emptied; a secure field cannot be read here, the rendered test checks it); alex is still signed in and still here.
  await expect(dialog).toBeVisible();
  await browser.keyboard.press('Escape');
  expect((await pageApi(browser, 'GET', '/api/auth/me')).status, 'still signed in').toBe(200);
  const bare = await pageApi<{ code?: string }>(browser, 'DELETE', '/api/settings/account', {});
  expect(bare.status, 'no password, no deletion').toBe(400);
  expect(bare.data.code).toBe('PASSWORD_REQUIRED');
});
