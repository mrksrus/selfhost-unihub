import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { ok, pageApi } from '../support/api.ts';
import { people, runId } from '../support/env.ts';
import { collectionUrl, waitForSummary } from '../support/caldav.ts';
import { onlyOn } from '../support/ui.ts';

// The hand order of tasks that live in a calendar server's calendar (0.27, D32):
// the order is UniHub's own overlay keyed by the item's UID, so a sync that
// rewrites the rows keeps it, and nothing about order reaches the server.

const mailbox = people.admin.mailbox;
const account = `${people.admin.name} (CalDAV)`;

interface Calendar { id: string; name: string; account_provider: string; auto_todo_enabled: boolean; write_block: string | null }
interface Task { id: string; title: string; sort_rank?: number; hand_ordered?: boolean; calendar_id: string | null }

async function syncCalendar(screen: Screen) {
  await screen.getByRole('button', `Actions for ${account}`, { visible: true }).tap();
  await screen.getByRole('menuitem', 'Sync now').tap();
}

async function tasksOf(browser: unknown, prefix: string) {
  const { events } = ok(await pageApi<{ events: Task[] }>(browser, 'GET', '/api/calendar/events?include_todos=true&respect_auto_todo=true'), 'list tasks');
  return events.filter(task => task.title.startsWith(prefix)).sort((a, b) => (a.sort_rank ?? 0) - (b.sort_rank ?? 0) || a.id.localeCompare(b.id));
}

// 27-01 (server calendar): two dated tasks in the CalDAV calendar with ToDo on are
// ordered by hand; Sync now re-reads the server copies and the order stays, and the
// server's objects carry nothing about it.
test('[27-01 D32] the hand order of tasks in a CalDAV calendar survives a sync and stays in UniHub', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const prefix = `Server order ${runId()}`;
  await app.open('/calendar');
  const calendar = ok(await pageApi<{ calendars: Calendar[] }>(browser, 'GET', '/api/calendar/calendars'), 'calendars').calendars
    .find(entry => entry.account_provider === 'caldav' && entry.name === 'Calendar' && !entry.write_block);
  test.skip(!calendar, 'needs the seeded CalDAV calendar');
  const wasTodo = calendar!.auto_todo_enabled;
  ok(await pageApi(browser, 'PUT', `/api/calendar/calendars/${calendar!.id}`, { auto_todo_enabled: true }), 'show the calendar in ToDo');
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const made: Task[] = [];
  try {
    for (const [index, hour] of ['09', '11'].entries()) {
      const { event } = ok(await pageApi<{ event: Task }>(browser, 'POST', '/api/calendar/events', {
        title: `${prefix} ${index + 1}`, calendar_id: calendar!.id, is_todo_only: false, start_time: `${day}T${hour}:00:00.000Z`, end_time: `${day}T${hour}:30:00.000Z`, reminders: null,
      }), `create task ${index + 1}`);
      made.push(event);
    }
    // Both reached the server.
    for (const task of made) await waitForSummary(collectionUrl(mailbox), mailbox, task.title);
    expect((await tasksOf(browser, prefix)).map(task => task.title)).toEqual([`${prefix} 1`, `${prefix} 2`]);

    // Placed by hand: 2 above 1.
    ok(await pageApi(browser, 'PUT', `/api/calendar/events/${made[1].id}/position`, { after: null, before: made[0].id }), 'place');
    expect((await tasksOf(browser, prefix)).map(task => [task.title, task.hand_ordered])).toEqual([[`${prefix} 2`, true], [`${prefix} 1`, false]]);

    // A sync re-reads the server copies; the order is keyed by their UIDs and stays.
    await app.open('/calendar');
    await syncCalendar(screen);
    await expect.poll(async () => (await tasksOf(browser, prefix)).map(task => [task.title, task.hand_ordered]), { timeout: 60_000 })
      .toEqual([[`${prefix} 2`, true], [`${prefix} 1`, false]]);
    await app.open('/todo');
    const rows = screen.getByRole('region', 'Later').getByRole('listitem').filter({ hasText: prefix });
    await expect(rows.first()).toContainText(`${prefix} 2`);

    // Nothing about order was written to the server (D32).
    const stored = await waitForSummary(collectionUrl(mailbox), mailbox, `${prefix} 2`);
    expect(stored.ics).not.toMatch(/SORT-ORDER/i);
  } finally {
    const current = await tasksOf(browser, prefix);
    for (const task of current) await pageApi(browser, 'DELETE', `/api/calendar/events/${task.id}`);
    await pageApi(browser, 'PUT', `/api/calendar/calendars/${calendar!.id}`, { auto_todo_enabled: wasTodo });
  }
});
