import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';
import { outside, runId } from '../support/env.ts';
import { addMailAccount, ok, pageApi } from '../support/api.ts';
import { createProviderFolder, createProviderMailbox, deleteProviderFolder, providerFolder, sendMail } from '../support/mail.ts';
import { isNarrow, onlyOn, syncNow, waitForRow } from '../support/ui.ts';

type App = { open: (path?: string) => Promise<unknown> };
interface Copy { account_id: string; remote_name: string; uidvalidity: string | null; mailbox_id: string | null }
interface Folder { slug: string; display_name: string; server_copies?: Copy[] }

/** The folder as the person's folder list shows it, or undefined. */
async function listed(browser: unknown, name: string): Promise<Folder | undefined> {
  const { folders } = ok(await pageApi<{ folders: Folder[] }>(browser, 'GET', '/api/mail/folders'), 'list folders');
  return folders.find((folder) => folder.display_name === name);
}

/** Waits until UniHub has read the folder's server copy at this UIDVALIDITY (a sync ran). */
async function readAt(screen: Screen, browser: unknown, mailbox: string, name: string, uidValidity: string) {
  await expect.poll(async () => {
    const copy = (await listed(browser, name))?.server_copies?.[0]?.uidvalidity ?? null;
    if (copy !== uidValidity) await syncNow(screen, mailbox);
    return copy;
  }, { timeout: 120_000, intervals: [5_000] }).toBe(uidValidity);
}

/** Opens Mail folders and the delete question for one folder, with "on the mail server as well" ticked. */
async function askToDelete(app: App, screen: Screen, browser: unknown, name: string) {
  await app.open('/mail');
  if (await isNarrow(browser)) await screen.getByRole('button', 'All accounts', { visible: true }).first().tap();
  await screen.getByRole('button', 'Manage folders', { visible: true }).first().tap();
  await screen.getByRole('dialog', 'Mail folders').getByRole('button', `Delete ${name}`).tap();
  const question = screen.getByRole('alertdialog', `Delete ${name}?`);
  await expect(question).toContainText('on the mail server');
  await question.getByRole('checkbox').tap();
  return question.getByRole('button', 'Delete on server and in UniHub');
}

// 0.28.2: deleting a folder at the mail server names the copy the person saw
// (its UIDVALIDITY). Another mail program deletes the folder and creates it
// again under the same name while the question is open: UniHub deletes
// nothing, and the new folder and its mail stay at the provider. Once a sync
// has read the new folder, deleting it works as before.
test('[0.28.2] a folder created again under the same name while the question is open is not deleted', { session: 'alex', timeout: 360_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const id = runId();
  const mailbox = `folders-${id}@mail.test`, name = `Projects-${id}`;
  await createProviderMailbox(mailbox);
  await createProviderFolder(mailbox, name, `Filed ${id}`);
  const first = (await providerFolder(mailbox, name))!;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject: `Arrived ${id}`, text: 'Synthetic message.' });
  await app.open('/mail');
  await addMailAccount(browser, mailbox);
  await app.open('/mail');
  await waitForRow(screen, `Arrived ${id}`, mailbox);
  await readAt(screen, browser, mailbox, name, first.uidValidity);

  const confirm = await askToDelete(app, screen, browser, name);
  // Another mail program: the folder deleted and created again, with new mail in it.
  await deleteProviderFolder(mailbox, name);
  await createProviderFolder(mailbox, name, `Replacement ${id}`);
  const replacement = (await providerFolder(mailbox, name))!;
  expect(replacement.uidValidity, 'the provider gave the new folder another UIDVALIDITY').not.toBe(first.uidValidity);
  await confirm.tap();
  await expect(screen.getByText('Folder not deleted').first()).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText(/changed on the mail server/).first()).toBeVisible();
  expect(await providerFolder(mailbox, name), 'the new folder and its mail stay at the provider').toEqual(replacement);
  expect(await listed(browser, name), 'and in UniHub').toBeTruthy();

  // A sync reads the new folder; deleting it now deletes it at the provider and in UniHub.
  await app.open('/mail');
  await readAt(screen, browser, mailbox, name, replacement.uidValidity);
  await (await askToDelete(app, screen, browser, name)).tap();
  await expect(screen.getByText('Folder deleted on the server').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => providerFolder(mailbox, name), { timeout: 30_000 }).toBeNull();
  await expect.poll(async () => (await listed(browser, name)) ?? null, { timeout: 30_000 }).toBeNull();
});
