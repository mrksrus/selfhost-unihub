import { useMemo, useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { Plus, ChevronLeft, ChevronRight, Clock, MapPin, Trash2, Edit, Loader2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, parseISO, startOfMonth, startOfWeek, subMonths } from 'date-fns';
import { enGB } from 'date-fns/locale';
import { useAuth } from '@/contexts/AuthContext';
import { calendarApi, calendarQueryKeys, formatEventTime, localDatetimeToIso, toDatetimeLocalValue, type CalendarEvent } from '@/lib/calendar-api';

const colorOptions = [
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#06b6d4', label: 'Cyan' },
];

const reminderOptions = [
  { value: 0, label: 'At event time' },
  { value: 5, label: '5 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '1 day before' },
];

const CalendarPage = () => {
  const { user } = useAuth();
  const timezone = user?.timezone ?? null;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    all_day: false,
    location: '',
    color: '#22c55e',
    reminders: [0] as number[],
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'new') {
      setIsDialogOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const invalidateCalendarQueries = () => {
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.upcomingEvents });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.stats });
  };

  const { data: events = [], isLoading } = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: false }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: false }),
  });

  const monthEvents = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    return events.filter((event) => {
      const eventDate = parseISO(event.start_time);
      return eventDate >= monthStart && eventDate <= monthEnd;
    });
  }, [events, currentMonth]);

  const createEvent = useMutation({
    mutationFn: () => calendarApi.createEvent({
      title: formData.title,
      description: formData.description || null,
      start_time: localDatetimeToIso(formData.start_time, timezone),
      end_time: localDatetimeToIso(formData.end_time, timezone),
      all_day: formData.all_day,
      location: formData.location || null,
      color: formData.color,
      reminders: formData.reminders,
      is_todo_only: false,
    }),
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Event created successfully' });
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create event', description: error.message, variant: 'destructive' });
    },
  });

  const updateEvent = useMutation({
    mutationFn: () => {
      if (!editingEvent) throw new Error('No event selected');
      return calendarApi.updateEvent(editingEvent.id, {
        title: formData.title,
        description: formData.description || null,
        start_time: localDatetimeToIso(formData.start_time, timezone),
        end_time: localDatetimeToIso(formData.end_time, timezone),
        all_day: formData.all_day,
        location: formData.location || null,
        color: formData.color,
        reminders: formData.reminders,
      });
    },
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Event updated successfully' });
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update event', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEvent = useMutation({
    mutationFn: (id: string) => calendarApi.deleteEvent(id),
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Event deleted successfully' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete event', description: error.message, variant: 'destructive' });
    },
  });

  const resetForm = () => {
    setFormData({
      title: '',
      description: '',
      start_time: '',
      end_time: '',
      all_day: false,
      location: '',
      color: '#22c55e',
      reminders: [0],
    });
    setEditingEvent(null);
    setIsDialogOpen(false);
  };

  const handleNewEvent = (date?: Date) => {
    const targetDate = date || selectedDate || new Date();
    const start = new Date(targetDate);
    start.setHours(9, 0, 0, 0);
    const end = new Date(targetDate);
    end.setHours(10, 0, 0, 0);
    setFormData((prev) => ({
      ...prev,
      start_time: format(start, "yyyy-MM-dd'T'HH:mm"),
      end_time: format(end, "yyyy-MM-dd'T'HH:mm"),
    }));
    setIsDialogOpen(true);
  };

  const handleEdit = (event: CalendarEvent) => {
    setEditingEvent(event);
    setFormData({
      title: event.title,
      description: event.description || '',
      start_time: toDatetimeLocalValue(event.start_time, timezone),
      end_time: toDatetimeLocalValue(event.end_time, timezone),
      all_day: event.all_day,
      location: event.location || '',
      color: event.color,
      reminders: event.reminders || [0],
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!formData.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' });
      return;
    }
    if (!formData.start_time || !formData.end_time) {
      toast({ title: 'Start and end times are required', variant: 'destructive' });
      return;
    }
    if (new Date(formData.end_time).getTime() < new Date(formData.start_time).getTime()) {
      toast({ title: 'End time must be after start time', variant: 'destructive' });
      return;
    }
    if (editingEvent) {
      updateEvent.mutate();
    } else {
      createEvent.mutate();
    }
  };

  const weekStartsOnMonday = { weekStartsOn: 1 as const };
  const calendarStart = startOfWeek(startOfMonth(currentMonth), weekStartsOnMonday);
  const calendarEnd = endOfWeek(endOfMonth(currentMonth), weekStartsOnMonday);
  const calendarDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  const getEventsForDay = (date: Date) => {
    return monthEvents.filter((event) => isSameDay(parseISO(event.start_time), date));
  };

  const selectedDateEvents = selectedDate ? getEventsForDay(selectedDate) : [];

  const getStatusPrefix = (status: CalendarEvent['todo_status']) => {
    if (status === 'cancelled') return 'CANCELLED: ';
    if (status === 'done') return 'DONE: ';
    return '';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
          <p className="text-muted-foreground">Planning mode for all scheduled work.</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button onClick={() => handleNewEvent()}>
              <Plus className="h-4 w-4 mr-2" />
              New Event
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editingEvent ? 'Edit Event' : 'Create New Event'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(event) => setFormData((prev) => ({ ...prev, title: event.target.value }))}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start_time">Start Time *</Label>
                  <Input
                    id="start_time"
                    type="datetime-local"
                    value={formData.start_time}
                    onChange={(event) => setFormData((prev) => ({ ...prev, start_time: event.target.value }))}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_time">End Time *</Label>
                  <Input
                    id="end_time"
                    type="datetime-local"
                    value={formData.end_time}
                    onChange={(event) => setFormData((prev) => ({ ...prev, end_time: event.target.value }))}
                    required
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="all-day-toggle">All day</Label>
                <Switch
                  id="all-day-toggle"
                  checked={formData.all_day}
                  onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, all_day: checked }))}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="location">Location</Label>
                <Input
                  id="location"
                  value={formData.location}
                  onChange={(event) => setFormData((prev) => ({ ...prev, location: event.target.value }))}
                  placeholder="Add location"
                />
              </div>

              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex gap-2">
                  {colorOptions.map((color) => (
                    <button
                      key={color.value}
                      type="button"
                      onClick={() => setFormData((prev) => ({ ...prev, color: color.value }))}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${
                        formData.color === color.value ? 'border-foreground scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color.value }}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(event) => setFormData((prev) => ({ ...prev, description: event.target.value }))}
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label>Reminders (up to 3)</Label>
                <div className="space-y-2">
                  {formData.reminders.map((reminder, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Select
                        value={String(reminder)}
                        onValueChange={(value) => {
                          const nextReminders = [...formData.reminders];
                          nextReminders[index] = Number(value);
                          setFormData((prev) => ({ ...prev, reminders: nextReminders }));
                        }}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {reminderOptions.map((option) => (
                            <SelectItem key={option.value} value={String(option.value)}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {formData.reminders.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            const nextReminders = formData.reminders.filter((_, reminderIndex) => reminderIndex !== index);
                            setFormData((prev) => ({ ...prev, reminders: nextReminders }));
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {formData.reminders.length < 3 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFormData((prev) => ({ ...prev, reminders: [...prev.reminders, 15] }))}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Reminder
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createEvent.isPending || updateEvent.isPending}>
                  {(createEvent.isPending || updateEvent.isPending) && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {editingEvent ? 'Save Changes' : 'Create Event'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">{format(currentMonth, 'MMMM yyyy')}</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setCurrentMonth(new Date())}>
                  Today
                </Button>
                <Button variant="outline" size="icon" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 mb-2">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                <div key={day} className="p-2 text-center text-sm font-medium text-muted-foreground">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map((day) => {
                const dayEvents = getEventsForDay(day);
                const isSelected = selectedDate && isSameDay(day, selectedDate);
                const today = isToday(day);
                const isOtherMonth = !isSameMonth(day, currentMonth);
                return (
                  <button
                    key={day.toISOString()}
                    onClick={() => setSelectedDate(day)}
                    className={`aspect-square p-1 rounded-lg text-sm relative transition-colors ${
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : today
                          ? 'bg-accent/10 text-accent font-semibold'
                          : isOtherMonth
                            ? 'text-muted-foreground/60 hover:bg-muted/50'
                            : 'hover:bg-muted'
                    }`}
                  >
                    <span className="block">{format(day, 'd')}</span>
                    {dayEvents.length > 0 && (
                      <div className="flex justify-center gap-0.5 mt-0.5">
                        {dayEvents.slice(0, 3).map((event) => (
                          <div key={event.id} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: event.color }} />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {selectedDate ? format(selectedDate, 'EEEE, dd/MM/yyyy', { locale: enGB }) : 'Select a date'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDate && (
              <Button variant="outline" size="sm" className="w-full mb-4" onClick={() => handleNewEvent(selectedDate)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Event
              </Button>
            )}

            {selectedDateEvents.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No events scheduled</p>
              </div>
            ) : (
              <div className="space-y-3">
                <AnimatePresence mode="popLayout">
                  {selectedDateEvents.map((event) => {
                    const completedSubtasks = event.subtasks.filter((subtask) => subtask.is_done).length;
                    return (
                      <motion.div
                        key={event.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="group relative p-3 rounded-lg border border-border hover:border-accent/30 transition-colors"
                      >
                        <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg" style={{ backgroundColor: event.color }} />
                        <div className="pl-3">
                          <h4 className="font-medium text-foreground">
                            {getStatusPrefix(event.todo_status)}
                            {event.title}
                          </h4>
                          <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                            <Clock className="h-3.5 w-3.5" />
                            <span>
                              {event.all_day
                                ? formatEventTime(event.start_time, 'dd/MM/yyyy', timezone, { locale: enGB })
                                : `${formatEventTime(event.start_time, 'HH:mm', timezone, { locale: enGB })} - ${formatEventTime(event.end_time, 'HH:mm', timezone, { locale: enGB })}`}
                            </span>
                          </div>
                          {event.location && (
                            <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                              <MapPin className="h-3.5 w-3.5 shrink-0" />
                              <a
                                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline focus:underline focus:outline-none text-muted-foreground hover:text-foreground truncate"
                              >
                                {event.location}
                              </a>
                            </div>
                          )}
                          {event.subtasks.length > 0 && (
                            <p className="text-xs text-muted-foreground mt-2">
                              Subtasks: {completedSubtasks}/{event.subtasks.length} done
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="sm" onClick={() => handleEdit(event)}>
                              <Edit className="h-3.5 w-3.5 mr-1" />
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => deleteEvent.mutate(event.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1" />
                              Delete
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default CalendarPage;
