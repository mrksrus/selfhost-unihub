import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import {
  calendarApi, invalidateCalendarQueries,
  type CalendarEvent, type CalendarRsvpStatus, type RecurrenceScope,
} from '@/lib/calendar-api';

export type EventInput = Partial<CalendarEvent> & { title: string };

/** Every change to a calendar event, with its feedback. */
export function useEventActions() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => { void invalidateCalendarQueries(client); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  const create = useMutation({
    mutationFn: (event: EventInput) => calendarApi.createEvent(event),
    onSuccess: () => { refresh(); toast({ title: 'Event created' }); },
    onError: failed('Could not create the event'),
  });

  const update = useMutation({
    mutationFn: ({ id, event, scope }: { id: string; event: Partial<CalendarEvent>; scope?: RecurrenceScope }) => calendarApi.updateEvent(id, event, scope),
    // A changed series is expanded again; its occurrences get new ids.
    onSuccess: ({ replaced }) => { refresh(); toast({ title: replaced ? 'Series updated' : 'Event updated' }); },
    onError: failed('Could not update the event'),
  });

  const remove = useMutation({
    mutationFn: ({ id, scope }: { id: string; scope?: RecurrenceScope }) => calendarApi.deleteEvent(id, scope),
    onSuccess: (_data, { scope }) => { refresh(); toast({ title: scope === 'series' ? 'Series deleted' : 'Event deleted' }); },
    onError: failed('Could not delete the event'),
  });

  const rsvp = useMutation({
    mutationFn: ({ id, status }: { id: string; status: CalendarRsvpStatus }) => calendarApi.updateRsvp(id, { response_status: status }),
    onSuccess: () => { refresh(); toast({ title: 'Reply saved' }); },
    onError: failed('Could not save the reply'),
  });

  return { create, update, remove, rsvp };
}

export type EventActions = ReturnType<typeof useEventActions>;
