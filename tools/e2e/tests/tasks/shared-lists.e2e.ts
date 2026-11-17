import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { people, runId } from '../support/env.ts';
import { ok, pageApi, signIn, type ApiCall } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createGroup, seededId, sweep } from '../organisation/organisation-helpers.ts';
import { makeCalendar, removeCalendars, share } from '../calendar/shared-helpers.ts';

// A shared task list (a calendar shared for editing): two people tick tasks
// in the one list, and each keeps their own order of it.

interface Task { id: string; title: string; todo_status: string | null; sort_rank?: number }

const row = (screen: Screen, title: string) => screen.getByRole('listitem').filter({ hasText: title });
const openOrder = (tasks: Task[], prefix: string) => tasks.filter((task) => task.title.startsWith(prefix) && task.todo_status !== 'done')
  .sort((a, b) => (a.sort_rank ?? 0) - (b.sort_rank ?? 0) || a.id.localeCompare(b.id)).map((task) => task.title);
const listed = async (call: Promise<{ status: number; data: { events: Task[] } }>) => ok(await call, 'tasks').events;
const TASKS = '/api/calendar/events?include_todos=true&respect_auto_todo=true';

test('[32-04] two people tick tasks in one shared list, and each keeps their own order', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const blair: ApiCall = await signIn('blair');
  const clean = async () => { await removeCalendars(blair); await sweep(); };
  await clean();
  try {
    const run = runId();
    const prefix = `Chore ${run}`;
    const list = await makeCalendar(blair, `e2e Chores ${run}`);
    // A member shares with the people of her own groups.
    const alexId = await seededId('alex');
    await createGroup('Household', [alexId, await seededId('blair')]);
    await share(blair, list.id, { kind: 'user', id: alexId }, 'edit');
    const tasks: Task[] = [];
    for (let index = 1; index <= 4; index++) {
      // A second apart, so the server ranks them by creation.
      if (index > 1) await new Promise((resolve) => setTimeout(resolve, 1100));
      tasks.push(ok(await blair<{ event: Task }>('POST', '/api/calendar/events', { calendar_id: list.id, title: `${prefix} ${index}`, is_todo_only: true, reminders: null }), `task ${index}`).event);
    }

    await app.open('/todo');
    // The list is blair's, and the row says so.
    await expect(row(screen, `${prefix} 1`).getByText(people.blair.name, { exact: true })).toBeVisible();

    // Alex ticks one; blair has it done.
    await screen.getByRole('button', `Mark ${prefix} 1 done`).tap();
    await expect(row(screen, `${prefix} 1`)).toHaveCount(0);
    expect((await listed(blair('GET', TASKS))).find((task) => task.id === tasks[0].id)?.todo_status, 'done for blair too').toBe('done');

    // Blair ticks another; it leaves alex's open tasks.
    ok(await blair('PUT', `/api/calendar/events/${tasks[1].id}/todo-status`, { todo_status: 'done' }), 'blair ticks a task');
    await app.open('/todo');
    await expect(row(screen, `${prefix} 3`)).toBeVisible();
    await expect(row(screen, `${prefix} 2`)).toHaveCount(0);

    // Alex puts the last task first: his order, not blair's.
    await screen.getByRole('button', `More actions for ${prefix} 4`).tap();
    await screen.getByRole('menuitem', 'Move up', { exact: true }).tap();
    await expect.poll(async () => openOrder(await listed(pageApi(browser, 'GET', TASKS)), prefix)).toEqual([`${prefix} 4`, `${prefix} 3`]);
    expect(openOrder(await listed(blair('GET', TASKS)), prefix), 'blair keeps her own order').toEqual([`${prefix} 3`, `${prefix} 4`]);
  } finally {
    await clean();
  }
});
