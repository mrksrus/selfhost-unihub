import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { CalendarEvent } from '@/lib/calendar-api';
import { DEFAULT_CALENDAR_SETTINGS, defaultsResolved, type UserSettingValues } from '@/lib/settings-api';
import { showNotification } from '@/utils/service-worker';
import { useCalendarNotifications } from '@/hooks/use-calendar-notifications';
import { userSettingsAnswer } from './settings-fixtures';

// The in-page reminder fallback (an offline page that is still open) must
// show no more than the server's reminders would: the person's reminder
// level and each calendar's switch apply to it too.
const state = vi.hoisted(() => ({ detail: 'full' as UserSettingValues['reminder_notification_detail'] }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ modules: [{ id: 'calendar', enabled: true, background: true }] }) }));
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), isOnline: () => false }));
vi.mock('@/utils/service-worker', () => ({ pushEnabledForUser: () => true, showNotification: vi.fn(async () => true) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

// Reminders due a minute ago, so the timers fire at once.
const start = new Date(Date.now() - 60000).toISOString();
const event = (id: string, calendar_id: string, title: string, todo = false): CalendarEvent => ({
  id, user_id: 'owner', calendar_id, title, description: null, start_time: start, end_time: start, all_day: false, location: null, color: '#2563eb',
  recurrence: null, reminder_minutes: 0, reminders: [0], todo_status: null, is_todo_only: todo, done_at: null, created_at: start, updated_at: start, subtasks: [], attendees: [],
});
const events = [event('e-1', 'cal-on', 'Dentist at 10'), event('e-2', 'cal-off', 'Private appointment'), event('e-3', 'cal-on', 'Buy milk', true)];

function Host() { useCalendarNotifications(); return null; }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
}

beforeEach(() => {
  state.detail = 'full';
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/calendar/events')) return { data: { events } };
    if (path === '/settings/values/calendars') return { data: { calendars: { 'cal-off': defaultsResolved({ ...DEFAULT_CALENDAR_SETTINGS, notify_enabled: false }) } } };
    if (path === '/settings/values') return userSettingsAnswer({ reminder_notification_detail: state.detail });
    return { data: {} };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('local calendar reminders', () => {
  it('skips a calendar whose notifications are off and otherwise shows the title', async () => {
    mount();
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(2));
    expect(showNotification).toHaveBeenCalledWith('Dentist at 10', expect.objectContaining({ body: 'Event is starting now', data: expect.objectContaining({ eventId: 'e-1', url: '/calendar' }) }));
    expect(showNotification).toHaveBeenCalledWith('Buy milk', expect.objectContaining({ data: expect.objectContaining({ eventId: 'e-3', url: '/todo' }) }));
    expect(vi.mocked(showNotification).mock.calls.some(([title]) => title === 'Private appointment')).toBe(false);
  });

  it('at level none shows only that a reminder is due, as the server does', async () => {
    state.detail = 'none';
    mount();
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(2));
    expect(showNotification).toHaveBeenCalledWith('Event reminder', expect.objectContaining({ body: '', data: expect.objectContaining({ eventId: 'e-1' }) }));
    expect(showNotification).toHaveBeenCalledWith('ToDo reminder', expect.objectContaining({ body: '', data: expect.objectContaining({ eventId: 'e-3' }) }));
    for (const [title, options] of vi.mocked(showNotification).mock.calls) {
      expect(`${title} ${options?.body ?? ''}`).not.toMatch(/Dentist|milk|Private/);
    }
  });
});
