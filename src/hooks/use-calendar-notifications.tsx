import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface CalendarEvent {
  id: string;
  title: string;
  start_time: string;
  reminders: number[] | null;
}

export const useCalendarNotifications = () => {
  const notificationTimeoutsRef = useRef<Map<string, NodeJS.Timeout[]>>(new Map());

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(console.error);
    }
  }, []);

  // Fetch calendar events
  const { data: events = [] } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: async () => {
      const response = await api.get<{ events: CalendarEvent[] }>('/calendar/events');
      if (response.error) throw new Error(response.error);
      return response.data?.events || [];
    },
    refetchInterval: 60000, // Refetch every minute to check for new events
  });

  useEffect(() => {
    // Clear all existing timeouts
    notificationTimeoutsRef.current.forEach((timeouts) => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
    });
    notificationTimeoutsRef.current.clear();

    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const now = new Date().getTime();
    const scheduledNotifications = new Set<string>();

    events.forEach((event) => {
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
              new Notification(event.title, {
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
        notificationTimeoutsRef.current.set(event.id, timeouts);
      }
    });

    // Cleanup function
    return () => {
      notificationTimeoutsRef.current.forEach((timeouts) => {
        timeouts.forEach((timeout) => clearTimeout(timeout));
      });
      notificationTimeoutsRef.current.clear();
    };
  }, [events]);
};
