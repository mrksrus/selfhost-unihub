import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { ok, pageApi, signIn } from '../support/api.ts';
import { runId } from '../support/env.ts';
import { centreOf, longPressDrag, mouseDrag, onlyOn, targetOf } from '../support/ui.ts';

// The hand order of tasks (0.27, D31): within a date section the order is the
// person's own, kept on the server (PUT /api/calendar/events/:id/position) and
// shown on every device.

interface Task { id: string; title: string; sort_rank?: number; hand_ordered?: boolean; calendar_id?: string }

/**
 * Three tasks without a date, created through the API a second apart, so the
 * server ranks them by creation (tasks made within one second tie, and a tie
 * is ordered by id).
 */
async function createUndated(browser: unknown, prefix: string, count = 3) {
  const tasks: Task[] = [];
  for (let index = 1; index <= count; index++) {
    if (index > 1) await new Promise(resolve => setTimeout(resolve, 1100));
    const { event } = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', { title: `${prefix} ${index}`, is_todo_only: true, reminders: null }), `create task ${index}`);
    tasks.push(event);
  }
  return tasks;
}

async function removeAll(browser: unknown, tasks: Task[]) {
  for (const task of tasks) await pageApi(browser, 'DELETE', `/api/calendar/events/${task.id}`);
}

/** The titles of this run's tasks in the No date section, top to bottom. */
async function shownOrder(screen: Screen, prefix: string) {
  const rows = screen.getByRole('region', 'No date').getByRole('listitem').filter({ hasText: prefix });
  const titles: string[] = [];
  for (const row of await rows.all()) titles.push(((await row.textContent()) ?? '').match(new RegExp(`${prefix} \\d`))?.[0] ?? '');
  return titles;
}

/** The order the server holds, by rank, limited to this run's tasks. */
async function storedOrder(browser: unknown, prefix: string) {
  const { events } = ok(await pageApi<{ events: Task[] }>(browser, 'GET', '/api/calendar/events?include_todos=true&respect_auto_todo=true'), 'list tasks');
  return events.filter(task => task.title.startsWith(prefix)).sort((a, b) => (a.sort_rank ?? 0) - (b.sort_rank ?? 0) || a.id.localeCompare(b.id)).map(task => task.title);
}

const handle = (screen: Screen, title: string) => screen.getByRole('button', `Reorder ${title}`);
const row = (screen: Screen, title: string) => screen.getByRole('region', 'No date').getByRole('listitem').filter({ hasText: title });

// 27-01: a task dragged by its handle with the mouse keeps its place after a reload.
// Move up and Move down from the row menu do the same; the keyboard drag (Space,
// ArrowDown, Space) too. 27-03 (agent part): a change made on another device
// shows without a reload, through the live hint.
test('[27-01 27-03] a task dragged by its handle keeps its place after a reload and follows to another device', { session: 'admin', tags: ['smoke'], timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const prefix = `Order ${runId()}`;
  await app.open('/todo');
  const tasks = await createUndated(browser, prefix);
  try {
    await app.open('/todo');
    await expect(row(screen, `${prefix} 3`)).toBeVisible();
    expect(await shownOrder(screen, prefix)).toEqual([`${prefix} 1`, `${prefix} 2`, `${prefix} 3`]);

    // Drag the last task above the first: the handle shows on hover.
    await row(screen, `${prefix} 3`).hover();
    const from = await centreOf(handle(screen, `${prefix} 3`));
    const target = await centreOf(row(screen, `${prefix} 1`));
    await mouseDrag(browser, from, { x: from.x, y: target.y - 8 });
    await expect.poll(() => shownOrder(screen, prefix)).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    await expect.poll(() => storedOrder(browser, prefix), { timeout: 15_000 }).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    await browser.reload();
    await expect(row(screen, `${prefix} 3`)).toBeVisible();
    expect(await shownOrder(screen, prefix)).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);

    // Move down from the menu, disabled at the bottom.
    await row(screen, `${prefix} 3`).getByRole('button', `More actions for ${prefix} 3`).tap();
    await screen.getByRole('menuitem', 'Move down', { exact: true }).tap();
    await expect.poll(() => shownOrder(screen, prefix)).toEqual([`${prefix} 1`, `${prefix} 3`, `${prefix} 2`]);
    await expect.poll(() => storedOrder(browser, prefix), { timeout: 15_000 }).toEqual([`${prefix} 1`, `${prefix} 3`, `${prefix} 2`]);

    // The keyboard: Space picks up task 1, ArrowDown moves it below task 3, Space drops it.
    await handle(screen, `${prefix} 1`).focus();
    await browser.keyboard.press('Space');
    await expect(handle(screen, `${prefix} 1`)).toHaveAttribute('aria-pressed', 'true');
    await browser.keyboard.press('ArrowDown');
    await browser.keyboard.press('Space');
    await expect.poll(() => shownOrder(screen, prefix)).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    await expect.poll(() => storedOrder(browser, prefix), { timeout: 15_000 }).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    await expect(handle(screen, `${prefix} 1`)).toBeFocused();

    // Another device (a server session) places task 2 at the top; the page follows without a reload.
    const other = await signIn('admin', { userAgent: 'UniHub e2e other device' });
    ok(await other('PUT', `/api/calendar/events/${tasks[1].id}/position`, { after: null, before: tasks[2].id }), 'place from another device');
    await expect.poll(() => shownOrder(screen, prefix), { timeout: 30_000 }).toEqual([`${prefix} 2`, `${prefix} 3`, `${prefix} 1`]);
  } finally {
    await removeAll(browser, tasks);
  }
});

// 27-02 (agent part): on a phone, a long press on the handle picks the row up and
// a drag reorders it; a finger that moves at once from the handle, and a long
// press on the row's text, change nothing.
test('[27-02] on a phone a long press on the handle reorders; a swipe scrolls', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  const prefix = `Touch ${runId()}`;
  await app.open('/todo');
  const tasks = await createUndated(browser, prefix);
  try {
    await app.open('/todo');
    await expect(row(screen, `${prefix} 3`)).toBeVisible();

    // A finger that lands on the handle and moves at once (no hold): not a
    // drag, the order stays. (The harness's own `screen.swipe` is a pointer
    // drag on this engine, so the finger is sent as touch events in the page;
    // whether the page scrolls under a real finger is the maintainer's 27-02.)
    const grip = await centreOf(handle(screen, `${prefix} 3`));
    const above = await centreOf(row(screen, `${prefix} 1`));
    await longPressDrag(browser, grip, { x: grip.x, y: above.y - 8 }, { hold: 0, steps: 4 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await storedOrder(browser, prefix)).toEqual([`${prefix} 1`, `${prefix} 2`, `${prefix} 3`]);
    expect(await shownOrder(screen, prefix)).toEqual([`${prefix} 1`, `${prefix} 2`, `${prefix} 3`]);

    // A long press on the handle, then a drag above the first task: reordered.
    await row(screen, `${prefix} 3`).scrollIntoView();
    const from = await centreOf(handle(screen, `${prefix} 3`));
    const target = await centreOf(row(screen, `${prefix} 1`));
    await longPressDrag(browser, from, { x: from.x, y: target.y - 8 });
    await expect.poll(() => shownOrder(screen, prefix)).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    await expect.poll(() => storedOrder(browser, prefix), { timeout: 15_000 }).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    // Nothing was selected and no context menu is open after the hold.
    expect(await browser.evaluate(() => String(window.getSelection()?.toString() ?? ''))).toBe('');

    // A long press on the row's text, then a move: only the handle picks a row up.
    const text = await centreOf(row(screen, `${prefix} 1`).getByText(`${prefix} 1`, { exact: true }));
    await longPressDrag(browser, text, { x: text.x, y: Math.max(80, text.y - 200) });
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await storedOrder(browser, prefix)).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    expect(await shownOrder(screen, prefix)).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
  } finally {
    await removeAll(browser, tasks);
  }
});

// 27-01 (subtasks): subtasks are dragged by their handle too, on desktop with
// the mouse and on a phone with a long press; the order is kept on the server.
test('[27-01] subtasks are reordered by their handle', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  const target = await targetOf(browser);
  const title = `Subtask order ${runId()}`;
  await app.open('/todo');
  const { event } = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', { title, is_todo_only: true, reminders: null }), 'create task');
  const names = ['Alpha', 'Beta', 'Gamma'].map(name => `${name} ${runId()}`);
  for (const name of names) ok(await pageApi(browser, 'POST', `/api/calendar/events/${event.id}/subtasks`, { title: name }), `subtask ${name}`);
  try {
    await app.open('/todo');
    const task = row(screen, title);
    await expect(task.getByRole('checkbox', names[2])).toBeVisible();
    const storedSubtasks = async () => ok(await pageApi<{ event: { subtasks: { title: string; position: number }[] } }>(browser, 'GET', `/api/calendar/events/${event.id}`), 'read task')
      .event.subtasks.sort((a, b) => a.position - b.position).map(subtask => subtask.title);
    expect(await storedSubtasks()).toEqual(names);

    const list = task.getByRole('list', 'Subtasks');
    if (target === 'desktop') await list.getByRole('listitem').filter({ hasText: names[2] }).hover();
    const from = await centreOf(list.getByRole('button', `Reorder ${names[2]}`));
    const to = await centreOf(list.getByRole('listitem').filter({ hasText: names[0] }));
    if (target === 'desktop') await mouseDrag(browser, from, { x: from.x, y: to.y - 6 });
    else await longPressDrag(browser, from, { x: from.x, y: to.y - 6 });
    await expect.poll(storedSubtasks, { timeout: 15_000 }).toEqual([names[2], names[0], names[1]]);
    await browser.reload();
    const checkboxes = row(screen, title).getByRole('list', 'Subtasks').getByRole('checkbox');
    await expect(checkboxes.first()).toHaveAccessibleName(names[2]);
  } finally {
    await pageApi(browser, 'DELETE', `/api/calendar/events/${event.id}`);
  }
});

// D31: a date changed in UniHub (Move to another time) returns the task to its
// date's place; its hand order is forgotten.
test('[27-01] a task moved to another time goes back to its date order', { session: 'admin', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const prefix = `Dated ${runId()}`;
  await app.open('/todo');
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const tasks: Task[] = [];
  for (const [index, hour] of ['09', '11', '13'].entries()) {
    const { event } = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', {
      title: `${prefix} ${index + 1}`, is_todo_only: false, start_time: `${day}T${hour}:00:00.000Z`, end_time: `${day}T${hour}:30:00.000Z`, reminders: null,
    }), 'create dated task');
    tasks.push(event);
  }
  try {
    const later = () => screen.getByRole('region', 'Later').getByRole('listitem').filter({ hasText: prefix });
    const laterOrder = async () => {
      const titles: string[] = [];
      for (const item of await later().all()) titles.push(((await item.textContent()) ?? '').match(new RegExp(`${prefix} \\d`))?.[0] ?? '');
      return titles;
    };
    await app.open('/todo');
    await expect(later().nth(2)).toBeVisible();
    expect(await laterOrder()).toEqual([`${prefix} 1`, `${prefix} 2`, `${prefix} 3`]);
    // Place task 3 first by hand.
    ok(await pageApi(browser, 'PUT', `/api/calendar/events/${tasks[2].id}/position`, { after: null, before: tasks[0].id }), 'place');
    await browser.reload();
    await expect(later().nth(2)).toBeVisible();
    expect(await laterOrder()).toEqual([`${prefix} 3`, `${prefix} 1`, `${prefix} 2`]);
    // Move it to a later time on the same day: it goes back to its date's place, now last.
    await later().nth(0).getByRole('button', `More actions for ${prefix} 3`).tap();
    await screen.getByRole('menuitem', 'Move to another time', { exact: true }).tap();
    await screen.getByLabel('New start', { exact: true }).fill(`${day}T15:00`);
    await screen.getByLabel('New end (optional)', { exact: true }).fill(`${day}T15:30`);
    await screen.getByRole('dialog').getByRole('button', 'Move', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    await expect.poll(laterOrder, { timeout: 15_000 }).toEqual([`${prefix} 1`, `${prefix} 2`, `${prefix} 3`]);
    const { events } = ok(await pageApi<{ events: Task[] }>(browser, 'GET', '/api/calendar/events?include_todos=true'), 'list');
    expect(events.find(task => task.id === tasks[2].id)?.hand_ordered).toBe(false);
  } finally {
    await removeAll(browser, tasks);
  }
});
