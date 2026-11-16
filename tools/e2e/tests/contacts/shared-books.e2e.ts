import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, signIn, type ApiCall } from '../support/api.ts';
import { chooseFile, contactFixture, createContact, runDigits } from '../support/contacts.ts';
import { isNarrow, onlyOn } from '../support/ui.ts';
import { createGroup, seededId, sweep } from '../organisation/organisation-helpers.ts';

// Shared address books, three people: blair makes a book and shares it with a
// group; alex, in the group, edits it; a book shared for reading is read
// only; leaving the group takes the book away. Who may do what is the
// server's rule, proven in api/tests (address-books-mysql-integration); here
// is what each person sees.

interface Book { id: string; name: string; permission: string }
const booksOf = async (api: ApiCall) => ok(await api<{ books: Book[] }>('GET', '/api/address-books'), 'books').books;
const namesIn = async (api: ApiCall, bookId: string) =>
  ok(await api<{ contacts: { display_name: string }[] }>('GET', `/api/address-books/${bookId}/contacts`), 'book contacts').contacts.map((contact) => contact.display_name);

test('[31-02] blair makes a shared book, shares it with a group for editing, and fills it by hand, by copying and from a file', { session: 'blair', timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const run = runId();
    const group = await createGroup('Books', [await seededId('alex'), await seededId('blair')]);
    const name = `e2e Suppliers ${run}`;
    await app.open('/contacts');
    const own = await createContact(browser, { name: { given: `Copied${run}`, family: 'Personal' }, emails: [{ value: `copied-${run}@example.com`, label: 'work' }] });

    // On narrow screens the panel is a sheet, opened from the page's scope.
    if (await isNarrow(browser)) await screen.getByRole('button', 'All contacts', { exact: true, visible: true }).first().tap();
    await screen.getByRole('button', 'New book', { exact: true, visible: true }).first().tap();
    const create = screen.getByRole('dialog', 'New book');
    await create.getByLabel('Name', { exact: true }).fill(name);
    await create.getByRole('button', 'Create book', { exact: true }).tap();
    await expect(screen.getByRole('heading', name)).toBeVisible();

    await screen.getByRole('button', 'Share', { exact: true }).tap();
    const share = screen.getByRole('dialog', `Share ${name}`);
    await share.getByRole('combobox', 'What they may do').tap();
    await screen.getByRole('option', 'Can edit', { exact: true }).tap();
    await share.getByLabel('Add people or groups', { exact: true }).fill(group.name);
    await share.getByRole('button', `Share with ${group.name}`).tap();
    await expect(share.getByRole('combobox', `What ${group.name} may do`)).toContainText('Can edit');
    await share.getByRole('button', 'Done', { exact: true }).tap();
    const alex = await signIn('alex');
    const book = (await booksOf(alex)).find((entry) => entry.name === name);
    expect(book?.permission, 'alex may edit it through the group').toBe('edit');

    // By hand.
    await screen.getByRole('button', 'New contact', { exact: true, visible: true }).first().tap();
    const editor = screen.getByRole('dialog', `New contact in ${name}`);
    await editor.getByLabel('First name', { exact: true }).fill(`Typed${run}`);
    await editor.getByLabel('Last name', { exact: true }).fill('Shared');
    await editor.getByLabel('Email', { exact: true }).fill(`typed-${run}@example.com`);
    await editor.getByRole('button', 'Add contact').tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    await expect(screen.getByRole('button', new RegExp(`^Typed${run} Shared`))).toBeVisible();

    // A copy of one of blair's own contacts.
    await app.open(`/contacts?contact=${own.id}`);
    await screen.getByRole('button', `More actions for Copied${run} Personal`).tap();
    await screen.getByRole('menuitem', `Copy to ${name}`).tap();
    await expect(screen.getByText(`1 contact copied to ${name}`, { exact: true }).first()).toBeVisible();

    // From a file, with the import's review.
    await app.open(`/contacts?book=${book!.id}`);
    await screen.getByRole('button', `More actions for ${name}`).tap();
    await screen.getByRole('menuitem', 'Import from a file…').tap();
    const dialog = screen.getByRole('dialog', `Import into ${name}`);
    await chooseFile(browser, contactFixture('vcard40.vcf', run, runDigits()));
    await expect(dialog.getByRole('button', 'Import 2 contacts', { exact: true })).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', 'Import 2 contacts', { exact: true }).tap();
    await expect(dialog.getByText('Added', { exact: true })).toBeVisible({ timeout: 120_000 });
    await dialog.getByRole('button', 'Done', { exact: true }).tap();

    const names = await namesIn(alex, book!.id);
    for (const expected of [`Typed${run} Shared`, `Copied${run} Personal`]) expect(names, 'what alex finds in the book').toContain(expected);
    expect(names.filter((entry) => entry.includes(`Fourpoint ${run}`)), 'both cards of the file').toHaveLength(2);
  } finally {
    await sweep();
  }
});

test('[31-03 31-06] alex edits a book shared with their group and restores from its bin, only reads another, and loses the first on leaving the group', { session: 'alex', timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const run = runId();
    const alexId = await seededId('alex');
    const group = await createGroup('Team', [alexId, await seededId('blair')]);
    const blair = await signIn('blair');
    const make = async (label: string, principal: Record<string, string>, permission: 'read' | 'edit') => {
      const { book } = ok(await blair<{ book: Book }>('POST', '/api/address-books', { name: `e2e ${label} ${run}` }), `create ${label}`);
      ok(await blair('PUT', `/api/address-books/${book.id}/shares`, { principal, permission }), `share ${label}`);
      ok(await blair('POST', `/api/address-books/${book.id}/contacts`, { name: { given: `${label}${run}`, family: 'Entry' }, emails: [{ value: `${label.toLowerCase()}-${run}@example.com`, label: 'work' }] }), `a contact in ${label}`);
      return book;
    };
    const team = await make('Team', { kind: 'group', id: group.id }, 'edit');
    const readers = await make('Readers', { kind: 'user', id: alexId }, 'read');

    await app.open('/contacts');
    if (await isNarrow(browser)) await screen.getByRole('button', 'All contacts', { exact: true, visible: true }).first().tap();
    await screen.getByRole('button', new RegExp(`^${team.name}`), { visible: true }).first().tap();
    await screen.getByRole('button', new RegExp(`^Team${run} Entry`)).tap();
    await screen.getByRole('article', `Team${run} Entry`).getByRole('button', 'Edit', { exact: true }).tap();
    const editor = screen.getByRole('dialog', 'Edit contact');
    await editor.getByLabel('Last name', { exact: true }).fill('Edited');
    await editor.getByRole('button', 'Save', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    expect(await namesIn(blair, team.id), 'blair sees the edit').toContain(`Team${run} Edited`);

    // Deleted from the book: it waits in the book's own bin, where an editor restores it.
    await screen.getByRole('button', `More actions for Team${run} Edited`).tap();
    await screen.getByRole('menuitem', 'Delete contact').tap();
    await screen.getByRole('alertdialog').getByRole('button', 'Delete', { exact: true }).tap();
    await expect(screen.getByText('Moved to the bin', { exact: true }).first()).toBeVisible();
    await screen.getByRole('radio', /^Deleted/).tap();
    await screen.getByRole('list', 'Deleted items').getByRole('button', `Restore Team${run} Edited`).tap();
    await expect(screen.getByText('Restored', { exact: true }).first()).toBeVisible();
    expect(await namesIn(blair, team.id), 'back in the book').toContain(`Team${run} Edited`);

    // A book shared for reading says so and offers no change.
    await app.open(`/contacts?book=${readers.id}`);
    await expect(screen.getByText(/^You can read this book\./).first()).toBeVisible();
    await expect(screen.getByRole('button', 'New contact', { exact: true })).toHaveCount(0);
    await screen.getByRole('button', new RegExp(`^Readers${run} Entry`)).tap();
    const detail = screen.getByRole('article', `Readers${run} Entry`);
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('button', 'Edit', { exact: true })).toHaveCount(0);

    // Out of the group, the group's book is gone at the next load.
    ok(await (await signIn('admin'))('DELETE', `/api/groups/${group.id}/members/${alexId}`), 'alex leaves the group');
    await app.open(`/contacts?book=${team.id}`);
    await expect(screen.getByText('No such book', { exact: true })).toBeVisible();
  } finally {
    await sweep();
  }
});
