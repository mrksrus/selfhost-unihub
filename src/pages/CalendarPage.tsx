import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import { useToast } from '@/hooks/use-toast';
import { Plus, ChevronLeft, ChevronRight, Clock, MapPin, Trash2, Edit, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isSameMonth, addMonths, subMonths, isToday, parseISO } from 'date-fns';

interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  location: string | null;
  color: string;
}

const colorOptions = [
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#06b6d4', label: 'Cyan' },
];

const CalendarPage = () => {
  const { user } = useAuth();
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
  });

  // Fetch events for current month
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['calendar-events', format(currentMonth, 'yyyy-MM')],
    queryFn: async () => {
      const start = startOfMonth(currentMonth);
      const end = endOfMonth(currentMonth);
      
      const { data, error } = await supabase
        .from('calendar_events')
        .select('*')
        .gte('start_time', start.toISOString())
        .lte('start_time', end.toISOString())
        .order('start_time', { ascending: true });
      
      if (error) throw error;
      return data as CalendarEvent[];
    },
  });

  // Create event mutation
  const createEvent = useMutation({
    mutationFn: async (event: typeof formData) => {
      const { error } = await supabase.from('calendar_events').insert({
        ...event,
        user_id: user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-events'] });
      toast({ title: 'Event created successfully' });
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create event', description: error.message, variant: 'destructive' });
    },
  });

  // Update event mutation
  const updateEvent = useMutation({
    mutationFn: async ({ id, ...event }: Partial<CalendarEvent> & { id: string }) => {
      const { error } = await supabase.from('calendar_events').update(event).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-events'] });
      toast({ title: 'Event updated successfully' });
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update event', description: error.message, variant: 'destructive' });
    },
  });

  // Delete event mutation
  const deleteEvent = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('calendar_events').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-events'] });
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
    });
    setEditingEvent(null);
    setIsDialogOpen(false);
  };

  const handleNewEvent = (date?: Date) => {
    const targetDate = date || selectedDate || new Date();
    const dateStr = format(targetDate, "yyyy-MM-dd'T'HH:mm");
    setFormData({
      ...formData,
      start_time: dateStr,
      end_time: dateStr,
    });
    setIsDialogOpen(true);
  };

  const handleEdit = (event: CalendarEvent) => {
    setEditingEvent(event);
    setFormData({
      title: event.title,
      description: event.description || '',
      start_time: format(parseISO(event.start_time), "yyyy-MM-dd'T'HH:mm"),
      end_time: format(parseISO(event.end_time), "yyyy-MM-dd'T'HH:mm"),
      all_day: event.all_day,
      location: event.location || '',
      color: event.color,
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const eventData = {
      ...formData,
      start_time: new Date(formData.start_time).toISOString(),
      end_time: new Date(formData.end_time).toISOString(),
    };
    
    if (editingEvent) {
      updateEvent.mutate({ id: editingEvent.id, ...eventData });
    } else {
      createEvent.mutate(eventData);
    }
  };

  const daysInMonth = eachDayOfInterval({
    start: startOfMonth(currentMonth),
    end: endOfMonth(currentMonth),
  });

  const getEventsForDay = (date: Date) => {
    return events.filter((event) => isSameDay(parseISO(event.start_time), date));
  };

  const selectedDateEvents = selectedDate ? getEventsForDay(selectedDate) : [];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
          <p className="text-muted-foreground">Schedule and organize your events</p>
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
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
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
                    onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_time">End Time *</Label>
                  <Input
                    id="end_time"
                    type="datetime-local"
                    value={formData.end_time}
                    onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="location">Location</Label>
                <Input
                  id="location"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
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
                      onClick={() => setFormData({ ...formData, color: color.value })}
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
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                />
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
        {/* Calendar Grid */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">
                {format(currentMonth, 'MMMM yyyy')}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="icon"
                  onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setCurrentMonth(new Date())}
                >
                  Today
                </Button>
                <Button 
                  variant="outline" 
                  size="icon"
                  onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Day headers */}
            <div className="grid grid-cols-7 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div key={day} className="p-2 text-center text-sm font-medium text-muted-foreground">
                  {day}
                </div>
              ))}
            </div>
            
            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-1">
              {/* Empty cells for days before month starts */}
              {Array.from({ length: startOfMonth(currentMonth).getDay() }).map((_, i) => (
                <div key={`empty-${i}`} className="aspect-square p-1" />
              ))}
              
              {daysInMonth.map((day) => {
                const dayEvents = getEventsForDay(day);
                const isSelected = selectedDate && isSameDay(day, selectedDate);
                const today = isToday(day);
                
                return (
                  <button
                    key={day.toISOString()}
                    onClick={() => setSelectedDate(day)}
                    className={`aspect-square p-1 rounded-lg text-sm relative transition-colors ${
                      isSelected 
                        ? 'bg-primary text-primary-foreground' 
                        : today
                        ? 'bg-accent/10 text-accent font-semibold'
                        : 'hover:bg-muted'
                    }`}
                  >
                    <span className="block">{format(day, 'd')}</span>
                    {dayEvents.length > 0 && (
                      <div className="flex justify-center gap-0.5 mt-0.5">
                        {dayEvents.slice(0, 3).map((event) => (
                          <div
                            key={event.id}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: event.color }}
                          />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Selected Day Events */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {selectedDate ? format(selectedDate, 'EEEE, MMM d') : 'Select a date'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDate && (
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full mb-4"
                onClick={() => handleNewEvent(selectedDate)}
              >
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
                  {selectedDateEvents.map((event) => (
                    <motion.div
                      key={event.id}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="group relative p-3 rounded-lg border border-border hover:border-accent/30 transition-colors"
                    >
                      <div 
                        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg"
                        style={{ backgroundColor: event.color }}
                      />
                      <div className="pl-3">
                        <h4 className="font-medium text-foreground">{event.title}</h4>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                          <Clock className="h-3.5 w-3.5" />
                          <span>
                            {format(parseISO(event.start_time), 'h:mm a')} - {format(parseISO(event.end_time), 'h:mm a')}
                          </span>
                        </div>
                        {event.location && (
                          <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                            <MapPin className="h-3.5 w-3.5" />
                            <span>{event.location}</span>
                          </div>
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
                  ))}
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
