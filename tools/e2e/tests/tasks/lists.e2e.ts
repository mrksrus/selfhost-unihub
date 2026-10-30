import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { ok, pageApi, setSettings } from '../support/api.ts';
import { outside, people, runId } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { onlyOn, openMessage } from '../support/ui.ts';

// Where a new task goes (0.27): the list chooser in the new-task dialog, the
// default task list and calendar from Settings, and the email dialog's start.
// The move between lists (stream B) extends this file.

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
