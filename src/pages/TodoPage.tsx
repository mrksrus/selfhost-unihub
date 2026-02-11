import { useState, useEffect, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useCalendarNotifications } from '@/hooks/use-calendar-notifications';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, Clock, XCircle, Edit, Loader2, Plus, X, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format, parseISO } from 'date-fns';

const colorOptions = [
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#06b6d4', label: 'Cyan' },
];

interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  location: string | null;
  color: string;
  todo_status: string | null;
  reminders: number[] | null;
  is_todo_only: boolean;
  done_at: string | null;
  updated_at: string;
}

const TodoPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // Enable calendar notifications (tied to ToDo list)
  useCalendarNotifications();

  // Listen for service worker messages to trigger calendar checks
  useEffect(() => {
    const handleSWMessage = (event: MessageEvent) => {
      if (event.data?.type === 'CHECK_CALENDAR') {
        console.log('[TodoPage] Service worker requested calendar check');
        // Invalidate calendar events query to trigger refetch
        queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSWMessage);
      return () => {
        navigator.serviceWorker.removeEventListener('message', handleSWMessage);
      };
    }
  }, [queryClient]);
  const [isChangeDialogOpen, setIsChangeDialogOpen] = useState(false);
  const [isTimeMoveDialogOpen, setIsTimeMoveDialogOpen] = useState(false);
  const [isNewTodoDialogOpen, setIsNewTodoDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [newTodoForm, setNewTodoForm] = useState({
    title: '',
    description: '',
  });
  const [changeForm, setChangeForm] = useState({
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    location: '',
    color: '#22c55e',
    reminders: [0] as number[],
  });
  const [timeMoveForm, setTimeMoveForm] = useState({
    start_time: '',
  });
  const [showDoneTasks, setShowDoneTasks] = useState(false);

  // Fetch all calendar events including todos
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: async () => {
      const response = await api.get<{ events: CalendarEvent[] }>('/calendar/events?include_todos=true');
      if (response.error) throw new Error(response.error);
      return response.data?.events || [];
    },
  });

  // Filter events: show all events that are NOT done or cancelled (including standalone todos)
  const upcomingEvents = events.filter((e) => {
    return e.todo_status !== 'done' && e.todo_status !== 'cancelled';
  }).sort((a, b) => {
    // Sort standalone todos first (they have far-future dates), then by date
    if (a.is_todo_only && !b.is_todo_only) return -1;
    if (!a.is_todo_only && b.is_todo_only) return 1;
    return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
  });

  // Filter and sort done tasks by completion time (newest first)
  const doneEvents = events
    .filter((e) => e.todo_status === 'done')
    .sort((a, b) => {
      // Sort by done_at (newest first), fallback to updated_at if done_at is null
      const aTime = a.done_at ? new Date(a.done_at).getTime() : new Date(a.updated_at).getTime();
      const bTime = b.done_at ? new Date(b.done_at).getTime() : new Date(b.updated_at).getTime();
      return bTime - aTime;
    });

  // Update todo status mutation
  const updateTodoStatus = useMutation({
    mutationFn: async ({ id, todo_status, start_time }: { id: string; todo_status: string | null; start_time?: string }) => {
      const response = await api.put(`/calendar/events/${id}/todo-status`, { todo_status, start_time });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-events'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      toast({ title: 'Todo status updated' });
      setIsChangeDialogOpen(false);
      setIsTimeMoveDialogOpen(false);
      setEditingEvent(null);
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update todo status', description: error.message, variant: 'destructive' });
    },
  });

  // Create standalone todo mutation
  const createTodo = useMutation({
    mutationFn: async (todo: { title: string; description?: string }) => {
      // Use far-future date for standalone todos: 2099-12-31
      const farFutureDate = '2099-12-31T23:59:59';
      const response = await api.post('/calendar/events', {
        title: todo.title,
        description: todo.description || null,
        start_time: farFutureDate,
        end_time: farFutureDate,
        all_day: false,
        is_todo_only: true,
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-events'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      toast({ title: 'Todo created successfully' });
      setIsNewTodoDialogOpen(false);
      setNewTodoForm({ title: '', description: '' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create todo', description: error.message, variant: 'destructive' });
    },
  });

  // Update event mutation (for Changed action)
  const updateEvent = useMutation({
    mutationFn: async ({ id, ...event }: Partial<CalendarEvent> & { id: string }) => {
      const response = await api.put(`/calendar/events/${id}`, event);
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-events'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      toast({ title: 'Event updated' });
      setIsChangeDialogOpen(false);
      setEditingEvent(null);
      setChangeForm({ title: '', description: '', start_time: '', end_time: '', location: '', color: '#22c55e', reminders: [0] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update event', description: error.message, variant: 'destructive' });
    },
  });

  const handleDone = (event: CalendarEvent) => {
    updateTodoStatus.mutate({ id: event.id, todo_status: 'done' });
  };

  const handleChanged = (event: CalendarEvent) => {
    setEditingEvent(event);
    setChangeForm({
      title: event.title,
      description: event.description || '',
      start_time: event.start_time.slice(0, 16), // Format for datetime-local input
      end_time: event.end_time.slice(0, 16),
      location: event.location || '',
      color: event.color,
      reminders: event.reminders || [0],
    });
    setIsChangeDialogOpen(true);
  };

  const handleTimeMoved = (event: CalendarEvent) => {
    setEditingEvent(event);
    setTimeMoveForm({
      start_time: event.start_time.slice(0, 16),
    });
    setIsTimeMoveDialogOpen(true);
  };

  const handleCancelled = (event: CalendarEvent) => {
    updateTodoStatus.mutate({ id: event.id, todo_status: 'cancelled' });
  };

  const handleChangeSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!editingEvent) return;
    
    // Update all event fields
    updateEvent.mutate({
      id: editingEvent.id,
      title: changeForm.title,
      description: changeForm.description || null,
      start_time: changeForm.start_time ? new Date(changeForm.start_time).toISOString() : editingEvent.start_time,
      end_time: changeForm.end_time ? new Date(changeForm.end_time).toISOString() : editingEvent.end_time,
      location: changeForm.location || null,
      color: changeForm.color,
      reminders: changeForm.reminders,
    });
    
    // Then set todo_status to 'changed'
    updateTodoStatus.mutate({ id: editingEvent.id, todo_status: 'changed' });
  };

  const handleTimeMoveSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!editingEvent) return;
    updateTodoStatus.mutate({ 
      id: editingEvent.id, 
      todo_status: 'time_moved',
      start_time: timeMoveForm.start_time 
    });
  };

  const getStatusBadge = (status: string | null) => {
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

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">ToDo List</h1>
          <p className="text-muted-foreground">
            Manage your calendar events as tasks. Mark them as done, change details, move times, or cancel.
          </p>
        </div>
        <Dialog open={isNewTodoDialogOpen} onOpenChange={setIsNewTodoDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => setIsNewTodoDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New Todo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Todo</DialogTitle>
            </DialogHeader>
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!newTodoForm.title.trim()) return;
              createTodo.mutate(newTodoForm);
            }} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="todo-title">Title *</Label>
                <Input
                  id="todo-title"
                  value={newTodoForm.title}
                  onChange={(e) => setNewTodoForm({ ...newTodoForm, title: e.target.value })}
                  placeholder="What needs to be done?"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="todo-description">Description</Label>
                <Textarea
                  id="todo-description"
                  value={newTodoForm.description}
                  onChange={(e) => setNewTodoForm({ ...newTodoForm, description: e.target.value })}
                  placeholder="Add details..."
                  rows={3}
                />
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

      {upcomingEvents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CheckCircle2 className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-2">No todos</h3>
            <p className="text-muted-foreground">Create a new todo or add events in Calendar to see them here.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <AnimatePresence mode="popLayout">
            {upcomingEvents.map((event) => (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.2 }}
              >
                <Card className={event.todo_status === 'cancelled' ? 'opacity-60' : ''}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="font-semibold text-lg">{event.title}</h3>
                          {getStatusBadge(event.todo_status)}
                          {event.is_todo_only && (
                            <span className="px-2 py-1 text-xs rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                              Standalone
                            </span>
                          )}
                        </div>
                        {event.description && (
                          <p className="text-sm text-muted-foreground mb-2">{event.description}</p>
                        )}
                        {!event.is_todo_only && (
                          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <Clock className="h-4 w-4" />
                              <span>
                                {event.all_day
                                  ? format(parseISO(event.start_time), 'MMM d, yyyy')
                                  : format(parseISO(event.start_time), 'MMM d, yyyy h:mm a')}
                                {!event.all_day && (
                                  <> - {format(parseISO(event.end_time), 'h:mm a')}</>
                                )}
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
                      </div>
                      <div className="flex flex-col gap-2 shrink-0">
                        {event.todo_status !== 'done' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDone(event)}
                            disabled={updateTodoStatus.isPending}
                            className="w-full"
                          >
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            Done
                          </Button>
                        )}
                        {event.todo_status !== 'changed' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleChanged(event)}
                            disabled={updateTodoStatus.isPending}
                            className="w-full"
                          >
                            <Edit className="h-4 w-4 mr-2" />
                            Changed
                          </Button>
                        )}
                        {!event.is_todo_only && event.todo_status !== 'time_moved' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleTimeMoved(event)}
                            disabled={updateTodoStatus.isPending}
                            className="w-full"
                          >
                            <Clock className="h-4 w-4 mr-2" />
                            Time Moved
                          </Button>
                        )}
                        {event.todo_status !== 'cancelled' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCancelled(event)}
                            disabled={updateTodoStatus.isPending}
                            className="w-full text-destructive hover:text-destructive"
                          >
                            <XCircle className="h-4 w-4 mr-2" />
                            Cancel
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Done Tasks Section */}
      {doneEvents.length > 0 && (
        <Collapsible open={showDoneTasks} onOpenChange={setShowDoneTasks} className="mt-6">
          <CollapsibleTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-between"
            >
              <span>Done Tasks ({doneEvents.length})</span>
              {showDoneTasks ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 space-y-4 max-h-96 overflow-y-auto">
              <AnimatePresence mode="popLayout">
                {doneEvents.map((event) => (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Card className="opacity-75">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <h3 className="font-semibold text-lg line-through">{event.title}</h3>
                              {getStatusBadge(event.todo_status)}
                              {event.is_todo_only && (
                                <span className="px-2 py-1 text-xs rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                                  Standalone
                                </span>
                              )}
                            </div>
                            {event.description && (
                              <p className="text-sm text-muted-foreground mb-2">{event.description}</p>
                            )}
                            {!event.is_todo_only && (
                              <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                                <div className="flex items-center gap-1">
                                  <Clock className="h-4 w-4" />
                                  <span>
                                    {event.all_day
                                      ? format(parseISO(event.start_time), 'MMM d, yyyy')
                                      : format(parseISO(event.start_time), 'MMM d, yyyy h:mm a')}
                                    {!event.all_day && (
                                      <> - {format(parseISO(event.end_time), 'h:mm a')}</>
                                    )}
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
                            {event.done_at && (
                              <p className="text-xs text-muted-foreground mt-2">
                                Completed: {format(parseISO(event.done_at), 'MMM d, yyyy h:mm a')}
                              </p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Changed Dialog */}
      <Dialog open={isChangeDialogOpen} onOpenChange={setIsChangeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Event Details</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleChangeSubmit} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="change-title">Title *</Label>
              <Input
                id="change-title"
                value={changeForm.title}
                onChange={(e) => setChangeForm({ ...changeForm, title: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="change-description">Description</Label>
              <Textarea
                id="change-description"
                value={changeForm.description}
                onChange={(e) => setChangeForm({ ...changeForm, description: e.target.value })}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="change-start-time">Start Time (optional)</Label>
                <Input
                  id="change-start-time"
                  type="datetime-local"
                  value={changeForm.start_time}
                  onChange={(e) => setChangeForm({ ...changeForm, start_time: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="change-end-time">End Time (optional)</Label>
                <Input
                  id="change-end-time"
                  type="datetime-local"
                  value={changeForm.end_time}
                  onChange={(e) => setChangeForm({ ...changeForm, end_time: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="change-location">Location (optional)</Label>
              <Input
                id="change-location"
                value={changeForm.location}
                onChange={(e) => setChangeForm({ ...changeForm, location: e.target.value })}
                placeholder="Event location"
              />
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2">
                {colorOptions.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setChangeForm({ ...changeForm, color: color.value })}
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
                      value={reminder.toString()}
                      onValueChange={(value) => {
                        const newReminders = [...changeForm.reminders];
                        newReminders[index] = parseInt(value);
                        setChangeForm({ ...changeForm, reminders: newReminders });
                      }}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">At event time</SelectItem>
                        <SelectItem value="5">5 minutes before</SelectItem>
                        <SelectItem value="15">15 minutes before</SelectItem>
                        <SelectItem value="30">30 minutes before</SelectItem>
                        <SelectItem value="60">1 hour before</SelectItem>
                        <SelectItem value="120">2 hours before</SelectItem>
                        <SelectItem value="1440">1 day before</SelectItem>
                      </SelectContent>
                    </Select>
                    {changeForm.reminders.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          const newReminders = changeForm.reminders.filter((_, i) => i !== index);
                          setChangeForm({ ...changeForm, reminders: newReminders });
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
                    onClick={() => {
                      setChangeForm({ ...changeForm, reminders: [...changeForm.reminders, 15] });
                    }}
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
              <Button type="submit" disabled={updateEvent.isPending || updateTodoStatus.isPending}>
                Save Changes
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Time Moved Dialog */}
      <Dialog open={isTimeMoveDialogOpen} onOpenChange={setIsTimeMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Time</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleTimeMoveSubmit} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="time-move-start">New Start Date & Time</Label>
              <Input
                id="time-move-start"
                type="datetime-local"
                value={timeMoveForm.start_time}
                onChange={(e) => setTimeMoveForm({ start_time: e.target.value })}
                required
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
