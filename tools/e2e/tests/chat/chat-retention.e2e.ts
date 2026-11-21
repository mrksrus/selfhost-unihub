import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { apiRequire, runId, stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { dbRead } from '../support/db.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge, addPerson, createGroup, dialogPassword, sweep, type Effective } from '../organisation/organisation-helpers.ts';
import { chatWithHook, choosePassphrase, confirmRules, keepScreen, secondBrowser, shows, type Person } from './chat-helpers.ts';

// Chat retention as the owner sets it for a group on the Policies page, and
// as the two people of a chat then see it. The owner is in the test's
// browser, Alex and Blair in one of their own each.
//
// The server starts a wait and deletes in an hourly job, which a test cannot
// call or wait for. So this goes as far as the screens reach without it: the
// count, the typed word and the password, the notice, Undo, and the owner
// ending the wait, after which a device deletes its own old copies. That the
// job deletes nothing during the 24 hours and the right rows after them is
// proven against the real database (chat-retention-mysql-integration).

const NOTICE = 'Your administrator changed the data rules';
const LINE = 'Messages older than 30 days are deleted here';

// The one thing this test writes past the app: its clock. Forty days cannot
// be waited for, so the chat's first message is moved back.
async function firstMessageSentDaysAgo(conversationId: string, days: number) {
  const password = /^APP_PW=(.*)$/m.exec(readFileSync(stack.dbEnvFile, 'utf8'))?.[1];
  const db = await apiRequire('mysql2/promise').createConnection({ host: '127.0.0.1', port: stack.dbPort, user: 'unihub', password, database: 'unihub_dev', timezone: 'Z' });
  try {
    const [result] = await db.execute("UPDATE chat_messages SET created_at = UTC_TIMESTAMP() - INTERVAL ? DAY WHERE conversation_id = ? AND kind = 'message' AND replaces IS NULL ORDER BY seq LIMIT 1", [days, conversationId]);
    if (result.affectedRows !== 1) throw new Error(`chat ${conversationId} has no message to move back`);
  } finally {
    await db.end();
  }
}

const rulesOf = async (person: Person) => ok(await (await signIn(person.email))<Effective>('GET', '/api/policies/effective'), 'rules');

test('a shorter chat retention for a group: the count, the typed word and the password before saving, the notice to its member, Undo deletes nothing; after the owner ends the wait both chats name the time and a device drops its old copy', { session: 'admin', timeout: 720_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  await sweep();
  const opened: Awaited<ReturnType<typeof secondBrowser>>[] = [];
  let passed = false;
  try {
    const alex = await addPerson('alex');
    const blair = await addPerson('blair');
    const group = await createGroup('Short chats', [blair.id]);
    for (const person of [alex, blair]) await confirmRules(person);
    opened.push(await secondBrowser(alex));
    opened.push(await secondBrowser(blair));
    const [{ page: a }, { page: b }] = opened;

    // Both have a chat device; Blair then looks away, so that her device reads the first message only after its time was moved.
    await b.goto(`${stack.url}${chatWithHook}`);
    expect(await choosePassphrase(b), 'Blair had no passphrase yet').toBe('choose-passphrase');
    await shows(b.getByText('No chats yet', { exact: true }));
    await b.goto('about:blank');
    await a.goto(`${stack.url}${chatWithHook}`);
    expect(await choosePassphrase(a), 'Alex had no passphrase yet').toBe('choose-passphrase');
    await shows(a.getByText('No chats yet', { exact: true }));

    await a.goto(`${stack.url}/contacts?book=company&contact=${blair.id}`);
    await a.getByRole('button', { name: 'Message', exact: true }).click();
    await a.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
    const chat = new URL(a.url()).searchParams.get('c')!;
    const alexThread = a.getByRole('region', { name: `Chat with ${blair.name}` });
    const alexMessages = alexThread.getByRole('list', { name: `Messages with ${blair.name}` });
    const stored = async () => Number((await dbRead<{ n: number }>("SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ? AND kind = 'message'", [chat]))[0].n);
    const send = async (text: string, count: number) => {
      await alexThread.getByRole('textbox', { name: `Message to ${blair.name}` }).fill(text);
      await alexThread.getByRole('button', { name: 'Send', exact: true }).click();
      await shows(alexMessages.getByText(text, { exact: true }));
      await expect.poll(stored, { timeout: 60_000 }).toBe(count);
    };
    const old = `Old message ${run}`;
    const young = `Young message ${run}`;
    await send(old, 1);
    await firstMessageSentDaysAgo(chat, 40);
    await send(young, 2);

    await b.goto(`${stack.url}/chat?c=${chat}`);
    const blairThread = b.getByRole('region', { name: `Chat with ${alex.name}` });
    const blairMessages = blairThread.getByRole('list', { name: `Messages with ${alex.name}` });
    await shows(blairMessages.getByText(old, { exact: true }), 90_000);
    await shows(blairMessages.getByText(young, { exact: true }));

    // The owner sets 30 days for Blair's group: the count first, then the word and the password.
    const chooseThirtyDays = async () => {
      await screen.getByRole('combobox', 'Delete chat messages after', { exact: true }).tap();
      await screen.getByRole('option', '30 days', { exact: true }).tap();
      await screen.getByRole('button', 'Save changes…').tap();
      return screen.getByRole('dialog', `Save the changed rules of ${group.name}?`);
    };
    await app.open(`/admin/policies?group=${group.id}`);
    const dialog = await chooseThirtyDays();
    await expect(dialog.getByText('1 message and 0 files in 1 chat are older than 30 days and will be deleted.', { exact: true })).toBeVisible();
    const save = dialog.getByRole('button', 'Save changes', { exact: true });
    await dialog.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await expect(save).toBeDisabled();
    await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
    await save.tap();
    const undoButton = screen.getByRole('button', 'Undo', { exact: true });
    await expect(undoButton).toBeVisible();

    // Blair, whom the rule reaches, gets the notice with its sentence; Alex, who is not in the group, has nothing to confirm.
    const due = await rulesOf(blair);
    expect(due.policies['chat.retention_days'].value, 'the group\'s rule reaches Blair').toBe(30);
    expect((await rulesOf(alex)).policies['chat.retention_days'].value, 'Alex is not in the group').toBe(null);
    await b.reload();
    const notice = b.getByRole('dialog', { name: NOTICE });
    await shows(notice.getByRole('list', { name: 'Rules in force' }).getByText(/Chat messages are deleted after 30 days/), 60_000);
    await notice.getByRole('button', { name: 'OK' }).click();
    await acknowledge();
    await confirmRules(alex);

    // Undo within the wait: the earlier value is back and nothing was deleted, on the server or in either browser.
    await undoButton.tap();
    const undo = screen.getByRole('dialog', 'Undo the shorter time?');
    await undo.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await undo.getByRole('button', 'Undo', { exact: true }).tap();
    await expect(screen.getByText('Undone', { exact: true })).toBeVisible();
    expect((await rulesOf(blair)).policies['chat.retention_days'].value, 'Undo set the earlier value').toBe(null);
    expect(await stored(), 'nothing was deleted').toBe(2);
    await acknowledge();
    for (const person of [alex, blair]) await confirmRules(person);
    await b.reload();
    await shows(blairMessages.getByText(old, { exact: true }), 60_000);
    await shows(blairMessages.getByText(young, { exact: true }));
    await a.reload();
    await shows(alexMessages.getByText(old, { exact: true }), 60_000);

    // The same rule again; this time the owner ends the wait with the password.
    // (No count here: had the hourly job passed since the first save, the chat would already be at 30 days and count as nothing new.)
    const again = await chooseThirtyDays();
    await again.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
    await again.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await again.getByRole('button', 'Save changes', { exact: true }).tap();
    await expect(undoButton).toBeVisible();
    await screen.getByRole('button', 'Apply now…').tap();
    const apply = screen.getByRole('dialog', 'Start deleting now?');
    await apply.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await apply.getByRole('button', 'Apply now', { exact: true }).tap();
    await expect(screen.getByText('Deleting starts now', { exact: true })).toBeVisible();
    const [row] = await dbRead<{ retention_days: number | null; started: number }>('SELECT retention_days, retention_from <= UTC_TIMESTAMP() AS started FROM chat_conversations WHERE id = ?', [chat]);
    expect(Number(row.retention_days), 'the chat follows Blair\'s 30 days').toBe(30);
    expect(Number(row.started), 'its wait is over').toBe(1);
    await acknowledge();
    for (const person of [alex, blair]) await confirmRules(person);

    // Both chats name the time in force. Blair's device read the old message with its moved time and deletes its copy; the young one stays.
    await b.reload();
    await shows(blairThread.getByText(LINE, { exact: true }), 90_000);
    await expect.poll(() => blairMessages.getByText(old, { exact: true }).count(), { timeout: 90_000 }).toBe(0);
    await shows(blairMessages.getByText(young, { exact: true }));
    await a.reload();
    await shows(alexThread.getByText(LINE, { exact: true }), 90_000);
    await shows(alexMessages.getByText(young, { exact: true }));
    passed = true;
  } finally {
    if (!passed) for (const [index, other] of opened.entries()) await keepScreen(other.page, index ? 'retention-blair' : 'retention-alex');
    for (const other of opened) await other.browser.close();
    await sweep();
  }
});
