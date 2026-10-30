import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { emailsWithSubject, ok, pageApi, setSettings } from '../support/api.ts';
import { outside, people, runId, stack } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { deleteObject, icsValue, listObjects, makeCalendar } from '../support/caldav.ts';
import { onlyOn, openMessage } from '../support/ui.ts';

// Where a new task goes (0.27): the list chooser in the new-task dialog, the
// default task list and calendar from Settings, and the email dialog's start;
// and moving a task to another list (slice 3).

interface Calendar { id: string; name: string; account_id: string; account_provider: string; auto_todo_enabled: boolean; default_for_tasks: boolean; default_for_events: boolean; takes_undated_tasks: boolean; write_block: string | null }

async function calendars(browser: unknown) {
  return ok(await pageApi<{ calendars: Calendar[] }>(browser, 'GET', '/api/calendar/calendars'), 'list calendars').calendars;
}

/** A second UniHub list of the person, shown in ToDo, created for this run. */
async function createList(browser: unknown, name: string) {
  const local = (await calendars(browser)).find(calendar => calendar.account_provider === 'local')!;
  return ok(await pageApi<{ calendar: Calendar }>(browser, 'POST', '/api/calendar/calendars', { account_id: local.account_id, name, auto_todo_enabled: true, color: '#8b5cf6' }), 'create list').calendar;
}

const chooser = (screen: Screen, label: string) => screen.getByRole('dialog').getByRole('combobox', label);

// 27-05: the new-task dialog offers the lists by account; a server calendar is
// greyed out for a task without a date and takes it once the task has a time.
test('[27-05] a new task is made in the chosen list; a server calendar takes only dated tasks', { session: 'admin', tags: ['smoke'], timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const listName = `Errands ${runId()}`;
  await app.open('/todo');
  const list = await createList(browser, listName);
  const created: string[] = [];
  try {
    const server = (await calendars(browser)).find(calendar => calendar.account_provider === 'caldav' && !calendar.write_block);
    await app.open('/todo');
    await screen.getByRole('button', 'New task', { exact: true }).first().tap();
    await chooser(screen, 'List').tap();
    await expect(screen.getByRole('option', new RegExp(listName))).toBeVisible();
    if (server) {
      const option = screen.getByRole('option', new RegExp(server.name));
      await expect(option).toHaveAttribute('aria-disabled', 'true');
      await expect(option).toContainText('Tasks without a date stay in UniHub');
    }
    await screen.getByRole('option', new RegExp(listName)).tap();
    const title = `Buy stamps ${runId()}`;
    await screen.getByLabel('Title', { exact: true }).fill(title);
    await screen.getByRole('button', 'Create task', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    const { events } = ok(await pageApi<{ events: { id: string; title: string; calendar_id: string }[] }>(browser, 'GET', '/api/calendar/events?include_todos=true'), 'list');
    const task = events.find(event => event.title === title)!;
    created.push(task.id);
    expect(task.calendar_id).toBe(list.id);

    if (server) {
      // With a time, the server calendar can be chosen.
      await screen.getByRole('button', 'New task', { exact: true }).first().tap();
      await screen.getByLabel('Give it a time in the calendar').tap();
      await chooser(screen, 'List').tap();
      const option = screen.getByRole('option', new RegExp(server.name));
      await expect(option).not.toHaveAttribute('aria-disabled', 'true');
      await browser.keyboard.press('Escape');
      await screen.getByRole('button', 'Cancel', { exact: true }).tap();
    }
  } finally {
    for (const id of created) await pageApi(browser, 'DELETE', `/api/calendar/events/${id}`);
    await pageApi(browser, 'DELETE', `/api/calendar/calendars/${list.id}`);
  }
});

// 27-06 (agent part): the default task list and default calendar chosen in
// Settings are marked by the server, preselected in the dialogs and used by a
// create without a list; the email dialog starts with the default when the
// device has no last list.
test('[27-06] the default task list and calendar from Settings are preselected and used', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const listName = `Default list ${runId()}`;
  await app.open('/settings');
  const list = await createList(browser, listName);
  const created: string[] = [];
  try {
    await app.open('/settings');
    await screen.getByLabel('New tasks go to', { exact: true }).tap();
    await screen.getByRole('option', new RegExp(listName)).tap();
    await expect(screen.getByLabel('New tasks go to', { exact: true })).toContainText(listName);
    await expect.poll(async () => (await calendars(browser)).find(calendar => calendar.default_for_tasks)?.id).toBe(list.id);

    const server = (await calendars(browser)).find(calendar => calendar.account_provider === 'caldav' && !calendar.write_block);
    if (server) {
      await screen.getByLabel('New events go to', { exact: true }).tap();
      await screen.getByRole('option', new RegExp(server.name)).tap();
      await expect(screen.getByLabel('New events go to', { exact: true })).toContainText(server.name);
      await expect.poll(async () => (await calendars(browser)).find(calendar => calendar.default_for_events)?.id).toBe(server.id);
    }

    // The new-task dialog starts with it; a create without a list lands there.
    await app.open('/todo');
    await screen.getByRole('button', 'New task', { exact: true }).first().tap();
    await expect(chooser(screen, 'List')).toContainText(listName);
    await screen.getByRole('button', 'Cancel', { exact: true }).tap();
    const { event } = ok(await pageApi<{ event: { id: string; calendar_id: string } }>(browser, 'POST', '/api/calendar/events', { title: `No list ${runId()}`, is_todo_only: true, reminders: null }), 'create without a list');
    created.push(event.id);
    expect(event.calendar_id).toBe(list.id);

    if (server) {
      await app.open('/calendar');
      await screen.getByRole('button', 'New event', { visible: true }).first().tap();
      await expect(chooser(screen, 'Calendar')).toContainText(server.name);
      await screen.getByRole('button', 'Cancel', { exact: true }).tap();
    }

    // The email dialog, on a device with no last list, starts with the default.
    await browser.evaluate(() => localStorage.removeItem('email-task-list'));
    const subject = `Default list email ${runId()}`;
    await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [people.admin.mailbox], subject, text: 'A task from this goes to the default list.' });
    await app.open('/mail');
    await openMessage(screen, subject, people.admin.mailbox);
    await screen.getByRole('button', 'Add task').tap();
    await expect(screen.getByRole('dialog').getByRole('radio', listName)).toBeChecked();
    await screen.getByRole('button', 'Cancel', { exact: true }).tap();
  } finally {
    await setSettings(browser, { default_task_list_id: '', default_calendar_id: '' });
    for (const id of created) await pageApi(browser, 'DELETE', `/api/calendar/events/${id}`);
    await pageApi(browser, 'DELETE', `/api/calendar/calendars/${list.id}`);
  }
});

// A default that is gone falls back: Settings says where tasks go now, and a create still works.
test('[27-06] a deleted default list falls back to UniHub’s choice and Settings says so', { session: 'alex', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/settings');
  const list = await createList(browser, `Short-lived ${runId()}`);
  await setSettings(browser, { default_task_list_id: list.id });
  const created: string[] = [];
  try {
    ok(await pageApi(browser, 'DELETE', `/api/calendar/calendars/${list.id}`), 'delete the list');
    await app.open('/settings');
    await expect(screen.getByLabel('New tasks go to', { exact: true })).toContainText('Let UniHub choose');
    await expect(screen.getByText(/The list chosen before is no longer available; new tasks go to /)).toBeVisible();
    const fallback = (await calendars(browser)).find(calendar => calendar.default_for_tasks)!;
    expect(fallback.account_provider).toBe('local');
    const { event } = ok(await pageApi<{ event: { id: string; calendar_id: string } }>(browser, 'POST', '/api/calendar/events', { title: `Fallback ${runId()}`, is_todo_only: true, reminders: null }), 'create');
    created.push(event.id);
    expect(event.calendar_id).toBe(fallback.id);
  } finally {
    await setSettings(browser, { default_task_list_id: '' });
    for (const id of created) await pageApi(browser, 'DELETE', `/api/calendar/events/${id}`);
  }
});

// --- Moving a task to another list ------------------------------------------

interface Task {
  id: string; title: string; calendar_id: string | null; todo_status: string | null;
  subtasks: { id: string; title: string; is_done: boolean }[]; source_email: { subject: string | null } | null;
}

const tasksTitled = async (browser: unknown, title: string) =>
  ok(await pageApi<{ events: Task[] }>(browser, 'GET', '/api/calendar/events?include_todos=true&include_done=true'), 'list tasks').events.filter(task => task.title === title);
const copiesAt = async (collection: string, mailbox: string, title: string) =>
  (await listObjects(collection, mailbox)).filter(object => icsValue(object.ics, 'SUMMARY') === title);

/** The admin's CalDAV account at the stack's Radicale, with extra calendars made there for this run and shown in ToDo. */
async function serverCalendars(browser: unknown, names: string[]) {
  const mailbox = people.admin.mailbox;
  const seeded = (await calendars(browser)).find(calendar => calendar.account_provider === 'caldav' && calendar.name === 'Calendar' && !calendar.write_block);
  test.skip(!seeded, 'needs the seeded CalDAV account');
  const accountId = seeded!.account_id;
  const collections = names.map(name => `${stack.caldavUrl}${mailbox}/${name.toLowerCase().replace(/\W+/g, '-')}/`);
  for (const [index, name] of names.entries()) await makeCalendar(collections[index], mailbox, name);
  const sync = async () => ok(await pageApi(browser, 'POST', `/api/calendar/accounts/${accountId}/sync`, {}), 'sync');
  await sync();
  const found = await calendars(browser);
  const made = names.map(name => found.find(calendar => calendar.name === name)!);
  expect(made.map(calendar => calendar?.account_id)).toEqual(names.map(() => accountId));
  for (const calendar of made) ok(await pageApi(browser, 'PUT', `/api/calendar/calendars/${calendar.id}`, { auto_todo_enabled: true }), 'show in ToDo');
  return {
    accountId, mailbox, collections, calendars: made, sync,
    async remove() {
      for (const collection of collections) await deleteObject(collection, mailbox).catch(() => {});
      await pageApi(browser, 'POST', `/api/calendar/accounts/${accountId}/sync`, {});
    },
  };
}

async function openMoveDialog(screen: Screen, title: string) {
  await screen.getByRole('button', `More actions for ${title}`, { visible: true }).first().tap();
  await screen.getByRole('menuitem', 'Move to another list').tap();
  const dialog = screen.getByRole('dialog', 'Move to another list');
  await dialog.getByRole('combobox', 'New list').tap();
  return dialog;
}

async function moveInUi(screen: Screen, title: string, listName: string) {
  const dialog = await openMoveDialog(screen, title);
  await screen.getByRole('option', new RegExp(`^${listName}`)).tap();
  await dialog.getByRole('button', 'Move', { exact: true }).tap();
  await expect(dialog).toBeHidden();
}

// 27-07 (agent part): "Move to another list" from a UniHub list to a CalDAV
// calendar, between two CalDAV calendars and back. After each move and a
// sync the task is one row, the same one with its subtasks, done state and
// source email, and one object at Radicale, in its new calendar only.
test('[27-07] a task moved between a UniHub list and CalDAV calendars exists once and keeps its subtasks, done state and email', { session: 'admin', timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const id = runId();
  const title = `Prepare board pack ${id}`;
  const subject = `Board pack ${id}`;
  await app.open('/todo');
  const list = await createList(browser, `Move list ${id}`);
  const server = await serverCalendars(browser, [`Move A ${id}`, `Move B ${id}`]);
  const [a, b] = server.calendars;
  const [atA, atB] = server.collections;
  let taskId: string | null = null;
  try {
    // A dated task made from an email, with two subtasks (one done), in the UniHub list.
    await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [server.mailbox], subject, text: 'Please prepare the synthetic board pack.' });
    await expect.poll(async () => (await emailsWithSubject(browser, 'inbox', subject)).length, { timeout: 90_000 }).toBe(1);
    const [email] = await emailsWithSubject(browser, 'inbox', subject);
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    taskId = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', {
      title, calendar_id: list.id, is_todo_only: false, start_time: `${day}T09:00:00.000Z`, end_time: `${day}T10:00:00.000Z`, reminders: null, source_email_id: email.id,
    }), 'create task').event.id;
    for (const step of ['Collect figures', 'Print copies']) ok(await pageApi(browser, 'POST', `/api/calendar/events/${taskId}/subtasks`, { title: step }), 'add subtask');
    const [first] = (await tasksTitled(browser, title))[0].subtasks;
    ok(await pageApi(browser, 'PUT', `/api/calendar/events/${taskId}/subtasks/${first.id}`, { is_done: true }), 'tick subtask');
    const keptOf = (task: Task) => ({ id: task.id, subtasks: task.subtasks.map(step => [step.title, step.is_done]), email: task.source_email?.subject });
    const kept = keptOf((await tasksTitled(browser, title))[0]);
    expect(kept.email).toBe(subject);

    // Once in UniHub, in this calendar, and once at Radicale in the expected collection (or none).
    const assertOnce = async (calendarId: string, at: 'a' | 'b' | null) => {
      for (const round of ['moved', 'after a sync']) {
        if (round !== 'moved') await server.sync();
        const rows = await tasksTitled(browser, title);
        expect(rows.map(task => [task.id, task.calendar_id]), round).toEqual([[taskId, calendarId]]);
        expect(keptOf(rows[0]), round).toEqual(kept);
        const copies = [(await copiesAt(atA, server.mailbox, title)).length, (await copiesAt(atB, server.mailbox, title)).length];
        expect(copies, round).toEqual([at === 'a' ? 1 : 0, at === 'b' ? 1 : 0]);
      }
    };
    for (const [target, at] of [[a, 'a'], [b, 'b'], [list, null]] as const) {
      await app.open('/todo');
      await moveInUi(screen, title, target.name);
      await expect.poll(async () => (await tasksTitled(browser, title))[0]?.calendar_id).toBe(target.id);
      await assertOnce(target.id, at);
    }

    // A done task keeps its done state on the way to the server.
    ok(await pageApi(browser, 'PUT', `/api/calendar/events/${taskId}/todo-status`, { todo_status: 'done' }), 'mark done');
    const moved = ok(await pageApi<{ event: Task; pending?: string }>(browser, 'POST', `/api/calendar/events/${taskId}/move`, { calendar_id: a.id }), 'move done task');
    expect([moved.event.calendar_id, moved.event.todo_status, moved.pending]).toEqual([a.id, 'done', undefined]);
    await assertOnce(a.id, 'a');
    expect((await tasksTitled(browser, title))[0].todo_status).toBe('done');
  } finally {
    if (taskId) await pageApi(browser, 'DELETE', `/api/calendar/events/${taskId}`);
    await server.remove();
    await pageApi(browser, 'DELETE', `/api/calendar/calendars/${list.id}`);
  }
});

// A list that cannot take the task is greyed out with its reason in the move
// dialog, and the server refuses it too: a server calendar for a task without
// a date, and a calendar that takes nothing new (here: its account paused; a
// read-only calendar is refused the same way, see
// api/tests/calendar-move-mysql-integration.test.cts).
test('[27-07] the move dialog greys out lists that cannot take the task, and the server refuses them', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const id = runId();
  await app.open('/todo');
  const list = await createList(browser, `Refusals ${id}`);
  const server = await serverCalendars(browser, [`Server only ${id}`]);
  const [calendar] = server.calendars;
  const created: string[] = [];
  try {
    const undated = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', { title: `Someday ${id}`, calendar_id: list.id, is_todo_only: true, reminders: null }), 'undated').event;
    created.push(undated.id);
    await app.open('/todo');
    await openMoveDialog(screen, undated.title);
    const noDate = screen.getByRole('option', new RegExp(`^${calendar.name}`));
    await expect(noDate).toHaveAttribute('aria-disabled', 'true');
    await expect(noDate).toContainText('Tasks without a date stay in UniHub');
    await browser.keyboard.press('Escape');
    await screen.getByRole('button', 'Cancel', { exact: true }).tap();
    const refused = await pageApi<{ code: string }>(browser, 'POST', `/api/calendar/events/${undated.id}/move`, { calendar_id: calendar.id });
    expect([refused.status, refused.data.code]).toEqual([400, 'CALENDAR_TODO_REMOTE']);

    const day = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const dated = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', {
      title: `Renew lease ${id}`, calendar_id: list.id, is_todo_only: false, start_time: `${day}T09:00:00.000Z`, end_time: `${day}T10:00:00.000Z`, reminders: null,
    }), 'dated').event;
    created.push(dated.id);
    ok(await pageApi(browser, 'PUT', `/api/calendar/accounts/${server.accountId}`, { is_active: false }), 'pause the account');
    try {
      await app.open('/todo');
      await openMoveDialog(screen, dated.title);
      const paused = screen.getByRole('option', new RegExp(`^${calendar.name}`));
      await expect(paused).toHaveAttribute('aria-disabled', 'true');
      await expect(paused).toContainText('Sync is paused');
      await browser.keyboard.press('Escape');
      await screen.getByRole('button', 'Cancel', { exact: true }).tap();
      const blocked = await pageApi<{ code: string }>(browser, 'POST', `/api/calendar/events/${dated.id}/move`, { calendar_id: calendar.id });
      expect([blocked.status, blocked.data.code]).toEqual([409, 'CALENDAR_SYNC_PAUSED']);
    } finally {
      ok(await pageApi(browser, 'PUT', `/api/calendar/accounts/${server.accountId}`, { is_active: true }), 'resume the account');
    }
    expect((await tasksTitled(browser, dated.title)).map(task => task.calendar_id)).toEqual([list.id]);
    expect(await copiesAt(server.collections[0], server.mailbox, dated.title)).toEqual([]);
  } finally {
    for (const taskId of created) await pageApi(browser, 'DELETE', `/api/calendar/events/${taskId}`);
    await server.remove();
    await pageApi(browser, 'DELETE', `/api/calendar/calendars/${list.id}`);
  }
});
