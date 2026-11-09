import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { BinDeleteResponse, BinEmptyRequest, BinItem, BinListResponse, BinModule, BinRestoreRequest, BinRestoreResponse, BinRetention } from '../../api/src/contracts/bin';

export type { BinItem, BinItemType, BinModule, BinReason, BinRetention, BinRestored, BinRestoreResponse, BinnedResponse } from '../../api/src/contracts/bin';

// The bin (P-31): deleted contacts, events, tasks, recordings and local
// calendars wait here for the person's retention; mail keeps its Trash
// folders. Items are gated by their module, so a module's view lists only
// its own kind, and Settings → Bin lists everything.

/** The retention choices, from the shortest; "forever" keeps items until restored or deleted. */
export const BIN_RETENTIONS: { value: BinRetention; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'forever', label: 'Until I delete them' },
];

/**
 * The default: 30 days, the same as the 0.26 merge undo.
 * Change it here and in the registry's default together.
 */
export const DEFAULT_BIN_RETENTION: BinRetention = '30';

/** What the retention means, in one sentence. */
export function retentionSentence(retention: BinRetention) {
  return retention === 'forever' ? 'Items stay here until you restore or delete them.' : `Items stay here ${retention} days, then are deleted for good.`;
}

export const BIN_MODULES: { id: BinModule; label: string }[] = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'calendar', label: 'Calendar and ToDo' },
  { id: 'recordings', label: 'Recordings' },
];

export const binQueryKeys = {
  all: ['bin'] as const,
  list: (module?: BinModule) => ['bin', module ?? 'all'] as const,
};

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The server did not answer with the ${what}.`);
  return value;
};

export const binApi = {
  /** One page, newest first; `before` is the next_cursor of the page before (whole groups only, so a group never spans pages). */
  list: async (module?: BinModule, before?: string | null, signal?: AbortSignal): Promise<BinListResponse> => {
    const params = new URLSearchParams();
    if (module) params.set('module', module);
    if (before) params.set('before', before);
    const query = params.toString();
    const answer = required(unwrap(await api.get<BinListResponse>(`/bin${query ? `?${query}` : ''}`, { signal })), 'bin');
    return { items: answer.items ?? [], retention: answer.retention ?? DEFAULT_BIN_RETENTION, next_cursor: answer.next_cursor ?? null };
  },
  /**
   * Restores items; a group (a merge, a calendar with its events) is restored
   * as a unit. `calendarId` sends events and tasks to that calendar or list
   * of the person's instead of their own: the answer to a failed entry with
   * BIN_RESTORE_NEEDS_CALENDAR or BIN_RESTORE_NEEDS_LIST.
   */
  restore: async (ids: string[], calendarId?: string) =>
    required(unwrap(await api.post<BinRestoreResponse>('/bin/restore', { ids, ...(calendarId ? { calendar_id: calendarId } : {}) } satisfies BinRestoreRequest)), 'restore result'),
  /** Deletes one item for good (policy bin.delete). */
  delete: async (id: string) => required(unwrap(await api.delete<BinDeleteResponse>(`/bin/${encodeURIComponent(id)}`)), 'result').deleted,
  /** Empties the whole bin or one module's part (policy bin.delete). */
  empty: async (module?: BinModule) => required(unwrap(await api.post<BinDeleteResponse>('/bin/empty', (module ? { module } : {}) satisfies BinEmptyRequest)), 'result').deleted,
  /** The person's retention: a user setting (`bin_retention`), saved like the others. */
  setRetention: async (retention: BinRetention) => { unwrap(await api.put('/settings/values', { values: { bin_retention: retention } })); },
};

/** A failed entry that asks the person where the item should go. */
export type BinDestinationKind = 'calendar' | 'list';
export const destinationAsked = (code?: string): BinDestinationKind | null =>
  code === 'BIN_RESTORE_NEEDS_CALENDAR' ? 'calendar' : code === 'BIN_RESTORE_NEEDS_LIST' ? 'list' : null;

/** What the server's refusal to restore means for the person; the server's own sentence when the code is not known here. */
export function restoreRefusal(code: string | undefined, fallback: string) {
  switch (code) {
    case 'BIN_RESTORE_CALENDAR_NOT_FOUND': return 'The chosen calendar is not one of yours. Choose another.';
    case 'CALENDAR_READ_ONLY': return 'That calendar is read-only or a subscription: nothing can be added to it. Choose another.';
    case 'CALENDAR_SYNC_BUSY': return 'The calendar is syncing right now. Try again shortly.';
    case 'RECORDING_FOLDER_UNSAFE': return 'The recordings folder on the server is not safe to write to. Ask your administrator.';
    case 'RECORDING_BUSY': return 'The recording is being changed right now. Try again shortly.';
    // An earlier restore is still being confirmed by the calendar server: it can go nowhere else until
    // then, and restoring it again without a destination finishes it there.
    case 'BIN_RESTORE_PENDING': return 'This item is still being put back on its server calendar. Try again in a moment, or restore it to the same calendar.';
    default: return fallback;
  }
}

/** The bin a page at a time: the first page, then older pages as the person asks for them (next_cursor → before). */
export const binQueryOptions = (module?: BinModule) => infiniteQueryOptions({
  queryKey: binQueryKeys.list(module),
  queryFn: ({ pageParam, signal }) => binApi.list(module, pageParam, signal),
  initialPageParam: null as string | null,
  getNextPageParam: page => page.next_cursor,
});

export function invalidateBinQueries(client: QueryClient) {
  return client.invalidateQueries({ queryKey: binQueryKeys.all });
}

/** A group's items together (a merge, a calendar with its events), single items on their own; newest first. */
export function groupBinItems(items: BinItem[]): BinItem[][] {
  const groups = new Map<string, BinItem[]>();
  for (const item of items) {
    const key = item.group_id ?? `item:${item.id}`;
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  // The calendar leads its group; the rest keep their order.
  return [...groups.values()].map(group => group.sort((a, b) => (a.item_type === 'calendar' ? -1 : 0) - (b.item_type === 'calendar' ? -1 : 0)))
    .sort((a, b) => Date.parse(b[0].deleted_at) - Date.parse(a[0].deleted_at));
}
