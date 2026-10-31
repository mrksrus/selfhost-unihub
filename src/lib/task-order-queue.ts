import type { QueryClient } from '@tanstack/react-query';
import { CalendarRequestError, WRITE_TIMEOUT, calendarQueryKeys, invalidateCalendarQueries, type CalendarEvent, type CalendarSubtask } from '@/lib/calendar-api';
import type { SessionScope } from '@/lib/session-scope';
import { optimisticRanks } from '@/lib/tasks';

/**
 * A change to the shown order whose request is queued or in flight, kept as
 * positions (not ranks), so it can be laid over whatever the cache holds at
 * the time: the list as fetched, or the server's ranks from an earlier answer.
 * A placement remembers the section it was made in (`section`, by
 * `sectionOf`): once the moved task is in another section or gone, the
 * placement is superseded and the server's answer decides.
 */
export type OrderChange =
  | { kind: 'place'; id: string; order: readonly string[]; section: string; sectionOf: (task: CalendarEvent) => string }
  | { kind: 'subtasks'; eventId: string; ids: readonly string[] }
  | { kind: 'move'; id: string };

type EventLists = CalendarEvent[] | undefined;
const EVENT_LISTS = { queryKey: calendarQueryKeys.all };
const isEventList = (queryKey: readonly unknown[]) => queryKey[0] === calendarQueryKeys.all[0];
const noop = () => {};

/** How long a queued write may wait for its answer before the outcome counts as unknown. */
export const WRITE_DEADLINE_MS = 30_000;
/** A move, or its cancellation, waits for the calendar server (up to about 20 s on the API side). */
export const MOVE_DEADLINE_MS = 60_000;

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
      const moved = byId.get(change.id);
      // Gone, or in another section by now (a date change, a tick): the placement no longer applies to anyone.
      if (!moved || change.sectionOf(moved) !== change.section) continue;
      const order = change.order.map(id => byId.get(id)).filter((event): event is CalendarEvent => !!event && change.sectionOf(event) === change.section);
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

const timedOut = () => new CalendarRequestError({ error: 'The server has not answered.', code: WRITE_TIMEOUT }, 'The server has not answered.');
const sessionEnded = () => new CalendarRequestError({ error: 'The session ended before this change was sent.', code: 'SESSION_ENDED' }, 'The session ended.');

/**
 * Sends an ordering write (a placement, a subtask order, a move) after the
 * ones before it have settled, so only one is in flight and an answer never
 * arrives after a newer one's. The change shows at once, laid over the cache
 * with the changes queued before it. Nothing is rolled back on failure: once
 * the queue is empty the lists are fetched again, and the server's order
 * replaces whatever was shown, without touching unrelated data.
 *
 * A write still queued when its session ends (sign-out, account change) is
 * never sent. One that gets no answer within its deadline is abandoned with
 * an unknown outcome (WRITE_TIMEOUT), so the writes behind it go on and the
 * refresh after the queue shows what the server did with it.
 */
export function queueTaskWrite<T>(client: QueryClient, scope: SessionScope, change: OrderChange, request: (signal: AbortSignal) => Promise<T>, deadline = WRITE_DEADLINE_MS): Promise<T> {
  const writes = writesFor(client);
  writes.changes.push(change);
  // A fetch in flight would land after the change below; cancelling reverts it
  // at once (its last manual write is kept), then the change goes on top.
  void client.cancelQueries(EVENT_LISTS);
  showChanges(client, writes);
  const dispatch = async () => {
    if (scope.ended) throw sessionEnded();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(timedOut()); }, deadline); });
    try { return await Promise.race([request(controller.signal), limit]); }
    finally { clearTimeout(timer); }
  };
  const run = writes.tail.then(dispatch, dispatch);
  writes.tail = run.then(noop, noop);
  return run.finally(() => {
    writes.changes.splice(writes.changes.indexOf(change), 1);
    if (!writes.changes.length) void invalidateCalendarQueries(client);
  });
}

/**
 * What a cancelled move means for the person: nothing is deleted at the
 * calendar server, so a copy it stored after all appears in the new list as
 * an item of its own.
 */
export function cancelledMoveNotice(what: 'task' | 'event', from?: string, to?: string) {
  const place = what === 'task' ? 'list' : 'calendar';
  return `The ${what} stays in ${from ?? `its ${place}`}. If ${to ?? `the new ${place}`} received a copy anyway, it will show up there; delete it if you don't want it.`;
}

/** Writes the ranks the server stored into every cached list, with the changes still pending laid over them. */
export function writeTaskRanks(client: QueryClient, ranks: Record<string, number>) {
  const writes = writesFor(client);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(
    events.map(event => ranks[event.id] === undefined ? event : { ...event, sort_rank: ranks[event.id], hand_ordered: true }), writes.changes));
}

/**
 * Writes a task as the server answered it into every cached list that holds
 * it, with the changes still pending laid over it: a tick or an edit shows
 * at once, whatever ordering writes are still in flight.
 */
export function writeTaskEvent(client: QueryClient, event: CalendarEvent) {
  const writes = writesFor(client);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(
    events.map(known => known.id === event.id ? { ...known, ...event } : known), writes.changes));
}

/** Changes a task's subtasks in every cached list that holds it, as the server confirmed them. */
export function writeTaskSubtasks(client: QueryClient, eventId: string, update: (subtasks: readonly CalendarSubtask[]) => CalendarSubtask[]) {
  const writes = writesFor(client);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(
    events.map(known => known.id === eventId ? { ...known, subtasks: update(known.subtasks) } : known), writes.changes));
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
