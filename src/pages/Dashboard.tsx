import { useModules } from '@/hooks/use-modules';
import { mailQueryKeys } from '@/lib/mail-api';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, endOfDay, format, startOfDay } from 'date-fns';
import { Check, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { calendarApi, calendarQueryKeys, formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import { useTaskActions } from '@/hooks/use-task-actions';
import { formatListDate } from '@/components/mail/mail-page-model';
import { isOverdue, taskWhen } from '@/lib/tasks';
import type { ReactNode } from 'react';

type EmailSummary = {
  id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  received_at: string;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function Section({ title, link, children }: { title: string; link?: { to: string; label: string }; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-8 last:mb-0">
      <div className="mb-1 flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {link && <Link to={link.to} className="text-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{link.label}</Link>}
      </div>
      {children}
    </section>
  );
}

/** One line of the schedule: time, calendar color, title. */
function Slot({ event, timezone, label, now }: { event: CalendarEvent; timezone: string | null; label: string; now?: boolean }) {
  return (
    <Link to={`/calendar?event=${encodeURIComponent(event.id)}`}
      className="grid grid-cols-[4.5rem_3px_1fr] items-stretch gap-3 border-b border-border py-2.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <span className={cn('pt-0.5 text-sm tabular-nums', now ? 'font-semibold text-accent' : 'text-muted-foreground')}>{label}</span>
      <span aria-hidden="true" className="rounded-full" style={{ backgroundColor: event.color || 'hsl(var(--calendar-color))' }} />
      <span className="min-w-0">
        <span className="block truncate">{event.title}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {event.all_day ? 'All day' : `Until ${formatEventTime(event.end_time, 'HH:mm', timezone)}`}{event.location ? `, ${event.location}` : ''}
        </span>
      </span>
    </Link>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="border-b border-border py-2.5 pl-[5.25rem] text-sm text-muted-foreground">{children}</p>;

const Dashboard = () => {
  const { user } = useAuth();
  const { canNavigate, isEnabled } = useModules();
  const timezone = user?.timezone ?? null;
  const actions = useTaskActions();
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const weekEnd = endOfDay(addDays(now, 7));
  const showCalendar = canNavigate('/calendar');
  const showTasks = canNavigate('/todo');
  const showMail = canNavigate('/mail');

  const todayFilters = { includeTodos: false, includeDone: false, visibleOnly: true, rangeStart: todayStart.toISOString(), rangeEnd: todayEnd.toISOString() };
  const todayEventsQuery = useQuery({
    enabled: isEnabled('calendar') && showCalendar,
    queryKey: calendarQueryKeys.list(todayFilters),
    queryFn: ({ signal }) => calendarApi.fetchEvents(todayFilters, signal),
  });
  const weekFilters = { includeTodos: false, includeDone: false, visibleOnly: true, rangeStart: todayEnd.toISOString(), rangeEnd: weekEnd.toISOString() };
  const weekQuery = useQuery({
    enabled: isEnabled('calendar') && showCalendar,
    queryKey: calendarQueryKeys.list(weekFilters),
    queryFn: ({ signal }) => calendarApi.fetchEvents(weekFilters, signal),
  });
  const taskFilters = { includeTodos: true, includeDone: false, respectAutoTodo: true };
  const taskEventsQuery = useQuery({
    enabled: isEnabled('calendar') && showTasks,
    queryKey: calendarQueryKeys.list(taskFilters),
    queryFn: ({ signal }) => calendarApi.fetchEvents(taskFilters, signal),
  });
  const unreadEmailsQuery = useQuery({
    queryKey: mailQueryKeys.dashboardUnread,
    enabled: isEnabled('mail') && showMail,
    queryFn: async ({ signal }) => {
      const response = await api.get<{ emails: EmailSummary[]; pagination?: { total: number } }>('/mail/emails?limit=5&offset=0&is_read=false&include_count=true', { signal });
      if (response.error) throw new Error(response.error);
      return { emails: response.data?.emails || [], total: response.data?.pagination?.total ?? response.data?.emails?.length ?? 0 };
    },
  });

  const todayEvents = (todayEventsQuery.data ?? []).slice().sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start_time.localeCompare(b.start_time));
  const nextEvents = (weekQuery.data ?? []).filter(event => !todayEvents.some(today => today.id === event.id)).slice(0, 5);
  const activeTasks = (taskEventsQuery.data ?? [])
    .filter((event) => event.todo_status !== 'done' && event.todo_status !== 'cancelled')
    .sort((a, b) => Number(a.is_todo_only) - Number(b.is_todo_only) || a.start_time.localeCompare(b.start_time));
  const overdueTasks = activeTasks.filter(task => isOverdue(task));
  const shownTasks = [...overdueTasks, ...activeTasks.filter(task => !overdueTasks.includes(task))].slice(0, 6);
  const unread = unreadEmailsQuery.data;
  const current = todayEvents.find(event => !event.all_day && new Date(event.end_time) > now);

  const summary = [
    showCalendar && todayEventsQuery.data && (todayEvents.length ? `${plural(todayEvents.length, 'appointment', 'appointments')} today` : 'Nothing scheduled today'),
    showTasks && taskEventsQuery.data && overdueTasks.length > 0 && `${plural(overdueTasks.length, 'task', 'tasks')} overdue`,
    showMail && unread && unread.total > 0 && `${plural(unread.total, 'unread email', 'unread emails')}`,
  ].filter(Boolean) as string[];
  const sentence = summary.length ? `${summary.slice(0, -1).join(', ')}${summary.length > 1 ? ' and ' : ''}${summary[summary.length - 1]}.`.replace(/^./, c => c.toUpperCase()) : null;

  return (
    <PageShell>
      <PageHeader title="Today" className="md:hidden" />
      <PageBody width="wide" className="md:py-10">
        <div className="mb-8 flex flex-col gap-4 md:mb-10 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="sr-only">Today</p>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{format(now, 'EEEE, d MMMM')}</h1>
            {sentence && <p className="mt-2 text-muted-foreground">{sentence}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {showTasks && <Button asChild variant="outline" size="sm"><Link to="/todo?action=new"><Plus aria-hidden="true" />Task</Link></Button>}
            {showCalendar && <Button asChild variant="outline" size="sm"><Link to="/calendar?action=new"><Plus aria-hidden="true" />Event</Link></Button>}
            {canNavigate('/contacts') && <Button asChild variant="outline" size="sm"><Link to="/contacts?action=new"><Plus aria-hidden="true" />Contact</Link></Button>}
            {showMail && <Button asChild size="sm"><Link to="/mail?action=compose"><Plus aria-hidden="true" />Email</Link></Button>}
          </div>
        </div>

        {!showCalendar && !showTasks && !showMail ? (
          <p className="text-muted-foreground">Calendar, ToDo and Mail are hidden or turned off. Choose what to show in Settings.</p>
        ) : (
          <div className="grid grid-cols-1 gap-x-14 lg:grid-cols-[1.15fr_1fr]">
            {showCalendar && (
              <div>
                <Section title="Schedule" link={{ to: '/calendar', label: 'Calendar' }}>
                  {todayEventsQuery.isLoading ? <LoadingState compact label="Loading today's events…" />
                    : todayEventsQuery.error ? <ErrorState title="Could not load today's events" error={todayEventsQuery.error} onRetry={() => void todayEventsQuery.refetch()} retrying={todayEventsQuery.isFetching} />
                    : <>
                      {todayEvents.length === 0 && <Note>Nothing scheduled today.</Note>}
                      {todayEvents.map(event => (
                        <Slot key={event.id} event={event} timezone={timezone} now={event.id === current?.id}
                          label={event.all_day ? 'All day' : formatEventTime(event.start_time, 'HH:mm', timezone)} />
                      ))}
                    </>}
                </Section>
                {nextEvents.length > 0 && (
                  <Section title="Next days">
                    {nextEvents.map(event => (
                      <Slot key={event.id} event={event} timezone={timezone}
                        label={formatEventTime(event.start_time, event.all_day ? 'EEE d' : 'EEE HH:mm', timezone)} />
                    ))}
                  </Section>
                )}
              </div>
            )}
            <div>
              {showTasks && (
                <Section title="Tasks" link={{ to: '/todo', label: 'All tasks' }}>
                  {taskEventsQuery.isLoading ? <LoadingState compact label="Loading tasks…" />
                    : taskEventsQuery.error ? <ErrorState title="Could not load tasks" error={taskEventsQuery.error} onRetry={() => void taskEventsQuery.refetch()} retrying={taskEventsQuery.isFetching} />
                    : shownTasks.length === 0 ? <p className="py-2.5 text-sm text-muted-foreground">No open tasks.</p>
                    : <ul>
                      {shownTasks.map(task => {
                        const late = overdueTasks.includes(task);
                        return (
                          <li key={task.id} className="flex items-start gap-3 border-b border-border py-2.5">
                            <button type="button" aria-label={`Mark ${task.title} done`}
                              disabled={actions.setStatus.isPending && actions.setStatus.variables?.id === task.id}
                              onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: 'done' })}
                              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-muted-foreground/60 text-transparent hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
                            </button>
                            <Link to={late ? '/todo?view=overdue' : '/todo'} className="min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
                              <span className="block truncate">{task.title}</span>
                              <span className={cn('block text-sm', late ? 'text-warning' : 'text-muted-foreground')}>
                                {late ? `Overdue since ${formatEventTime(task.end_time, 'd MMM', timezone)}` : taskWhen(task, timezone)}
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>}
                </Section>
              )}
              {showMail && (
                <Section title="Unread mail" link={{ to: '/mail', label: 'Inbox' }}>
                  {unreadEmailsQuery.isLoading ? <LoadingState compact label="Loading unread mail…" />
                    : unreadEmailsQuery.error ? <ErrorState title="Could not load unread mail" error={unreadEmailsQuery.error} onRetry={() => void unreadEmailsQuery.refetch()} retrying={unreadEmailsQuery.isFetching} />
                    : !unread?.emails.length ? <p className="py-2.5 text-sm text-muted-foreground">Inbox is caught up.</p>
                    : <ul>
                      {unread.emails.map(email => (
                        <li key={email.id}>
                          <Link to={`/mail?email=${email.id}`} className="flex items-start gap-3 border-b border-border py-2.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{email.subject || '(No subject)'}</span>
                              <span className="block truncate text-sm text-muted-foreground">{email.from_name || email.from_address}</span>
                            </span>
                            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{formatListDate(email.received_at)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>}
                </Section>
              )}
            </div>
          </div>
        )}
      </PageBody>
    </PageShell>
  );
};

export default Dashboard;
