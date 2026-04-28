import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { calendarApi, calendarQueryKeys, type CalendarEvent } from '@/lib/calendar-api';
import {
  CALENDAR_PERIODIC_SYNC_TAG,
  NOTIFICATION_CHECK_INTERVAL_MS,
  initServiceWorker,
  registerPeriodicSync,
  requestNotificationPermission,
  showNotification,
} from '@/utils/service-worker';

const CALENDAR_REMINDER_STORAGE_PREFIX = 'unihub:calendar-reminders:';
const CALENDAR_EVENT_NOTIFICATION_STORAGE_PREFIX = 'unihub:calendar-event-notifications:';
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const MISSED_REMINDER_GRACE_MS = 5 * 60 * 1000;
const MAX_STORED_REMINDERS = 500;
const MAX_TRACKED_CALENDAR_EVENT_IDS = 500;
const REMINDER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NEW_EVENT_GRACE_MS = 5 * 60 * 1000;
const CALENDAR_PERIODIC_SYNC_MS = NOTIFICATION_CHECK_INTERVAL_MS;

type ReminderTimeout = ReturnType<typeof window.setTimeout>;
type ReminderStore = Record<string, number>;

interface CalendarEventNotificationState {
  knownIds: string[];
  lastCheckedAt: number;
}

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

function getCalendarEventNotificationStorageKey(userId: string) {
  return `${CALENDAR_EVENT_NOTIFICATION_STORAGE_PREFIX}${userId}`;
}

function loadCalendarEventNotificationState(storageKey: string): CalendarEventNotificationState | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CalendarEventNotificationState>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.knownIds)) {
      return null;
    }
    return {
      knownIds: parsed.knownIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS),
      lastCheckedAt: Number.isFinite(parsed.lastCheckedAt) ? Number(parsed.lastCheckedAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

function saveCalendarEventNotificationState(storageKey: string, state: CalendarEventNotificationState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({
      knownIds: state.knownIds.slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS),
      lastCheckedAt: state.lastCheckedAt,
    }));
  } catch {
    // Ignore storage failures; notifications can still work for the current session.
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

function getCalendarEventStartText(event: CalendarEvent) {
  const start = new Date(event.start_time);
  if (!Number.isFinite(start.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = event.all_day
    ? { dateStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  return `Starts ${start.toLocaleString(undefined, options)}`;
}

export const useCalendarNotifications = () => {
  const { user } = useAuth();
  const reminderStoreRef = useRef<ReminderStore>({});
  const eventNotificationStateRef = useRef<CalendarEventNotificationState | null>(null);
  const notificationTimeoutsRef = useRef<Map<string, ReminderTimeout[]>>(new Map());

  useEffect(() => {
    if (!user?.id) {
      reminderStoreRef.current = {};
      eventNotificationStateRef.current = null;
      return;
    }

    reminderStoreRef.current = loadReminderStore(getCalendarReminderStorageKey(user.id));
    eventNotificationStateRef.current = loadCalendarEventNotificationState(getCalendarEventNotificationStorageKey(user.id));

    const setupNotifications = async () => {
      await initServiceWorker();
      await requestNotificationPermission();
      await registerPeriodicSync(CALENDAR_PERIODIC_SYNC_TAG, CALENDAR_PERIODIC_SYNC_MS);
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
    if (!user?.id) return;

    const storageKey = getCalendarEventNotificationStorageKey(user.id);
    const relevantEvents = events.filter((event) => (
      !event.is_todo_only &&
      event.todo_status !== 'done' &&
      event.todo_status !== 'cancelled'
    ));
    const now = Date.now();

    if (!eventNotificationStateRef.current) {
      const initialState = {
        knownIds: relevantEvents.map((event) => event.id).slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS),
        lastCheckedAt: now,
      };
      eventNotificationStateRef.current = initialState;
      saveCalendarEventNotificationState(storageKey, initialState);
      return;
    }

    const currentState = eventNotificationStateRef.current;
    const knownIds = new Set(currentState.knownIds);
    const freshnessThreshold = Math.max(0, currentState.lastCheckedAt - NEW_EVENT_GRACE_MS);
    const newEvents = relevantEvents.filter((event) => {
      if (knownIds.has(event.id)) return false;
      const createdAtMs = Date.parse(event.created_at);
      return Number.isFinite(createdAtMs) && createdAtMs >= freshnessThreshold;
    });

    const nextState: CalendarEventNotificationState = {
      knownIds: Array.from(new Set([
        ...relevantEvents.map((event) => event.id),
        ...currentState.knownIds,
      ])).slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS),
      lastCheckedAt: now,
    };
    eventNotificationStateRef.current = nextState;
    saveCalendarEventNotificationState(storageKey, nextState);

    if (newEvents.length === 0) return;

    const isViewingCalendar = document.visibilityState === 'visible' && window.location.pathname.startsWith('/calendar');
    if (isViewingCalendar) return;

    const firstEvent = newEvents[0];
    const title = newEvents.length === 1 ? 'New Calendar Event' : 'New Calendar Events';
    const body = newEvents.length === 1
      ? [firstEvent.title, getCalendarEventStartText(firstEvent)].filter(Boolean).join(' - ')
      : `${newEvents.length} new calendar events added`;

    void showNotification(title, {
      body,
      tag: 'calendar-new-events',
      renotify: true,
      requireInteraction: false,
      data: {
        url: '/calendar',
        eventIds: newEvents.map((event) => event.id),
      },
    });
  }, [events, user?.id]);

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
