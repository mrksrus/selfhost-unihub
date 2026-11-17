import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useModules } from '@/hooks/use-modules';
import { calendarBinQueryOptions } from '@/lib/bin-api';
import { calendarSharesApi, calendarSharesQueryKeys, calendarSharesQueryOptions } from '@/lib/calendar-shares-api';
import { can } from '@/lib/permissions';

// Shares, share candidates, a calendar's bin and Server › Calendars. The
// reached calendars and their events come with the calendar list and events
// (use-calendar-*), also offline; these are live only.

function useCalendarOn() {
  const { user, isOffline } = useAuth();
  const { isEnabled } = useModules();
  return { user, online: !!user && !isOffline && isEnabled('calendar') };
}

/** A calendar's shares, for those who manage it. */
export function useCalendarShares(calendarId: string | undefined, manages: boolean) {
  const { online } = useCalendarOn();
  return useQuery({ ...calendarSharesQueryOptions(calendarId ?? ''), enabled: online && !!calendarId && manages });
}

/** People and groups within the manager's reach, searched as they type. */
export function useCalendarShareCandidates(calendarId: string | undefined, query: string, enabled = true) {
  const { online } = useCalendarOn();
  const search = useDebouncedValue(query.trim());
  return useQuery({
    queryKey: calendarSharesQueryKeys.candidates(calendarId ?? '', search),
    queryFn: ({ signal }) => calendarSharesApi.candidates(calendarId!, search, signal),
    enabled: online && !!calendarId && enabled,
  });
}

/** A calendar's Deleted view, for those who may edit it. */
export function useCalendarBin(calendarId: string | undefined, edits: boolean) {
  const { online } = useCalendarOn();
  return useInfiniteQuery({ ...calendarBinQueryOptions(calendarId ?? ''), enabled: online && !!calendarId && edits });
}

/** Server › Calendars: organisation and group calendars and every shared person's calendar, by name and counts. */
export function useAdminCalendars() {
  const { user, online } = useCalendarOn();
  return useQuery({
    queryKey: calendarSharesQueryKeys.admin,
    queryFn: ({ signal }) => calendarSharesApi.adminList(signal),
    enabled: online && can(user, 'calendars.manage'),
  });
}
