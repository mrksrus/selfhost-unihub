import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, endOfDay, format, isAfter, isBefore, parseISO, startOfDay } from 'date-fns';
import { ArrowRight, Calendar, CheckCircle2, Clock, Mail, Plus, Search, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { calendarApi, calendarQueryKeys, formatEventTime, type CalendarEvent } from '@/lib/calendar-api';

type Stats = {
  contacts: number;
  upcomingEvents: number;
  unreadEmails: number;
};

type EmailSummary = {
  id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  received_at: string;
};

const Dashboard = () => {
  const { user } = useAuth();
  const timezone = user?.timezone ?? null;
  const firstName = user?.full_name?.split(' ')[0] || 'there';
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const { data: stats = { contacts: 0, upcomingEvents: 0, unreadEmails: 0 } } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => {
      const response = await api.get<Stats>('/stats');
      if (response.error) throw new Error(response.error);
      return response.data || { contacts: 0, upcomingEvents: 0, unreadEmails: 0 };
    },
  });

  const { data: todayEvents = [] } = useQuery({
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

  const { data: taskEvents = [] } = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: true, includeDone: false, respectAutoTodo: true }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true, includeDone: false, respectAutoTodo: true }),
  });

  const { data: unreadEmails = [] } = useQuery({
    queryKey: ['dashboard-unread-mail'],
    queryFn: async () => {
      const response = await api.get<{ emails: EmailSummary[] }>('/mail/emails?limit=5&offset=0&is_read=false');
      if (response.error) throw new Error(response.error);
      return response.data?.emails || [];
    },
  });

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
  const tomorrow = addDays(todayStart, 1);

  const metrics = [
    { label: 'Contacts', value: stats.contacts, href: '/contacts', icon: Users },
    { label: 'Today', value: todayEvents.length, href: '/calendar', icon: Calendar },
    { label: 'Unread', value: stats.unreadEmails, href: '/mail', icon: Mail },
    { label: 'Overdue', value: overdueTasks.length, href: '/todo', icon: CheckCircle2 },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Today</h1>
          <p className="text-muted-foreground mt-1">
            Good {getTimeOfDay()}, {firstName}. {format(now, 'EEEE, MMMM d')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/contacts?action=new"><Plus className="h-4 w-4 mr-2" />Contact</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/calendar?action=new"><Plus className="h-4 w-4 mr-2" />Event</Link>
          </Button>
          <Button asChild>
            <Link to="/mail?action=compose"><Plus className="h-4 w-4 mr-2" />Email</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {metrics.map((metric) => (
          <Link key={metric.label} to={metric.href} className="rounded-md border bg-card p-4 hover:border-accent/50 transition-colors">
            <div className="flex items-center justify-between">
              <metric.icon className="h-5 w-5 text-muted-foreground" />
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-3 text-2xl font-semibold">{metric.value}</p>
            <p className="text-sm text-muted-foreground">{metric.label}</p>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Today&apos;s Agenda</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/calendar">Calendar</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {todayEvents.length === 0 ? (
              <EmptyState icon={Calendar} title="No events today" actionHref="/calendar?action=new" actionLabel="Create event" />
            ) : (
              <div className="space-y-3">
                {todayEvents.slice(0, 7).map((event) => (
                  <EventRow key={event.id} event={event} timezone={timezone} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Task Queue</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/todo">ToDo</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {overdueTasks.length > 0 && (
              <div>
                <Badge variant="destructive" className="mb-3">Overdue</Badge>
                <div className="space-y-2">
                  {overdueTasks.map((event) => <TaskRow key={event.id} event={event} timezone={timezone} />)}
                </div>
              </div>
            )}
            <div>
              <div className="flex items-center justify-between mb-3">
                <Badge variant="secondary">Next</Badge>
                <span className="text-xs text-muted-foreground">through {format(tomorrow, 'MMM d')}</span>
              </div>
              {nextTasks.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="No active tasks" actionHref="/todo" actionLabel="Open ToDo" compact />
              ) : (
                <div className="space-y-2">
                  {nextTasks.map((event) => <TaskRow key={event.id} event={event} timezone={timezone} />)}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Unread Mail</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/mail">Mail</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {unreadEmails.length === 0 ? (
              <EmptyState icon={Mail} title="Inbox is caught up" actionHref="/mail" actionLabel="Open mail" compact />
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
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Find Anything</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-dashed p-5">
              <Search className="h-6 w-6 text-muted-foreground mb-3" />
              <p className="font-medium">Global search and commands</p>
              <p className="text-sm text-muted-foreground mt-1">
                Press Ctrl+K or Cmd+K to search contacts, mail, calendar events, todos, and actions.
              </p>
            </div>
          </CardContent>
        </Card>
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

const EmptyState = ({
  icon: Icon,
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
  <div className={`text-center text-muted-foreground ${compact ? 'py-4' : 'py-8'}`}>
    <Icon className="h-9 w-9 mx-auto mb-3 opacity-50" />
    <p>{title}</p>
    <Button asChild variant="link" className="mt-1">
      <Link to={actionHref}>{actionLabel}</Link>
    </Button>
  </div>
);

const getTimeOfDay = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
};

export default Dashboard;
