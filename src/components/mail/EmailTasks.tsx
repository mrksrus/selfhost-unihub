import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ListTodo } from 'lucide-react';
import { calendarApi, calendarQueryKeys } from '@/lib/calendar-api';
import type { EmailTaskSummary } from '@/lib/email-tasks';
import { taskWhen } from '@/lib/tasks';
import { cn } from '@/lib/utils';

/** The tasks made from the open email, each leading to the ToDo page. */
export function EmailTasks({ tasks, timezone }: { tasks: EmailTaskSummary[]; timezone: string | null }) {
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal) }).data ?? [];
  if (tasks.length === 0) return null;
  const listName = (id: string | null) => calendars.find(calendar => calendar.id === id)?.name;
  return (
    <section aria-label="Tasks" className="border-t border-border pt-4">
      <div className="mb-1 flex items-center gap-2">
        <ListTodo aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{tasks.length === 1 ? 'Task' : 'Tasks'}</span>
      </div>
      <ul>
        {tasks.map(task => {
          const done = task.todo_status === 'done';
          const when = task.is_todo_only ? null : taskWhen(task, timezone);
          return (
            <li key={task.id}>
              <Link to={`/todo?task=${encodeURIComponent(task.id)}`}
                className="flex items-center gap-3 rounded-sm py-1.5 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span aria-hidden="true" className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px]',
                  done ? 'border-accent bg-accent text-accent-foreground' : 'border-muted-foreground/60 text-transparent')}>
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
                <span className={cn('min-w-0 flex-1 truncate', done && 'text-muted-foreground line-through')}>{task.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{[listName(task.calendar_id), when].filter(Boolean).join(' · ')}</span>
                {done && <span className="sr-only">(done)</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
