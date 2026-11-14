import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createGroup, dialogPassword, effectiveOf, seededId, setRules, sweep } from './organisation-helpers.ts';

// 30-04, three people: a group makes a rule stricter for its members only.
// The owner sets it on the group's Rules view; alex, a member, gets the
// notice and the greyed control with the server's reason; blair, in no such
// group, keeps the control and is not told about a change that is not theirs.

const NOTICE = 'Your administrator changed the data rules';

/** Everyone may empty the bin; a new group with alex in it then forbids it, with the notice still due for `unseen`. */
async function strictGroup(unseen: readonly ('alex' | 'blair')[]) {
  await sweep();
  await setRules({ 'bin.delete': 'allowed' });
  const group = await createGroup('Strict', [await seededId('alex')]);
  await setRules({ 'bin.delete': 'forbidden' }, { groupId: group.id, unseen });
  return group;
}

test('[30-04] the owner sets a stricter rule on a group\'s Rules view; it holds for its members only, and alex in two groups gets the strictest', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  await setRules({ 'bin.delete': 'allowed' });
  try {
    const alexId = await seededId('alex');
    const everyone = (await effectiveOf('blair')).policies['auth.password_min_length'].value;
    const strict = await createGroup('Strict', [alexId]);
    const stricter = await createGroup('Stricter', [alexId]);
    await setRules({ 'auth.password_min_length': 14 }, { groupId: strict.id });
    await setRules({ 'auth.password_min_length': 16 }, { groupId: stricter.id });

    await app.open(`/admin/groups/${strict.id}?view=rules`);
    await screen.getByRole('combobox', 'Users may empty the bin or delete for good').tap();
    await screen.getByRole('option', 'Not allowed', { exact: true }).tap();
    await screen.getByRole('button', 'Save changes…').tap();
    const dialog = screen.getByRole('dialog', `Save the changed rules of ${strict.name}?`);
    await dialog.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await dialog.getByRole('button', 'Save changes', { exact: true }).tap();
    await expect(screen.getByText('Policies saved', { exact: true })).toBeVisible();

    const alex = await effectiveOf('alex');
    expect(alex.policies['bin.delete'].allowed, 'the group\'s rule reaches its member').toBe(false);
    expect(alex.policies['auth.password_min_length'].value, 'the strictest of alex\'s groups').toBe(16);
    const refused = await (await signIn('alex'))<{ code?: string }>('POST', '/api/bin/empty', {});
    expect(refused.status, 'the server refuses, not only the page').toBe(403);
    expect(refused.data.code).toBe('POLICY_FORBIDS');
    const blair = await effectiveOf('blair');
    expect(blair.policies['bin.delete'].allowed, 'not a member, not bound').toBe(true);
    expect(blair.policies['auth.password_min_length'].value).toBe(everyone);

    await app.open('/admin/groups');
    await expect(screen.getByRole('list', 'Groups').getByRole('link', new RegExp(`^${strict.name}`))).toContainText('own rules');
  } finally {
    await sweep();
  }
});

test('[30-04] alex, a member, is told about the group\'s rule and sees the control greyed with its reason', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  try {
    await strictGroup(['alex']);
    await app.open('/settings?section=bin');
    const notice = screen.getByRole('dialog', NOTICE);
    await expect(notice).toBeVisible();
    await notice.getByRole('button', 'OK', { exact: true }).tap();
    await expect(notice).toBeHidden();
    await expect(screen.getByRole('button', 'Empty bin')).toBeDisabled();
    const reason = (await effectiveOf('alex')).policies['bin.delete'].reason;
    await expect(screen.getByText(reason ?? 'the server gave no reason', { exact: true }).first()).toBeVisible();
  } finally {
    await sweep();
  }
});

test('[30-04] blair, in no such group, keeps the control and gets no notice of a change that is not theirs', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  try {
    // Nobody confirms anything for blair here: a notice that were due would show.
    await strictGroup(['alex', 'blair']);
    const reason = (await effectiveOf('alex')).policies['bin.delete'].reason;
    await app.open('/settings?section=bin');
    await expect(screen.getByRole('button', 'Empty bin')).toBeVisible();
    await expect(screen.getByText(reason ?? 'the server gave no reason', { exact: true })).toHaveCount(0);
    await expect(screen.getByRole('dialog', NOTICE)).toHaveCount(0);
  } finally {
    await sweep();
  }
});
