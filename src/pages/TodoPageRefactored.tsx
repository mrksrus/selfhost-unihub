import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCalendarNotifications } from '@/hooks/use-calendar-notifications';
import { useAuth } from '@/contexts/AuthContext';
import { calendarApi, calendarQueryKeys, formatEventTime, localDatetimeToIso, toDatetimeLocalValue, type CalendarEvent, type CalendarSubtask } from '@/lib/calendar-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, Clock, XCircle, Edit, Loader2, Plus, X, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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

const TodoPage = () => {
  const { user } = useAuth();
  const timezone = user?.timezone ?? null;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useCalendarNotifications();

  const [isChangeDialogOpen, setIsChangeDialogOpen] = useState(false);
  const [isTimeMoveDialogOpen, setIsTimeMoveDialogOpen] = useState(false);
  const [isNewTodoDialogOpen, setIsNewTodoDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [showDoneTasks, setShowDoneTasks] = useState(false);
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState('');
  const [newSubtaskByEvent, setNewSubtaskByEvent] = useState<Record<string, string>>({});

  const [newTodoForm, setNewTodoForm] = useState({
    title: '',
    description: '',
    scheduled: false,
    start_time: '',
    end_time: '',
    location: '',
    color: '#22c55e',
    reminders: [0] as number[],
  });

  const [changeForm, setChangeForm] = useState({
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    all_day: false,
    location: '',
    color: '#22c55e',
    reminders: [0] as number[],
  });

  const [timeMoveForm, setTimeMoveForm] = useState({
    start_time: '',
    end_time: '',
  });

  const invalidateCalendarQueries = () => {
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.upcomingEvents });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.stats });
  };

  useEffect(() => {
    const handleSWMessage = (event: MessageEvent) => {
      if (event.data?.type === 'CHECK_CALENDAR') {
        queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSWMessage);
      return () => {
        navigator.serviceWorker.removeEventListener('message', handleSWMessage);
      };
    }
  }, [queryClient]);

  const { data: events = [], isLoading } = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: true }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true }),
  });

  const createTodo = useMutation({
    mutationFn: async () => {
      const payload: Partial<CalendarEvent> & { title: string } = {
        title: newTodoForm.title.trim(),
        description: newTodoForm.description || null,
        location: newTodoForm.location || null,
        color: newTodoForm.color,
        reminders: newTodoForm.scheduled ? newTodoForm.reminders : null,
      };

      if (newTodoForm.scheduled) {
        payload.start_time = localDatetimeToIso(newTodoForm.start_time, timezone);
        payload.end_time = localDatetimeToIso(newTodoForm.end_time, timezone);
        payload.is_todo_only = false;
      } else {
        payload.is_todo_only = true;
      }

      return calendarApi.createEvent(payload);
    },
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Todo created successfully' });
      setIsNewTodoDialogOpen(false);
      setNewTodoForm({
        title: '',
        description: '',
        scheduled: false,
        start_time: '',
        end_time: '',
        location: '',
        color: '#22c55e',
        reminders: [0],
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create todo', description: error.message, variant: 'destructive' });
    },
  });

  const updateEventAndMarkChanged = useMutation({
    mutationFn: async (payload: { id: string; update: Partial<CalendarEvent> }) => {
      await calendarApi.updateEvent(payload.id, payload.update);
      return calendarApi.updateTodoStatus(payload.id, { todo_status: 'changed' });
    },
    onSuccess: () => {
      invalidateCalendarQueries();
      toast({ title: 'Task updated' });
      setIsChangeDialogOpen(false);
      setEditingEvent(null);
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update task', description: error.message, variant: 'destructive' });
    },
  });

  const updateTodoStatus = useMutation({
    mutationFn: (payload: { id: string; todo_status: CalendarEvent['todo_status']; start_time?: string; end_time?: string }) => (
      calendarApi.updateTodoStatus(payload.id, {
        todo_status: payload.todo_status,
        start_time: payload.start_time,
        end_time: payload.end_time,
      })
    ),
    onSuccess: () => {
      invalidateCalendarQueries();
      setIsTimeMoveDialogOpen(false);
      setEditingEvent(null);
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update task status', description: error.message, variant: 'destructive' });
    },
  });

  const createSubtask = useMutation({
    mutationFn: ({ eventId, title }: { eventId: string; title: string }) => calendarApi.createSubtask(eventId, { title }),
    onSuccess: (_, variables) => {
      invalidateCalendarQueries();
      setNewSubtaskByEvent((prev) => ({ ...prev, [variables.eventId]: '' }));
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to add subtask', description: error.message, variant: 'destructive' });
    },
  });

  const updateSubtask = useMutation({
    mutationFn: (payload: { eventId: string; subtaskId: string; update: Partial<Pick<CalendarSubtask, 'title' | 'is_done' | 'position'>> }) => (
      calendarApi.updateSubtask(payload.eventId, payload.subtaskId, payload.update)
    ),
    onSuccess: () => {
      invalidateCalendarQueries();
      setEditingSubtaskId(null);
      setEditingSubtaskTitle('');
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update subtask', description: error.message, variant: 'destructive' });
    },
  });

  const deleteSubtask = useMutation({
    mutationFn: ({ eventId, subtaskId }: { eventId: string; subtaskId: string }) => calendarApi.deleteSubtask(eventId, subtaskId),
    onSuccess: () => {
      invalidateCalendarQueries();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete subtask', description: error.message, variant: 'destructive' });
    },
  });

  const reorderSubtasks = useMutation({
    mutationFn: ({ eventId, subtaskIds }: { eventId: string; subtaskIds: string[] }) => calendarApi.reorderSubtasks(eventId, subtaskIds),
    onSuccess: () => {
      invalidateCalendarQueries();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to reorder subtasks', description: error.message, variant: 'destructive' });
    },
  });

  const activeEvents = useMemo(() => {
    return events
      .filter((event) => event.todo_status !== 'done' && event.todo_status !== 'cancelled')
      .sort((a, b) => {
        if (a.is_todo_only && !b.is_todo_only) return -1;
        if (!a.is_todo_only && b.is_todo_only) return 1;
        return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
      });
  }, [events]);

  const doneEvents = useMemo(() => {
    return events
      .filter((event) => event.todo_status === 'done')
      .sort((a, b) => {
        const aTime = a.done_at ? new Date(a.done_at).getTime() : new Date(a.updated_at).getTime();
        const bTime = b.done_at ? new Date(b.done_at).getTime() : new Date(b.updated_at).getTime();
        return bTime - aTime;
      });
  }, [events]);

  const now = Date.now();
  const overdueEvents = activeEvents.filter(
    (event) => !event.is_todo_only && new Date(event.end_time).getTime() < now
  );
  const plannedEvents = activeEvents.filter(
    (event) => event.is_todo_only || new Date(event.end_time).getTime() >= now
  );

  const openChangeDialog = (event: CalendarEvent) => {
    setEditingEvent(event);
    setChangeForm({
      title: event.title,
      description: event.description || '',
      start_time: toDatetimeLocalValue(event.start_time, timezone),
      end_time: toDatetimeLocalValue(event.end_time, timezone),
      all_day: event.all_day,
      location: event.location || '',
      color: event.color,
      reminders: event.reminders || [0],
    });
    setIsChangeDialogOpen(true);
  };

  const openTimeMoveDialog = (event: CalendarEvent) => {
    setEditingEvent(event);
    setTimeMoveForm({
      start_time: toDatetimeLocalValue(event.start_time, timezone),
      end_time: toDatetimeLocalValue(event.end_time, timezone),
    });
    setIsTimeMoveDialogOpen(true);
  };

  const handleChangeSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!editingEvent) return;
    if (!changeForm.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' });
      return;
    }

    updateEventAndMarkChanged.mutate({
      id: editingEvent.id,
      update: {
        title: changeForm.title.trim(),
        description: changeForm.description || null,
        start_time: localDatetimeToIso(changeForm.start_time, timezone),
        end_time: localDatetimeToIso(changeForm.end_time, timezone),
        all_day: changeForm.all_day,
        location: changeForm.location || null,
        color: changeForm.color,
        reminders: changeForm.reminders,
      },
    });
  };

  const handleTimeMoveSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!editingEvent) return;
    updateTodoStatus.mutate({
      id: editingEvent.id,
      todo_status: 'time_moved',
      start_time: localDatetimeToIso(timeMoveForm.start_time, timezone),
      end_time: timeMoveForm.end_time ? localDatetimeToIso(timeMoveForm.end_time, timezone) : undefined,
    });
  };

  const moveSubtask = (event: CalendarEvent, subtaskId: string, direction: -1 | 1) => {
    const ids = event.subtasks.map((subtask) => subtask.id);
    const currentIndex = ids.indexOf(subtaskId);
    const targetIndex = currentIndex + direction;
    if (currentIndex === -1 || targetIndex < 0 || targetIndex >= ids.length) return;
    const reordered = [...ids];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
    reorderSubtasks.mutate({ eventId: event.id, subtaskIds: reordered });
  };

  const getStatusBadge = (status: CalendarEvent['todo_status']) => {
    switch (status) {
      case 'done':
        return <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Done</span>;
      case 'changed':
        return <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Changed</span>;
      case 'time_moved':
        return <span className="px-2 py-1 text-xs rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">Time Moved</span>;
      case 'cancelled':
        return <span className="px-2 py-1 text-xs rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">Cancelled</span>;
      default:
        return null;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  const renderTaskCard = (event: CalendarEvent, isDoneSection = false) => (
    <motion.div
      key={event.id}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.2 }}
    >
      <Card className={isDoneSection ? 'opacity-80' : ''}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <h3 className={`font-semibold text-lg ${isDoneSection ? 'line-through' : ''}`}>{event.title}</h3>
                {getStatusBadge(event.todo_status)}
                {event.is_todo_only && (
                  <span className="px-2 py-1 text-xs rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                    Unscheduled
                  </span>
                )}
              </div>

              {event.description && (
                <p className="text-sm text-muted-foreground mb-2">{event.description}</p>
              )}

              {!event.is_todo_only && (
                <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mb-3">
                  <div className="flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    <span>
                      {event.all_day
                        ? formatEventTime(event.start_time, 'MMM d, yyyy', timezone)
                        : `${formatEventTime(event.start_time, 'MMM d, yyyy h:mm a', timezone)} - ${formatEventTime(event.end_time, 'h:mm a', timezone)}`}
                    </span>
                  </div>
                  {event.location && (
                    <div className="flex items-center gap-1">
                      <span>📍</span>
                      <span>{event.location}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2 rounded-md border border-border/60 p-3">
                <div className="text-sm font-medium">Subtasks</div>
                {event.subtasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No subtasks yet.</p>
                ) : (
                  <div className="space-y-2">
                    {event.subtasks.map((subtask, index) => (
                      <div key={subtask.id} className="flex items-center gap-2">
                        <Checkbox
                          checked={subtask.is_done}
                          onCheckedChange={(checked) => updateSubtask.mutate({
                            eventId: event.id,
                            subtaskId: subtask.id,
                            update: { is_done: checked === true },
                          })}
                        />
                        {editingSubtaskId === subtask.id ? (
                          <>
                            <Input
                              value={editingSubtaskTitle}
                              onChange={(evt) => setEditingSubtaskTitle(evt.target.value)}
                              className="h-8"
                            />
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => updateSubtask.mutate({
                                eventId: event.id,
                                subtaskId: subtask.id,
                                update: { title: editingSubtaskTitle },
                              })}
                            >
                              Save
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditingSubtaskId(null);
                                setEditingSubtaskTitle('');
                              }}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className={`flex-1 text-sm ${subtask.is_done ? 'line-through text-muted-foreground' : ''}`}>
                              {subtask.title}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveSubtask(event, subtask.id, -1)}
                              disabled={index === 0}
                              className="h-7 w-7"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveSubtask(event, subtask.id, 1)}
                              disabled={index === event.subtasks.length - 1}
                              className="h-7 w-7"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setEditingSubtaskId(subtask.id);
                                setEditingSubtaskTitle(subtask.title);
                              }}
                              className="h-7 w-7"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => deleteSubtask.mutate({ eventId: event.id, subtaskId: subtask.id })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {!isDoneSection && (
                  <form
                    className="flex gap-2"
                    onSubmit={(submitEvent) => {
                      submitEvent.preventDefault();
                      const newTitle = (newSubtaskByEvent[event.id] || '').trim();
                      if (!newTitle) return;
                      createSubtask.mutate({ eventId: event.id, title: newTitle });
                    }}
                  >
                    <Input
                      value={newSubtaskByEvent[event.id] || ''}
                      onChange={(inputEvent) => setNewSubtaskByEvent((prev) => ({
                        ...prev,
                        [event.id]: inputEvent.target.value,
                      }))}
                      placeholder="Add subtask..."
                      className="h-8"
                    />
                    <Button type="submit" size="sm">
                      Add
                    </Button>
                  </form>
                )}
              </div>

              {event.done_at && (
                <p className="text-xs text-muted-foreground mt-2">
                  Completed: {formatEventTime(event.done_at, 'MMM d, yyyy h:mm a', timezone)}
                </p>
              )}
            </div>

            {!isDoneSection && (
              <div className="flex flex-col gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateTodoStatus.mutate({ id: event.id, todo_status: 'done' })}
                  disabled={updateTodoStatus.isPending}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Done
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openChangeDialog(event)}
                  disabled={updateEventAndMarkChanged.isPending}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openTimeMoveDialog(event)}
                  disabled={updateTodoStatus.isPending || event.is_todo_only}
                >
                  <Clock className="h-4 w-4 mr-2" />
                  Move Time
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => updateTodoStatus.mutate({ id: event.id, todo_status: 'cancelled' })}
                  disabled={updateTodoStatus.isPending}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              </div>
            )}

            {isDoneSection && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => updateTodoStatus.mutate({ id: event.id, todo_status: null })}
                disabled={updateTodoStatus.isPending}
              >
                Reopen
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">ToDo List</h1>
          <p className="text-muted-foreground">
            Execution mode for your planned tasks. Keep working through overdue and upcoming work in one place.
          </p>
        </div>

        <Dialog open={isNewTodoDialogOpen} onOpenChange={setIsNewTodoDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Todo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Todo</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!newTodoForm.title.trim()) return;
                if (newTodoForm.scheduled && (!newTodoForm.start_time || !newTodoForm.end_time)) {
                  toast({ title: 'Start and end time are required for scheduled tasks', variant: 'destructive' });
                  return;
                }
                createTodo.mutate();
              }}
              className="space-y-4 mt-4"
            >
              <div className="space-y-2">
                <Label htmlFor="todo-title">Title *</Label>
                <Input
                  id="todo-title"
                  value={newTodoForm.title}
                  onChange={(event) => setNewTodoForm((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="What needs to be done?"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="todo-description">Description</Label>
                <Textarea
                  id="todo-description"
                  value={newTodoForm.description}
                  onChange={(event) => setNewTodoForm((prev) => ({ ...prev, description: event.target.value }))}
                  rows={3}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="font-medium text-sm">Schedule in calendar</p>
                  <p className="text-xs text-muted-foreground">Turn on to assign explicit start/end time.</p>
                </div>
                <Switch
                  checked={newTodoForm.scheduled}
                  onCheckedChange={(checked) => setNewTodoForm((prev) => ({ ...prev, scheduled: checked }))}
                />
              </div>

              {newTodoForm.scheduled && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Start Time</Label>
                      <Input
                        type="datetime-local"
                        value={newTodoForm.start_time}
                        onChange={(event) => setNewTodoForm((prev) => ({ ...prev, start_time: event.target.value }))}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>End Time</Label>
                      <Input
                        type="datetime-local"
                        value={newTodoForm.end_time}
                        onChange={(event) => setNewTodoForm((prev) => ({ ...prev, end_time: event.target.value }))}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Location</Label>
                    <Input
                      value={newTodoForm.location}
                      onChange={(event) => setNewTodoForm((prev) => ({ ...prev, location: event.target.value }))}
                      placeholder="Optional location"
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex gap-2">
                  {colorOptions.map((color) => (
                    <button
                      key={color.value}
                      type="button"
                      onClick={() => setNewTodoForm((prev) => ({ ...prev, color: color.value }))}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${
                        newTodoForm.color === color.value ? 'border-foreground scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color.value }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsNewTodoDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createTodo.isPending}>
                  {createTodo.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Todo
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {overdueEvents.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3 text-destructive">Overdue</h2>
          <div className="space-y-4">
            <AnimatePresence mode="popLayout">
              {overdueEvents.map((event) => renderTaskCard(event))}
            </AnimatePresence>
          </div>
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Planned / Active</h2>
        {plannedEvents.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <CheckCircle2 className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium mb-2">No active tasks</h3>
              <p className="text-muted-foreground">Create a todo or schedule tasks from Calendar.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <AnimatePresence mode="popLayout">
              {plannedEvents.map((event) => renderTaskCard(event))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {doneEvents.length > 0 && (
        <Collapsible open={showDoneTasks} onOpenChange={setShowDoneTasks}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              <span>Done Tasks ({doneEvents.length})</span>
              {showDoneTasks ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 space-y-4 max-h-96 overflow-y-auto">
              <AnimatePresence mode="popLayout">
                {doneEvents.map((event) => renderTaskCard(event, true))}
              </AnimatePresence>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <Dialog open={isChangeDialogOpen} onOpenChange={setIsChangeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Task Details</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleChangeSubmit} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="change-title">Title *</Label>
              <Input
                id="change-title"
                value={changeForm.title}
                onChange={(event) => setChangeForm((prev) => ({ ...prev, title: event.target.value }))}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="change-description">Description</Label>
              <Textarea
                id="change-description"
                value={changeForm.description}
                onChange={(event) => setChangeForm((prev) => ({ ...prev, description: event.target.value }))}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="change-start-time">Start Time</Label>
                <Input
                  id="change-start-time"
                  type="datetime-local"
                  value={changeForm.start_time}
                  onChange={(event) => setChangeForm((prev) => ({ ...prev, start_time: event.target.value }))}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="change-end-time">End Time</Label>
                <Input
                  id="change-end-time"
                  type="datetime-local"
                  value={changeForm.end_time}
                  onChange={(event) => setChangeForm((prev) => ({ ...prev, end_time: event.target.value }))}
                  required
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">All day event</p>
              </div>
              <Switch
                checked={changeForm.all_day}
                onCheckedChange={(checked) => setChangeForm((prev) => ({ ...prev, all_day: checked }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="change-location">Location</Label>
              <Input
                id="change-location"
                value={changeForm.location}
                onChange={(event) => setChangeForm((prev) => ({ ...prev, location: event.target.value }))}
                placeholder="Optional location"
              />
            </div>

            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2">
                {colorOptions.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setChangeForm((prev) => ({ ...prev, color: color.value }))}
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      changeForm.color === color.value ? 'border-foreground scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color.value }}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Reminders (up to 3)</Label>
              <div className="space-y-2">
                {changeForm.reminders.map((reminder, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Select
                      value={String(reminder)}
                      onValueChange={(value) => {
                        const nextReminders = [...changeForm.reminders];
                        nextReminders[index] = Number(value);
                        setChangeForm((prev) => ({ ...prev, reminders: nextReminders }));
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
                    {changeForm.reminders.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          const nextReminders = changeForm.reminders.filter((_, reminderIndex) => reminderIndex !== index);
                          setChangeForm((prev) => ({ ...prev, reminders: nextReminders }));
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {changeForm.reminders.length < 3 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setChangeForm((prev) => ({ ...prev, reminders: [...prev.reminders, 15] }))}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Reminder
                  </Button>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsChangeDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateEventAndMarkChanged.isPending}>
                Save Changes
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isTimeMoveDialogOpen} onOpenChange={setIsTimeMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Time</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleTimeMoveSubmit} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="time-move-start">New Start</Label>
              <Input
                id="time-move-start"
                type="datetime-local"
                value={timeMoveForm.start_time}
                onChange={(event) => setTimeMoveForm((prev) => ({ ...prev, start_time: event.target.value }))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="time-move-end">New End (optional)</Label>
              <Input
                id="time-move-end"
                type="datetime-local"
                value={timeMoveForm.end_time}
                onChange={(event) => setTimeMoveForm((prev) => ({ ...prev, end_time: event.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsTimeMoveDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateTodoStatus.isPending}>
                Move Time
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TodoPage;
