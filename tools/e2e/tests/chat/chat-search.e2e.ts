import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Page } from 'playwright-core';
import { runId, stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { chatBrowser, chatRow, escape, joinChat, leave, messagesOf, secondBrowser, shows, startChat, twoPeople, write } from './chat-helpers.ts';

// Search looks through what a device holds: Blair finds an old message on the
// browser that received it, and on a newly signed-in one only after the chat
// passphrase brought the earlier messages there.

const PASSPHRASE = 'synthetic chat passphrase';
const search = (page: Page, word: string) => page.getByRole('searchbox', { name: 'Search chats and messages' }).fill(word);
const results = (page: Page) => page.getByRole('region', { name: 'Search results' });

test('a word from an earlier message is found and opens the chat at that message; a new browser finds it after the passphrase', { timeout: 900_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    opened.push(await chatBrowser(alex), await chatBrowser(blair));
    const [a, b] = opened.map((entry) => entry.page);
    await startChat(a, blair);
    // One word no other message has, then enough lines to push it out of view.
    const word = `forklift${run.replace(/\W/g, '')}`;
    const old = `The ${word} licence is renewed.`;
    await write(a, blair.name, old);
    for (let line = 1; line <= 24; line++) await write(a, blair.name, `Line ${line} of the day ${run}`);
    await shows(chatRow(b, alex.name), 90_000);

    // Blair searches from the list: the chat, the sender and the line with the word marked.
    await search(b, word.toUpperCase());
    const hit = results(b).getByRole('link', { name: new RegExp(`^${escape(alex.name)}.*${escape(alex.name)}: The ${word} licence`) });
    await shows(hit, 60_000);
    expect(await hit.locator('mark').textContent(), 'the match is marked').toBe(word);
    await shows(results(b).getByText('Search looks through the chats on this device. The server cannot read them.', { exact: true }));
    await hit.click();
    await b.waitForURL(/\/chat\?c=[^&]+&m=/);
    const found = messagesOf(b, alex.name).getByText(old, { exact: true });
    await expect.poll(() => found.evaluate((element) => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight; }), { timeout: 30_000 }).toBe(true);
    expect(await messagesOf(b, alex.name).getByText(`Line 24 of the day ${run}`, { exact: true }).evaluate((element) => element.getBoundingClientRect().top > element.closest('ol')!.parentElement!.getBoundingClientRect().bottom), 'the chat is at the old message, not at its end').toBe(true);

    // A newly signed-in browser of Blair's holds nothing of it until the passphrase.
    const second = await secondBrowser(blair, { device: 'second browser' });
    opened.push(second);
    const s = second.page;
    await s.goto(`${stack.url}/chat`);
    await shows(s.getByRole('heading', { name: 'Enter your chat passphrase' }), 90_000);
    await joinChat(s, PASSPHRASE);
    await s.reload();
    await shows(s.getByRole('heading', { name: 'Enter your chat passphrase' }), 90_000);
    await s.getByRole('button', { name: 'Not now' }).click();
    await search(s, word);
    await shows(results(s).getByText('Nothing in your chats matches.', { exact: true }), 60_000);
    await s.getByRole('button', { name: 'Enter passphrase' }).click();
    await s.getByLabel('Chat passphrase', { exact: true }).fill(PASSPHRASE);
    await s.getByRole('button', { name: 'Get my earlier messages' }).click();
    await shows(chatRow(s, alex.name), 90_000);
    // The earlier messages arrive in the background: asked again until the word is there.
    await expect.poll(async () => {
      await search(s, '');
      await search(s, word);
      await s.waitForTimeout(1_000);
      return results(s).getByRole('link', { name: new RegExp(`The ${word} licence`) }).count();
    }, { timeout: 120_000, intervals: [2_000] }).toBe(1);
    await results(s).getByRole('link', { name: new RegExp(`The ${word} licence`) }).click();
    await shows(messagesOf(s, alex.name).getByText(old, { exact: true }), 60_000);
    passed = true;
  } finally {
    await leave(opened, people, passed);
  }
});
