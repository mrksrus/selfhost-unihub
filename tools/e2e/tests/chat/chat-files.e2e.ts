import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator, Page } from 'playwright-core';
import { fixturePath, runId } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge, createGroup, setRules } from '../organisation/organisation-helpers.ts';
import { chatBrowser, chatRow, confirmRules, FAKE_MICROPHONE, leave, messagesOf, shows, startChat, twoPeople, write } from './chat-helpers.ts';

// Files in a chat end to end: encrypted in Alex's browser, stored by the
// server, decrypted in Blair's. Each has a browser of their own; Alex's has a
// generated tone for a microphone.

const drawn = (image: Locator) => expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0), { timeout: 60_000 }).toBe(true);
const attach = (page: Page, files: Parameters<Locator['setInputFiles']>[0]) => page.getByLabel('Choose files to send').setInputFiles(files);
const send = (page: Page) => page.getByRole('button', { name: 'Send', exact: true }).click();

test('a picture, a PDF and a voice message reach the other person, a deleted picture is gone for both, and a file above the administrator\'s limit is refused with the limit', { timeout: 900_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let groupId: string | undefined;
  let passed = false;
  try {
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair));
    const [a, b] = opened.map((entry) => entry.page);
    await startChat(a, blair);
    const hello = `Files follow ${run}`;
    await write(a, blair.name, hello);
    await shows(chatRow(b, alex.name), 90_000);
    await chatRow(b, alex.name).click();
    const [alexSees, blairSees] = [messagesOf(a, blair.name), messagesOf(b, alex.name)];
    await shows(blairSees.getByText(hello, { exact: true }), 60_000);

    // A picture with a line of text: it waits above the field, then Blair sees its preview and opens the picture itself.
    await attach(a, fixturePath('fixtures/synthetic-photo.jpg'));
    await shows(a.getByRole('list', { name: 'Files to send' }).getByText('synthetic-photo.jpg', { exact: true }));
    const caption = `The gate ${run}`;
    await a.getByLabel(`Message to ${blair.name}`, { exact: true }).fill(caption);
    await send(a);
    const picture = { name: 'Open the picture synthetic-photo.jpg', exact: true };
    await shows(blairSees.getByText(caption, { exact: true }), 90_000);
    await drawn(blairSees.getByRole('button', picture).locator('img'));
    await drawn(alexSees.getByRole('button', picture).locator('img'));
    await blairSees.getByRole('button', picture).click();
    const viewer = b.getByRole('dialog', { name: 'synthetic-photo.jpg', exact: true });
    await drawn(viewer.locator('img'));
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await viewer.waitFor({ state: 'hidden' });

    // A PDF opens in the reader.
    await attach(a, fixturePath('fixtures/synthetic-report.pdf'));
    await send(a);
    await shows(blairSees.getByRole('button', { name: 'Open synthetic-report.pdf', exact: true }), 90_000);
    await blairSees.getByRole('button', { name: 'Open synthetic-report.pdf', exact: true }).click();
    const reader = b.getByRole('dialog', { name: 'synthetic-report.pdf', exact: true });
    await shows(reader.getByText(/page 1 of \d+/), 60_000);
    await shows(reader.locator('canvas').first(), 60_000);
    await reader.getByRole('button', { name: 'Close', exact: true }).click();
    await reader.waitFor({ state: 'hidden' });

    // A voice message from the microphone: Blair sees its length and plays it.
    await a.getByRole('button', { name: 'Record a voice message', exact: true }).click();
    await expect.poll(async () => (await a.getByRole('timer').textContent()) ?? '', { timeout: 30_000 }).toMatch(/^0:0[2-9]$/);
    await a.getByRole('button', { name: 'Send the voice message', exact: true }).click();
    const play = blairSees.getByRole('button', { name: /^Play the voice message, 0:0\d$/ });
    await shows(play, 90_000);
    await play.click();
    await expect.poll(() => b.evaluate(() => { const audio = document.querySelector('audio'); return !!audio && !audio.error && audio.currentTime > 0; }), { timeout: 60_000 }).toBe(true);

    // Alex deletes the picture's message: it is gone for both.
    await alexSees.getByRole('listitem').filter({ hasText: caption }).getByRole('button', { name: /^Actions for your message at \d\d:\d\d$/ }).click();
    await a.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await a.getByRole('alertdialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    for (const thread of [alexSees, blairSees]) {
      await expect.poll(() => thread.getByRole('button', picture).count(), { timeout: 60_000 }).toBe(0);
      expect(await thread.getByText(caption, { exact: true }).count(), 'its text went with it').toBe(0);
    }

    // The administrator allows Alex's group 10 MB: a larger file is refused in the server's words, and Blair gets nothing.
    const group = await createGroup('Small files', [alex.id]);
    groupId = group.id;
    await setRules({ 'chat.attachment_max_mb': 10 }, { groupId });
    for (const person of people) await confirmRules(person);
    await a.reload();
    await shows(alexSees.getByText(hello, { exact: true }), 90_000);
    await attach(a, { name: `too-large-${run}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(11 * 1024 * 1024, 1) });
    await send(a);
    await shows(alexSees.getByText('Not sent. Files in a chat can be at most 10 MB.', { exact: true }), 120_000);
    expect(await blairSees.getByText(`too-large-${run}.bin`, { exact: true }).count(), 'nothing of it reached Blair').toBe(0);
    passed = true;
  } finally {
    await leave(opened, people, passed, groupId);
    await acknowledge();
  }
});
