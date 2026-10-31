import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { calendarApi, writeRefusal, type CalendarCalendar, type CalendarEvent, type CalendarSubtask, type NewCalendarEvent, type TaskMove } from '@/lib/calendar-api';
import { neighboursAt } from '@/lib/tasks';
import { queueTaskWrite, refreshTasksWhenIdle, writeTaskRanks } from '@/lib/task-order-queue';

export type NewTask = NewCalendarEvent;

/**
 * Where a task goes: between the two tasks shown next to it, either null at a
 * section's end, and the section in its new order (for the optimistic view).
 */
export interface TaskPlacement { id: string; after: CalendarEvent | null; before: CalendarEvent | null; order: readonly CalendarEvent[] }

/**
 * Every change to a task, with its feedback. Tasks are calendar events, so the
 * same writes and invalidation apply wherever tasks are shown (ToDo, Today).
 *
 * Ordering writes (placements, subtask orders, moves) go through one queue
 * per session (task-order-queue.ts): the change shows at once, one request is
 * in flight at a time, nothing is rolled back, and the lists are fetched
 * again once the queue is empty. Every refresh here waits for that moment.
 */
export function useTaskActions() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => refreshTasksWhenIdle(client);
  // A write the server refused with a reason (still being moved, changed on
  // the server, a stale list) is a plain notice, not a failure; a reason that
  // needs the current lists reloads them first.
  const failed = (title: string) => (error: Error) => {
    const refusal = writeRefusal(error);
    if (refusal?.reload) refresh();
    toast(refusal ? { title: refusal.title, description: refusal.description } : { title, description: error.message, variant: 'destructive' });
  };

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

  /**
   * Places a task between its new neighbours: shown at once in the requested
   * order, then the server's ranks replace it. A failure says so, and the
   * refresh after the queue puts the task back where the server has it; a
   * list that changed meanwhile (ORDER_STALE) is reloaded instead of guessed.
   * An answer that arrives after an account switch changes nothing
   * (useSessionMutation).
   */
  const place = useSessionMutation({
    mutationFn: ({ id, after, before, order }: TaskPlacement) => queueTaskWrite(client, { kind: 'place', id, order: order.map(task => task.id) },
      () => calendarApi.setTaskPosition(id, { after: after?.id ?? null, before: before?.id ?? null })),
    onSuccess: ({ ranks }) => writeTaskRanks(client, ranks),
    onError: failed('Could not move the task'),
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

  /** Moves a task to another list or calendar; the lists are fetched again once the queue is empty. */
  const moveToList = useSessionMutation({
    mutationFn: ({ id, calendarId }: { id: string; calendarId: string; list?: CalendarCalendar }) =>
      queueTaskWrite(client, { kind: 'move', id }, () => calendarApi.moveTask(id, calendarId)),
    onSuccess: (result: TaskMove, { list }) => {
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

  /** The new order of a task's subtasks shows at once; the refresh after the queue holds the server's. */
  const reorderSubtasks = useSessionMutation({
    mutationFn: ({ eventId, subtaskIds }: { eventId: string; subtaskIds: string[] }) =>
      queueTaskWrite(client, { kind: 'subtasks', eventId, ids: subtaskIds }, () => calendarApi.reorderSubtasks(eventId, subtaskIds)),
    onError: failed('Could not reorder the subtasks'),
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
