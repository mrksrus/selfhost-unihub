import { isOnline } from '@/lib/platform';
import { onAppEvent } from '@/lib/app-events';
import { useModules } from '@/hooks/use-modules';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { calendarApi, calendarQueryKeys } from '@/lib/calendar-api';
import { calendarSettingsQueryOptions, selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { pushEnabledForUser, showNotification } from '@/utils/service-worker';

export const useCalendarNotifications = () => {
  const { user } = useAuth();
  const { modules } = useModules();
  const active = modules.some(module => module.id === 'calendar' && module.enabled && module.background);
  const queryClient = useQueryClient();
  const { data: events = [] } = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: true, includeDone: false, visibleOnly: true }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true, includeDone: false, visibleOnly: true }),
    enabled: !!user && active,
    staleTime: 60000,
  });
  // The same choices the server applies to its reminders (notifications.ts,
  // calendarLevel): each calendar on or off, and how much a reminder shows.
  // Nothing is scheduled until both are known: a reminder already due would
  // otherwise show the event before the person's level arrived.
  const { data: detail } = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('reminder_notification_detail'), enabled: !!user && active });
  const { data: calendarSettings } = useQuery({ ...calendarSettingsQueryOptions, enabled: !!user && active });
  useEffect(() => {
    if (!user?.id || !active) return;
    const refresh = (detail: unknown) => {
      const data = detail as { userId?: string; kind?: string } | null;
      if (data?.userId === user.id && ['reminder', 'calendar', 'todo'].includes(data.kind ?? ''))
 void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
    };
    return onAppEvent('unihub:notification-data', refresh);
  }, [queryClient, user?.id, active]);
  // Best-effort local fallback while an offline page remains alive. Closed-app reminders come from the server.
  useEffect(() => {
    if (!user?.id || !active || !detail || !calendarSettings) return;
    const timers: number[] = [];
    const now = Date.now();
    for (const event of events) {
      if (event.todo_status === 'done' || event.todo_status === 'cancelled') continue;
      if (event.calendar_id && calendarSettings[event.calendar_id]?.notify_enabled.value === false) continue;
      const start = new Date(event.start_time).getTime();
      if (!Number.isFinite(start)) continue;
      const source = event.reminders?.length ? event.reminders : event.reminder_minutes == null ? [] : [event.reminder_minutes];
      for (const minutes of new Set(source.map(Number).filter(value => Number.isSafeInteger(value) && value >= 0))) {
        const due = start - minutes * 60000;
        if (due < now - 5 * 60000 || due > now + 7 * 86400000) continue;
        timers.push(window.setTimeout(() => {
          if (isOnline()
 || !pushEnabledForUser(user.id)) return;
          const { title, body } = detail === 'none'
            ? { title: event.is_todo_only ? 'ToDo reminder' : 'Event reminder', body: '' }
            : { title: event.title, body: minutes === 0 ? 'Event is starting now' : `Event starts in ${minutes} minutes` };
          void showNotification(title, { body, data: {
            userId: user.id, dedupeKey: `reminder:${event.id}:${new Date(start).toISOString()}:${minutes}`, eventId: event.id, url: event.is_todo_only ? '/todo' : '/calendar',
          } });
        }, Math.max(0, due - now)));
      }
    }
    return () => timers.forEach(window.clearTimeout);
  }, [events, user?.id, active, detail, calendarSettings]);
};
