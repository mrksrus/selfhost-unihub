import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { calendarApi, calendarQueryKeys, type CalendarEvent } from '@/lib/calendar-api';
import { showNotification, registerPeriodicSync, initServiceWorker } from '@/utils/service-worker';

export const useCalendarNotifications = () => {
  const notificationTimeoutsRef = useRef<Map<string, NodeJS.Timeout[]>>(new Map());

  // Initialize service worker and request notification permission
  useEffect(() => {
    const setupNotifications = async () => {
      await initServiceWorker();
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      
      // Register periodic background sync for calendar checks (if supported)
      await registerPeriodicSync('check-calendar-periodic', 15);
    };
    
    setupNotifications();
  }, []);

  // Fetch calendar events
  const { data: events = [] } = useQuery({
    queryKey: calendarQueryKeys.list({ includeTodos: true }),
    queryFn: () => calendarApi.fetchEvents({ includeTodos: true }),
    refetchInterval: 60000, // Refetch every minute to check for new events
  });

  useEffect(() => {
    const timeoutRegistry = notificationTimeoutsRef.current;

    // Clear all existing timeouts
    timeoutRegistry.forEach((timeouts) => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
    });
    timeoutRegistry.clear();

    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const now = new Date().getTime();
    const scheduledNotifications = new Set<string>();

    events.forEach((event) => {
      if (event.todo_status === 'done' || event.todo_status === 'cancelled') return;
      if (!event.reminders || event.reminders.length === 0) return;

      const eventStart = new Date(event.start_time).getTime();
      if (eventStart < now) return; // Event already passed

      const timeouts: NodeJS.Timeout[] = [];

      event.reminders.forEach((reminderMinutes) => {
        const reminderTime = eventStart - reminderMinutes * 60 * 1000;
        const delay = reminderTime - now;

        if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
          // Only schedule if within 7 days
          const notificationId = `${event.id}-${reminderMinutes}`;
          if (!scheduledNotifications.has(notificationId)) {
            scheduledNotifications.add(notificationId);
            const timeout = setTimeout(() => {
              showNotification(event.title, {
                body: reminderMinutes === 0 
                  ? 'Event is starting now'
                  : `Event starts in ${reminderMinutes} minute${reminderMinutes !== 1 ? 's' : ''}`,
                icon: '/favicon.ico',
                tag: `calendar-${event.id}`,
                requireInteraction: false,
              });
            }, delay);
            timeouts.push(timeout);
          }
        }
      });

      if (timeouts.length > 0) {
        timeoutRegistry.set(event.id, timeouts);
      }
    });

    // Cleanup function
    return () => {
      timeoutRegistry.forEach((timeouts) => {
        timeouts.forEach((timeout) => clearTimeout(timeout));
      });
      timeoutRegistry.clear();
    };
  }, [events]);
};
