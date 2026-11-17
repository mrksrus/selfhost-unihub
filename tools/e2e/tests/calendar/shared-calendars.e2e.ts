import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, runId } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createGroup, seededId, sweep } from '../organisation/organisation-helpers.ts';
import { calendarsOf, makeCalendar, removeCalendars, share } from './shared-helpers.ts';

// Shared calendars, three people: blair shares one of her calendars with a
// group; alex, in the group, adds and changes events in it; a calendar shared
// as free/busy shows only "Busy"; leaving the group takes the calendar away;
// a calendar synced from a provider is not shared here. Who may do what is
// the server's rule (api/tests, calendar-shares and shared-events); here is
// what each person sees.

interface Event { id: string; title: string; calendar_id: string; user_id: string | null; reminders: number[] | null; subtasks: { title: string; created_by: string | null }[] }
const eventsOf = async (api: Awaited<ReturnType<typeof signIn>>, calendarId: string) =>
  ok(await api<{ events: Event[] }>('GET', `/api/calendar/events?calendar_ids=${calendarId}`), 'events').events;

async function clean() {
  await removeCalendars(await signIn('blair'));
  await sweep();
}

test('[32-01] blair shares a calendar with a group for editing; a share she can no longer raise offers only lower levels', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await clean();
  try {
    const run = runId();
    const alexId = await seededId('alex');
    const group = await createGroup('Support', [alexId, await seededId('blair')]);
    const blair = await signIn('blair');
    const calendar = await makeCalendar(blair, `e2e Team ${run}`);
    await share(blair, calendar.id, { kind: 'user', id: alexId }, 'read');

    await app.open('/calendar');
    await screen.getByRole('button', `Settings for ${calendar.name}`).tap();
    await screen.getByRole('dialog', calendar.name).getByRole('button', 'Share', { exact: true }).tap();
    const dialog = screen.getByRole('dialog', `Share ${calendar.name}`);
    await dialog.getByRole('combobox', 'What they may do').tap();
    await screen.getByRole('option', 'Can edit', { exact: true }).tap();
    await dialog.getByLabel('Add people or groups', { exact: true }).fill(group.name);
    await dialog.getByRole('button', `Share with ${group.name}`).tap();
    await expect(dialog.getByRole('combobox', `What ${group.name} may do`)).toContainText('Can edit');
    const alex = await signIn('alex');
    expect((await calendarsOf(alex)).find((entry) => entry.id === calendar.id)?.permission, 'alex may edit it through the group').toBe('edit');

    // Alex is in a group with blair, so she may raise his own share.
    const alexLevel = dialog.getByRole('combobox', `What ${people.alex.name} may do`);
    await alexLevel.tap();
    await expect(screen.getByRole('option', 'Can manage', { exact: true })).toBeVisible();
    await screen.getByRole('option', 'Can read', { exact: true }).tap();
    await dialog.getByRole('button', 'Done', { exact: true }).tap();

    // Out of her groups he is out of her reach: the server would refuse a raise, so none is offered.
    ok(await (await signIn('admin'))('DELETE', `/api/groups/${group.id}/members/${alexId}`), 'alex leaves the group');
    await app.open('/calendar');
    await screen.getByRole('button', `Settings for ${calendar.name}`).tap();
    await screen.getByRole('dialog', calendar.name).getByRole('button', 'Share', { exact: true }).tap();
    await expect(dialog.getByRole('combobox', `What ${group.name} may do`)).toBeVisible();
    await alexLevel.tap();
    await expect(screen.getByRole('option', 'Sees busy times', { exact: true })).toBeVisible();
    await expect(screen.getByRole('option', 'Can edit', { exact: true })).toHaveCount(0);
  } finally {
    await clean();
  }
});

test('[32-02 32-06] alex adds, changes, deletes and restores an event in a calendar shared with his group, adds a subtask where he contributes, sees only "Busy" in another, and loses the first on leaving the group', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await clean();
  try {
    const run = runId();
    const alexId = await seededId('alex');
    const group = await createGroup('Support', [alexId, await seededId('blair')]);
    const blair = await signIn('blair');
    const team = await makeCalendar(blair, `e2e Team ${run}`);
    await share(blair, team.id, { kind: 'group', id: group.id }, 'edit');
    const away = await makeCalendar(blair, `e2e Away ${run}`);
    await share(blair, away.id, { kind: 'user', id: alexId }, 'freebusy');
    const now = Date.now();
    const times = { start_time: new Date(now).toISOString(), end_time: new Date(now + 30 * 60_000).toISOString() };
    ok(await blair('POST', '/api/calendar/events', { calendar_id: away.id, title: `Dentist ${run}`, ...times }), 'an event in the free/busy calendar');
    const agenda = await makeCalendar(blair, `e2e Agenda ${run}`);
    await share(blair, agenda.id, { kind: 'user', id: alexId }, 'contribute');
    const planning = ok(await blair<{ event: Event }>('POST', '/api/calendar/events', { calendar_id: agenda.id, title: `Planning ${run}`, ...times }), 'an event to contribute to').event;
    ok(await blair('POST', `/api/calendar/events/${planning.id}/subtasks`, { title: 'Budget' }), "blair's subtask");

    await app.open('/calendar');
    await screen.getByRole('radio', 'Day', { exact: true }).tap();
    const today = screen.getByRole('button', 'Today', { exact: true });
    if (await today.isEnabled()) await today.tap();
    const shared = screen.getByRole('region', 'Shared with me');
    await expect(shared.getByText(team.name, { exact: true })).toBeVisible();
    await expect(shared.getByText(people.blair.name, { exact: true }).first()).toBeVisible();

    // Free/busy: the time shows as "Busy", nothing else of the event.
    await screen.getByRole('button', /Busy/).first().tap();
    await expect(screen.getByRole('dialog', 'Busy').getByText(`You only see when ${people.blair.name} is busy.`, { exact: true })).toBeVisible();
    await expect(screen.getByText(`Dentist ${run}`)).toHaveCount(0);
    await screen.getByRole('dialog', 'Busy').getByRole('button', 'Close', { exact: true }).first().tap();

    // Contribute: the event is read-only, blair's subtask too; alex adds his own.
    await screen.getByRole('button', new RegExp(`Planning ${run}`)).first().tap();
    const contribute = screen.getByRole('dialog', 'Event');
    await expect(contribute.getByText('You can add subtasks here and change your own. The rest is read-only.', { exact: true })).toBeVisible();
    await expect(contribute.getByLabel('Title', { exact: true })).toBeDisabled();
    await expect(contribute.getByRole('checkbox', 'Budget', { exact: true })).toBeDisabled();
    await contribute.getByLabel(`Add a subtask to Planning ${run}`, { exact: true }).fill('Coffee');
    await contribute.getByRole('button', 'Add', { exact: true }).tap();
    await expect(contribute.getByRole('checkbox', 'Coffee', { exact: true })).toBeEnabled();
    expect((await eventsOf(blair, agenda.id))[0].subtasks.find((subtask) => subtask.title === 'Coffee')?.created_by, 'the subtask is alex\'s').toBe(alexId);
    // His reminders on her event are his own.
    await contribute.getByText('15 minutes before', { exact: true }).tap();
    await contribute.getByRole('button', 'Save reminders', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    const mine = ok(await pageApi<{ events: Event[] }>(browser, 'GET', `/api/calendar/events?calendar_ids=${agenda.id}`), 'alex\'s view').events[0];
    expect(mine.reminders, 'alex\'s own reminder').toEqual([15]);
    expect((await eventsOf(blair, agenda.id))[0].reminders ?? [], 'blair\'s reminders are untouched').not.toContain(15);

    // A new event goes into the shared calendar; it is blair's data, made by alex.
    const title = `Stand-up ${run}`;
    await screen.getByRole('button', 'New event', { visible: true }).first().tap();
    const create = screen.getByRole('dialog', 'New event');
    await create.getByLabel('Title', { exact: true }).fill(title);
    await create.getByLabel('Calendar', { exact: true }).tap();
    await expect(screen.getByRole('option', new RegExp(`^${away.name}`))).toHaveCount(0);
    await screen.getByRole('option', team.name, { exact: true }).tap();
    await create.getByRole('button', 'Create', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    const made = (await eventsOf(blair, team.id)).find((event) => event.title === title);
    expect(made?.user_id, 'the event belongs to the calendar\'s owner').toBe(await seededId('blair'));

    await screen.getByRole('button', new RegExp(title)).first().tap();
    const edit = screen.getByRole('dialog', 'Edit event');
    await edit.getByLabel('Title', { exact: true }).fill(`${title} moved`);
    await edit.getByRole('button', 'Save', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    expect((await eventsOf(blair, team.id)).map((event) => event.title), 'blair sees the change').toContain(`${title} moved`);

    // Deleted from the shared calendar, it waits in that calendar's own bin, where an editor restores it.
    await screen.getByRole('button', new RegExp(`${title} moved`)).first().tap();
    await screen.getByRole('dialog', 'Edit event').getByRole('button', 'Delete', { exact: true }).tap();
    await expect(screen.getByText('Moved to the bin', { exact: true }).first()).toBeVisible();
    expect(await eventsOf(blair, team.id), 'gone from the calendar').toHaveLength(0);
    await screen.getByRole('button', 'Bin', { exact: true, visible: true }).first().tap();
    await screen.getByRole('radio', new RegExp(`^${team.name}`)).tap();
    await screen.getByRole('list', 'Deleted items').getByRole('button', `Restore ${title} moved`).tap();
    await expect(screen.getByText('Restored', { exact: true }).first()).toBeVisible();
    expect((await eventsOf(blair, team.id)).map((event) => event.title), 'back in the calendar').toContain(`${title} moved`);

    // Out of the group, the group's calendar is gone at the next load.
    ok(await (await signIn('admin'))('DELETE', `/api/groups/${group.id}/members/${alexId}`), 'alex leaves the group');
    await app.open('/calendar');
    await expect(shared.getByText(away.name, { exact: true })).toBeVisible();
    await expect(screen.getByText(team.name, { exact: true })).toHaveCount(0);
    await expect(screen.getByText(`${title} moved`)).toHaveCount(0);
  } finally {
    await clean();
  }
});

test('[32-07] a calendar synced from a provider offers no Share', { session: 'admin', timeout: 120_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/calendar');
  await screen.getByRole('region', `${people.admin.name} (CalDAV)`).getByRole('button', /^Settings for /).first().tap();
  const dialog = screen.getByRole('dialog');
  await expect(dialog.getByText('Shared at its provider', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', 'Share', { exact: true })).toHaveCount(0);
});
