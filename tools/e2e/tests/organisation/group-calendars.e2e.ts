import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, runId } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { adminCalendars, calendarsOf, removeSharedCalendars } from '../calendar/shared-helpers.ts';
import { createGroup, seededId, setManager, sweep } from './organisation-helpers.ts';

// 32-03 and 32-18, three people: alex manages a group and makes its
// calendar on the group's page; he schedules a meeting in it; blair, a
// member, adds her subtask and can neither move nor delete the meeting;
// alex deletes the calendar and the owner finds it under Server ›
// Calendars. Who may do what is the server's rule (api/tests,
// calendar-shares and shared-events).

interface Event { id: string; title: string; subtasks: { title: string; created_by_name: string | null }[] }

async function clean() {
  await removeSharedCalendars();
  await sweep();
}

test('[32-03 32-18] alex makes his group\'s calendar and schedules a meeting; blair adds a subtask and cannot move or delete the meeting; alex deletes the calendar', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await clean();
  try {
    const run = runId();
    const [alexId, blairId] = [await seededId('alex'), await seededId('blair')];
    const group = await createGroup('Support', [alexId, blairId]);
    await setManager(group.id, alexId);
    const [alex, blair] = [await signIn('alex'), await signIn('blair')];
    const name = `e2e Support plan ${run}`;

    await app.open(`/groups/${group.id}`);
    await screen.getByRole('button', 'New calendar', { exact: true }).tap();
    const create = screen.getByRole('dialog', 'New calendar');
    await create.getByLabel('Name', { exact: true }).fill(name);
    await create.getByRole('button', 'Create calendar', { exact: true }).tap();
    await expect(screen.getByRole('list', 'Calendars of the group').getByText(name, { exact: true })).toBeVisible();
    const calendar = (await calendarsOf(blair)).find((entry) => entry.name === name);
    expect(calendar?.permission, 'every member adds subtasks').toBe('contribute');
    expect((await calendarsOf(alex)).find((entry) => entry.name === name)?.permission, 'the manager manages it').toBe('manage');

    // The manager schedules a meeting in it.
    const title = `Support meeting ${run}`;
    await app.open('/calendar');
    await screen.getByRole('radio', 'Day', { exact: true }).tap();
    await expect(screen.getByRole('region', 'Groups').getByText(name, { exact: true })).toBeVisible();
    await screen.getByRole('button', 'New event', { visible: true }).first().tap();
    const event = screen.getByRole('dialog', 'New event');
    await event.getByLabel('Title', { exact: true }).fill(title);
    await event.getByLabel('Calendar', { exact: true }).tap();
    await screen.getByRole('option', name, { exact: true }).tap();
    await event.getByRole('button', 'Create', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    const meeting = ok(await blair<{ events: Event[] }>('GET', `/api/calendar/events?calendar_ids=${calendar!.id}`), 'blair sees the meeting').events.find((entry) => entry.title === title)!;

    // A member adds her subtask; the meeting itself is not hers to move or delete.
    ok(await blair('POST', `/api/calendar/events/${meeting.id}/subtasks`, { title: 'Phone rota' }), 'blair adds a subtask');
    const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    expect((await blair('PUT', `/api/calendar/events/${meeting.id}`, { start_time: later(24), end_time: later(25) })).status, 'a member does not move it').toBe(403);
    expect((await blair('DELETE', `/api/calendar/events/${meeting.id}`)).status, 'a member does not delete it').toBe(403);
    await app.open('/calendar');
    await screen.getByRole('button', new RegExp(title)).first().tap();
    const open = screen.getByRole('dialog', 'Edit event');
    await expect(open.getByRole('checkbox', 'Phone rota', { exact: true })).toBeVisible();
    await expect(open.getByText(people.blair.name).first()).toBeVisible();
    await open.getByRole('button', 'Cancel', { exact: true }).tap();

    // Deleted by the manager, it is gone for the group at once and waits for an administrator.
    await app.open(`/groups/${group.id}`);
    await screen.getByRole('button', `Actions for ${name}`).tap();
    await screen.getByRole('menuitem', 'Delete', { exact: true }).tap();
    await screen.getByRole('alertdialog', `Delete ${name}?`).getByRole('button', 'Delete calendar', { exact: true }).tap();
    await expect(screen.getByText('This group has no calendar yet.', { exact: true })).toBeVisible();
    expect((await calendarsOf(blair)).some((entry) => entry.name === name), 'gone for the members').toBe(false);
    expect((await adminCalendars()).find((entry) => entry.name === name)?.deleted_at, 'kept for an administrator to restore').toBeTruthy();
  } finally {
    await clean();
  }
});
