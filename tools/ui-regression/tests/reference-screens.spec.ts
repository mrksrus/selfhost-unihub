// The reference screens of docs/UI_ACCEPTANCE.md "Baselines and approval":
// Mail with a message open (Wide), ToDo (Wide and Phone), Recordings library
// (Phone), Settings -> Appearance (Wide), the composer (Phone), since 0.26.0
// the contact detail, the contact editor and the merge review (Wide and
// Phone), and since 0.27.0 a ToDo row picked up by its handle, the new-task
// dialog with its list chooser open (Wide and Phone) and Settings -> Pages
// (Wide), and since 0.28.0 Settings -> Backup and restore (Wide), the bin
// (Wide and Phone) and Server settings -> Policies (Wide), and since 0.29.0
// Settings -> App lock (Wide and Phone), the whole-app lock screen (Phone), a
// module's lock screen (Wide), the required-by-your-administrator prompt
// (Phone), the Policies page at its App lock group (Wide) and Settings ->
// Security with Devices (Wide), each in Dark Default and Light Default.
// Fifty-six pictures; see docs/UI_BASELINES.md.
import { expect, expectBaseline, test, THEMES, VIEWPORTS, type Page } from '../support/test.ts';
import { CURRENT_DEVICE_LOCKED, POLICIES_ADMIN_APP_LOCK, POLICIES_EFFECTIVE_APP_LOCK, USER } from '../support/fixtures.ts';

// The app lock's state is this browser's (a PIN record in IndexedDB
// `unihub-lock-v1`, as src/lib/app-lock/pin.ts keeps it) plus the server's
// answer for this device. A PIN record without a timeline asks at start; the
// pictures never unlock, so the hash is arbitrary.
async function seedPin(page: Page) {
  await page.addInitScript((userId: string) => {
    const request = indexedDB.open('unihub-lock-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('timeline')) db.createObjectStore('timeline', { keyPath: 'userId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['pins'], 'readwrite');
      tx.objectStore('pins').put({ v: 1, userId, salt: new Uint8Array(16), iterations: 1000, hash: new Uint8Array(32), failures: 0, waitUntil: null, createdAt: Date.now() });
      tx.oncomplete = () => db.close();
    };
  }, USER.id);
}
/** This device locks Mail and Contacts under the administrator's rule; `scope` overrides what it locks, `meets` whether it has a method. */
async function lockedDevice(page: Page, { scope = CURRENT_DEVICE_LOCKED.settings.app_lock_scope.value, meets = true }: { scope?: string[]; meets?: boolean } = {}) {
  // A device short of the requirement reports no lock yet (otherwise its PIN would count as lost, not missing).
  const body = { ...CURRENT_DEVICE_LOCKED, device: { ...CURRENT_DEVICE_LOCKED.device, lock: meets ? CURRENT_DEVICE_LOCKED.device.lock : null },
    settings: { ...CURRENT_DEVICE_LOCKED.settings, app_lock_scope: { ...CURRENT_DEVICE_LOCKED.settings.app_lock_scope, value: scope } }, compliance: { ...CURRENT_DEVICE_LOCKED.compliance, meets } };
  await page.route('**/api/devices/current', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('**/api/settings/values/device', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ device_id: body.device.id, settings: body.settings }) }));
  // The rules that put the floors there, with the server's reasons beside the greyed choices.
  await page.route('**/api/policies/effective', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POLICIES_EFFECTIVE_APP_LOCK) }));
}

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

      // 0.28 (P-29, D29): Backup and restore, the bin and the policies page.
      test(`settings backup (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=backup');
        await expect(page.getByRole('button', { name: 'Create backup' })).toBeVisible();
        await expect(page.getByText('Not encrypted, made before 0.28.')).toBeVisible();
        await settle();
        await expectBaseline(page, `settings-backup-wide-${theme}.png`);
      });

      test(`bin (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=bin');
        await expect(page.getByRole('list', { name: 'Deleted items' })).toBeVisible();
        await settle();
        await expectBaseline(page, `bin-wide-${theme}.png`);
      });

      test.describe('as an administrator', () => {
        test.use({ admin: true });
        test(`admin policies (wide, ${theme})`, async ({ page, open, settle }) => {
          await open('/admin/policies');
          await expect(page.getByRole('combobox', { name: 'Creating backups' })).toBeVisible();
          await settle();
          await expectBaseline(page, `admin-policies-wide-${theme}.png`);
        });

        test(`admin policies, the App lock group (wide, ${theme})`, async ({ page, open, settle }) => {
          await page.route('**/api/admin/policies', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POLICIES_ADMIN_APP_LOCK) }));
          await open('/admin/policies');
          await expect(page.getByRole('combobox', { name: 'App lock required' })).toHaveText('Chosen modules');
          await page.getByRole('combobox', { name: 'Screenshots in the Android app' }).scrollIntoViewIfNeeded();
          await settle();
          await expectBaseline(page, `admin-policies-app-lock-wide-${theme}.png`);
        });
      });

      // 0.29 (P-29, D29): the app lock and the devices.
      test(`settings app lock (wide, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page);
        await open('/settings?section=app-lock');
        await expect(page.getByRole('checkbox', { name: /^Mail/ })).toBeDisabled();
        await settle();
        await expectBaseline(page, `settings-app-lock-wide-${theme}.png`);
      });

      test(`module lock screen (wide, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page);
        await open('/mail');
        await expect(page.getByRole('heading', { name: 'Mail is locked' })).toBeVisible();
        await settle();
        await expectBaseline(page, `lock-module-wide-${theme}.png`);
      });

      test(`devices (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=security');
        await expect(page.getByText('UniHub app 0.29.0 on Android')).toBeVisible();
        await page.getByRole('heading', { name: 'Devices' }).scrollIntoViewIfNeeded();
        await settle();
        await expectBaseline(page, `devices-wide-${theme}.png`);
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

      test(`bin (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=bin');
        await expect(page.getByRole('list', { name: 'Deleted items' })).toBeVisible();
        await settle();
        await expectBaseline(page, `bin-phone-${theme}.png`);
      });

      // 0.29: the lock in a phone's hand, and the set-up the administrator requires.
      test(`settings app lock (phone, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page);
        await open('/settings?section=app-lock');
        await expect(page.getByRole('checkbox', { name: /^Mail/ })).toBeDisabled();
        await settle();
        await expectBaseline(page, `settings-app-lock-phone-${theme}.png`);
      });

      test(`whole-app lock screen (phone, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page, { scope: ['app'] });
        await open('/todo');
        await expect(page.getByRole('heading', { name: 'UniHub is locked' })).toBeVisible();
        await settle();
        await expectBaseline(page, `lock-app-phone-${theme}.png`);
      });

      test(`required by the administrator (phone, ${theme})`, async ({ page, open, settle }) => {
        await lockedDevice(page, { meets: false });
        await open('/mail');
        await expect(page.getByRole('heading', { name: 'Your administrator requires the app lock' })).toBeVisible();
        await settle();
        await expectBaseline(page, `lock-required-phone-${theme}.png`);
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
