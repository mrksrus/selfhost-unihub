import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { calendarApi, writeRefusal, type CalendarCalendar, type CalendarEvent, type CalendarSubtask, type NewCalendarEvent, type TaskMove, type TaskMoveCancelled } from '@/lib/calendar-api';
import { useSessionScope } from '@/lib/session-scope';
import { neighboursAt } from '@/lib/tasks';
import { MOVE_DEADLINE_MS, cancelledMoveNotice, confirmedFields, isCurrentWrite, issueWrite, markDeleted, queueTaskWrite, refreshTasks, subtaskKey, taskKey, writeTaskFields, writeTaskRanks, writeTaskSubtasks } from '@/lib/task-order-queue';

export type NewTask = NewCalendarEvent;

// Every reply writes only the fields its request changed, and only while no
// newer write for the task or subtask was issued (task-order-queue.ts).
// A status reply confirms the status; the times and the place only when the
// request set a time (a new date returns the task to its date's place, D31).
const STATUS_FIELDS = ['todo_status', 'done_at', 'updated_at'] as const;
const TIME_FIELDS = ['start_time', 'end_time', 'sort_rank', 'sort_key', 'hand_ordered'] as const;
const MOVE_FIELDS = ['calendar_id', 'move_pending', 'updated_at'] as const;
const replaceSubtask = (subtasks: readonly CalendarSubtask[], subtask: CalendarSubtask) =>
  subtasks.map(known => known.id === subtask.id ? { ...known, ...subtask } : known);

/**
 * Where a task goes: between the two tasks shown next to it, either null at a
 * section's end, and the section in its new order (for the optimistic view).
 */
export interface TaskPlacement { id: string; after: CalendarEvent | null; before: CalendarEvent | null; order: readonly CalendarEvent[]; section: SectionIdentity }

/**
 * The section a placement was made in: its key and how a task's section is
 * told from its fields, so a task that lands in another section meanwhile
 * (a date change, a tick) is no longer placed by it.
 */
export interface SectionIdentity { key: string; of: (task: CalendarEvent) => string }

/**
 * Every change to a task, with its feedback. Tasks are calendar events, so the
 * same writes and invalidation apply wherever tasks are shown (ToDo, Today).
 *
 * Ordering writes (placements, subtask orders, moves) go through one queue
 * per session (task-order-queue.ts): the change shows at once, one request is
 * in flight at a time, nothing is rolled back, and the lists are fetched
 * again once the queue is empty. Other writes show their confirmed answer in
 * the cache at once; only their list refresh waits for that moment.
 */
export function useTaskActions() {
  const client = useQueryClient();
  const scope = useSessionScope();
  const { toast } = useToast();
  const refresh = () => refreshTasks(client);
  const issueTask = ({ id }: { id: string }) => ({ sequence: issueWrite(client, taskKey(id)) });
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
  const update = useSessionMutation({
    mutationFn: async ({ id, update }: { id: string; update: Partial<CalendarEvent> }) => {
      await calendarApi.updateEvent(id, update);
      return calendarApi.updateTodoStatus(id, { todo_status: 'changed' });
    },
    onMutate: issueTask,
    onSuccess: (event, { id, update }, { sequence }) => {
      const changed = Object.keys(update) as (keyof CalendarEvent)[];
      if (isCurrentWrite(client, taskKey(id), sequence)) writeTaskFields(client, id, confirmedFields(event, [...changed, ...STATUS_FIELDS, ...(changed.includes('start_time') ? TIME_FIELDS : [])]));
      refresh();
      toast({ title: 'Task updated' });
    },
    onError: failed('Could not update the task'),
  });

  const setStatus = useSessionMutation({
    mutationFn: ({ id, todo_status, start_time, end_time }: { id: string; todo_status: CalendarEvent['todo_status']; start_time?: string; end_time?: string }) =>
      calendarApi.updateTodoStatus(id, { todo_status, start_time, end_time }),
    onMutate: issueTask,
    onSuccess: (event, { id, todo_status, start_time, end_time }, { sequence }) => {
      if (isCurrentWrite(client, taskKey(id), sequence)) writeTaskFields(client, id, confirmedFields(event, [...STATUS_FIELDS, ...(start_time || end_time ? TIME_FIELDS : [])]));
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
    mutationFn: ({ id, after, before, order, section }: TaskPlacement) =>
      queueTaskWrite(client, scope, { kind: 'place', id, order: order.map(task => task.id), section: section.key, sectionOf: section.of },
        signal => calendarApi.setTaskPosition(id, { after: after?.id ?? null, before: before?.id ?? null }, signal)),
    onSuccess: ({ ranks }) => writeTaskRanks(client, ranks),
    onError: failed('Could not move the task'),
  });

  /** Moves a task to `index` within the section it is shown in. */
  const placeTask = (section: readonly CalendarEvent[], taskId: string, index: number, identity: SectionIdentity) => {
    const { after, before } = neighboursAt(section, taskId, index);
    const task = section.find(entry => entry.id === taskId);
    if (!task || (!after && !before)) return;
    const others = section.filter(entry => entry.id !== taskId);
    const at = Math.max(0, Math.min(index, others.length));
    place.mutate({ id: taskId, after, before, order: [...others.slice(0, at), task, ...others.slice(at)], section: identity });
  };
  /** Moves one task up (-1) or down (1) within its section; nothing happens at the ends. */
  const moveTask = (section: readonly CalendarEvent[], taskId: string, direction: -1 | 1, identity: SectionIdentity) => {
    const from = section.findIndex(task => task.id === taskId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= section.length) return;
    placeTask(section, taskId, to, identity);
  };

  /** Moves a task to another list or calendar; the lists are fetched again once the queue is empty. */
  const moveToList = useSessionMutation({
    mutationFn: ({ id, calendarId }: { id: string; calendarId: string; list?: CalendarCalendar }) =>
      queueTaskWrite(client, scope, { kind: 'move', id }, signal => calendarApi.moveTask(id, calendarId, signal), MOVE_DEADLINE_MS),
    onMutate: issueTask,
    onSuccess: (result: TaskMove, { id, list }, { sequence }) => {
      // The answer carries the task as it is now: in its new list, or still in the old one with its move marked (move_pending).
      if (result.event && isCurrentWrite(client, taskKey(id), sequence)) writeTaskFields(client, id, confirmedFields(result.event, MOVE_FIELDS));
      if (result.pending === 'creating') toast({ title: 'Moving…', description: 'The calendar server has not confirmed yet. UniHub finishes this in the background.' });
      else toast({ title: list ? `Task moved to ${list.name}` : 'Task moved',
        ...(result.sourceKept ? { description: 'Its old copy was changed in another app meanwhile, so it stays in the old calendar too.' } : {}) });
    },
    onError: failed('Could not move the task'),
  });

  /**
   * Cancels a move whose new copy is not confirmed yet: the task stays in its
   * old list. Nothing is deleted at the calendar server: a copy it stored
   * after all shows up in the new list as a task of its own. Waits its turn
   * like a move, as it changes where the task is. `from` and `to` name the
   * lists for the notice.
   */
  const cancelMove = useSessionMutation({
    mutationFn: ({ id }: { id: string; from?: string; to?: string }) => queueTaskWrite(client, scope, { kind: 'move', id }, signal => calendarApi.cancelMove(id, signal), MOVE_DEADLINE_MS),
    onMutate: issueTask,
    onSuccess: (result: TaskMoveCancelled, { id, from, to }, { sequence }) => {
      if (result.event && isCurrentWrite(client, taskKey(id), sequence)) writeTaskFields(client, id, confirmedFields(result.event, MOVE_FIELDS));
      if (result.cancelled) toast({ title: 'Move cancelled', description: cancelledMoveNotice('task', from, to) });
      // Where the task is now comes from the lists, not from this answer.
      else { refresh(); toast({ title: 'Nothing to cancel', description: 'No move was waiting on the calendar server.' }); }
    },
    onError: failed('Could not cancel the move'),
  });

  const addSubtask = useSessionMutation({
    mutationFn: ({ eventId, title }: { eventId: string; title: string }) => calendarApi.createSubtask(eventId, { title }),
    // The reply to a creation is the oldest write for the new id: it applies
    // only while nothing newer touched the subtask (a tick on the copy a list
    // fetched meanwhile, a deletion). A list holding it already gets it replaced, never twice.
    onSuccess: (subtask, { eventId }) => {
      if (isCurrentWrite(client, subtaskKey(subtask.id), 0)) {
        writeTaskSubtasks(client, eventId, subtasks => subtasks.some(known => known.id === subtask.id) ? replaceSubtask(subtasks, subtask) : [...subtasks, subtask]);
      }
      refresh();
    },
    onError: failed('Could not add the subtask'),
  });

  const updateSubtask = useSessionMutation({
    mutationFn: ({ eventId, subtaskId, update }: { eventId: string; subtaskId: string; update: Partial<Pick<CalendarSubtask, 'title' | 'is_done' | 'position'>> }) =>
      calendarApi.updateSubtask(eventId, subtaskId, update),
    onMutate: ({ subtaskId }) => ({ sequence: issueWrite(client, subtaskKey(subtaskId)) }),
    // Absent from the cache means deleted or not fetched, never "create it".
    onSuccess: (subtask, { eventId, subtaskId }, { sequence }) => {
      if (isCurrentWrite(client, subtaskKey(subtaskId), sequence)) writeTaskSubtasks(client, eventId, subtasks => replaceSubtask(subtasks, subtask));
      refresh();
    },
    onError: failed('Could not update the subtask'),
  });

  const deleteSubtask = useSessionMutation({
    mutationFn: ({ eventId, subtaskId }: { eventId: string; subtaskId: string }) => calendarApi.deleteSubtask(eventId, subtaskId),
    onSuccess: (_, { subtaskId }) => { markDeleted(client, subtaskKey(subtaskId)); refresh(); },
    onError: failed('Could not delete the subtask'),
  });

  /** The new order of a task's subtasks shows at once; the refresh after the queue holds the server's. */
  const reorderSubtasks = useSessionMutation({
    mutationFn: ({ eventId, subtaskIds }: { eventId: string; subtaskIds: string[] }) =>
      queueTaskWrite(client, scope, { kind: 'subtasks', eventId, ids: subtaskIds }, signal => calendarApi.reorderSubtasks(eventId, subtaskIds, signal)),
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

  return { create, update, setStatus, place, placeTask, moveTask, moveToList, cancelMove, addSubtask, updateSubtask, deleteSubtask, reorderSubtasks, moveSubtask };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
