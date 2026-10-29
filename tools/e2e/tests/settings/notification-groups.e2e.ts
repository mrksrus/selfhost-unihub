import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { addMailAccount, mailAccount, ok, pageApi } from '../support/api.ts';
import { createProviderMailbox } from '../support/mail.ts';
import { onlyOn } from '../support/ui.ts';

type AccountSettings = Record<string, Record<string, { value: unknown }> | undefined>;

// B-23 (0.25.1): with several mail accounts, Settings → Notifications shows each
// account's settings as one labelled group under its address, the address standing
// out to the left of the account's rows, and a switch in one group changes only
// that account.
test('[B-23] each mail account\'s notification settings are one group of their own', { session: 'alex', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const second = `notify-${runId()}@mail.test`;
  await createProviderMailbox(second);
  await app.open('/settings');
  const seeded = await mailAccount(browser, 'alex@mail.test');
  ok(await pageApi(browser, 'PUT', `/api/settings/values/mail-accounts/${seeded.id}`, { values: { notify_enabled: true } }), 'seeded account announces');
  const added = await addMailAccount(browser, second);
  try {
    await app.open('/settings?section=notifications');
    const seededGroup = screen.getByRole('group', seeded.email_address, { exact: true });
    const addedGroup = screen.getByRole('group', second, { exact: true });
    await expect(seededGroup.getByRole('switch', 'Notifications')).toBeChecked();
    await expect(addedGroup.getByRole('switch', 'Notifications')).toBeChecked();

    // The address is the group's heading and stands further left than the account's rows.
    const heading = await addedGroup.getByRole('heading', second, { exact: true }).boundingBox();
    const label = await addedGroup.getByText('Notifications', { exact: true }).boundingBox();
    expect(heading && label && label.x > heading.x, 'the rows are indented under the address').toBe(true);

    await addedGroup.getByRole('switch', 'Notifications').tap();
    await expect(addedGroup.getByRole('switch', 'Notifications')).not.toBeChecked();
    await expect(addedGroup.getByRole('combobox', 'Folders')).toHaveCount(0);
    await expect(seededGroup.getByRole('switch', 'Notifications')).toBeChecked();
    await expect(seededGroup.getByRole('combobox', 'Folders')).toBeVisible();

    await expect.poll(async () => {
      const { accounts } = ok(await pageApi<{ accounts: AccountSettings }>(browser, 'GET', '/api/settings/values/mail-accounts'), 'mail account settings');
      return [accounts[added.id]?.notify_enabled?.value, accounts[seeded.id]?.notify_enabled?.value ?? true];
    }, { timeout: 20_000 }).toEqual([false, true]);
  } finally {
    ok(await pageApi(browser, 'DELETE', `/api/mail/accounts/${added.id}?purge=true&disconnect=true&confirm_purge=${encodeURIComponent(second)}`), 'remove the added account');
  }
});
