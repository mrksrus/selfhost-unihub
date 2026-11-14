import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, signInPassword } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createGroup, seededId, setManager, sweep, type GroupRow } from './organisation-helpers.ts';

// 30-03, three people: the owner makes alex the manager of one group. alex
// adds and removes its members from Settings › Your groups and reaches
// nothing else: not the other group, not its rules, not the Server pages.
// blair, a member, manages nothing.

test('[30-03] alex manages the members of their group, and neither another group, its rules nor the Server pages; blair cannot manage', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const [alexId, blairId, adminId] = [await seededId('alex'), await seededId('blair'), await seededId('admin')];
    const managed = await createGroup('Managed', [alexId]);
    const other = await createGroup('Other', [blairId]);
    await setManager(managed.id, alexId);
    const alex = await signIn('alex');
    const blair = await signIn('blair');

    await app.open('/groups');
    const mine = screen.getByRole('list', 'Your groups');
    await expect(mine.getByRole('link', new RegExp(`^${other.name}`))).toHaveCount(0);
    await mine.getByRole('link', new RegExp(`^${managed.name}`)).tap();

    await screen.getByRole('button', 'Add people', { exact: true }).tap();
    const add = screen.getByRole('dialog', `Add people to ${managed.name}`);
    await add.getByLabel('Name or email', { exact: true }).fill(people.blair.email);
    await add.getByRole('checkbox', new RegExp(`^${people.blair.name}`)).check();
    await add.getByRole('button', 'Add', { exact: true }).tap();
    await expect(add).toBeHidden();
    await expect(screen.getByRole('button', `Remove ${people.blair.name}`)).toBeVisible();
    const groupsOf = async (api: typeof blair) => ok(await api<{ groups: GroupRow[] }>('GET', '/api/groups'), 'groups').groups.map((group) => group.id);
    expect(await groupsOf(blair), 'blair is a member now').toContain(managed.id);

    // A member manages nothing: blair is refused, here and for the rules.
    expect((await blair('POST', `/api/groups/${managed.id}/members`, { user_ids: [adminId] })).status, 'a member adds nobody').toBe(403);
    // A manager changes members, not rules, and names no manager.
    expect((await alex('PUT', `/api/admin/groups/${managed.id}/policies`, { values: { 'bin.delete': 'forbidden' }, current_password: signInPassword })).status, 'no rules for a manager').toBe(403);
    expect((await alex('PUT', `/api/admin/groups/${managed.id}/managers/${blairId}`, { manager: true })).status, 'no managers named by a manager').toBe(403);
    await expect(screen.getByRole('switch', `${people.blair.name}: manager`)).toHaveCount(0);
    await expect(screen.getByRole('button', 'Delete group')).toHaveCount(0);

    await screen.getByRole('button', `Remove ${people.blair.name}`).tap();
    await screen.getByRole('alertdialog', `Remove ${people.blair.name} from ${managed.name}?`).getByRole('button', 'Remove', { exact: true }).tap();
    await expect(screen.getByRole('button', `Remove ${people.blair.name}`)).toHaveCount(0);
    expect(await groupsOf(blair), 'blair is out again').not.toContain(managed.id);

    // The other group is out of alex's sight: the page and the server say the same as for one that does not exist.
    await app.open(`/groups/${other.id}`);
    await expect(screen.getByText('No such group', { exact: true })).toBeVisible();
    expect((await alex('POST', `/api/groups/${other.id}/members`, { user_ids: [alexId] })).status, 'not their group').toBe(404);

    // No Server pages for a manager.
    await app.open('/admin/users');
    await expect(screen.getByText('Only administrators can see this page.', { exact: true })).toBeVisible();
    expect((await alex('GET', '/api/admin/users')).status).toBe(403);
    expect((await alex('GET', '/api/admin/groups')).status).toBe(403);
  } finally {
    await sweep();
  }
});
