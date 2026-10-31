// The reference screens of docs/UI_ACCEPTANCE.md "Baselines and approval":
// Mail with a message open (Wide), ToDo (Wide and Phone), Recordings library
// (Phone), Settings -> Appearance (Wide), the composer (Phone), since 0.26.0
// the contact detail, the contact editor and the merge review (Wide and
// Phone), and since 0.27.0 a ToDo row picked up by its handle, the new-task
// dialog with its list chooser open (Wide and Phone) and Settings -> Pages
// (Wide), each in Dark Default and Light Default. Thirty-four pictures; see
// docs/UI_BASELINES.md.
import { expect, expectBaseline, test, THEMES, VIEWPORTS, type Page } from '../support/test.ts';

// A row picked up with the keyboard (P-29, D29/D31): Space on the ≡ handle
// lifts the row with everything it holds; the picture shows that state.
async function pickUpRow(page: Page, title: string) {
  const handle = page.getByRole('button', { name: `Reorder ${title}` });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: `Picked up ${title}` })).toHaveCount(1);
}

// The new-task dialog with its chooser open: the lists grouped by account,
// the server calendar greyed out for a task without a date.
async function openNewTaskChooser(page: Page) {
  await page.getByRole('button', { name: 'New task', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'List' }).click();
  await expect(page.getByRole('option', { name: /Team/ })).toBeVisible();
}

for (const theme of THEMES) {
  test.describe(`${theme} default`, () => {
    test.use({ theme, colorScheme: theme });

    test.describe('wide', () => {
      test.use(VIEWPORTS.wide);

      test(`mail reader (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/mail');
        await page.getByRole('button', { name: /^Grace Hopper/ }).click();
        await expect(page.getByRole('heading', { name: /Quarterly planning notes/ })).toBeVisible();
        await settle();
        await expectBaseline(page, `mail-reader-wide-${theme}.png`);
      });

      test(`todo (wide, ${theme})`, async ({ page, open }) => {
        await open('/todo');
        await expectBaseline(page, `todo-wide-${theme}.png`);
      });

      test(`todo row picked up (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await pickUpRow(page, 'Confirm the documentation review dates');
        await settle();
        await expectBaseline(page, `todo-drag-wide-${theme}.png`);
      });

      test(`new task with the list chooser (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await openNewTaskChooser(page);
        await settle();
        await expectBaseline(page, `new-task-wide-${theme}.png`);
      });

      test(`settings pages (wide, ${theme})`, async ({ page, open }) => {
        await open('/settings?section=pages');
        await expect(page.getByRole('button', { name: 'Reorder Mail' })).toBeVisible();
        await expectBaseline(page, `settings-pages-wide-${theme}.png`);
      });

      test(`settings appearance (wide, ${theme})`, async ({ page, open }) => {
        await open('/settings?section=appearance');
        await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible();
        await expectBaseline(page, `settings-appearance-wide-${theme}.png`);
      });

      test(`contact detail (wide, ${theme})`, async ({ page, open }) => {
        await open('/contacts?contact=c-1');
        await expect(page.getByRole('article', { name: 'Grace Brewster Hopper' })).toBeVisible();
        await expectBaseline(page, `contact-detail-wide-${theme}.png`);
      });

      test(`contact editor (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?contact=c-1');
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
        await settle();
        await expectBaseline(page, `contact-editor-wide-${theme}.png`);
      });

      test(`merge review (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?view=duplicates');
        await page.getByRole('region', { name: /Group of 2, high confidence/ }).first().getByRole('button', { name: 'Review and merge' }).click();
        await expect(page.getByRole('dialog', { name: 'Merge 2 contacts into one' })).toBeVisible();
        await settle();
        await expectBaseline(page, `merge-review-wide-${theme}.png`);
      });
    });

    test.describe('phone', () => {
      test.use(VIEWPORTS.phone);

      test(`todo (phone, ${theme})`, async ({ page, open }) => {
        await open('/todo');
        await expectBaseline(page, `todo-phone-${theme}.png`);
      });

      test(`todo row picked up (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await pickUpRow(page, 'Confirm the documentation review dates');
        await settle();
        await expectBaseline(page, `todo-drag-phone-${theme}.png`);
      });

      test(`new task with the list chooser (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await openNewTaskChooser(page);
        await settle();
        await expectBaseline(page, `new-task-phone-${theme}.png`);
      });

      test(`recordings (phone, ${theme})`, async ({ page, open }) => {
        await open('/recordings');
        await expect(page.getByText('Song sketch in G')).toBeVisible();
        await expectBaseline(page, `recordings-phone-${theme}.png`);
      });

      test(`composer (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/mail');
        await page.getByRole('button', { name: 'Compose', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await settle();
        await expectBaseline(page, `composer-phone-${theme}.png`);
      });

      test(`contact detail (phone, ${theme})`, async ({ page, open }) => {
        await open('/contacts?contact=c-1');
        await expect(page.getByRole('article', { name: 'Grace Brewster Hopper' })).toBeVisible();
        await expectBaseline(page, `contact-detail-phone-${theme}.png`);
      });

      test(`contact editor (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?contact=c-1');
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
        await settle();
        await expectBaseline(page, `contact-editor-phone-${theme}.png`);
      });

      test(`merge review (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?view=duplicates');
        await page.getByRole('region', { name: /Group of 2, high confidence/ }).first().getByRole('button', { name: 'Review and merge' }).click();
        await expect(page.getByRole('dialog', { name: 'Merge 2 contacts into one' })).toBeVisible();
        await settle();
        await expectBaseline(page, `merge-review-phone-${theme}.png`);
      });
    });
  });
}
