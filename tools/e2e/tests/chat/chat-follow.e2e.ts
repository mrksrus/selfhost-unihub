import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, createGroup, setManager } from '../organisation/organisation-helpers.ts';
import { chatBrowser, chatRow, confirmRules, leave, messagesOf, readsChat, shows, write } from './chat-helpers.ts';

// A chat that follows an organisation group: its manager starts it from the
// group's page, nobody is added or removed in the chat, and it gains and
// loses people as the administrator changes the group.

test('a chat follows an organisation group: started from the group\'s page, it says why nobody is added by hand, and gains and loses people with the group', { timeout: 900_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const people = [await addPerson('alex'), await addPerson('blair'), await addPerson('casey')];
  const [alex, blair, casey] = people;
  const team = await createGroup('Followed', [alex.id, blair.id]);
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    await setManager(team.id, alex.id);
    for (const person of people) await confirmRules(person);
    for (const person of people) opened.push(await chatBrowser(person));
    const [a, b, c] = opened.map((entry) => entry.page);
    const chat = team.name;

    // Alex manages the group and starts its chat from the group's page; the name offered is the group's.
    await a.goto(new URL(`/groups/${team.id}`, a.url()).href);
    await a.getByRole('button', { name: 'New group chat', exact: true }).click();
    const dialog = a.getByRole('dialog', { name: 'New group chat' });
    expect(await dialog.getByLabel('Name', { exact: true }).inputValue()).toBe(chat);
    await dialog.getByRole('button', { name: 'Create chat', exact: true }).click();
    await a.waitForURL(/\/chat\?c=/);
    const id = new URL(a.url()).searchParams.get('c');
    await shows(a.getByText(`2 people, follows ${chat}`, { exact: true }), 60_000);
    const hello = `Hello team ${run}`;
    await write(a, chat, hello);
    await shows(chatRow(b, chat), 90_000);
    await chatRow(b, chat).click();
    await shows(messagesOf(b, chat).getByText(hello, { exact: true }), 60_000);

    // The chat's people cannot be changed in the chat, and it says why.
    await a.getByRole('button', { name: 'People in this chat', exact: true }).click();
    const panel = a.getByRole('dialog', { name: chat, exact: true });
    await shows(panel.getByText(/nobody is added or removed here, and nobody leaves\./));
    await shows(panel.getByRole('button', { name: 'Stop following', exact: true }));
    expect(await panel.getByRole('button', { name: /^(Remove .*|Add people|Leave chat)$/ }).count(), 'no adding, removing or leaving').toBe(0);
    // By its button: Escape goes to a notice first when one happens to show.
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });

    // The administrator adds Casey to the group: the chat comes to Casey, who reads from then on.
    const admin = await signIn('admin');
    ok(await admin('POST', `/api/groups/${team.id}/members`, { user_ids: [casey.id] }), 'add Casey to the group');
    for (const person of people) await confirmRules(person);
    await shows(chatRow(c, chat), 90_000);
    await chatRow(c, chat).click();
    await shows(c.getByText('No messages yet', { exact: true }), 60_000);
    const welcome = `Welcome Casey ${run}`;
    await write(a, chat, welcome);
    await shows(messagesOf(c, chat).getByText(welcome, { exact: true }), 60_000);
    expect(await messagesOf(c, chat).getByText(hello, { exact: true }).count(), 'nothing from before Casey joined').toBe(0);
    await shows(messagesOf(a, chat).getByText(`${casey.name} joined the chat`));

    // The administrator removes Blair from the group: the chat goes from Blair, who reads nothing new.
    ok(await admin('DELETE', `/api/groups/${team.id}/members/${blair.id}`), 'remove Blair from the group');
    for (const person of people) await confirmRules(person);
    await shows(b.getByText('No chats yet', { exact: true }), 90_000);
    const later = `After Blair ${run}`;
    await write(a, chat, later);
    await shows(messagesOf(c, chat).getByText(later, { exact: true }), 60_000);
    expect(await readsChat(blair, id), 'the server serves Blair nothing of the chat').toBe(false);
    passed = true;
  } finally {
    await leave(opened, people, passed, team.id);
  }
});
