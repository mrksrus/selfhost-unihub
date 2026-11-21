import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId, signInPassword } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { chatBrowser, chatRow, leave, messagesOf, shows, twoPeople, write } from './chat-helpers.ts';

// A colleague who leaves: deactivated, then deleted. What they wrote stays
// under their name, marked as a former colleague's, and the chat with them
// can be read and no longer written to.

test('a deactivated, then deleted colleague: their messages keep their name with "former colleague" and the chat with them is read-only', { timeout: 900_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    for (const person of people) opened.push(await chatBrowser(person));
    const [a, b] = opened.map((entry) => entry.page);

    // The two write to each other.
    await a.goto(new URL(`/contacts?book=company&contact=${blair.id}`, a.url()).href);
    await a.getByRole('button', { name: 'Message', exact: true }).first().click();
    await a.waitForURL(/\/chat\?c=/);
    await write(a, blair.name, `Hello Blair ${run}`);
    await shows(chatRow(b, alex.name), 90_000);
    await chatRow(b, alex.name).click();
    const answer = `Before I go ${run}`;
    await write(b, alex.name, answer);
    await shows(messagesOf(a, blair.name).getByText(answer, { exact: true }), 60_000);
    await opened[1].browser.close();

    // Deactivated: the chat says why it cannot be written to, and Blair's message is a former colleague's.
    const admin = await signIn('admin');
    ok(await admin('PUT', `/api/admin/users/${blair.id}/activate`, { is_active: false, current_password: signInPassword }), 'deactivate Blair');
    await a.reload();
    const thread = a.getByRole('region', { name: `Chat with ${blair.name}` });
    await shows(thread.getByText(`${blair.name} is deactivated.`, { exact: true }), 90_000);
    await shows(thread.getByText('former colleague', { exact: true }), 60_000);
    await shows(thread.getByText(answer, { exact: true }));
    expect(await thread.getByRole('textbox').count(), 'nothing to write in').toBe(0);

    // Deleted: the message keeps the name it was written under.
    ok(await admin('DELETE', `/api/admin/users/${blair.id}`, { current_password: signInPassword }), 'delete Blair');
    await a.reload();
    const left = a.getByRole('region', { name: 'Chat with Deleted person' });
    await shows(left.getByText('This person was deleted.', { exact: true }), 90_000);
    await shows(left.getByText(answer, { exact: true }));
    await shows(left.getByText(blair.name, { exact: true }));
    await shows(left.getByText('former colleague', { exact: true }));
    expect(await left.getByRole('textbox').count(), 'nothing to write in').toBe(0);
    passed = true;
  } finally {
    await leave(opened, people, passed);
  }
});
