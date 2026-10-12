import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { calendarApi, invalidateCalendarQueries, type CalendarEvent, type CalendarSubtask } from '@/lib/calendar-api';

export type NewTask = Partial<CalendarEvent> & { title: string };

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

  const reorderSubtasks = useMutation({
    mutationFn: ({ eventId, subtaskIds }: { eventId: string; subtaskIds: string[] }) => calendarApi.reorderSubtasks(eventId, subtaskIds),
    onSuccess: refresh,
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

  return { create, update, setStatus, addSubtask, updateSubtask, deleteSubtask, reorderSubtasks, moveSubtask };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
