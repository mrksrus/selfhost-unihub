import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { listPeople, newGroupName, sweep, type GroupRow } from './organisation-helpers.ts';

// 30-02, Server › Groups: the owner makes two groups and adds people to
// them. alex is in both, blair in one, and Everyone lists every active
// person without being a group anyone is put in.

test('[30-02] the owner creates groups and adds alex and blair; alex is in two groups, and Everyone lists all', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  const support = newGroupName('Support');
  const finance = newGroupName('Finance');
  try {
    for (const [group, members] of [[support, ['alex', 'blair']], [finance, ['alex']]] as const) {
      await app.open('/admin/groups');
      await screen.getByRole('button', 'New group', { exact: true }).first().tap();
      const create = screen.getByRole('dialog', 'New group');
      await create.getByLabel('Name', { exact: true }).fill(group);
      await create.getByRole('button', 'Create group', { exact: true }).tap();
      // The new group opens, empty, ready for its people.
      await expect(browser).toHaveURL(/\/admin\/groups\/[^/]+$/);
      await screen.getByRole('button', 'Add people', { exact: true }).tap();
      const add = screen.getByRole('dialog', `Add people to ${group}`);
      for (const member of members) {
        await add.getByLabel('Name or email', { exact: true }).fill(people[member].email);
        // A ticked person stays ticked while the search changes.
        await add.getByRole('checkbox', people[member].name).check();
      }
      await add.getByRole('button', members.length > 1 ? `Add ${members.length} people` : 'Add', { exact: true }).tap();
      await expect(add).toBeHidden();
      for (const member of members) await expect(screen.getByText(people[member].name, { exact: true, visible: true }).first()).toBeVisible();
    }

    await app.open('/admin/groups');
    const list = screen.getByRole('list', 'Groups');
    const active = (await listPeople()).filter((person) => person.is_active).length;
    await expect(list.getByRole('link', /^Everyone/)).toContainText(`${active} people`);
    await expect(list.getByRole('link', new RegExp(`^${support}`))).toContainText('2 members');
    await expect(list.getByRole('link', new RegExp(`^${finance}`))).toContainText('1 member');

    // People, narrowed to one group: its members and nobody else.
    await app.open('/admin/users');
    await screen.getByRole('radio', new RegExp(`^${finance}`)).tap();
    const shown = screen.getByRole('list', 'People');
    await expect(shown).toContainText(people.alex.email);
    await expect(shown.getByText(people.blair.email, { exact: true })).toHaveCount(0);

    const mine = async (name: 'alex' | 'blair') => ok(await (await signIn(name))<{ groups: GroupRow[] }>('GET', '/api/groups'), `${name} groups`).groups.map((group) => group.name).sort();
    expect(await mine('alex'), 'alex is in both').toEqual([finance, support].sort());
    expect(await mine('blair'), 'blair is in one').toEqual([support]);
  } finally {
    await sweep();
  }
});
