// The browser's side of shared, group and organisation calendars (F4): the
// routes of api/src/contracts/calendar-shares.ts with their shapes and the
// query keys their views share. Events of a reached calendar come with the
// person's own events (calendar-api.ts); `permission` on each calendar only
// says what to offer, the server decides. The query client is per session,
// so nothing here crosses accounts.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type {
  AdminCalendarsResponse, CalendarShare, CalendarShareCandidatesResponse, CalendarSharesResponse, CalendarView, CalendarViewRequest, CalendarViewResponse,
  DeleteSharedCalendarResponse, SetCalendarShareRequest, SharedCalendarInput, SharedCalendarResponse, SharedCalendarSummary, SharedCalendarUpdate,
} from '../../api/src/contracts/calendar-shares';
import type {
  AdminHandOverRequest, AdminHandOverResponse, ArchiveCalendarRequest, ArchiveCalendarResponse, HandOverRequest, HandOverResponse,
} from '../../api/src/contracts/calendar-ownership';

export type { SharedCalendarRef } from '../../api/src/contracts/calendar-ownership';
export type {
  CalendarAccessFields, CalendarOffer, CalendarOwnerKind, CalendarPermission, CalendarShare, CalendarView, PersonRef, SetCalendarShareRequest,
  SharedCalendarInput, SharedCalendarSummary, SharedCalendarUpdate, SubtaskAuthorFields,
} from '../../api/src/contracts/calendar-shares';

export const calendarSharesQueryKeys = {
  all: ['calendar-shares'] as const,
  shares: (id: string) => ['calendar-shares', id, 'shares'] as const,
  candidates: (id: string, query: string) => ['calendar-shares', id, 'candidates', query] as const,
  admin: ['calendar-shares', 'admin'] as const,
};

const required = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The server sent no ${what}.`);
  return value;
};
const calendarPath = (id: string, rest = '') => `/calendar/calendars/${encodeURIComponent(id)}${rest}`;
const sharedPath = (id: string) => `/calendar/shared-calendars/${encodeURIComponent(id)}`;

export const calendarSharesApi = {
  shares: async (id: string, signal?: AbortSignal) => required(unwrap(await api.get<CalendarSharesResponse>(calendarPath(id, '/shares'), { signal })), 'shares').shares,
  /** Gives, changes or (null) removes one share; answers the shares as they are now. */
  setShare: async (id: string, request: SetCalendarShareRequest): Promise<CalendarShare[]> =>
    required(unwrap(await api.put<CalendarSharesResponse>(calendarPath(id, '/shares'), request)), 'shares').shares,
  candidates: async (id: string, query: string, signal?: AbortSignal) =>
    required(unwrap(await api.get<CalendarShareCandidatesResponse>(calendarPath(id, `/share-candidates?q=${encodeURIComponent(query)}`), { signal })), 'candidates'),
  /** The person's own on/off, colour and change notifications for a calendar they reach (only notifications for their own). */
  setView: async (id: string, request: CalendarViewRequest): Promise<CalendarView> =>
    required(unwrap(await api.put<CalendarViewResponse>(calendarPath(id, '/view'), request)), 'view').view,

  // Group and organisation calendars.
  create: async (input: SharedCalendarInput): Promise<SharedCalendarSummary> => required(unwrap(await api.post<SharedCalendarResponse>('/calendar/shared-calendars', input)), 'calendar').calendar,
  update: async (id: string, input: SharedCalendarUpdate): Promise<SharedCalendarSummary> => required(unwrap(await api.put<SharedCalendarResponse>(sharedPath(id), input)), 'calendar').calendar,
  /** Hidden at once; an administrator can restore it. */
  remove: async (id: string) => { unwrap(await api.delete<DeleteSharedCalendarResponse>(sharedPath(id))); },

  // Server › Calendars.
  adminList: async (signal?: AbortSignal): Promise<SharedCalendarSummary[]> => required(unwrap(await api.get<AdminCalendarsResponse>('/admin/calendars', { signal })), 'calendars').calendars,
  adminRestore: async (id: string) => required(unwrap(await api.post<SharedCalendarResponse>(`/admin/calendars/${encodeURIComponent(id)}/restore`, {})), 'calendar').calendar,
  /** At once, with the administrator's password: to a person's id, to 'organisation', or to 'bin' (with its events into its owner's bin). */
  adminHandOver: async (id: string, to: string, currentPassword: string) => {
    unwrap(await api.post<AdminHandOverResponse>(`/admin/calendars/${encodeURIComponent(id)}/hand-over`, { to, current_password: currentPassword } satisfies AdminHandOverRequest));
  },
  /** Archived, a calendar is read-only for everyone, its owner too. */
  adminArchive: async (id: string, archived: boolean, currentPassword: string) => {
    unwrap(await api.put<ArchiveCalendarResponse>(`/admin/calendars/${encodeURIComponent(id)}/archive`, { archived, current_password: currentPassword } satisfies ArchiveCalendarRequest));
  },

  // A calendar's owner (contracts/calendar-ownership.ts).
  /** Offers a person's calendar to someone (the pending offer); a group manager's `now` hands it over at once (null). */
  handOver: async (id: string, request: HandOverRequest) => unwrap(await api.post<HandOverResponse>(calendarPath(id, '/hand-over'), request))?.offer ?? null,
  acceptOffer: async (id: string) => { unwrap(await api.post(calendarPath(id, '/hand-over/accept'), {})); },
  /** Whoever offered withdraws; the person it was offered to declines. */
  withdrawOffer: async (id: string) => { unwrap(await api.delete(calendarPath(id, '/hand-over'))); },
};

export const calendarSharesQueryOptions = (id: string) => queryOptions({
  queryKey: calendarSharesQueryKeys.shares(id),
  queryFn: ({ signal }) => calendarSharesApi.shares(id, signal),
});

/** After shares, memberships or shared calendars changed. */
export function invalidateCalendarShareQueries(client: QueryClient) {
  return client.invalidateQueries({ queryKey: calendarSharesQueryKeys.all });
}
