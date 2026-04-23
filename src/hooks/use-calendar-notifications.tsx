import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { calendarApi, calendarQueryKeys, type CalendarEvent } from '@/lib/calendar-api';
import { initServiceWorker, registerPeriodicSync, requestNotificationPermission, showNotification } from '@/utils/service-worker';

const CALENDAR_REMINDER_STORAGE_PREFIX = 'unihub:calendar-reminders:';
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const MISSED_REMINDER_GRACE_MS = 5 * 60 * 1000;
const MAX_STORED_REMINDERS = 500;
const REMINDER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CALENDAR_PERIODIC_SYNC_MS = 15 * 60 * 1000;

type ReminderTimeout = ReturnType<typeof window.setTimeout>;
type ReminderStore = Record<string, number>;

function getCalendarReminderStorageKey(userId: string) {
  return `${CALENDAR_REMINDER_STORAGE_PREFIX}${userId}`;
}

function normalizeReminderStore(store: ReminderStore, now = Date.now()): ReminderStore {
  return Object.fromEntries(
    Object.entries(store)
      .filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= now - REMINDER_RETENTION_MS)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_STORED_REMINDERS)
  );
}

function loadReminderStore(storageKey: string): ReminderStore {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return normalizeReminderStore(parsed as ReminderStore);
  } catch {
    return {};
  }
}

function saveReminderStore(storageKey: string, store: ReminderStore) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(normalizeReminderStore(store)));
  } catch {
    // Ignore storage failures; reminders can still work for the current session.
  }
}

function getReminderLeadText(reminderMinutes: number) {
  if (reminderMinutes <= 0) return 'Event is starting now';
  if (reminderMinutes % 1440 === 0) {
    const days = reminderMinutes / 1440;
    return `Event starts in ${days} day${days === 1 ? '' : 's'}`;
  }
  if (reminderMinutes % 60 === 0) {
    const hours = reminderMinutes / 60;
    return `Event starts in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `Event starts in ${reminderMinutes} minute${reminderMinutes === 1 ? '' : 's'}`;
}

function getReminderKey(event: CalendarEvent, reminderMinutes: number) {
  return `${event.id}:${event.start_time}:${reminderMinutes}`;
}

function getReminderMinutes(event: CalendarEvent) {
  const source = Array.isArray(event.reminders) && event.reminders.length > 0
    ? event.reminders
    : (typeof event.reminder_minutes === 'number' ? [event.reminder_minutes] : []);

  return Array.from(
    new Set(
      source
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
    )
  ).sort((a, b) => b - a);
}

function getCalendarNotificationPath(event: CalendarEvent) {
  return event.is_todo_only ? '/todo' : '/calendar';
}

export const useCalendarNotifications = () => {
  const { user } = useAuth();
  const reminderStoreRef = useRef<ReminderStore>({});
  const notificationTimeoutsRef = useRef<Map<string, ReminderTimeout[]>>(new Map());

  useEffect(() => {
    if (!user?.id) return;

    reminderStoreRef.current = loadReminderStore(getCalendarReminderStorageKey(user.id));

    const setupNotifications = async () => {
      await initServiceWorker();
      await requestNotificationPermission();
      await registerPeriodicSync('check-calendar-periodic', CALENDAR_PERIODIC_SYNC_MS);
    };

    void setupNotifications();
  }, [user?.id]);

  const { data: events = [], refetch } = useQuery({
    queryKey: [...calendarQueryKeys.list({ includeTodos: true, includeDone: false, visibleOnly: true }), user?.id],
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true, includeDone: false, visibleOnly: true }),
    enabled: !!user,
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
    staleTime: 30000,
  });

  useEffect(() => {
    if (!user?.id) return;

    const refreshNotifications = () => {
      void refetch();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshNotifications();
      }
    };

    window.addEventListener('sw-check-calendar', refreshNotifications);
    window.addEventListener('focus', refreshNotifications);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('sw-check-calendar', refreshNotifications);
      window.removeEventListener('focus', refreshNotifications);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refetch, user?.id]);

  useEffect(() => {
    const timeoutRegistry = notificationTimeoutsRef.current;
    timeoutRegistry.forEach((timeouts) => {
      timeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    });
    timeoutRegistry.clear();

    if (!user?.id) {
      return;
    }

    const storageKey = getCalendarReminderStorageKey(user.id);
    const now = Date.now();
    const reminderStore = normalizeReminderStore(reminderStoreRef.current, now);
    reminderStoreRef.current = reminderStore;
    saveReminderStore(storageKey, reminderStore);

    const scheduleReminderNotification = (event: CalendarEvent, reminderMinutes: number, reminderKey: string) => {
      const notificationPath = getCalendarNotificationPath(event);
      const reminderLabel = getReminderLeadText(reminderMinutes);
      const markDelivered = () => {
        reminderStoreRef.current = {
          ...reminderStoreRef.current,
          [reminderKey]: Date.now(),
        };
        saveReminderStore(storageKey, reminderStoreRef.current);
      };

      const notify = async () => {
        const shown = await showNotification(event.title, {
          body: reminderLabel,
          tag: `calendar-${event.id}`,
          renotify: true,
          requireInteraction: false,
          data: {
            url: notificationPath,
            eventId: event.id,
            reminderMinutes,
          },
        });

        if (shown) {
          markDelivered();
        }
      };

      return notify;
    };

    for (const event of events) {
      if (event.todo_status === 'done' || event.todo_status === 'cancelled') continue;

      const eventStartMs = Date.parse(event.start_time);
      if (!Number.isFinite(eventStartMs)) continue;

      const reminderMinutesList = getReminderMinutes(event);
      if (reminderMinutesList.length === 0) continue;

      const timeouts: ReminderTimeout[] = [];

      for (const reminderMinutes of reminderMinutesList) {
        const reminderKey = getReminderKey(event, reminderMinutes);
        if (reminderStoreRef.current[reminderKey]) continue;

        const reminderTimeMs = eventStartMs - reminderMinutes * 60 * 1000;
        const delayMs = reminderTimeMs - now;
        const notify = scheduleReminderNotification(event, reminderMinutes, reminderKey);

        if (delayMs <= 0) {
          if (now - reminderTimeMs <= MISSED_REMINDER_GRACE_MS) {
            void notify();
          }
          continue;
        }

        if (delayMs > MAX_SCHEDULE_AHEAD_MS) continue;

        const timeoutId = window.setTimeout(() => {
          void notify();
        }, delayMs);
        timeouts.push(timeoutId);
      }

      if (timeouts.length > 0) {
        timeoutRegistry.set(event.id, timeouts);
      }
    }

    return () => {
      timeoutRegistry.forEach((timeouts) => {
        timeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
      });
      timeoutRegistry.clear();
    };
  }, [events, user?.id]);
};
