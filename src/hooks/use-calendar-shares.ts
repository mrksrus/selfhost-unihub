import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useModules } from '@/hooks/use-modules';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { calendarBinQueryOptions } from '@/lib/bin-api';
import { calendarQueryKeys, invalidateCalendarQueries, type CalendarCalendar } from '@/lib/calendar-api';
import { calendarSharesApi, calendarSharesQueryKeys, calendarSharesQueryOptions, type CalendarShare, type CalendarView } from '@/lib/calendar-shares-api';
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

/**
 * Which shares the person may raise. The server checks a raise against the
 * person's reach (their groups and the people in them; an administrator's is
 * everyone) and lets anyone who manages lower or remove a share, so a higher
 * level is offered only for a share its own search finds.
 */
export function useCalendarShareReach(calendarId: string | undefined, shares: readonly CalendarShare[], enabled: boolean) {
  const { user, online } = useCalendarOn();
  const anyone = can(user, 'calendars.manage');
  // shortcut: one candidates request per share, fine for the handful a calendar has; a flag on the shares answer when lists grow.
  const found = useQueries({
    queries: anyone ? [] : shares.filter(share => share.principal.kind !== 'everyone').map(share => {
      const search = share.email ?? share.name;
      return {
        queryKey: calendarSharesQueryKeys.candidates(calendarId ?? '', search),
        queryFn: ({ signal }: { signal: AbortSignal }) => calendarSharesApi.candidates(calendarId!, search, signal),
        enabled: online && !!calendarId && enabled,
      };
    }),
  });
  return (principal: CalendarShare['principal']) => anyone || (principal.kind !== 'everyone'
    && found.some(query => (principal.kind === 'group' ? query.data?.groups : query.data?.people)?.some(entry => entry.id === principal.id)));
}

/** The person's own on/off, colour and change notifications for a calendar; the calendar list shows the change at once. */
export function useSetCalendarView() {
  const client = useQueryClient();
  const { toast } = useToast();
  const write = (id: string, fields: Partial<CalendarCalendar>) => client.setQueryData<CalendarCalendar[]>(calendarQueryKeys.calendars,
    calendars => calendars?.map(calendar => calendar.id === id ? { ...calendar, ...fields } : calendar));
  return useSessionMutation({
    mutationFn: ({ id, ...view }: { id: string } & Partial<CalendarView>) => calendarSharesApi.setView(id, view),
    onMutate: ({ id, is_visible }) => { if (is_visible !== undefined) write(id, { is_visible }); },
    onSuccess: (view, { id }) => { write(id, { view, is_visible: view.is_visible, color: view.color }); void invalidateCalendarQueries(client); },
    onError: (error: Error) => { void invalidateCalendarQueries(client); toast({ title: 'Could not change the calendar', description: error.message, variant: 'destructive' }); },
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
