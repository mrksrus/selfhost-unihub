import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { emailsWithSubject, ok, pageApi } from '../support/api.ts';
import { outside, people, runId, stack } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { deleteObject, icsValue, listObjects, makeCalendar } from '../support/caldav.ts';
import { onlyOn } from '../support/ui.ts';

// Moving a task to another list (0.27, slice 3; the move part of
// tasks/lists.e2e.ts, kept apart so the two streams' files merge cleanly):
// "Move to another list" from a UniHub list to a CalDAV calendar, between two
// CalDAV calendars, and back. After every move and a sync, the task is one
// row in UniHub, the same row with its subtasks, done state and source email,
// and one object at Radicale, in the new calendar only.

const mailbox = people.admin.mailbox;

interface Calendar { id: string; name: string; account_id: string; account_provider: string; write_block: string | null }
interface Task {
  id: string; title: string; calendar_id: string | null; todo_status: string | null;
  subtasks: { title: string; is_done: boolean }[]; source_email: { subject: string | null } | null;
}

const calendars = async (browser: unknown) => ok(await pageApi<{ calendars: Calendar[] }>(browser, 'GET', '/api/calendar/calendars'), 'list calendars').calendars;
const tasksTitled = async (browser: unknown, title: string) =>
  ok(await pageApi<{ events: Task[] }>(browser, 'GET', '/api/calendar/events?include_todos=true&include_done=true'), 'list tasks').events.filter(task => task.title === title);
const copiesAt = async (collection: string, title: string) => (await listObjects(collection, mailbox)).filter(object => icsValue(object.ics, 'SUMMARY') === title);

async function moveInUi(screen: Screen, title: string, listName: string) {
  await screen.getByRole('button', `More actions for ${title}`, { visible: true }).first().tap();
  await screen.getByRole('menuitem', 'Move to another list').tap();
  const dialog = screen.getByRole('dialog', 'Move to another list');
  await dialog.getByRole('combobox', 'New list').tap();
  await screen.getByRole('option', new RegExp(`^${listName}`)).tap();
  await dialog.getByRole('button', 'Move', { exact: true }).tap();
  await expect(dialog).toBeHidden();
}

// 27-07 (agent part): local → CalDAV, CalDAV A → B and CalDAV → local, once at
// the server and once in UniHub after a sync, with what UniHub keeps of its own.
test('[27-07] a task moved between a UniHub list and CalDAV calendars exists once and keeps its subtasks, done state and email', { session: 'admin', timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const names = { list: `Move list ${id}`, a: `Move A ${id}`, b: `Move B ${id}` };
  const collections = { a: `${stack.caldavUrl}${mailbox}/move-a-${id}/`, b: `${stack.caldavUrl}${mailbox}/move-b-${id}/` };
  const title = `Prepare board pack ${id}`;
  const subject = `Board pack ${id}`;
  await app.open('/todo');
  const local = (await calendars(browser)).find(calendar => calendar.account_provider === 'local')!;
  const list = ok(await pageApi<{ calendar: Calendar }>(browser, 'POST', '/api/calendar/calendars', { account_id: local.account_id, name: names.list, auto_todo_enabled: true, color: '#8b5cf6' }), 'create list').calendar;
  const server = (await calendars(browser)).find(calendar => calendar.account_provider === 'caldav' && calendar.name === 'Calendar' && !calendar.write_block);
  test.skip(!server, 'needs the seeded CalDAV account');
  const accountId = server!.account_id;
  const syncNow = async () => ok(await pageApi(browser, 'POST', `/api/calendar/accounts/${accountId}/sync`, {}), 'sync');
  let taskId: string | null = null;
  try {
    // Two more calendars at Radicale, as another client would make them; ToDo shows both.
    await makeCalendar(collections.a, mailbox, names.a);
    await makeCalendar(collections.b, mailbox, names.b);
    await syncNow();
    const found = await calendars(browser);
    const a = found.find(calendar => calendar.name === names.a)!;
    const b = found.find(calendar => calendar.name === names.b)!;
    expect([a?.account_id, b?.account_id]).toEqual([accountId, accountId]);
    for (const calendar of [a, b]) ok(await pageApi(browser, 'PUT', `/api/calendar/calendars/${calendar.id}`, { auto_todo_enabled: true }), 'show in ToDo');

    // A dated task made from an email, with two subtasks (one done), in the UniHub list.
    await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Please prepare the synthetic board pack.' });
    await expect.poll(async () => (await emailsWithSubject(browser, 'inbox', subject)).length, { timeout: 90_000 }).toBe(1);
    const [email] = await emailsWithSubject(browser, 'inbox', subject);
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    taskId = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', {
      title, calendar_id: list.id, is_todo_only: false, start_time: `${day}T09:00:00.000Z`, end_time: `${day}T10:00:00.000Z`, reminders: null, source_email_id: email.id,
    }), 'create task').event.id;
    for (const step of ['Collect figures', 'Print copies']) ok(await pageApi(browser, 'POST', `/api/calendar/events/${taskId}/subtasks`, { title: step }), 'add subtask');
    const [first] = (await tasksTitled(browser, title))[0].subtasks as (Task['subtasks'][number] & { id: string })[];
    ok(await pageApi(browser, 'PUT', `/api/calendar/events/${taskId}/subtasks/${first.id}`, { is_done: true }), 'tick subtask');
    const keptOf = (task: Task) => ({ id: task.id, subtasks: task.subtasks.map(step => [step.title, step.is_done]), email: task.source_email?.subject });
    const kept = keptOf((await tasksTitled(browser, title))[0]);
    expect(kept.email).toBe(subject);

    // Once in UniHub, in this calendar, and once at the server in the expected collection (or none).
    const assertOnce = async (calendarId: string, at: 'a' | 'b' | null) => {
      for (const round of ['moved', 'after a sync']) {
        if (round !== 'moved') await syncNow();
        const rows = await tasksTitled(browser, title);
        expect(rows.map(task => [task.id, task.calendar_id]), round).toEqual([[taskId, calendarId]]);
        expect(keptOf(rows[0]), round).toEqual(kept);
        expect([(await copiesAt(collections.a, title)).length, (await copiesAt(collections.b, title)).length], round).toEqual([at === 'a' ? 1 : 0, at === 'b' ? 1 : 0]);
      }
    };

    // Through the row menu: UniHub list → A → B → UniHub list.
    await app.open('/todo');
    await moveInUi(screen, title, names.a);
    await expect.poll(async () => (await tasksTitled(browser, title))[0]?.calendar_id).toBe(a.id);
    await assertOnce(a.id, 'a');
    await app.open('/todo');
    await moveInUi(screen, title, names.b);
    await expect.poll(async () => (await tasksTitled(browser, title))[0]?.calendar_id).toBe(b.id);
    await assertOnce(b.id, 'b');
    await app.open('/todo');
    await moveInUi(screen, title, names.list);
    await expect.poll(async () => (await tasksTitled(browser, title))[0]?.calendar_id).toBe(list.id);
    await assertOnce(list.id, null);

    // A done task keeps its done state on the way to the server.
    ok(await pageApi(browser, 'PUT', `/api/calendar/events/${taskId}/todo-status`, { todo_status: 'done' }), 'mark done');
    const moved = ok(await pageApi<{ event: Task; pending?: string }>(browser, 'POST', `/api/calendar/events/${taskId}/move`, { calendar_id: a.id }), 'move done task');
    expect([moved.event.calendar_id, moved.event.todo_status, moved.pending]).toEqual([a.id, 'done', undefined]);
    await assertOnce(a.id, 'a');
    expect((await tasksTitled(browser, title))[0].todo_status).toBe('done');

    // A task without a date cannot go to a server calendar; the server says why.
    const undated = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', { title: `Someday ${id}`, calendar_id: list.id, is_todo_only: true, reminders: null }), 'undated').event;
    const refused = await pageApi<{ code: string }>(browser, 'POST', `/api/calendar/events/${undated.id}/move`, { calendar_id: b.id });
    expect([refused.status, refused.data.code]).toEqual([400, 'CALENDAR_TODO_REMOTE']);
    await pageApi(browser, 'DELETE', `/api/calendar/events/${undated.id}`);
  } finally {
    if (taskId) await pageApi(browser, 'DELETE', `/api/calendar/events/${taskId}`);
    for (const collection of Object.values(collections)) await deleteObject(collection, mailbox).catch(() => {});
    await pageApi(browser, 'POST', `/api/calendar/accounts/${accountId}/sync`, {});
    await pageApi(browser, 'DELETE', `/api/calendar/calendars/${list.id}`);
  }
});
