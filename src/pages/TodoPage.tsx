import { useEffect, useMemo, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, CalendarClock, CalendarDays, CheckCircle2, Inbox, ListTodo, Plus, Sun } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { useTaskActions } from '@/hooks/use-task-actions';
import { useNotificationEventLink } from '@/hooks/use-notification-event-link';
import { calendarApi, calendarQueryKeys, formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { TaskRow } from '@/components/todo/TaskRow';
import { isOverdue } from '@/lib/tasks';
import { EditTaskDialog, MoveTaskDialog, NewTaskDialog } from '@/components/todo/TaskDialogs';

const VIEWS = {
  open: { label: 'Open', icon: ListTodo },
  today: { label: 'Today', icon: Sun },
  overdue: { label: 'Overdue', icon: AlertCircle },
  later: { label: 'Later', icon: CalendarClock },
  undated: { label: 'No date', icon: Inbox },
  done: { label: 'Done', icon: CheckCircle2 },
} as const;
type View = keyof typeof VIEWS;
const isView = (value: string | null): value is View => !!value && value in VIEWS;

const active = (task: CalendarEvent) => task.todo_status !== 'done' && task.todo_status !== 'cancelled';

/** Sorts and groups tasks once; views only pick from the groups. */
function groupTasks(tasks: CalendarEvent[], timezone: string | null) {
  const now = new Date();
  const today = formatEventTime(now.toISOString(), 'yyyy-MM-dd', timezone);
  const open = tasks.filter(active).sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  const isToday = (task: CalendarEvent) => !task.is_todo_only && formatEventTime(task.start_time, 'yyyy-MM-dd', timezone) === today;
  const overdue = open.filter(task => isOverdue(task, now.getTime()));
  const todayTasks = open.filter(task => isToday(task) && !overdue.includes(task));
  const later = open.filter(task => !task.is_todo_only && !overdue.includes(task) && !todayTasks.includes(task));
  const undated = open.filter(task => task.is_todo_only);
  const done = tasks.filter(task => task.todo_status === 'done')
    .sort((a, b) => new Date(b.done_at ?? b.updated_at).getTime() - new Date(a.done_at ?? a.updated_at).getTime());
  return { open, overdue, today: todayTasks, later, undated, done };
}

const TodoPage = () => {
  const { user } = useAuth();
  const timezone = user?.timezone ?? null;
  const { pages } = useModules();
  const title = pages.find(page => page.id === 'todo')?.label ?? 'ToDo';
  const [params, setParams] = useSearchParams();
  const view: View = isView(params.get('view')) ? params.get('view') as View : 'open';
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [moving, setMoving] = useState<CalendarEvent | null>(null);
  // A task linked from an email that ToDo does not list: its list is hidden from ToDo.
  const [hiddenTask, setHiddenTask] = useState<string | null>(null);
  // A task linked from an email, scrolled to once its row is on the page.
  const [linkedTask, setLinkedTask] = useState<string | null>(null);
  const actions = useTaskActions();

  const tasksQuery = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: true, respectAutoTodo: true }),
    queryFn: ({ signal }) => calendarApi.fetchEvents({ includeTodos: true, respectAutoTodo: true }, signal),
  });
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal) }).data ?? [];
  useNotificationEventLink(setEditing);
  // Today and the command palette link here to start a new task.
  useEffect(() => {
    if (params.get('action') !== 'new') return;
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete('action');
    setParams(next, { replace: true });
  }, [params, setParams]);
  // An email's task list links here; the task opens in the view it belongs to.
  const { data: taskList, error: tasksError, isFetching: tasksFetching, isFetchedAfterMount: tasksFresh, refetch: refetchTasks } = tasksQuery;
  useEffect(() => {
    const taskId = params.get('task');
    if (!taskId || !taskList) return;
    const linked = taskList.find(task => task.id === taskId);
    // A cached list can predate the task; only a fresh answer proves it is not listed.
    if (!linked && (!tasksFresh || tasksFetching || tasksError)) {
      if (!tasksFresh && !tasksFetching) void refetchTasks();
      return;
    }
    const next = new URLSearchParams(params);
    next.delete('task');
    if (linked) {
      if (linked.todo_status === 'done') next.set('view', 'done'); else next.delete('view');
      setCalendarId(null);
      setLinkedTask(taskId);
    }
    setHiddenTask(linked ? null : taskId);
    setParams(next, { replace: true });
  }, [params, setParams, taskList, tasksError, tasksFetching, tasksFresh, refetchTasks]);
  useEffect(() => {
    if (!linkedTask) return;
    setLinkedTask(null);
    document.getElementById(`task-${linkedTask}`)?.scrollIntoView?.({ block: 'center' });
  }, [linkedTask]);

  const tasks = useMemo(() => (tasksQuery.data ?? []).filter(task => !calendarId || task.calendar_id === calendarId), [tasksQuery.data, calendarId]);
  const groups = useMemo(() => groupTasks(tasks, timezone), [tasks, timezone]);
  const calendarColor = (task: CalendarEvent) => calendars.length > 1 ? calendars.find(calendar => calendar.id === task.calendar_id)?.color : undefined;
  const openCount = (id: string) => (tasksQuery.data ?? []).filter(task => active(task) && task.calendar_id === id).length;

  const selectView = (next: View) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'open') nextParams.delete('view'); else nextParams.set('view', next);
    setParams(nextParams, { replace: true });
    setHiddenTask(null);
  };

  const sections: { id: string; label?: string; tone?: 'warning'; tasks: CalendarEvent[] }[] = view === 'open'
    ? [
      { id: 'overdue', label: 'Overdue', tone: 'warning' as const, tasks: groups.overdue },
      { id: 'today', label: 'Today', tasks: groups.today },
      { id: 'later', label: 'Later', tasks: groups.later },
      { id: 'undated', label: 'No date', tasks: groups.undated },
    ].filter(section => section.tasks.length)
    : [{ id: view, tasks: groups[view] }];
  const total = sections.reduce((sum, section) => sum + section.tasks.length, 0);

  // Views and lists stay in sight on every window size; nothing folds away.
  const filters = (
    <div className="space-y-2 px-4 pb-3 md:px-6">
      <ChipGroup label="View">
        {(Object.keys(VIEWS) as View[]).map(id => (
          <Chip key={id} icon={VIEWS[id].icon} selected={view === id} onSelect={() => selectView(id)}
            count={id === 'done' ? null : groups[id].length} countTone={id === 'overdue' ? 'warning' : 'default'} countLabel={id === 'done' ? undefined : 'tasks'}>
            {VIEWS[id].label}
          </Chip>
        ))}
      </ChipGroup>
      {calendars.length > 1 && (
        <ChipGroup label="List">
          <Chip icon={CalendarDays} selected={!calendarId} onSelect={() => setCalendarId(null)}>All lists</Chip>
          {calendars.map(calendar => (
            <Chip key={calendar.id} color={calendar.color} selected={calendarId === calendar.id} onSelect={() => setCalendarId(calendar.id)}
              count={openCount(calendar.id)} countLabel="open tasks">
              {calendar.name}
            </Chip>
          ))}
        </ChipGroup>
      )}
    </div>
  );

  return (
    <PageShell>
      <PageHeader title={title} actions={<Button size="sm" onClick={() => setCreating(true)} aria-label="New task"><Plus aria-hidden="true" /><span className="hidden sm:inline">New task</span></Button>}>
        {filters}
      </PageHeader>

      <PageBody width="reading">
        {hiddenTask && (
          <p className="mb-4 text-sm text-muted-foreground">
            This task is in a list hidden from ToDo.{' '}
            <Link to={`/calendar?event=${encodeURIComponent(hiddenTask)}`} className="rounded-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open in Calendar</Link>
          </p>
        )}
        {tasksQuery.isLoading ? <LoadingState label="Loading tasks…" />
          : tasksQuery.error ? <ErrorState title="Could not load tasks" error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} retrying={tasksQuery.isFetching} />
          : total === 0 ? (
            <EmptyState icon={CheckCircle2}
              title={view === 'done' ? 'Nothing done yet' : view === 'open' ? 'No open tasks' : `Nothing in ${VIEWS[view].label}`}
              description={view === 'open' ? 'Create a task here, or turn on tasks for a calendar in Calendar.' : undefined}
              action={view === 'done' ? undefined : <Button variant="outline" onClick={() => setCreating(true)}><Plus aria-hidden="true" />New task</Button>} />
          ) : sections.map(section => (
            <section key={section.id} aria-label={section.label ?? VIEWS[view].label} className="mb-6 last:mb-0">
              {section.label && <h2 className={section.tone === 'warning' ? 'mb-1 text-sm font-medium text-warning' : 'mb-1 text-sm font-medium text-muted-foreground'}>{section.label}</h2>}
              <ul>
                {section.tasks.map(task => (
                  <TaskRow key={task.id} task={task} actions={actions} timezone={timezone} calendarColor={calendarColor(task)} onEdit={setEditing} onMove={setMoving} />
                ))}
              </ul>
            </section>
          ))}
      </PageBody>
      <NewTaskDialog open={creating} onOpenChange={setCreating} actions={actions} timezone={timezone} />
      <EditTaskDialog task={editing} onClose={() => setEditing(null)} actions={actions} timezone={timezone} />
      <MoveTaskDialog task={moving} onClose={() => setMoving(null)} actions={actions} timezone={timezone} />
    </PageShell>
  );
};

export default TodoPage;
