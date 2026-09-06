import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { calendarApi, type CalendarEvent } from '@/lib/calendar-api';

// Fetch the selected event independently of the current calendar range/filter.
// The API and offline snapshot both resolve it under the current account.
export function useNotificationEventLink(onOpen: (event: CalendarEvent) => void) {
  const { user } = useAuth();
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const open = useRef(onOpen);
  useEffect(() => { open.current = onOpen; }, [onOpen]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('event');
    if (!id || !user?.id) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const event = await calendarApi.fetchEvent(id, controller.signal);
        if (controller.signal.aborted) return;
        if (event.user_id !== user.id) throw new Error('Event not found');
        open.current(event);
      } catch (error) {
        if (!controller.signal.aborted) toast({ title: 'Could not open event', description: error instanceof Error ? error.message : 'Event not found', variant: 'destructive' });
      } finally {
        if (!controller.signal.aborted) {
          params.delete('event');
          navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true });
        }
      }
    })();
    return () => controller.abort();
  }, [location.pathname, location.search, location.hash, navigate, toast, user?.id]);
}
