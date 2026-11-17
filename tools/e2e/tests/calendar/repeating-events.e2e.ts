import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { makeCalendar, removeCalendars } from './shared-helpers.ts';

// 32-17: a weekly meeting in one of UniHub's own calendars. Changed for all
// its dates (moved to the next weekday), every date keeps its id and with it
// its subtasks and its tick; one date is then renamed and deleted on its own.
// How a series is stored and what a change keeps is the server's rule
// (api/tests, calendar-series); here is the dialog a person goes through.

interface Occurrence { id: string; title: string; start_time: string; series_key: string | null; todo_status: string | null; subtasks: { title: string }[] }
const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

test('[32-17] alex makes a weekly meeting, moves all its dates to the next weekday, then renames and deletes one date', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const alex = await signIn('alex');
  await removeCalendars(alex);
  try {
    const run = runId();
    const calendar = await makeCalendar(alex, `e2e Meetings ${run}`);
    const title = `Team meeting ${run}`;
    const dates = async () => ok(await alex<{ events: Occurrence[] }>('GET', `/api/calendar/events?calendar_ids=${calendar.id}`), 'the dates').events
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    const today = new Date();
    const tomorrow = new Date(today.getTime() + DAY);

    await app.open('/calendar');
    await screen.getByRole('radio', 'Day', { exact: true }).tap();
    await screen.getByRole('button', 'New event', { visible: true }).first().tap();
    const create = screen.getByRole('dialog', 'New event');
    await create.getByLabel('Title', { exact: true }).fill(title);
    await create.getByLabel('Calendar', { exact: true }).tap();
    await screen.getByRole('option', calendar.name, { exact: true }).tap();
    await create.getByLabel('Repeat', { exact: true }).tap();
    await screen.getByRole('option', `Weekly on ${WEEKDAYS[today.getUTCDay()]}`, { exact: true }).tap();
    await create.getByRole('button', 'Create', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();

    const made = await dates();
    expect(made.length, 'two years of weekly dates').toBeGreaterThan(100);
    expect(new Set(made.map((date) => date.series_key)).size, 'one series').toBe(1);
    expect(new Date(made[1].start_time).getTime() - new Date(made[0].start_time).getTime(), 'a week apart').toBe(7 * DAY);
    // The second date gets something of its own.
    ok(await alex('POST', `/api/calendar/events/${made[1].id}/subtasks`, { title: 'Agenda' }), 'a subtask on the second date');
    ok(await alex('PUT', `/api/calendar/events/${made[1].id}/todo-status`, { todo_status: 'done' }), 'the second date ticked');

    // All events move to tomorrow's weekday: the rule goes with the new time and no date is made anew.
    await screen.getByRole('button', new RegExp(title)).first().tap();
    const edit = screen.getByRole('dialog', 'Edit event');
    await expect(edit.getByLabel('Repeat', { exact: true })).toContainText(`Weekly on ${WEEKDAYS[today.getUTCDay()]}`);
    const stamp = (hour: string) => `${tomorrow.toISOString().slice(0, 10)}T${hour}`;
    await edit.getByLabel('End', { exact: true }).fill(stamp('10:00'));
    await edit.getByLabel('Start', { exact: true }).fill(stamp('09:00'));
    await expect(edit.getByLabel('Repeat', { exact: true })).toContainText(`Weekly on ${WEEKDAYS[tomorrow.getUTCDay()]}`);
    await edit.getByRole('button', 'Save', { exact: true }).tap();
    const scope = screen.getByRole('alertdialog', 'Change repeating event');
    await expect(scope.getByText(/Each event keeps its ToDo progress and subtasks\./)).toBeVisible();
    await scope.getByRole('button', 'All events', { exact: true }).tap();
    await expect(screen.getByText('Series updated', { exact: true }).first()).toBeVisible();
    const moved = await dates();
    expect(moved.map((date) => date.id), 'every date kept its id').toEqual(made.map((date) => date.id));
    expect(moved.every((date) => new Date(date.start_time).getUTCDay() === tomorrow.getUTCDay()), 'all on the new weekday').toBe(true);
    expect(moved[1], 'the second date kept its subtask and its tick').toMatchObject({ todo_status: 'done', subtasks: [{ title: 'Agenda' }] });
    const rule = ok(await alex<{ event: { repeat: { freq: string; by_day?: string[] } } }>('GET', `/api/calendar/events/${moved[0].id}`), 'the rule').event.repeat;
    expect(rule, 'the rule names the new weekday').toMatchObject({ freq: 'WEEKLY', by_day: [CODES[tomorrow.getUTCDay()]] });

    // One date renamed: only it changes.
    await screen.getByRole('button', 'Next day', { exact: true, visible: true }).first().tap();
    await screen.getByRole('button', new RegExp(title)).first().tap();
    await edit.getByLabel('Title', { exact: true }).fill(`${title} with guests`);
    await edit.getByRole('button', 'Save', { exact: true }).tap();
    await scope.getByRole('button', 'This event', { exact: true }).tap();
    await expect.poll(async () => (await dates()).filter((date) => date.title !== title).map((date) => date.id), { timeout: 20_000, message: 'one date renamed' }).toEqual([made[0].id]);
    await expect(screen.getByRole('dialog')).toBeHidden();

    // One date deleted: it goes to the bin, the series goes on.
    await screen.getByRole('button', new RegExp(`${title} with guests`)).first().tap();
    await edit.getByRole('button', 'Delete', { exact: true }).tap();
    await screen.getByRole('alertdialog', 'Delete repeating event').getByRole('button', 'This event', { exact: true }).tap();
    await expect(screen.getByText('Moved to the bin', { exact: true }).first()).toBeVisible();
    expect((await dates()).map((date) => date.id), 'the other dates stay').toEqual(made.slice(1).map((date) => date.id));
  } finally {
    await removeCalendars(alex);
  }
});
