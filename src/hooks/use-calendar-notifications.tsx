import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { calendarApi, calendarQueryKeys } from '@/lib/calendar-api';
import { pushEnabledForUser, showNotification } from '@/utils/service-worker';

export const useCalendarNotifications = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: events = [] } = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: true, includeDone: false, visibleOnly: true }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true, includeDone: false, visibleOnly: true }),
    enabled: !!user,
    staleTime: 60000,
  });
  useEffect(() => {
    if (!user?.id) return;
    const refresh = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.userId === user.id && ['reminder', 'calendar', 'todo'].includes(data.kind)) void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
    };
    window.addEventListener('unihub-notification-data', refresh);
    return () => window.removeEventListener('unihub-notification-data', refresh);
  }, [queryClient, user?.id]);
  // Best-effort local fallback while an offline page remains alive. Closed-app reminders come from the server.
  useEffect(() => {
    if (!user?.id) return;
    const timers: number[] = [];
    const now = Date.now();
    for (const event of events) {
      if (['done', 'cancelled'].includes(event.todo_status)) continue;
      const start = new Date(event.start_time).getTime();
      if (!Number.isFinite(start)) continue;
      const source = event.reminders?.length ? event.reminders : event.reminder_minutes == null ? [] : [event.reminder_minutes];
      for (const minutes of new Set(source.map(Number).filter(value => Number.isSafeInteger(value) && value >= 0))) {
        const due = start - minutes * 60000;
        if (due < now - 5 * 60000 || due > now + 7 * 86400000) continue;
        timers.push(window.setTimeout(() => {
          if (navigator.onLine !== false || !pushEnabledForUser(user.id)) return;
          void showNotification(event.title, { body: minutes === 0 ? 'Event is starting now' : `Event starts in ${minutes} minutes`, data: {
            userId: user.id, dedupeKey: `reminder:${event.id}:${new Date(start).toISOString()}:${minutes}`, eventId: event.id, url: event.is_todo_only ? '/todo' : '/calendar',
          } });
        }, Math.max(0, due - now)));
      }
    }
    return () => timers.forEach(window.clearTimeout);
  }, [events, user?.id]);
};
