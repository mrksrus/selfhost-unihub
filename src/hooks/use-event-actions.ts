import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import {
  calendarApi, invalidateCalendarQueries, writeRefusal,
  type CalendarEvent, type CalendarRsvpStatus, type RecurrenceScope, type TaskMoveCancelled,
} from '@/lib/calendar-api';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useSessionScope } from '@/lib/session-scope';
import { MOVE_DEADLINE_MS, cancelledMoveNotice, confirmedFields, queueTaskWrite, writeTaskFields } from '@/lib/task-order-queue';

export type EventInput = Partial<CalendarEvent> & { title: string };

/** Every change to a calendar event, with its feedback. */
export function useEventActions() {
  const client = useQueryClient();
  const scope = useSessionScope();
  const { toast } = useToast();
  const refresh = () => { void invalidateCalendarQueries(client); };
  // A write the server refused with a reason (still being moved, changed on
  // the server, not movable on its own) is a plain notice, not a failure; a
  // reason that needs the current lists reloads them first.
  const failed = (title: string) => (error: Error) => {
    const refusal = writeRefusal(error);
    if (refusal?.reload) refresh();
    toast(refusal ? { title: refusal.title, description: refusal.description } : { title, description: error.message, variant: 'destructive' });
  };

  const create = useMutation({
    mutationFn: (event: EventInput) => calendarApi.createEvent(event),
    onSuccess: () => { refresh(); toast({ title: 'Event created' }); },
    onError: failed('Could not create the event'),
  });

  const update = useMutation({
    mutationFn: ({ id, event, scope }: { id: string; event: Partial<CalendarEvent>; scope?: RecurrenceScope }) => calendarApi.updateEvent(id, event, scope),
    // A changed series is expanded again; its occurrences get new ids. A
    // changed calendar is a move: a server copy not yet confirmed ('creating')
    // finishes in the background and the event stays where it was meanwhile.
    onSuccess: ({ replaced, pending, sourceKept }) => {
      refresh();
      if (pending === 'creating') toast({ title: 'Moving…', description: 'The calendar server has not confirmed yet. UniHub finishes this in the background.' });
      else toast({ title: replaced ? 'Series updated' : 'Event updated',
        ...(sourceKept ? { description: 'Its old copy was changed in another app meanwhile, so it stays in the old calendar too.' } : {}) });
    },
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

  // Cancels a move whose new copy is not confirmed yet (the event stays in
  // its calendar), in the same queue as the task writes it would race.
  const cancelMove = useSessionMutation({
    mutationFn: ({ id }: { id: string; from?: string; to?: string }) => queueTaskWrite(client, scope, { kind: 'move', id }, signal => calendarApi.cancelMove(id, signal), MOVE_DEADLINE_MS),
    onSuccess: (result: TaskMoveCancelled, { id, from, to }) => {
      if (result.event) writeTaskFields(client, id, confirmedFields(result.event, ['calendar_id', 'move_pending', 'updated_at']));
      if (result.cancelled) toast({ title: 'Move cancelled', description: cancelledMoveNotice('event', from, to) });
      else { refresh(); toast({ title: 'Nothing to cancel', description: 'No move was waiting on the calendar server.' }); }
    },
    onError: failed('Could not cancel the move'),
  });

  return { create, update, remove, rsvp, cancelMove };
}

export type EventActions = ReturnType<typeof useEventActions>;
