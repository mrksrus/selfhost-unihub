import { useEffect, useMemo, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, CalendarClock, CalendarDays, CheckCircle2, Inbox, ListTodo, Plus, Sun } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { useTaskActions } from '@/hooks/use-task-actions';
import { useNotificationEventLink } from '@/hooks/use-notification-event-link';
import { calendarApi, calendarQueryKeys, formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { NarrowOnly, PageBody, PageHeader, PageShell, PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [moving, setMoving] = useState<CalendarEvent | null>(null);
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
  useEffect(() => {
    const taskId = params.get('task');
    if (!taskId || !tasksQuery.data) return;
    const linked = tasksQuery.data.find(task => task.id === taskId);
    const next = new URLSearchParams(params);
    next.delete('task');
    if (linked) {
      if (linked.todo_status === 'done') next.set('view', 'done'); else next.delete('view');
      setCalendarId(null);
      setOpenId(taskId);
      linkedTask.current = taskId;
    }
    setParams(next, { replace: true });
  }, [params, setParams, tasksQuery.data]);
  // Once the linked task's row is open, bring it into view.
  const linkedTask = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || openId !== linkedTask.current) return;
    linkedTask.current = null;
    document.getElementById(`task-${openId}-details`)?.scrollIntoView?.({ block: 'center' });
  }, [openId]);

  const tasks = useMemo(() => (tasksQuery.data ?? []).filter(task => !calendarId || task.calendar_id === calendarId), [tasksQuery.data, calendarId]);
  const groups = useMemo(() => groupTasks(tasks, timezone), [tasks, timezone]);
  const calendarColor = (task: CalendarEvent) => calendars.length > 1 ? calendars.find(calendar => calendar.id === task.calendar_id)?.color : undefined;
  const openCount = (id: string) => (tasksQuery.data ?? []).filter(task => active(task) && task.calendar_id === id).length;

  const selectView = (next: View) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'open') nextParams.delete('view'); else nextParams.set('view', next);
    setParams(nextParams, { replace: true });
    setOpenId(null);
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

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title={title} action={<Button size="sm" onClick={() => setCreating(true)}><Plus aria-hidden="true" />New</Button>} />
      <PanelGroup>
        {(Object.keys(VIEWS) as View[]).map(id => (
          <PanelItem key={id} icon={VIEWS[id].icon} active={view === id} onSelect={() => selectView(id)}
            count={id === 'done' ? null : groups[id].length} countTone={id === 'overdue' ? 'warning' : 'default'} countLabel={id === 'done' ? undefined : 'tasks'}>
            {VIEWS[id].label}
          </PanelItem>
        ))}
      </PanelGroup>
      {calendars.length > 1 && (
        <PanelGroup label="Calendars" className="border-t border-border pt-3">
          <PanelItem icon={CalendarDays} active={!calendarId} onSelect={() => setCalendarId(null)}>All calendars</PanelItem>
          {calendars.map(calendar => (
            <PanelItem key={calendar.id} color={calendar.color} active={calendarId === calendar.id} onSelect={() => setCalendarId(calendar.id)}
              count={openCount(calendar.id)} countLabel="open tasks">
              {calendar.name}
            </PanelItem>
          ))}
        </PanelGroup>
      )}
    </div>
  );

  const scope = [VIEWS[view].label, calendarId && calendars.find(calendar => calendar.id === calendarId)?.name].filter(Boolean).join(' · ');

  return (
    <PageShell panel={panel} panelLabel="Task lists">
      <PageHeader title={title} scope={scope} actions={<NarrowOnly><Button size="sm" onClick={() => setCreating(true)} aria-label="New task"><Plus aria-hidden="true" /><span className="hidden sm:inline">New task</span></Button></NarrowOnly>} />

      <PageBody width="reading">
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
                  <TaskRow key={task.id} task={task} actions={actions} timezone={timezone} calendarColor={calendarColor(task)}
                    open={openId === task.id} onToggle={() => setOpenId(openId === task.id ? null : task.id)}
                    onEdit={setEditing} onMove={setMoving} />
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
