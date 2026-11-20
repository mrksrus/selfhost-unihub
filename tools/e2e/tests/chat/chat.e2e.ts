import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId, stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { setRules, type Effective } from '../organisation/organisation-helpers.ts';
import { chatWithHook, choosePassphrase, confirmRules, cookiesOf, escape, keepScreen, removePeople, secondBrowser, shows, twoPeople } from './chat-helpers.ts';

// Chat end to end: two people in two browsers, through the real screens, the
// engine, the MLS module and the server. Alex is in the test's browser, Blair
// in a second one.

test('two people write to each other: read marks, an edit and a delete reach both, delete is greyed under the rule, the unread count clears', { timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const [alex, blair] = await twoPeople();
  const other = await secondBrowser(blair);
  const page = other.page;
  let passed = false;
  try {
    // The first Chat open asks each of them for a passphrase.
    await browser.setCookies(await cookiesOf(alex));
    await app.open(chatWithHook);
    await expect(screen.getByText('Choose a chat passphrase', { exact: true })).toBeVisible();
    expect(await choosePassphrase(browser), 'Alex had no passphrase yet').toBe('choose-passphrase');
    await expect(screen.getByText('No chats yet', { exact: true })).toBeVisible();
    await page.goto(`${stack.url}${chatWithHook}`);
    expect(await choosePassphrase(page), 'Blair had no passphrase yet').toBe('choose-passphrase');
    await shows(page.getByText('No chats yet', { exact: true }));

    // Alex starts the chat from Blair's entry in the company directory.
    await app.open(`/contacts?book=company&contact=${blair.id}`);
    await screen.getByRole('button', 'Message').tap();
    await expect(browser).toHaveURL(/\/chat\?c=/);
    const alexThread = screen.getByRole('region', `Chat with ${blair.name}`);
    const alexMessages = alexThread.getByRole('list', `Messages with ${blair.name}`);
    const hello = `Hello Blair ${run}`;
    await alexThread.getByRole('textbox', `Message to ${blair.name}`).fill(hello);
    await alexThread.getByRole('button', 'Send').tap();
    await expect(alexMessages.getByText(hello, { exact: true })).toBeVisible();

    // Blair's list and navigation count it as unread until the chat is open.
    const row = page.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(alex.name)}`) });
    await shows(row.filter({ hasText: '1 unread' }), 60_000);
    await shows(page.getByRole('link', { name: 'Chat, 1 unread', exact: true }));
    await row.click();
    const blairThread = page.getByRole('region', { name: `Chat with ${alex.name}` });
    const blairMessages = blairThread.getByRole('list', { name: `Messages with ${alex.name}` });
    await shows(blairMessages.getByText(hello, { exact: true }));
    await shows(page.getByRole('link', { name: 'Chat', exact: true }));
    await expect(alexThread.getByText('Read', { exact: true })).toBeVisible();

    // Blair answers; Alex has the chat open, so Blair sees it read.
    const answer = `Hello Alex ${run}`;
    await blairThread.getByRole('textbox', { name: `Message to ${alex.name}` }).fill(answer);
    await blairThread.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(alexMessages.getByText(answer, { exact: true })).toBeVisible();
    await shows(blairThread.getByText('Read', { exact: true }));

    // Alex edits the first message: both see the new text, marked edited.
    const alexMenu = (text: string) => alexMessages.getByRole('listitem').filter({ hasText: text }).getByRole('button', /^Actions for your message at \d\d:\d\d$/);
    const edited = `Hello again Blair ${run}`;
    await alexMenu(hello).tap();
    await screen.getByRole('menuitem', 'Edit').tap();
    const field = alexThread.getByRole('textbox', `Message to ${blair.name}`);
    await expect(field).toHaveValue(hello);
    await field.fill(edited);
    await alexThread.getByRole('button', 'Save change').tap();
    await expect(alexMessages.getByRole('listitem').filter({ hasText: edited })).toContainText('edited');
    await shows(blairMessages.getByText(edited, { exact: true }));
    await shows(blairMessages.getByRole('listitem').filter({ hasText: edited }).getByText(/^edited /));
    expect(await blairMessages.getByText(hello, { exact: true }).count(), 'the old text is gone on Blair\'s side').toBe(0);

    // While the administrator forbids deleting for good, Delete is greyed with the reason.
    await setRules({ 'bin.delete': 'forbidden' });
    try {
      for (const person of [alex, blair]) await confirmRules(person);
      const reason = ok(await (await signIn(alex.email))<Effective>('GET', '/api/policies/effective'), 'Alex\'s rules').policies['bin.delete'].reason
        ?? 'Your administrator does not allow this.';
      await browser.reload();
      await alexMenu(edited).tap();
      const locked = screen.getByRole('menuitem', /^Delete/);
      await expect(locked).toBeDisabled();
      await expect(locked).toContainText(reason);
      await browser.keyboard.press('Escape');
    } finally {
      await setRules({ 'bin.delete': 'allowed' });
      for (const person of [alex, blair]) await confirmRules(person);
    }

    // Allowed again: Alex deletes the message for both.
    await browser.reload();
    await alexMenu(edited).tap();
    await screen.getByRole('menuitem', 'Delete').tap();
    await screen.getByRole('alertdialog', 'Delete this message?').getByRole('button', 'Delete').tap();
    await expect(alexMessages.getByText('Message deleted', { exact: true })).toBeVisible();
    await shows(blairMessages.getByText('Message deleted', { exact: true }));
    expect(await blairMessages.getByText(edited, { exact: true }).count(), 'the text is gone on Blair\'s side').toBe(0);
    await expect(alexMessages.getByText(answer, { exact: true })).toBeVisible();
    passed = true;
  } finally {
    if (!passed) await keepScreen(page, 'blair');
    await other.browser.close();
    await removePeople([alex, blair]);
  }
});
