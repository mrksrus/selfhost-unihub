import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Page } from 'playwright-core';
import { stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge, createGroup, setRules, type Effective } from '../organisation/organisation-helpers.ts';
import { chatBrowser, chatRow, confirmRules, FAKE_MICROPHONE, leave, messagesOf, shows, startChat, twoPeople, write } from './chat-helpers.ts';

// Calls forbidden for a group: its member cannot call, and nobody can call the
// member. The button stays where it is, greyed, with the reason.

/** The greyed button says why when pressed, and starts nothing. */
async function greyed(page: Page, name: string, reason: string) {
  const button = page.getByRole('button', { name, exact: true });
  await expect.poll(() => button.getAttribute('aria-disabled'), { timeout: 60_000 }).toBe('true');
  await button.click();
  await shows(page.getByText(reason, { exact: true }));
  expect(await page.getByRole('dialog').filter({ hasText: 'Calling…' }).count(), 'no call started').toBe(0);
  await page.keyboard.press('Escape');
}

test('calls forbidden for a group grey Call with the reason for its member and for the person who calls the member', { timeout: 600_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let groupId: string | undefined;
  let passed = false;
  try {
    // Alex's call asks for the microphone before the server is asked.
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair));
    const [a, b] = opened.map((entry) => entry.page);
    await startChat(a, blair);
    await write(a, blair.name, 'Calls are off for one of us');
    const group = await createGroup('No calls', [blair.id]);
    groupId = group.id;
    await setRules({ 'chat.calls': 'forbidden' }, { groupId });
    for (const person of people) await confirmRules(person);

    // Blair, the member: greyed with the rule's reason.
    const rule = ok(await (await signIn(blair.email))<Effective>('GET', '/api/policies/effective'), 'Blair\'s rules').policies['chat.calls'];
    expect(rule.allowed, 'the group\'s rule reaches its member').toBe(false);
    await b.goto(`${stack.url}/chat`);
    await shows(chatRow(b, alex.name), 90_000);
    await chatRow(b, alex.name).click();
    await shows(messagesOf(b, alex.name).getByText('Calls are off for one of us', { exact: true }), 60_000);
    await greyed(b, `Call ${alex.name}`, rule.reason ?? 'the server gave no reason');

    // Alex is under no rule and learns it by calling: the server refuses with the reason, and the button stays greyed with it.
    await a.reload();
    await shows(messagesOf(a, blair.name).getByText('Calls are off for one of us', { exact: true }), 90_000);
    const call = a.getByRole('button', { name: `Call ${blair.name}`, exact: true });
    expect(await call.getAttribute('aria-disabled'), 'nothing greys Alex\'s button before the first try').toBeNull();
    await call.click();
    const refused = a.getByRole('dialog', { name: blair.name, exact: true });
    await shows(refused.getByText(`Calls are off for ${blair.name}.`, { exact: true }), 60_000);
    await refused.getByRole('button', { name: 'Close', exact: true }).click();
    await greyed(a, `Call ${blair.name}`, `Calls are off for ${blair.name}.`);
    passed = true;
  } finally {
    await leave(opened, people, passed, groupId);
    await acknowledge();
  }
});
