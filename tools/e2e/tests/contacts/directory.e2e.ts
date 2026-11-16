import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, runId } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, sweep } from '../organisation/organisation-helpers.ts';

// The company directory: a person fills in their own entry under Settings ›
// Profile, colleagues find it in the Company address book, and the composer
// suggests the people of the directory. The entry is alex's own and is
// emptied again afterwards.

test('[31-01 31-04] alex fills in their directory entry, it shows in Company, and the composer suggests a colleague from the directory', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const run = runId();
    const colleague = await addPerson('directory');
    await app.open('/settings?section=account');
    await screen.getByLabel('Job title', { exact: true }).fill(`Tester ${run}`);
    await screen.getByLabel('Department', { exact: true }).fill('Quality');
    await screen.getByRole('button', 'Save directory entry', { exact: true }).tap();
    await expect(screen.getByText('Directory entry saved', { exact: true }).first()).toBeVisible();

    await app.open('/contacts?book=company');
    await screen.getByRole('button', new RegExp(`^${people.alex.name}`)).tap();
    const entry = screen.getByRole('article', people.alex.name);
    await expect(entry.getByText(`Tester ${run}, Quality`, { exact: true })).toBeVisible();
    // Nobody edits a company entry here.
    await expect(entry.getByRole('button', 'Edit', { exact: true })).toHaveCount(0);

    // A colleague alex has no contact for is suggested from the directory.
    await app.open('/mail?action=compose');
    await screen.getByLabel('To').fill(colleague.name);
    await expect(screen.getByRole('button', new RegExp(colleague.email))).toBeVisible();
  } finally {
    ok(await pageApi(browser, 'PUT', '/api/directory/me', { job_title: null, department: null }), 'empty the entry again');
    await sweep();
  }
});
