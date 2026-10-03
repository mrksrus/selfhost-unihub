import { useModules } from '@/hooks/use-modules';
import { mailQueryKeys } from '@/lib/mail-api';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { endOfDay, format, isAfter, isBefore, parseISO, startOfDay } from 'date-fns';
import { Calendar, CheckCircle2, Clock, Mail, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { calendarApi, calendarQueryKeys, formatEventTime, type CalendarEvent } from '@/lib/calendar-api';

type EmailSummary = {
  id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  received_at: string;
};

const Dashboard = () => {
  const { user } = useAuth();
  const { canNavigate, isEnabled, isSuccess: modulesReady } = useModules();
  const timezone = user?.timezone ?? null;
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const todayEventsQuery = useQuery({
    enabled: isEnabled('calendar'),
    queryKey: calendarQueryKeys.list({
      includeTodos: false,
      includeDone: false,
      visibleOnly: true,
      rangeStart: todayStart.toISOString(),
      rangeEnd: todayEnd.toISOString(),
    }),
    queryFn: () => calendarApi.fetchEvents({
      includeTodos: false,
      includeDone: false,
      visibleOnly: true,
      rangeStart: todayStart.toISOString(),
      rangeEnd: todayEnd.toISOString(),
    }),
  });
  const todayEvents = todayEventsQuery.data ?? [];

  const taskEventsQuery = useQuery({
    enabled: isEnabled('calendar'),
    queryKey: calendarQueryKeys.list({ includeTodos: true, includeDone: false, respectAutoTodo: true }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true, includeDone: false, respectAutoTodo: true }),
  });
  const taskEvents = taskEventsQuery.data ?? [];

  const unreadEmailsQuery = useQuery({
    queryKey: mailQueryKeys.dashboardUnread,
    enabled: isEnabled('mail'),
    queryFn: async () => {
      const response = await api.get<{ emails: EmailSummary[] }>('/mail/emails?limit=5&offset=0&is_read=false&include_count=false');
      if (response.error) throw new Error(response.error);
      return response.data?.emails || [];
    },
  });
  const unreadEmails = unreadEmailsQuery.data ?? [];

  const activeTasks = taskEvents
    .filter((event) => event.todo_status !== 'done' && event.todo_status !== 'cancelled')
    .sort((a, b) => {
      if (a.is_todo_only && !b.is_todo_only) return 1;
      if (!a.is_todo_only && b.is_todo_only) return -1;
      return parseISO(a.start_time).getTime() - parseISO(b.start_time).getTime();
    });
  const overdueTasks = activeTasks.filter((event) => !event.is_todo_only && isBefore(parseISO(event.end_time), now)).slice(0, 4);
  const nextTasks = activeTasks
    .filter((event) => event.is_todo_only || isAfter(parseISO(event.end_time), now))
    .slice(0, 5);
  const sections = ['/calendar', '/todo', '/mail'].filter(href => canNavigate(href)).length;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Today</h1>
          <p className="text-muted-foreground mt-1">{format(now, 'EEEE, MMMM d')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canNavigate('/contacts') && (<Button asChild variant="outline">
            <Link to="/contacts?action=new"><Plus className="h-4 w-4 mr-2" />Contact</Link>
          </Button>)}
          {canNavigate('/calendar') && (<Button asChild variant="outline">
            <Link to="/calendar?action=new"><Plus className="h-4 w-4 mr-2" />Event</Link>
          </Button>)}
          {canNavigate('/mail') && (<Button asChild>
            <Link to="/mail?action=compose"><Plus className="h-4 w-4 mr-2" />Email</Link>
          </Button>)}
        </div>
      </div>

      {modulesReady && sections === 0 && <EmptyState icon={Calendar} title="Nothing to show" description="Calendar, ToDo and Mail are hidden or disabled." />}

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 items-start">
        {canNavigate('/calendar') && (<Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Agenda</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/calendar">Calendar</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {todayEventsQuery.isLoading ? (
              <LoadingState compact label="Loading today's events…" />
            ) : todayEventsQuery.error ? (
              <ErrorState
                title="Could not load today's events"
                error={todayEventsQuery.error}
                onRetry={() => void todayEventsQuery.refetch()}
                retrying={todayEventsQuery.isFetching}
              />
            ) : todayEvents.length === 0 ? (
              <DashboardEmpty icon={Calendar} title="No events today" actionHref="/calendar?action=new" actionLabel="Create event" />
            ) : (
              <div className="space-y-3">
                {todayEvents.slice(0, 7).map((event) => (
                  <EventRow key={event.id} event={event} timezone={timezone} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>)}

        {canNavigate('/todo') && (<Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Tasks</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/todo">ToDo</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {taskEventsQuery.isLoading ? (
              <LoadingState compact label="Loading tasks…" />
            ) : taskEventsQuery.error ? (
              <ErrorState
                title="Could not load tasks"
                error={taskEventsQuery.error}
                onRetry={() => void taskEventsQuery.refetch()}
                retrying={taskEventsQuery.isFetching}
              />
            ) : (<>
            {overdueTasks.length > 0 && (
              <div>
                <Badge variant="destructive" className="mb-3">Overdue</Badge>
                <div className="space-y-2">
                  {overdueTasks.map((event) => <TaskRow key={event.id} event={event} timezone={timezone} />)}
                </div>
              </div>
            )}
            <div>
              {overdueTasks.length > 0 && <Badge variant="secondary" className="mb-3">Next</Badge>}
              {nextTasks.length === 0 ? (
                <DashboardEmpty icon={CheckCircle2} title="No active tasks" actionHref="/todo" actionLabel="Open ToDo" compact />
              ) : (
                <div className="space-y-2">
                  {nextTasks.map((event) => <TaskRow key={event.id} event={event} timezone={timezone} />)}
                </div>
              )}
            </div>
            </>)}
          </CardContent>
        </Card>)}

        {canNavigate('/mail') && (<Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Unread mail</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/mail">Mail</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {unreadEmailsQuery.isLoading ? (
              <LoadingState compact label="Loading unread mail…" />
            ) : unreadEmailsQuery.error ? (
              <ErrorState
                title="Could not load unread mail"
                error={unreadEmailsQuery.error}
                onRetry={() => void unreadEmailsQuery.refetch()}
                retrying={unreadEmailsQuery.isFetching}
              />
            ) : unreadEmails.length === 0 ? (
              <DashboardEmpty icon={Mail} title="Inbox is caught up" actionHref="/mail" actionLabel="Open mail" compact />
            ) : (
              <div className="space-y-3">
                {unreadEmails.map((email) => (
                  <Link key={email.id} to={`/mail?email=${email.id}`} className="block rounded-md border p-3 hover:bg-muted/50 transition-colors">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium truncate">{email.from_name || email.from_address}</p>
                      <span className="text-xs text-muted-foreground shrink-0">{format(parseISO(email.received_at), 'MMM d')}</span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-1">{email.subject || '(No subject)'}</p>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>)}
      </div>
    </div>
  );
};

const EventRow = ({ event, timezone }: { event: CalendarEvent; timezone?: string | null }) => (
  <div className="flex items-start gap-3 rounded-md border p-3">
    <div className="mt-1 h-10 w-1 rounded-full" style={{ backgroundColor: event.color || 'hsl(var(--calendar-color))' }} />
    <div className="min-w-0 flex-1">
      <p className="font-medium truncate">{event.title}</p>
      <p className="text-sm text-muted-foreground">
        {event.all_day
          ? 'All day'
          : `${formatEventTime(event.start_time, 'HH:mm', timezone)} - ${formatEventTime(event.end_time, 'HH:mm', timezone)}`}
      </p>
    </div>
  </div>
);

const TaskRow = ({ event, timezone }: { event: CalendarEvent; timezone?: string | null }) => (
  <Link to="/todo" className="flex items-start gap-3 rounded-md border p-3 hover:bg-muted/50 transition-colors">
    <CheckCircle2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
    <div className="min-w-0 flex-1">
      <p className="font-medium truncate">{event.title}</p>
      <p className="text-xs text-muted-foreground">
        {event.is_todo_only ? 'Unscheduled' : (
          <><Clock className="inline h-3 w-3 mr-1" />{formatEventTime(event.start_time, 'MMM d, HH:mm', timezone)}</>
        )}
      </p>
    </div>
  </Link>
);

const DashboardEmpty = ({
  icon,
  title,
  actionHref,
  actionLabel,
  compact = false,
}: {
  icon: typeof Calendar;
  title: string;
  actionHref: string;
  actionLabel: string;
  compact?: boolean;
}) => (
  <EmptyState
    icon={icon}
    title={title}
    compact={compact}
    action={(
      <Button asChild variant="link" className="h-auto p-0">
        <Link to={actionHref}>{actionLabel}</Link>
      </Button>
    )}
  />
);

export default Dashboard;
