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

/**
 * A task or subtask the writes are counted for: 'task:<id>' or 'subtask:<id>'.
 * Every write issued for it takes the next sequence number; a reply applies
 * its confirmed fields only while no newer write has been issued since.
 */
export type EntityKey = `task:${string}` | `subtask:${string}`;
export const taskKey = (id: string): EntityKey => `task:${id}`;
export const subtaskKey = (id: string): EntityKey => `subtask:${id}`;

interface TaskWrites {
  /** Queued and in-flight changes, oldest first; the first is the one in flight. */
  changes: OrderChange[];
  tail: Promise<void>;
  /** The sequence number of the latest write issued per task or subtask. */
  sequence: Map<EntityKey, number>;
  /** Deleted on the server, with the fetch count at that moment: absent until a fetch started after the deletion answers. */
  tombstones: Map<EntityKey, number>;
  /** How many list fetches have started, and at which count each query's current fetch started. */
  fetches: number;
  fetchStartedAt: Map<string, number>;
}

// One queue per QueryClient, and SessionQueryProvider makes one client per
// signed-in session: a request of an earlier session never lands in the next
// one's cache, and its callbacks are guarded by the session scope anyway.
const writesByClient = new WeakMap<QueryClient, TaskWrites>();

function writesFor(client: QueryClient): TaskWrites {
  const known = writesByClient.get(client);
  if (known) return known;
  const writes: TaskWrites = { changes: [], tail: Promise.resolve(), sequence: new Map(), tombstones: new Map(), fetches: 0, fetchStartedAt: new Map() };
  writesByClient.set(client, writes);
  // A list fetched while writes are pending (a refresh, a live-update hint, a
  // window focus) would show the order from before them and bring back what
  // was deleted meanwhile: the pending changes are laid over its answer
  // again, and a deletion holds until a fetch that started after it answers.
  client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || !isEventList(event.query.queryKey)) return;
    if (event.action.type === 'fetch') { writes.fetchStartedAt.set(event.query.queryHash, ++writes.fetches); return; }
    if (event.action.type !== 'success' || event.action.manual || !Array.isArray(event.action.data)) return;
    const startedAt = writes.fetchStartedAt.get(event.query.queryHash) ?? 0;
    for (const [key, since] of writes.tombstones) if (startedAt > since) writes.tombstones.delete(key);
    if (!writes.changes.length && !writes.tombstones.size) return;
    client.setQueryData<EventLists>(event.query.queryKey, applyOrderChanges(withoutDeleted(event.action.data as CalendarEvent[], writes.tombstones), writes.changes));
  });
  return writes;
}

/** The lists without the tasks and subtasks deleted on the server since the fetch started. */
function withoutDeleted(events: readonly CalendarEvent[], tombstones: ReadonlyMap<EntityKey, number>): CalendarEvent[] {
  if (!tombstones.size) return [...events];
  return events.filter(event => !tombstones.has(taskKey(event.id)))
    .map(event => event.subtasks.some(subtask => tombstones.has(subtaskKey(subtask.id))) ? { ...event, subtasks: event.subtasks.filter(subtask => !tombstones.has(subtaskKey(subtask.id))) } : event);
}

/** Counts a write issued for a task or subtask; its reply applies only while this is still the latest (isCurrentWrite). */
export function issueWrite(client: QueryClient, key: EntityKey): number {
  const writes = writesFor(client);
  const sequence = (writes.sequence.get(key) ?? 0) + 1;
  writes.sequence.set(key, sequence);
  return sequence;
}

/**
 * Whether a reply may apply what it confirmed: no newer write for the task
 * or subtask was issued since. A reply to a creation counts as sequence 0,
 * the oldest write for its new id: it applies only while nothing newer
 * touched it, so a tick on the fetched copy is never undone by it.
 */
export function isCurrentWrite(client: QueryClient, key: EntityKey, sequence: number): boolean {
  return (writesFor(client).sequence.get(key) ?? 0) === sequence;
}

/**
 * Marks a task or subtask deleted on the server: it is removed from every
 * cached list and stays absent, whatever an older reply or an older fetch
 * says, until a fetch that started after the deletion answers.
 */
export function markDeleted(client: QueryClient, key: EntityKey) {
  const writes = writesFor(client);
  writes.tombstones.set(key, writes.fetches);
  issueWrite(client, key);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && withoutDeleted(events, writes.tombstones));
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
 * Writes the fields of a task an answer confirmed into every cached list
 * that holds it, with the changes still pending laid over it: a tick or an
 * edit shows at once, whatever ordering writes are still in flight. Only the
 * fields the request was about: an answer that arrives late must not put an
 * older state of the rest (subtasks confirmed meanwhile) over a newer one.
 */
export function writeTaskFields(client: QueryClient, id: string, fields: Partial<CalendarEvent>) {
  const writes = writesFor(client);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(
    events.map(known => known.id === id ? { ...known, ...fields } : known), writes.changes));
}

/** The fields of an answered task that a kind of request confirms. */
export function confirmedFields<K extends keyof CalendarEvent>(event: CalendarEvent, keys: readonly K[]): Partial<CalendarEvent> {
  const fields: Partial<CalendarEvent> = {};
  for (const key of keys) if (key in event) fields[key] = event[key];
  return fields;
}

/** A whole task as the server answered it (a fresh single-event read), laid over the lists that hold it. */
export function writeTaskEvent(client: QueryClient, event: CalendarEvent) {
  writeTaskFields(client, event.id, event);
}

/** Changes a task's subtasks in every cached list that holds it, as the server confirmed them. */
export function writeTaskSubtasks(client: QueryClient, eventId: string, update: (subtasks: readonly CalendarSubtask[]) => CalendarSubtask[]) {
  const writes = writesFor(client);
  client.setQueriesData<EventLists>(EVENT_LISTS, events => events && applyOrderChanges(
    events.map(known => known.id === eventId ? { ...known, subtasks: update(known.subtasks) } : known), writes.changes));
}

/**
 * Refreshes everything that shows events and tasks, at once: a list that
 * answers while ordering writes are pending gets them laid over it again
 * (the cache subscription above), so nothing wrong stays on show longer
 * than one round trip. The queue fetches once more when it drains.
 */
export function refreshTasks(client: QueryClient) {
  void invalidateCalendarQueries(client);
}
