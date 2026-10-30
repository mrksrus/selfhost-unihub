import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { CalendarRequestError, calendarApi, calendarQueryKeys, invalidateCalendarQueries, type CalendarCalendar, type CalendarEvent, type CalendarSubtask, type NewCalendarEvent, type TaskMove } from '@/lib/calendar-api';
import { neighboursAt, rankBetween } from '@/lib/tasks';

export type NewTask = NewCalendarEvent;

/** Where a task goes: between the two tasks shown next to it, either null at a section's end. */
export interface TaskPlacement { id: string; after: CalendarEvent | null; before: CalendarEvent | null }

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
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

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
  const writeRanks = (ranks: Record<string, number>) => {
    client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => (
      ranks[event.id] === undefined ? event : { ...event, sort_rank: ranks[event.id], hand_ordered: true }
    )));
  };

  /**
   * Places a task between its new neighbours: shown at once with a rank
   * between theirs, then the server's rank replaces it. A failure puts the
   * task back where it was and says so; a list that changed meanwhile
   * (ORDER_STALE) is reloaded instead of guessed. An answer that arrives after
   * an account switch changes nothing (useSessionMutation).
   */
  const place = useSessionMutation({
    mutationFn: ({ id, after, before }: TaskPlacement) => calendarApi.setTaskPosition(id, { after: after?.id ?? null, before: before?.id ?? null }),
    onMutate: async ({ id, after, before }) => {
      await client.cancelQueries(EVENT_LISTS);
      // Only the moved task is put back on failure, so two quick drags do not undo each other.
      const was = client.getQueriesData<EventLists>(EVENT_LISTS).flatMap(([, events]) => events ?? []).find(event => event.id === id);
      const previous = was ? { sort_rank: was.sort_rank, hand_ordered: was.hand_ordered } : null;
      const rank = rankBetween(after, before);
      writeRanks({ [id]: rank });
      return { previous };
    },
    onSuccess: ({ ranks }) => writeRanks(ranks),
    onError: (error: Error, { id }, context) => {
      if (context?.previous) {
        const { sort_rank, hand_ordered } = context.previous;
        client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => event.id === id ? { ...event, sort_rank, hand_ordered } : event));
      }
      if (error instanceof CalendarRequestError && error.code === 'ORDER_STALE') {
        refresh();
        toast({ title: 'The list changed in the meantime', description: 'It has been reloaded. Try again.' });
        return;
      }
      toast({ title: 'Could not move the task', description: error.message, variant: 'destructive' });
    },
  });

  /** Moves a task to `index` within the section it is shown in. */
  const placeTask = (section: readonly CalendarEvent[], taskId: string, index: number) => {
    const { after, before } = neighboursAt(section, taskId, index);
    if (!after && !before) return;
    place.mutate({ id: taskId, after, before });
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

  // The new order shows at once; the server's answer replaces it, a failure puts the old order back.
  const reorderSubtasks = useSessionMutation({
    mutationFn: ({ eventId, subtaskIds }: { eventId: string; subtaskIds: string[] }) => calendarApi.reorderSubtasks(eventId, subtaskIds),
    onMutate: async ({ eventId, subtaskIds }) => {
      await client.cancelQueries(EVENT_LISTS);
      const previous = client.getQueriesData<EventLists>(EVENT_LISTS);
      client.setQueriesData<EventLists>(EVENT_LISTS, events => events?.map(event => event.id !== eventId ? event : {
        ...event,
        subtasks: subtaskIds.map(id => event.subtasks.find(subtask => subtask.id === id)).filter((subtask): subtask is CalendarSubtask => !!subtask)
          .map((subtask, position) => ({ ...subtask, position })),
      }));
      return { previous };
    },
    onSuccess: refresh,
    onError: (error: Error, _variables, context) => {
      for (const [queryKey, events] of context?.previous ?? []) client.setQueryData(queryKey, events);
      failed('Could not reorder the subtasks')(error);
    },
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
