import { useMemo, useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, addMonths, eachDayOfInterval, endOfDay, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, parseISO, startOfDay, startOfMonth, startOfWeek, subDays, subMonths } from 'date-fns';
import { CheckCircle2, ChevronLeft, ChevronRight, Clock, Edit, Loader2, MapPin, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { calendarApi, calendarQueryKeys, formatEventTime, localDatetimeToIso, toDatetimeLocalValue, type CalendarAccount, type CalendarCalendar, type CalendarEvent, type CalendarProvider, type CalendarRsvpStatus } from '@/lib/calendar-api';

type CalendarViewMode = 'day' | 'week' | 'month';
const STORAGE_VIEW_KEY = 'calendar_view_mode';
const STORAGE_CURRENT_DATE_KEY = 'calendar_current_date';
const STORAGE_SELECTED_DATE_KEY = 'calendar_selected_date';
const STORAGE_SELECTED_CALENDAR_IDS_KEY = 'calendar_selected_ids';

const reminderOptions = [
  { value: 0, label: 'At event time' },
  { value: 5, label: '5 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '1 day before' },
];

const providerOptions: { value: CalendarProvider; label: string }[] = [
  { value: 'local', label: 'Local' },
];

function viewDateRange(viewMode: CalendarViewMode, baseDate: Date) {
  const weekOpts = { weekStartsOn: 1 as const };
  if (viewMode === 'day') {
    return { start: startOfDay(baseDate), end: endOfDay(baseDate) };
  }
  if (viewMode === 'week') {
    return { start: startOfWeek(baseDate, weekOpts), end: endOfWeek(baseDate, weekOpts) };
  }
  return {
    start: startOfWeek(startOfMonth(baseDate), weekOpts),
    end: endOfWeek(endOfMonth(baseDate), weekOpts),
  };
}

const CalendarPage = () => {
  const { user } = useAuth();
  const timezone = user?.timezone ?? null;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [viewMode, setViewMode] = useState<CalendarViewMode>(() => {
    const raw = localStorage.getItem(STORAGE_VIEW_KEY);
    return raw === 'day' || raw === 'week' || raw === 'month' ? raw : 'month';
  });
  const [currentDate, setCurrentDate] = useState(() => {
    const raw = localStorage.getItem(STORAGE_CURRENT_DATE_KEY);
    return raw ? new Date(raw) : new Date();
  });
  const [selectedDate, setSelectedDate] = useState(() => {
    const raw = localStorage.getItem(STORAGE_SELECTED_DATE_KEY);
    return raw ? new Date(raw) : new Date();
  });
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>(() => {
    const raw = localStorage.getItem(STORAGE_SELECTED_CALENDAR_IDS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [isEventDialogOpen, setIsEventDialogOpen] = useState(false);
  const [isAccountDialogOpen, setIsAccountDialogOpen] = useState(false);
  const [isCalendarDialogOpen, setIsCalendarDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);

  const [eventForm, setEventForm] = useState({
    calendar_id: '',
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    all_day: false,
    location: '',
    color: '#22c55e',
    reminders: [0] as number[],
    attendee_emails: '',
  });

  const [accountForm, setAccountForm] = useState({
    provider: 'local' as CalendarProvider,
    account_email: '',
    display_name: '',
  });

  const [calendarForm, setCalendarForm] = useState({
    account_id: '',
    name: '',
    color: '#22c55e',
    auto_todo_enabled: true,
  });

  const range = useMemo(() => viewDateRange(viewMode, currentDate), [viewMode, currentDate]);

  const invalidateCalendarQueries = () => {
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.accounts });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.calendars });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.upcomingEvents });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.stats });
  };

  const { data: accounts = [] } = useQuery({
    queryKey: calendarQueryKeys.accounts,
    queryFn: () => calendarApi.fetchAccounts(),
  });

  const { data: calendars = [] } = useQuery({
    queryKey: calendarQueryKeys.calendars,
    queryFn: () => calendarApi.fetchCalendars(),
  });

  useEffect(() => {
    if (selectedCalendarIds.length > 0 || calendars.length === 0) return;
    const visible = calendars.filter((calendar) => calendar.is_visible).map((calendar) => calendar.id);
    setSelectedCalendarIds(visible.length > 0 ? visible : calendars.map((calendar) => calendar.id));
  }, [calendars, selectedCalendarIds.length]);

  useEffect(() => {
    localStorage.setItem(STORAGE_VIEW_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_CURRENT_DATE_KEY, currentDate.toISOString());
  }, [currentDate]);

  useEffect(() => {
    localStorage.setItem(STORAGE_SELECTED_DATE_KEY, selectedDate.toISOString());
  }, [selectedDate]);

  useEffect(() => {
    localStorage.setItem(STORAGE_SELECTED_CALENDAR_IDS_KEY, JSON.stringify(selectedCalendarIds));
  }, [selectedCalendarIds]);

  const { data: events = [], isLoading } = useQuery({
    queryKey: calendarQueryKeys.list({
      includeTodos: false,
      includeDone: true,
      rangeStart: range.start.toISOString(),
      rangeEnd: range.end.toISOString(),
      calendarIds: selectedCalendarIds,
    }),
    queryFn: () => calendarApi.fetchEvents({
      includeTodos: false,
      includeDone: true,
      rangeStart: range.start.toISOString(),
      rangeEnd: range.end.toISOString(),
      calendarIds: selectedCalendarIds,
    }),
  });

  const createEventMutation = useMutation({
    mutationFn: async () => {
      const attendees = eventForm.attendee_emails
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
        .map((email) => ({ email, response_status: 'needsAction' as const }));
      return calendarApi.createEvent({
        calendar_id: eventForm.calendar_id || undefined,
        title: eventForm.title.trim(),
        description: eventForm.description || null,
        start_time: localDatetimeToIso(eventForm.start_time, timezone),
        end_time: localDatetimeToIso(eventForm.end_time, timezone),
        all_day: eventForm.all_day,
        location: eventForm.location || null,
        color: eventForm.color,
        reminders: eventForm.reminders,
        attendees,
      });
    },
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Event created' });
      resetEventForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create event', description: error.message, variant: 'destructive' });
    },
  });

  const updateEventMutation = useMutation({
    mutationFn: async () => {
      if (!editingEvent) throw new Error('No event selected');
      const attendees = eventForm.attendee_emails
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
        .map((email) => ({ email, response_status: 'needsAction' as const }));
      return calendarApi.updateEvent(editingEvent.id, {
        calendar_id: eventForm.calendar_id || undefined,
        title: eventForm.title.trim(),
        description: eventForm.description || null,
        start_time: localDatetimeToIso(eventForm.start_time, timezone),
        end_time: localDatetimeToIso(eventForm.end_time, timezone),
        all_day: eventForm.all_day,
        location: eventForm.location || null,
        color: eventForm.color,
        reminders: eventForm.reminders,
        attendees,
      });
    },
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Event updated' });
      resetEventForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update event', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEventMutation = useMutation({
    mutationFn: (id: string) => calendarApi.deleteEvent(id),
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Event deleted' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete event', description: error.message, variant: 'destructive' });
    },
  });

  const updateCalendarMutation = useMutation({
    mutationFn: (payload: { id: string; data: Partial<Pick<CalendarCalendar, 'is_visible' | 'auto_todo_enabled' | 'color'>> }) => (
      calendarApi.updateCalendar(payload.id, payload.data)
    ),
    onSuccess: () => invalidateCalendarQueries(),
    onError: (error: Error) => {
      toast({ title: 'Failed to update calendar', description: error.message, variant: 'destructive' });
    },
  });

  const createCalendarMutation = useMutation({
    mutationFn: () => calendarApi.createCalendar({
      account_id: calendarForm.account_id,
      name: calendarForm.name.trim(),
      color: calendarForm.color,
      auto_todo_enabled: calendarForm.auto_todo_enabled,
    }),
    onSuccess: () => {
      invalidateCalendarQueries();
      setIsCalendarDialogOpen(false);
      setCalendarForm((prev) => ({ ...prev, name: '' }));
      toast({ title: 'Calendar created' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create calendar', description: error.message, variant: 'destructive' });
    },
  });

  const createAccountMutation = useMutation({
    mutationFn: () => (
      calendarApi.createAccount({
        provider: accountForm.provider,
        account_email: accountForm.account_email || null,
        display_name: accountForm.display_name || null,
      })
    ),
    onSuccess: () => {
      invalidateCalendarQueries();
      setIsAccountDialogOpen(false);
      setAccountForm({
        provider: 'local',
        account_email: '',
        display_name: '',
      });
      toast({ title: 'Calendar account created' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create calendar account', description: error.message, variant: 'destructive' });
    },
  });

  const deleteAccountMutation = useMutation({
    mutationFn: (id: string) => calendarApi.deleteAccount(id),
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Account deleted' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete account', description: error.message, variant: 'destructive' });
    },
  });

  const deleteCalendarMutation = useMutation({
    mutationFn: (id: string) => calendarApi.deleteCalendar(id),
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Calendar deleted' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete calendar', description: error.message, variant: 'destructive' });
    },
  });

  const rsvpMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: CalendarRsvpStatus }) => (
      calendarApi.updateRsvp(id, { response_status: status })
    ),
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'RSVP updated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update RSVP', description: error.message, variant: 'destructive' });
    },
  });

  const groupedCalendars = useMemo(() => {
    const grouped = new Map<string, { account: CalendarAccount | null; calendars: CalendarCalendar[] }>();
    for (const account of accounts) {
      grouped.set(account.id, { account, calendars: [] });
    }
    for (const calendar of calendars) {
      const entry = grouped.get(calendar.account_id) || { account: null, calendars: [] };
      entry.calendars.push(calendar);
      grouped.set(calendar.account_id, entry);
    }
    return Array.from(grouped.entries()).map(([, value]) => value);
  }, [accounts, calendars]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = format(parseISO(event.start_time), 'yyyy-MM-dd');
      const list = map.get(key) || [];
      list.push(event);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const weekDays = useMemo(
    () => eachDayOfInterval({ start: startOfWeek(currentDate, { weekStartsOn: 1 }), end: endOfWeek(currentDate, { weekStartsOn: 1 }) }),
    [currentDate]
  );

  const monthDays = useMemo(
    () => eachDayOfInterval({ start: startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 }) }),
    [currentDate]
  );

  const selectedDateEvents = useMemo(() => {
    const key = format(selectedDate, 'yyyy-MM-dd');
    return (eventsByDay.get(key) || []).sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [eventsByDay, selectedDate]);

  const openEventDialog = (event?: CalendarEvent, date?: Date) => {
    if (event) {
      setEditingEvent(event);
      setEventForm({
        calendar_id: event.calendar_id || '',
        title: event.title,
        description: event.description || '',
        start_time: toDatetimeLocalValue(event.start_time, timezone),
        end_time: toDatetimeLocalValue(event.end_time, timezone),
        all_day: event.all_day,
        location: event.location || '',
        color: event.color,
        reminders: event.reminders || [0],
        attendee_emails: (event.attendees || []).map((attendee) => attendee.email).join(', '),
      });
    } else {
      const targetDate = date || selectedDate || new Date();
      const start = new Date(targetDate);
      start.setHours(9, 0, 0, 0);
      const end = new Date(targetDate);
      end.setHours(10, 0, 0, 0);
      setEditingEvent(null);
      setEventForm({
        calendar_id: calendars[0]?.id || '',
        title: '',
        description: '',
        start_time: format(start, "yyyy-MM-dd'T'HH:mm"),
        end_time: format(end, "yyyy-MM-dd'T'HH:mm"),
        all_day: false,
        location: '',
        color: '#22c55e',
        reminders: [0],
        attendee_emails: '',
      });
    }
    setIsEventDialogOpen(true);
  };

  const resetEventForm = () => {
    setIsEventDialogOpen(false);
    setEditingEvent(null);
    setEventForm({
      calendar_id: calendars[0]?.id || '',
      title: '',
      description: '',
      start_time: '',
      end_time: '',
      all_day: false,
      location: '',
      color: '#22c55e',
      reminders: [0],
      attendee_emails: '',
    });
  };

  const shiftPeriod = (direction: -1 | 1) => {
    if (viewMode === 'month') {
      setCurrentDate((prev) => (direction > 0 ? addMonths(prev, 1) : subMonths(prev, 1)));
      return;
    }
    if (viewMode === 'week') {
      setCurrentDate((prev) => (direction > 0 ? addDays(prev, 7) : subDays(prev, 7)));
      setSelectedDate((prev) => (direction > 0 ? addDays(prev, 7) : subDays(prev, 7)));
      return;
    }
    setCurrentDate((prev) => (direction > 0 ? addDays(prev, 1) : subDays(prev, 1)));
    setSelectedDate((prev) => (direction > 0 ? addDays(prev, 1) : subDays(prev, 1)));
  };

  useEffect(() => {
    if (viewMode === 'day') {
      setCurrentDate(selectedDate);
    }
  }, [viewMode, selectedDate]);

  const submitEventForm = (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!eventForm.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' });
      return;
    }
    if (!eventForm.start_time || !eventForm.end_time) {
      toast({ title: 'Start and end times are required', variant: 'destructive' });
      return;
    }
    if (!eventForm.calendar_id) {
      toast({ title: 'Select a calendar', variant: 'destructive' });
      return;
    }
    if (new Date(eventForm.end_time).getTime() < new Date(eventForm.start_time).getTime()) {
      toast({ title: 'End time must be after start time', variant: 'destructive' });
      return;
    }
    if (editingEvent) {
      updateEventMutation.mutate();
    } else {
      createEventMutation.mutate();
    }
  };

  const toggleCalendarVisibility = (calendarId: string, checked: boolean) => {
    setSelectedCalendarIds((prev) => {
      if (checked) return Array.from(new Set([...prev, calendarId]));
      return prev.filter((id) => id !== calendarId);
    });
    updateCalendarMutation.mutate({ id: calendarId, data: { is_visible: checked } });
  };

  const renderEventCompact = (event: CalendarEvent) => (
    <div
      key={event.id}
      className="relative rounded-md border border-border p-2 text-xs cursor-pointer hover:border-accent/50 transition-colors"
      style={{ borderLeftColor: event.color, borderLeftWidth: 4 }}
      onClick={() => openEventDialog(event)}
    >
      {event.todo_status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-600 absolute right-1 top-1" />}
      <div className="font-medium truncate pr-5">{event.title}</div>
      <div className="text-muted-foreground mt-0.5">
        {event.all_day
          ? 'All day'
          : `${formatEventTime(event.start_time, 'HH:mm', timezone)} - ${formatEventTime(event.end_time, 'HH:mm', timezone)}`}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] mx-auto">
      <div className="flex flex-col lg:flex-row gap-6">
        <Card className="w-full lg:w-[340px] shrink-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Calendars</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Dialog open={isAccountDialogOpen} onOpenChange={setIsAccountDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="flex-1">Add Account</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Calendar Account</DialogTitle>
                  </DialogHeader>
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      createAccountMutation.mutate();
                    }}
                  >
                    <div className="space-y-2">
                      <Label>Provider</Label>
                      <Select
                        value={accountForm.provider}
                        onValueChange={(value) => setAccountForm((prev) => ({ ...prev, provider: value as CalendarProvider }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {providerOptions.map((provider) => (
                            <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input
                        value={accountForm.account_email}
                        onChange={(event) => setAccountForm((prev) => ({ ...prev, account_email: event.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Display name</Label>
                      <Input
                        value={accountForm.display_name}
                        onChange={(event) => setAccountForm((prev) => ({ ...prev, display_name: event.target.value }))}
                      />
                    </div>
                    <Button type="submit" className="w-full" disabled={createAccountMutation.isPending}>
                      {createAccountMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Create Account
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>

              <Dialog open={isCalendarDialogOpen} onOpenChange={setIsCalendarDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="flex-1">Add Calendar</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Calendar</DialogTitle>
                  </DialogHeader>
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!calendarForm.account_id) {
                        toast({ title: 'Select an account', variant: 'destructive' });
                        return;
                      }
                      createCalendarMutation.mutate();
                    }}
                  >
                    <div className="space-y-2">
                      <Label>Account</Label>
                      <Select
                        value={calendarForm.account_id}
                        onValueChange={(value) => setCalendarForm((prev) => ({ ...prev, account_id: value }))}
                      >
                        <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                        <SelectContent>
                          {accounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.display_name || account.account_email || account.provider}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Name</Label>
                      <Input
                        value={calendarForm.name}
                        onChange={(event) => setCalendarForm((prev) => ({ ...prev, name: event.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Color</Label>
                      <Input
                        type="color"
                        value={calendarForm.color}
                        onChange={(event) => setCalendarForm((prev) => ({ ...prev, color: event.target.value }))}
                      />
                    </div>
                    <div className="flex items-center justify-between rounded border p-2">
                      <Label>Auto-create ToDo</Label>
                      <Switch
                        checked={calendarForm.auto_todo_enabled}
                        onCheckedChange={(checked) => setCalendarForm((prev) => ({ ...prev, auto_todo_enabled: checked }))}
                      />
                    </div>
                    <Button type="submit" className="w-full" disabled={createCalendarMutation.isPending}>
                      {createCalendarMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Create Calendar
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
              {groupedCalendars.map(({ account, calendars: accountCalendars }) => (
                <div key={account?.id || `unknown-${accountCalendars[0]?.account_id}`} className="rounded-md border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="text-sm font-semibold">{account?.display_name || account?.account_email || account?.provider || 'Account'}</p>
                      <p className="text-xs text-muted-foreground">{account?.provider || 'unknown'}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {account && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          title="Delete account"
                          onClick={() => {
                            const accepted = window.confirm(
                              'Delete this calendar account? All calendars and linked events in this account will be removed.'
                            );
                            if (!accepted) return;
                            deleteAccountMutation.mutate(account.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {accountCalendars.map((calendar) => {
                      const checked = selectedCalendarIds.includes(calendar.id);
                      return (
                        <div key={calendar.id} className="rounded border p-2 space-y-2">
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => toggleCalendarVisibility(calendar.id, event.target.checked)}
                            />
                            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: calendar.color }} />
                            <span className="flex-1 truncate">{calendar.name}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              title="Delete calendar"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const accepted = window.confirm(
                                  'Delete this calendar? All events in this calendar will be removed.'
                                );
                                if (!accepted) return;
                                deleteCalendarMutation.mutate(calendar.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </label>
                          <div className="flex items-center gap-2">
                            <Input
                              type="color"
                              className="h-8 w-16 p-1"
                              value={calendar.color}
                              onChange={(event) => updateCalendarMutation.mutate({
                                id: calendar.id,
                                data: { color: event.target.value },
                              })}
                            />
                            <div className="flex items-center justify-between flex-1 rounded border px-2 py-1">
                              <span className="text-xs">Auto-ToDo</span>
                              <Switch
                                checked={calendar.auto_todo_enabled}
                                onCheckedChange={(value) => updateCalendarMutation.mutate({
                                  id: calendar.id,
                                  data: { auto_todo_enabled: value },
                                })}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex-1 min-w-0 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
              <p className="text-muted-foreground">Multiple calendars, multiple views, and completed work history.</p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={viewMode} onValueChange={(value) => setViewMode(value as CalendarViewMode)}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => shiftPeriod(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCurrentDate(new Date())}>Today</Button>
              <Button variant="outline" size="icon" onClick={() => shiftPeriod(1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Dialog open={isEventDialogOpen} onOpenChange={(open) => { setIsEventDialogOpen(open); if (!open) resetEventForm(); }}>
                <DialogTrigger asChild>
                  <Button onClick={() => openEventDialog()}>
                    <Plus className="h-4 w-4 mr-2" />
                    New Event
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[560px]">
                  <DialogHeader>
                    <DialogTitle>{editingEvent ? 'Edit Event' : 'Create Event'}</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={submitEventForm} className="space-y-3">
                    <div className="space-y-2">
                      <Label>Calendar</Label>
                      <Select
                        value={eventForm.calendar_id}
                        onValueChange={(value) => setEventForm((prev) => ({ ...prev, calendar_id: value }))}
                      >
                        <SelectTrigger><SelectValue placeholder="Select calendar" /></SelectTrigger>
                        <SelectContent>
                          {calendars.map((calendar) => (
                            <SelectItem key={calendar.id} value={calendar.id}>
                              {calendar.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Title</Label>
                      <Input
                        value={eventForm.title}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, title: event.target.value }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Start</Label>
                        <Input
                          type="datetime-local"
                          value={eventForm.start_time}
                          onChange={(event) => setEventForm((prev) => ({ ...prev, start_time: event.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>End</Label>
                        <Input
                          type="datetime-local"
                          value={eventForm.end_time}
                          onChange={(event) => setEventForm((prev) => ({ ...prev, end_time: event.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded border p-2">
                      <Label>All day</Label>
                      <Switch
                        checked={eventForm.all_day}
                        onCheckedChange={(checked) => setEventForm((prev) => ({ ...prev, all_day: checked }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Location</Label>
                      <Input
                        value={eventForm.location}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, location: event.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Textarea
                        rows={3}
                        value={eventForm.description}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, description: event.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Attendees (comma-separated emails)</Label>
                      <Input
                        value={eventForm.attendee_emails}
                        onChange={(event) => setEventForm((prev) => ({ ...prev, attendee_emails: event.target.value }))}
                        placeholder="alice@example.com, bob@example.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Reminders</Label>
                      <div className="grid grid-cols-2 gap-2">
                        {reminderOptions.map((option) => {
                          const checked = eventForm.reminders.includes(option.value);
                          return (
                            <label key={option.value} className="flex items-center gap-2 text-sm rounded border px-2 py-1">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => {
                                  setEventForm((prev) => {
                                    if (event.target.checked) {
                                      return { ...prev, reminders: Array.from(new Set([...prev.reminders, option.value])).slice(0, 3) };
                                    }
                                    return { ...prev, reminders: prev.reminders.filter((value) => value !== option.value) };
                                  });
                                }}
                              />
                              {option.label}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button type="button" variant="outline" onClick={resetEventForm}>Cancel</Button>
                      <Button type="submit" disabled={createEventMutation.isPending || updateEventMutation.isPending}>
                        {(createEventMutation.isPending || updateEventMutation.isPending) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {editingEvent ? 'Save' : 'Create'}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>
                {viewMode === 'month' && format(currentDate, 'MMMM yyyy')}
                {viewMode === 'week' && `${format(weekDays[0], 'dd MMM')} - ${format(weekDays[6], 'dd MMM yyyy')}`}
                {viewMode === 'day' && format(currentDate, 'EEEE, dd MMM yyyy')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {viewMode === 'month' && (
                <div className="space-y-2">
                  <div className="grid grid-cols-7 text-sm text-muted-foreground">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                      <div key={day} className="p-2 text-center">{day}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {monthDays.map((day) => {
                      const key = format(day, 'yyyy-MM-dd');
                      const dayEvents = (eventsByDay.get(key) || []).slice(0, 3);
                      const isOtherMonth = !isSameMonth(day, currentDate);
                      const isSelectedDay = isSameDay(day, selectedDate);
                      return (
                        <button
                          key={key}
                          onClick={() => {
                            setSelectedDate(day);
                            setCurrentDate(day);
                          }}
                          className={`min-h-[108px] rounded border text-left p-1.5 align-top ${
                            isOtherMonth ? 'opacity-60' : ''
                          } ${isToday(day) ? 'border-accent' : 'border-border'} ${isSelectedDay ? 'ring-2 ring-primary border-primary' : ''}`}
                        >
                          <div className="text-xs font-medium mb-1">{format(day, 'd')}</div>
                          <div className="space-y-1">
                            {dayEvents.map((event) => (
                              <div key={event.id} className="relative rounded px-1 py-0.5 text-[11px] truncate" style={{ backgroundColor: `${event.color}20`, borderLeft: `3px solid ${event.color}` }}>
                                {event.todo_status === 'done' && <CheckCircle2 className="h-3 w-3 text-green-600 absolute right-1 top-0.5" />}
                                <span className="pr-4">{event.title}</span>
                              </div>
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {viewMode === 'week' && (
                <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
                  {weekDays.map((day) => {
                    const key = format(day, 'yyyy-MM-dd');
                    const dayEvents = (eventsByDay.get(key) || []).sort((a, b) => (
                      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
                    ));
                    const isSelectedDay = isSameDay(day, selectedDate);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setSelectedDate(day);
                          setCurrentDate(day);
                        }}
                        className={`rounded border p-2 text-left ${isToday(day) ? 'border-accent' : 'border-border'} ${isSelectedDay ? 'ring-2 ring-primary border-primary' : ''}`}
                      >
                        <div className="text-sm font-medium mb-2">{format(day, 'EEE dd')}</div>
                        <div className="space-y-2">
                          {dayEvents.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No events</p>
                          ) : (
                            dayEvents.map(renderEventCompact)
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {viewMode === 'day' && (
                <div className="space-y-2">
                  {selectedDateEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No events for this day.</p>
                  ) : (
                    selectedDateEvents.map((event) => (
                      <div key={event.id} className="relative rounded border p-3" style={{ borderLeft: `4px solid ${event.color}` }}>
                        {event.todo_status === 'done' && <CheckCircle2 className="h-5 w-5 text-green-600 absolute right-2 top-2" />}
                        <h4 className="font-semibold pr-7">{event.title}</h4>
                        <div className="mt-1 text-sm text-muted-foreground flex items-center gap-2">
                          <Clock className="h-4 w-4" />
                          {event.all_day
                            ? 'All day'
                            : `${formatEventTime(event.start_time, 'HH:mm', timezone)} - ${formatEventTime(event.end_time, 'HH:mm', timezone)}`}
                        </div>
                        {event.location && (
                          <div className="mt-1 text-sm text-muted-foreground flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            {event.location}
                          </div>
                        )}
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => openEventDialog(event)}>
                            <Edit className="h-3.5 w-3.5 mr-1" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteEventMutation.mutate(event.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            Delete
                          </Button>
                        </div>
                        {event.attendees.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-green-700"
                              onClick={() => rsvpMutation.mutate({ id: event.id, status: 'accepted' })}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => rsvpMutation.mutate({ id: event.id, status: 'tentative' })}
                            >
                              Maybe
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive"
                              onClick={() => rsvpMutation.mutate({ id: event.id, status: 'declined' })}
                            >
                              Decline
                            </Button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{format(selectedDate, 'EEEE, dd MMM yyyy')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {selectedDateEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events scheduled.</p>
                ) : (
                  selectedDateEvents.map(renderEventCompact)
                )}
                <Button variant="outline" size="sm" onClick={() => openEventDialog(undefined, selectedDate)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Event For Date
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default CalendarPage;
