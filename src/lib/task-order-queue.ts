import type { QueryClient } from '@tanstack/react-query';
import { calendarQueryKeys, invalidateCalendarQueries, type CalendarEvent, type CalendarSubtask } from '@/lib/calendar-api';
import { optimisticRanks } from '@/lib/tasks';

/**
 * A change to the shown order whose request is queued or in flight, kept as
 * positions (not ranks), so it can be laid over whatever the cache holds at
 * the time: the list as fetched, or the server's ranks from an earlier answer.
 */
export type OrderChange =
  | { kind: 'place'; id: string; order: readonly string[] }
  | { kind: 'subtasks'; eventId: string; ids: readonly string[] }
  | { kind: 'move'; id: string };

type EventLists = CalendarEvent[] | undefined;
const EVENT_LISTS = { queryKey: calendarQueryKeys.all };
const isEventList = (queryKey: readonly unknown[]) => queryKey[0] === calendarQueryKeys.all[0];
const noop = () => {};

interface TaskWrites {
  /** Queued and in-flight changes, oldest first; the first is the one in flight. */
  changes: OrderChange[];
  tail: Promise<void>;
}

// One queue per QueryClient, and SessionQueryProvider makes one client per
// signed-in session: a request of an earlier session never lands in the next
// one's cache, and its callbacks are guarded by the session scope anyway.
const writesByClient = new WeakMap<QueryClient, TaskWrites>();

function writesFor(client: QueryClient): TaskWrites {
  const known = writesByClient.get(client);
  if (known) return known;
  const writes: TaskWrites = { changes: [], tail: Promise.resolve() };
  writesByClient.set(client, writes);
  // A list fetched for another reason while writes are pending (a live-update
  // hint, another page's refresh, a window focus) would show the order from
  // before them; the pending changes are laid over its answer again.
  client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual || !writes.changes.length) return;
    if (!isEventList(event.query.queryKey) || !Array.isArray(event.action.data)) return;
    client.setQueryData<EventLists>(event.query.queryKey, applyOrderChanges(event.action.data as CalendarEvent[], writes.changes));
  });
  return writes;
}

function orderSubtasks(subtasks: readonly CalendarSubtask[], ids: readonly string[]) {
  const byId = new Map(subtasks.map(subtask => [subtask.id, subtask]));
  const ordered = ids.map(id => byId.get(id)).filter((subtask): subtask is CalendarSubtask => !!subtask);
  // A subtask added meanwhile is not in the request; it keeps its place at the end.
  return [...ordered, ...subtasks.filter(subtask => !ids.includes(subtask.id))].map((subtask, position) => ({ ...subtask, position }));
}

/** The events with every pending change laid over them, oldest change first. */
export function applyOrderChanges(events: readonly CalendarEvent[], changes: readonly OrderChange[]): CalendarEvent[] {
  let result = [...events];
  for (const change of changes) {
    if (change.kind === 'place') {
      const byId = new Map(result.map(event => [event.id, event]));
      const order = change.order.map(id => byId.get(id)).filter((event): event is CalendarEvent => !!event);
      const ranks = optimisticRanks(order, change.id);
      result = result.map(event => ranks[event.id] === undefined ? event : { ...event, sort_rank: ranks[event.id], ...(event.id === change.id ? { hand_ordered: true } : {}) });
    } else if (change.kind === 'subtasks') {
      result = result.map(event => event.id === change.eventId ? { ...event, subtasks: orderSubtasks(event.subtasks, change.ids) } : event);
    }
  }
  return result;
}

const showChanges = (client: QueryClient, writes: TaskWrites) => {
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(events, writes.changes));
};

/**
 * Sends an ordering write (a placement, a subtask order, a move) after the
 * ones before it have settled, so only one is in flight and an answer never
 * arrives after a newer one's. The change shows at once, laid over the cache
 * with the changes queued before it. Nothing is rolled back on failure: once
 * the queue is empty the lists are fetched again, and the server's order
 * replaces whatever was shown, without touching unrelated data.
 */
export function queueTaskWrite<T>(client: QueryClient, change: OrderChange, request: () => Promise<T>): Promise<T> {
  const writes = writesFor(client);
  writes.changes.push(change);
  // A fetch in flight would land after the change below; cancelling reverts it
  // at once (its last manual write is kept), then the change goes on top.
  void client.cancelQueries(EVENT_LISTS);
  showChanges(client, writes);
  const run = writes.tail.then(request, request);
  writes.tail = run.then(noop, noop);
  return run.finally(() => {
    writes.changes.splice(writes.changes.indexOf(change), 1);
    if (!writes.changes.length) void invalidateCalendarQueries(client);
  });
}

/** Writes the ranks the server stored into every cached list, with the changes still pending laid over them. */
export function writeTaskRanks(client: QueryClient, ranks: Record<string, number>) {
  const writes = writesFor(client);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(
    events.map(event => ranks[event.id] === undefined ? event : { ...event, sort_rank: ranks[event.id], hand_ordered: true }), writes.changes));
}

/**
 * Refreshes everything that shows events and tasks, now when no ordering
 * write is pending; otherwise the refresh that follows the last of them
 * covers it, as a fetch landing in between would show the order from before them.
 */
export function refreshTasksWhenIdle(client: QueryClient) {
  if (writesFor(client).changes.length) return;
  void invalidateCalendarQueries(client);
}
