// The reference screens of docs/UI_ACCEPTANCE.md "Baselines and approval":
// Mail with a message open (Wide), ToDo (Wide and Phone), Recordings library
// (Phone), Settings -> Appearance (Wide) and the composer (Phone), each in Dark
// Default and Light Default. Twelve pictures; see docs/UI_BASELINES.md.
import { expect, expectBaseline, test, THEMES, VIEWPORTS } from '../support/test.ts';

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

      test(`settings appearance (wide, ${theme})`, async ({ page, open }) => {
        await open('/settings?section=appearance');
        await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible();
        await expectBaseline(page, `settings-appearance-wide-${theme}.png`);
      });
    });

    test.describe('phone', () => {
      test.use(VIEWPORTS.phone);

      test(`todo (phone, ${theme})`, async ({ page, open }) => {
        await open('/todo');
        await expectBaseline(page, `todo-phone-${theme}.png`);
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
    });
  });
}
