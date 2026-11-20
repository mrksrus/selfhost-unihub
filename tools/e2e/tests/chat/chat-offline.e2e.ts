import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId, stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { chatWithHook, choosePassphrase, cookiesOf, escape, keepScreen, positions, removePeople, secondBrowser, shows, twoPeople } from './chat-helpers.ts';

// Chat across a lost connection: Blair's browser goes offline while Alex
// writes, and writes something itself meanwhile.

test('messages sent while the other browser is offline arrive in order when it is back, and what it wrote offline goes out', { timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const [alex, blair] = await twoPeople();
  const other = await secondBrowser(blair);
  const page = other.page;
  let passed = false;
  try {
    await browser.setCookies(await cookiesOf(alex));
    await app.open(chatWithHook);
    expect(await choosePassphrase(browser)).toBe('choose-passphrase');
    await page.goto(`${stack.url}${chatWithHook}`);
    expect(await choosePassphrase(page)).toBe('choose-passphrase');
    await shows(page.getByText('No chats yet', { exact: true }));

    await app.open(`/contacts?book=company&contact=${blair.id}`);
    await screen.getByRole('button', 'Message').tap();
    const alexThread = screen.getByRole('region', `Chat with ${blair.name}`);
    const alexMessages = alexThread.getByRole('list', `Messages with ${blair.name}`);
    const field = alexThread.getByRole('textbox', `Message to ${blair.name}`);
    const send = async (text: string) => {
      await field.fill(text);
      await alexThread.getByRole('button', 'Send').tap();
      await expect(alexMessages.getByText(text, { exact: true })).toBeVisible();
    };
    const first = `Before ${run}`;
    await send(first);

    await page.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(alex.name)}`) }).click();
    const blairThread = page.getByRole('region', { name: `Chat with ${alex.name}` });
    await shows(blairThread.getByText(first, { exact: true }), 60_000);

    // Offline: Alex's three messages reach the server, Blair writes one that waits.
    await page.context().setOffline(true);
    const three = ['One', 'Two', 'Three'].map((word) => `${word} ${run}`);
    for (const text of three) await send(text);
    await expect(alexMessages.getByRole('listitem').filter({ hasText: three[2] })).toContainText('Sent');
    const offline = `Written offline ${run}`;
    await blairThread.getByRole('textbox', { name: `Message to ${alex.name}` }).fill(offline);
    await blairThread.getByRole('button', { name: 'Send', exact: true }).click();
    await shows(blairThread.getByText('Sending…', { exact: true }));
    expect(await positions(page, alex.name, three), 'nothing reached the offline browser').toEqual([-1, -1, -1]);

    // Back online: all three in the order Alex wrote them, then Blair's.
    await page.context().setOffline(false);
    await expect.poll(async () => (await positions(page, alex.name, [first, ...three, offline])).every((at, index, all) => at >= 0 && (index === 0 || at > all[index - 1])),
      { timeout: 60_000 }).toBe(true);
    await expect(alexMessages.getByText(offline, { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await positions(browser, blair.name, [three[2], offline]).then(([before, after]) => before >= 0 && after > before), 'after Alex\'s three').toBe(true);
    await shows(blairThread.getByText('Read', { exact: true }));
    passed = true;
  } finally {
    if (!passed) await keepScreen(page, 'blair-offline');
    await other.browser.close();
    await removePeople([alex, blair]);
  }
});
