import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';
import { outside, runId } from '../support/env.ts';
import { addMailAccount, emailsWithSubject, mailAccounts } from '../support/api.ts';
import { createProviderMailbox, deliveredWithSubject, sendMail } from '../support/mail.ts';
import { isNarrow, onlyOn, waitForRow } from '../support/ui.ts';

type App = { open: (path?: string) => Promise<unknown> };

/** A provider mailbox of its own with one message, connected as an account of the signed-in person. */
async function connectedAccount(app: App, screen: Screen, browser: unknown, what: string) {
  const id = runId();
  const mailbox = `${what}-${id}@mail.test`;
  const subject = `${what} ${id}`;
  await createProviderMailbox(mailbox);
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Kept at the provider.' });
  await app.open('/mail');
  const account = await addMailAccount(browser, mailbox);
  // Opened again, so the page's account and sync lists include the new account.
  await app.open('/mail');
  await waitForRow(screen, subject, mailbox);
  expect((await emailsWithSubject(browser, 'inbox', subject)).length, 'synced into UniHub').toBe(1);
  return { mailbox, subject, account };
}

/** The account's remove control in the Accounts list: the panel is a sheet on narrow screens. */
async function openDisconnect(screen: Screen, browser: unknown, mailbox: string) {
  if (await isNarrow(browser)) await screen.getByRole('button', 'All accounts', { visible: true }).first().tap();
  await screen.getByRole('button', `Disconnect ${mailbox}`, { visible: true }).tap();
  await expect(screen.getByRole('alertdialog')).toContainText('Disconnect mail account?');
}

// D27 (0.25.0): the disconnect dialog offers removing the account together with its
// mail. After the typed confirmation the account and its mail are gone from UniHub,
// in the page and through the API, while the provider mailbox still holds the message.
test('[25-03 D27] removing an account with its mail deletes UniHub\'s copy only', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const { mailbox, subject, account } = await connectedAccount(app, screen, browser, 'removal');
  await openDisconnect(screen, browser, mailbox);
  const dialog = screen.getByRole('alertdialog');
  await dialog.getByRole('button', /^Remove the account with its mail/).tap();
  await expect(dialog).toContainText('Remove the account with its mail?');
  await expect(dialog).toContainText('stay at the provider');
  await expect(dialog).toContainText('1 email');
  const confirm = dialog.getByRole('button', 'Remove account and mail');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type the account address/).fill(mailbox);
  await expect(confirm).toBeEnabled();
  await confirm.tap();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await expect.poll(async () => (await mailAccounts(browser)).some((a) => a.id === account.id), { timeout: 30_000 }).toBe(false);
  expect(await emailsWithSubject(browser, 'inbox', subject), 'no local copy left').toEqual([]);
  await expect(screen.getByText(subject, { exact: true })).toHaveCount(0);
  if (await isNarrow(browser)) await screen.getByRole('button', 'All accounts', { visible: true }).first().tap();
  await expect(screen.getByRole('button', `Disconnect ${mailbox}`)).toHaveCount(0);
  expect((await deliveredWithSubject(mailbox, subject)).length, 'the provider keeps the message').toBe(1);
});

// The other choice still works: disconnect and keep the mail. The account stays
// listed as disconnected, its message stays readable, and the provider is untouched.
test('[25-03 D27] disconnecting keeps the mail in UniHub', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const { mailbox, subject, account } = await connectedAccount(app, screen, browser, 'keep');
  await openDisconnect(screen, browser, mailbox);
  const dialog = screen.getByRole('alertdialog');
  await dialog.getByRole('button', /^Disconnect and keep mail/).tap();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => (await mailAccounts(browser)).find((a) => a.id === account.id)?.disconnected_at ?? null, { timeout: 30_000 }).not.toBeNull();
  expect((await emailsWithSubject(browser, 'inbox', subject)).length, 'the local copy stays').toBe(1);
  if (await isNarrow(browser)) await screen.getByRole('button', 'All accounts', { visible: true }).first().tap();
  await expect(screen.getByRole('button', `Delete local data of ${mailbox}`)).toBeVisible();
  expect((await deliveredWithSubject(mailbox, subject)).length).toBe(1);
});
