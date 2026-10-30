import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixtures, runId } from '../support/env.ts';
import { createContact, getContact } from '../support/contacts.ts';
import { onlyOn } from '../support/ui.ts';

type Page = { evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>; locator: (css: string) => { setInputFiles: (files: string[]) => Promise<void> } };

/** The loaded picture of an <img> (0 while it is missing or broken). */
const loadedWidth = (browser: unknown, selector: string) => (browser as Page).evaluate((css: string) => {
  const image = document.querySelector(css) as HTMLImageElement | null;
  return image && image.complete ? image.naturalWidth : 0;
}, selector);

// D6 and slice 4: a picture chosen in the editor is converted by the server
// and shown in the detail and the list; Remove takes it away again. A write
// to the photo raises the contact's version, so an editor open elsewhere sees it.
test('[D6] a contact photo is set from the editor, shown in the detail and the list, and removed', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const id = runId();
  const created = await createContact(browser, { name: { given: `Photo${id}`, family: 'Synthetic' }, emails: [`photo-${id}@example.com`] });
  await app.open(`/contacts?contact=${created.id}`);
  await screen.getByRole('button', 'Edit', { exact: true }).tap();
  const dialog = screen.getByRole('dialog');
  await expect(dialog.getByRole('button', 'Choose photo')).toBeVisible();
  await (browser as Page).locator('[role=dialog] input[type=file][accept="image/*"]').setInputFiles([fixtures.jpg.path]);
  await dialog.getByRole('button', 'Save', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden({ timeout: 60_000 });

  const withPhoto = await getContact(browser, created.id);
  expect(withPhoto.photo, 'the contact has a photo').not.toBeNull();
  expect(withPhoto.version, 'the field save and the photo each raise the version').toBe(created.version + 2);
  const detailImage = `article img[src*="/contacts/${created.id}/photo?size=full"]`;
  await expect.poll(() => loadedWidth(browser, detailImage), { timeout: 30_000 }).toBeGreaterThan(0);
  // The server stores a square JPEG of at most 512 pixels.
  const full = await (browser as Page).evaluate(async (path: string) => {
    const response = await fetch(path, { credentials: 'include' });
    return { status: response.status, type: response.headers.get('content-type'), etag: response.headers.get('etag') };
  }, `/api/contacts/${created.id}/photo?size=full`);
  expect(full).toMatchObject({ status: 200, type: 'image/jpeg' });

  // The list shows the thumbnail (the detail hides the list on phones).
  await app.open(`/contacts`);
  await screen.getByRole('searchbox', 'Search contacts').fill(`Photo${id}`);
  const thumb = `img[src*="/contacts/${created.id}/photo?size=thumb"]`;
  await expect.poll(() => loadedWidth(browser, thumb), { timeout: 30_000 }).toBeGreaterThan(0);

  await app.open(`/contacts?contact=${created.id}`);
  await screen.getByRole('button', 'Edit', { exact: true }).tap();
  await screen.getByRole('dialog').getByRole('button', 'Remove', { exact: true }).tap();
  await screen.getByRole('dialog').getByRole('button', 'Save', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => (await getContact(browser, created.id)).photo).toBeNull();
  const gone = await (browser as Page).evaluate(async (path: string) => (await fetch(path, { credentials: 'include' })).status, `/api/contacts/${created.id}/photo?size=thumb`);
  expect(gone).toBe(404);
});

// A picture the server cannot read is refused in place, and the contact's
// other changes are saved.
test('[D6] an unreadable picture is refused inline and the contact is still saved', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const id = runId();
  const created = await createContact(browser, { name: { given: `Badphoto${id}` } });
  await app.open(`/contacts?contact=${created.id}`);
  await screen.getByRole('button', 'Edit', { exact: true }).tap();
  const dialog = screen.getByRole('dialog');
  await dialog.getByLabel('Last name', { exact: true }).fill('Saved anyway');
  await (browser as Page).locator('[role=dialog] input[type=file][accept="image/*"]').setInputFiles([fixtures.pdf.path]);
  await dialog.getByRole('button', 'Save', { exact: true }).tap();
  await expect(dialog.getByRole('alert')).toContainText(/picture|photo/i, { timeout: 60_000 });
  const stored = await getContact(browser, created.id);
  expect(stored.name.family).toBe('Saved anyway');
  expect(stored.photo).toBeNull();
  // The editor now holds the saved contact: saving again is not a version conflict.
  await dialog.getByRole('button', 'Save', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden();
});
