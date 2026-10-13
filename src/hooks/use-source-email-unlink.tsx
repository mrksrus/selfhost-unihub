import { useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, invalidateCalendarQueries, type CalendarEvent } from '@/lib/calendar-api';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

/**
 * Removes the link between a task (or event) and the email it came from. The
 * kept summary goes with it, so the toast offers Undo, which links the email
 * again while it is still in UniHub.
 */
export function useSourceEmailUnlink() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => { void invalidateCalendarQueries(client); };
  const relink = useMutation({
    mutationFn: (task: Pick<CalendarEvent, 'id' | 'source_email'>) => calendarApi.updateEvent(task.id, { source_email_id: task.source_email?.email_id ?? null }),
    onSuccess: () => { refresh(); toast({ title: 'Email linked again' }); },
    onError: (error: Error) => toast({ title: 'Could not link the email again', description: error.message, variant: 'destructive' }),
  });
  return useMutation({
    mutationFn: (task: Pick<CalendarEvent, 'id' | 'source_email'>) => calendarApi.updateEvent(task.id, { source_email_id: null }),
    onSuccess: (_result, task) => {
      refresh();
      toast({ title: 'Link to the email removed', action: <ToastAction altText="Link the email again" onClick={() => relink.mutate(task)}>Undo</ToastAction> });
    },
    onError: (error: Error) => toast({ title: 'Could not remove the link', description: error.message, variant: 'destructive' }),
  });
}
