import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { CalendarRequestError, MOVE_PENDING_NOTICE, calendarApi, calendarQueryKeys, invalidateCalendarQueries, isMovePending, type CalendarCalendar, type CalendarEvent, type CalendarSubtask, type NewCalendarEvent, type TaskMove } from '@/lib/calendar-api';
import { neighboursAt, optimisticRanks } from '@/lib/tasks';

export type NewTask = NewCalendarEvent;

/**
 * Where a task goes: between the two tasks shown next to it, either null at a
 * section's end, and the section in its new order (for the optimistic view).
 */
export interface TaskPlacement { id: string; after: CalendarEvent | null; before: CalendarEvent | null; order: readonly CalendarEvent[] }

type RankFields = Pick<CalendarEvent, 'sort_rank' | 'hand_ordered'>;

type EventLists = CalendarEvent[] | undefined;
const EVENT_LISTS = { queryKey: calendarQueryKeys.all };

/**
 * Every change to a task, with its feedback. Tasks are calendar events, so the
 * same writes and invalidation apply wherever tasks are shown (ToDo, Today).
 */
export function useTaskActions() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => { void invalidateCalendarQueries(client); };
  // A task still being moved refuses writes until the calendar server answers; that is a wait, not a failure.
  const failed = (title: string) => (error: Error) => toast(isMovePending(error) ? MOVE_PENDING_NOTICE : { title, description: error.message, variant: 'destructive' });

  const create = useMutation({
    mutationFn: (task: NewTask) => calendarApi.createEvent(task),
    onSuccess: () => { refresh(); toast({ title: 'Task created' }); },
    onError: failed('Could not create the task'),
  });

  // Editing a task marks it as changed, so its history shows it moved on from the original plan.
  const update = useMutation({
    mutationFn: async ({ id, update }: { id: string; update: Partial<CalendarEvent> }) => {
      await calendarApi.updateEvent(id, update);
      return calendarApi.updateTodoStatus(id, { todo_status: 'changed' });
    },
    onSuccess: () => { refresh(); toast({ title: 'Task updated' }); },
    onError: failed('Could not update the task'),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, todo_status, start_time, end_time }: { id: string; todo_status: CalendarEvent['todo_status']; start_time?: string; end_time?: string }) =>
      calendarApi.updateTodoStatus(id, { todo_status, start_time, end_time }),
    onSuccess: (_, { todo_status }) => {
      refresh();
      if (todo_status === 'done') toast({ title: 'Task done' });
      else if (todo_status === 'cancelled') toast({ title: 'Task cancelled' });
      else if (todo_status === 'time_moved') toast({ title: 'Task moved' });
    },
    onError: failed('Could not update the task'),
  });

  // Writes the same rank fields into every cached event list (ToDo, Today,
  // the calendar's ranges), so a task moved on one page is in place on the others.
  const writeRanks = (ranks: Record<string, number>, handOrdered?: boolean) => {
    client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => (
      ranks[event.id] === undefined ? event : { ...event, sort_rank: ranks[event.id], ...(handOrdered === undefined ? {} : { hand_ordered: handOrdered }) }
    )));
  };
  const writeRankFields = (fields: Record<string, RankFields>) => {
    client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => fields[event.id] ? { ...event, ...fields[event.id] } : event));
  };
  const cachedEvents = () => client.getQueriesData<EventLists>(EVENT_LISTS).flatMap(([, events]) => events ?? []);

  // Placements of one task are ordered: an answer or a failure of an older
  // placement, arriving after a newer one started, changes nothing. Once no
  // placement is in flight the lists are fetched again, so the cache ends at
  // what the server holds, whatever the optimistic view was.
  const placeGeneration = useRef(new Map<string, number>());
  const inFlight = useRef(0);
  const settleRanks = () => {
    inFlight.current -= 1;
    if (inFlight.current === 0) void client.invalidateQueries(EVENT_LISTS);
  };

  /**
   * Places a task between its new neighbours: shown at once in the requested
   * order, then the server's rank replaces it. A failure puts the moved task
   * back and says so; a list that changed meanwhile (ORDER_STALE) is reloaded
   * instead of guessed. An answer that arrives after an account switch
   * changes nothing (useSessionMutation).
   */
  const place = useSessionMutation({
    mutationFn: ({ id, after, before }: TaskPlacement) => calendarApi.setTaskPosition(id, { after: after?.id ?? null, before: before?.id ?? null }),
    onMutate: async ({ id, order }) => {
      await client.cancelQueries(EVENT_LISTS);
      const generation = (placeGeneration.current.get(id) ?? 0) + 1;
      placeGeneration.current.set(id, generation);
      inFlight.current += 1;
      const ranks = optimisticRanks(order, id);
      // What the changed tasks showed before, for a rollback of this placement only.
      const previous: Record<string, RankFields> = {};
      for (const event of cachedEvents()) if (ranks[event.id] !== undefined && !previous[event.id]) previous[event.id] = { sort_rank: event.sort_rank, hand_ordered: event.hand_ordered };
      writeRankFields(Object.fromEntries(Object.keys(ranks).map(taskId => [taskId, { sort_rank: ranks[taskId], hand_ordered: taskId === id ? true : previous[taskId]?.hand_ordered }])));
      return { generation, previous };
    },
    onSuccess: ({ ranks }, { id }, context) => {
      if (context.generation !== placeGeneration.current.get(id)) return;
      writeRanks(ranks, true);
    },
    onError: (error: Error, { id }, context) => {
      const superseded = !context || context.generation !== placeGeneration.current.get(id);
      if (!superseded) writeRankFields(context.previous);
      if (error instanceof CalendarRequestError && error.code === 'ORDER_STALE') {
        refresh();
        toast({ title: 'The list changed in the meantime', description: 'It has been reloaded. Try again.' });
        return;
      }
      failed('Could not move the task')(error);
    },
    onSettled: settleRanks,
  });

  /** Moves a task to `index` within the section it is shown in. */
  const placeTask = (section: readonly CalendarEvent[], taskId: string, index: number) => {
    const { after, before } = neighboursAt(section, taskId, index);
    const task = section.find(entry => entry.id === taskId);
    if (!task || (!after && !before)) return;
    const others = section.filter(entry => entry.id !== taskId);
    const at = Math.max(0, Math.min(index, others.length));
    place.mutate({ id: taskId, after, before, order: [...others.slice(0, at), task, ...others.slice(at)] });
  };
  /** Moves one task up (-1) or down (1) within its section; nothing happens at the ends. */
  const moveTask = (section: readonly CalendarEvent[], taskId: string, direction: -1 | 1) => {
    const from = section.findIndex(task => task.id === taskId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= section.length) return;
    placeTask(section, taskId, to);
  };

  /** Moves a task to another list or calendar; the list is refreshed from the server's answer. */
  const moveToList = useSessionMutation({
    mutationFn: ({ id, calendarId }: { id: string; calendarId: string; list?: CalendarCalendar }) => calendarApi.moveTask(id, calendarId),
    onSuccess: (result: TaskMove, { list }) => {
      refresh();
      if (result.pending === 'creating') toast({ title: 'Moving…', description: 'The calendar server has not confirmed yet. UniHub finishes this in the background.' });
      else toast({ title: list ? `Task moved to ${list.name}` : 'Task moved',
        ...(result.sourceKept ? { description: 'Its old copy was changed in another app meanwhile, so it stays in the old calendar too.' } : {}) });
    },
    onError: failed('Could not move the task'),
  });

  const addSubtask = useMutation({
    mutationFn: ({ eventId, title }: { eventId: string; title: string }) => calendarApi.createSubtask(eventId, { title }),
    onSuccess: refresh,
    onError: failed('Could not add the subtask'),
  });

  const updateSubtask = useMutation({
    mutationFn: ({ eventId, subtaskId, update }: { eventId: string; subtaskId: string; update: Partial<Pick<CalendarSubtask, 'title' | 'is_done' | 'position'>> }) =>
      calendarApi.updateSubtask(eventId, subtaskId, update),
    onSuccess: refresh,
    onError: failed('Could not update the subtask'),
  });

  const deleteSubtask = useMutation({
    mutationFn: ({ eventId, subtaskId }: { eventId: string; subtaskId: string }) => calendarApi.deleteSubtask(eventId, subtaskId),
    onSuccess: refresh,
    onError: failed('Could not delete the subtask'),
  });

  // The new order shows at once; the server's answer replaces it. A failure
  // puts back that task's subtask order only, nothing else that changed
  // meanwhile; a reorder started later for the same task wins over an older one.
  const subtaskGeneration = useRef(new Map<string, number>());
  const reorderSubtasks = useSessionMutation({
    mutationFn: ({ eventId, subtaskIds }: { eventId: string; subtaskIds: string[] }) => calendarApi.reorderSubtasks(eventId, subtaskIds),
    onMutate: async ({ eventId, subtaskIds }) => {
      await client.cancelQueries(EVENT_LISTS);
      const generation = (subtaskGeneration.current.get(eventId) ?? 0) + 1;
      subtaskGeneration.current.set(eventId, generation);
      inFlight.current += 1;
      const previous = cachedEvents().find(event => event.id === eventId)?.subtasks ?? null;
      client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => event.id !== eventId ? event : {
        ...event,
        subtasks: subtaskIds.map(id => event.subtasks.find(subtask => subtask.id === id)).filter((subtask): subtask is CalendarSubtask => !!subtask)
          .map((subtask, position) => ({ ...subtask, position })),
      }));
      return { generation, previous };
    },
    onError: (error: Error, { eventId }, context) => {
      if (context?.previous && context.generation === subtaskGeneration.current.get(eventId)) {
        const previous = context.previous;
        client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => event.id === eventId ? { ...event, subtasks: previous } : event));
      }
      failed('Could not reorder the subtasks')(error);
    },
    onSettled: settleRanks,
  });

  /** Moves one subtask up (-1) or down (1). */
  const moveSubtask = (task: CalendarEvent, subtaskId: string, direction: -1 | 1) => {
    const ids = task.subtasks.map(subtask => subtask.id);
    const from = ids.indexOf(subtaskId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    reorderSubtasks.mutate({ eventId: task.id, subtaskIds: ids });
  };

  return { create, update, setStatus, place, placeTask, moveTask, moveToList, addSubtask, updateSubtask, deleteSubtask, reorderSubtasks, moveSubtask };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
