import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, createGroup } from '../organisation/organisation-helpers.ts';
import { chatBrowser, chatRow, confirmRules, escape, leave, messagesOf, readsChat, shows, write } from './chat-helpers.ts';

// A group chat end to end: three people of one organisation group, each in a
// browser of their own, through the real screens, the engine, the MLS module
// and the server.

test('a group chat of three: all write, a mention is marked for the one it names, one sets it to mentions only, and a removed person loses the chat', { timeout: 900_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  // A member reaches the people who share a group with them.
  const team = await createGroup('Chat team');
  const people = [await addPerson('alex', { groups: [team.id] }), await addPerson('blair', { groups: [team.id] }), await addPerson('casey', { groups: [team.id] })];
  const [, blair, casey] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    for (const person of people) await confirmRules(person);
    for (const person of people) opened.push(await chatBrowser(person));
    const [a, b, c] = opened.map((entry) => entry.page);
    const chat = `Planning ${run}`;

    // Alex makes the chat with Blair and Casey.
    await a.getByRole('button', { name: 'New group', exact: true }).click();
    const dialog = a.getByRole('dialog', { name: 'New group chat' });
    await dialog.getByLabel('Name', { exact: true }).fill(chat);
    for (const person of [blair, casey]) {
      await dialog.getByLabel('Name or email', { exact: true }).fill(person.email);
      await dialog.getByRole('checkbox', { name: new RegExp(`^${escape(person.name)}`) }).check();
    }
    await dialog.getByRole('button', { name: 'Create chat', exact: true }).click();
    await a.waitForURL(/\/chat\?c=/);
    const hello = `Hello all ${run}`;
    await write(a, chat, hello);

    // Blair and Casey find it in their lists, read and answer; everyone sees whose message is whose.
    for (const [page, text] of [[b, `Blair here ${run}`], [c, `Casey here ${run}`]] as const) {
      await shows(chatRow(page, chat), 90_000);
      await chatRow(page, chat).click();
      await shows(messagesOf(page, chat).getByText(hello, { exact: true }), 60_000);
      await write(page, chat, text);
      await shows(messagesOf(a, chat).getByText(text, { exact: true }), 60_000);
    }
    await shows(messagesOf(a, chat).getByText(blair.name, { exact: true }).first());
    await shows(messagesOf(a, chat).getByText(casey.name, { exact: true }).first());

    // Casey mentions Blair from the list "@" opens. Blair, with the list in front, sees the "@" there and the mention marked in the chat; for Alex it is not marked.
    await b.goto(new URL('/chat', b.url()).href);
    await shows(chatRow(b, chat), 60_000);
    const field = c.getByLabel(`Message to ${chat}`, { exact: true });
    await field.pressSequentially(`@${blair.name.slice(0, 4)}`);
    await c.getByRole('option', { name: blair.name, exact: true }).click();
    await field.pressSequentially(`the gate is open ${run}`);
    await c.getByRole('button', { name: 'Send', exact: true }).click();
    const mention = `@${blair.name} the gate is open ${run}`;
    await shows(messagesOf(c, chat).getByText(mention, { exact: true }));
    await shows(chatRow(b, chat).filter({ hasText: 'mentions you' }), 60_000);
    await chatRow(b, chat).click();
    await shows(messagesOf(b, chat).locator('mark', { hasText: `@${blair.name}` }), 60_000);
    await shows(messagesOf(a, chat).getByText(mention, { exact: true }), 60_000);
    expect(await messagesOf(a, chat).locator('mark').count(), 'not marked for Alex').toBe(0);

    // Blair sets the chat to mentions only.
    await b.getByRole('button', { name: 'Notifications: All messages', exact: true }).click();
    await b.getByRole('menuitemradio', { name: 'Mentions only', exact: true }).click();
    await shows(b.getByRole('button', { name: 'Notifications: Mentions only', exact: true }));
    const blairsChat = ok(await (await signIn(blair.email))<{ conversations: { id: string; kind: string; notify: string }[] }>('GET', '/api/chat/conversations'), 'Blair\'s chats')
      .conversations.find((entry) => entry.kind === 'group');
    expect(blairsChat?.notify, 'the server keeps Blair\'s choice').toBe('mentions');

    // Alex removes Casey: the dialog says what that means, and the chat goes from Casey's list.
    await a.getByRole('button', { name: 'People in this chat', exact: true }).click();
    const panel = a.getByRole('dialog', { name: chat, exact: true });
    await panel.getByRole('button', { name: `Remove ${casey.name}`, exact: true }).click();
    const ask = a.getByRole('alertdialog', { name: `Remove ${casey.name} from ${chat}?` });
    await shows(ask.getByText(/They keep nothing in UniHub\. A copy they made elsewhere cannot be taken back\./));
    await ask.getByRole('button', { name: 'Remove', exact: true }).click();
    await ask.waitFor({ state: 'hidden', timeout: 30_000 });
    // The panel is in reach again once the question is gone: Casey is no longer in it.
    await panel.getByRole('button', { name: `Remove ${blair.name}`, exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await panel.getByRole('button', { name: `Remove ${casey.name}`, exact: true }).count(), 'Casey is gone from the people').toBe(0);
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await shows(c.getByText('No chats yet', { exact: true }), 90_000);

    // What is written next reaches Blair and not Casey.
    const after = `After Casey ${run}`;
    await write(a, chat, after);
    await shows(messagesOf(b, chat).getByText(after, { exact: true }), 60_000);
    await shows(messagesOf(b, chat).getByText(`${casey.name} left the chat`));
    expect(await readsChat(casey, blairsChat!.id), 'the server serves Casey nothing of the chat').toBe(false);
    expect(await c.getByText(after, { exact: true }).count(), 'nothing new on Casey\'s screen').toBe(0);
    passed = true;
  } finally {
    await leave(opened, people, passed, team.id);
  }
});
