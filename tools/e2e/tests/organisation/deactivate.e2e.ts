import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { signInPassword } from '../support/env.ts';
import { addPerson, createGroup, dialogPassword, passwordSignIn, personByEmail, setManager, sweep } from './organisation-helpers.ts';

// 30-08: deactivating a person signs them out and stops sign-in; activating
// brings back what they had: their data, their group and their manager
// role. The dialog names the shared address books they manage (31-07),
// which stay. The person is the test's own, so no seeded session ends; their
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
    const book = ok(await before<{ book: { id: string; name: string } }>('POST', '/api/address-books', { name: `${group.name} book` }), 'a shared book of theirs').book;

    await app.open(`/admin/users/${person.id}`);
    await screen.getByRole('button', 'Deactivate', { exact: true }).tap();
    const dialog = screen.getByRole('dialog', `Deactivate ${person.email}?`);
    await expect(dialog.getByText(book.name, { exact: true })).toBeVisible();
    await expect(dialog.getByText('They stay; administrators keep managing them.', { exact: true })).toBeVisible();
    await dialog.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await dialog.getByRole('button', 'Deactivate', { exact: true }).tap();
    await expect(screen.getByText(`${person.name} deactivated`, { exact: true }).first()).toBeVisible();

    expect((await before('GET', '/api/auth/me')).status, 'signed out everywhere').toBe(401);
    expect(await passwordSignIn(person.email), 'no sign-in while inactive').toBeGreaterThanOrEqual(400);
    const inactive = await personByEmail(person.email);
    expect(inactive.status).toBe('inactive');
    expect(inactive.groups, 'the group and the manager role stay').toMatchObject([{ id: group.id, role: 'manager' }]);
    const kept = ok(await (await signIn('admin'))<{ books: { id: string; deleted_at: string | null }[] }>('GET', '/api/admin/address-books'), 'every book').books.find((entry) => entry.id === book.id);
    expect(kept?.deleted_at, 'their book stays with the organisation').toBeNull();

    await screen.getByRole('button', 'Activate', { exact: true }).tap();
    await expect(screen.getByText(`${person.name} activated`, { exact: true }).first()).toBeVisible();
    const after = await signIn(person.email, { fresh: true });
    expect((await after('GET', `/api/contacts/${contact.id}`)).status, 'their contact is still theirs').toBe(200);
    expect(ok(await after<{ groups: { id: string; role: string }[] }>('GET', '/api/groups'), 'their groups').groups).toMatchObject([{ id: group.id, role: 'manager' }]);
  } finally {
    await sweep();
  }
});

// Another administrator's account is the owner's to change: an administrator
// who is not the owner is refused deactivating, deleting or resetting one
// (the page greys those out; src/test/organisation-people.test.tsx), may
// still sign their devices out, and the owner may deactivate them.
test('an administrator who is not the owner cannot deactivate, delete or reset another administrator; the owner can', { session: 'admin', timeout: 300_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  await sweep();
  try {
    const first = await addPerson('admin-one', { role: 'admin' });
    const second = await addPerson('admin-two', { role: 'admin' });
    const one = await signIn(first.email, { fresh: true });
    const two = await signIn(second.email, { fresh: true });
    const body = { current_password: signInPassword };
    for (const [what, method, path, extra] of [
      ['deactivate', 'PUT', `/api/admin/users/${second.id}/activate`, { is_active: false }],
      ['delete', 'DELETE', `/api/admin/users/${second.id}`, {}],
      ['password', 'PUT', `/api/admin/users/${second.id}/password`, { new_password: 'administrator-chosen-password' }],
    ] as const) {
      const refused = await one<{ code?: string }>(method, path, { ...body, ...extra });
      expect([refused.status, refused.data.code], what).toEqual([403, 'ADMINS_OWNER_ONLY']);
    }
    expect((await two('GET', '/api/auth/me')).status, 'the other administrator is untouched').toBe(200);
    ok(await one('DELETE', `/api/admin/users/${second.id}/devices`, body), 'signing their devices out stays open');
    expect((await two('GET', '/api/auth/me')).status, 'signed out').toBe(401);
    ok(await (await signIn('admin'))('PUT', `/api/admin/users/${second.id}/activate`, { ...body, is_active: false }), 'the owner deactivates them');
    expect((await personByEmail(second.email)).status).toBe('inactive');
  } finally {
    await sweep();
  }
});
