import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, createGroup, dialogPassword, passwordSignIn, personByEmail, setManager, sweep } from './organisation-helpers.ts';

// 30-08: deactivating a person signs them out and stops sign-in; activating
// brings back what they had: their data, their group and their manager
// role. The person is the test's own, so no seeded session ends; their
// contact stands for the data (a seeded person's mail and events are held by
// the same account row, which deactivation does not touch).

test('[30-08] a deactivated person cannot sign in and keeps their data, group and manager role; activating brings them back', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const person = await addPerson('leaving');
    const group = await createGroup('Kept', [person.id]);
    await setManager(group.id, person.id);
    const before = await signIn(person.email, { fresh: true });
    const contact = ok(await before<{ contact: { id: string } }>('POST', '/api/contacts', { name: { given: 'Kept', family: 'Contact' }, emails: ['kept.contact@example.com'] }), 'a contact of theirs').contact;

    await app.open(`/admin/users/${person.id}`);
    await screen.getByRole('button', 'Deactivate', { exact: true }).tap();
    const dialog = screen.getByRole('dialog', `Deactivate ${person.email}?`);
    await dialog.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await dialog.getByRole('button', 'Deactivate', { exact: true }).tap();
    await expect(screen.getByText(`${person.name} deactivated`, { exact: true }).first()).toBeVisible();

    expect((await before('GET', '/api/auth/me')).status, 'signed out everywhere').toBe(401);
    expect(await passwordSignIn(person.email), 'no sign-in while inactive').toBeGreaterThanOrEqual(400);
    const inactive = await personByEmail(person.email);
    expect(inactive.status).toBe('inactive');
    expect(inactive.groups, 'the group and the manager role stay').toMatchObject([{ id: group.id, role: 'manager' }]);

    await screen.getByRole('button', 'Activate', { exact: true }).tap();
    await expect(screen.getByText(`${person.name} activated`, { exact: true }).first()).toBeVisible();
    const after = await signIn(person.email, { fresh: true });
    expect((await after('GET', `/api/contacts/${contact.id}`)).status, 'their contact is still theirs').toBe(200);
    expect(ok(await after<{ groups: { id: string; role: string }[] }>('GET', '/api/groups'), 'their groups').groups).toMatchObject([{ id: group.id, role: 'manager' }]);
  } finally {
    await sweep();
  }
});
