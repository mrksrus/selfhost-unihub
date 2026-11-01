import { queryOptions, type QueryClient } from '@tanstack/react-query';
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
 * The default until D33 is decided and the registry carries `bin_retention`:
 * 30 days, the same as the 0.26 merge undo. Change it here and in the
 * registry's default together.
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
  list: async (module?: BinModule, signal?: AbortSignal): Promise<BinListResponse> => {
    const answer = required(unwrap(await api.get<BinListResponse>(`/bin${module ? `?module=${module}` : ''}`, { signal })), 'bin');
    return { items: answer.items ?? [], retention: answer.retention ?? DEFAULT_BIN_RETENTION };
  },
  /** Restores items; a group (a merge, a calendar with its events) is restored as a unit. */
  restore: async (ids: string[]) => required(unwrap(await api.post<BinRestoreResponse>('/bin/restore', { ids } satisfies BinRestoreRequest)), 'restore result'),
  /** Deletes one item for good (policy bin.delete). */
  delete: async (id: string) => required(unwrap(await api.delete<BinDeleteResponse>(`/bin/${encodeURIComponent(id)}`)), 'result').deleted,
  /** Empties the whole bin or one module's part (policy bin.delete). */
  empty: async (module?: BinModule) => required(unwrap(await api.post<BinDeleteResponse>('/bin/empty', (module ? { module } : {}) satisfies BinEmptyRequest)), 'result').deleted,
  /** The person's retention: a user setting (`bin_retention`), saved like the others. */
  setRetention: async (retention: BinRetention) => { unwrap(await api.put('/settings/values', { values: { bin_retention: retention } })); },
};

export const binQueryOptions = (module?: BinModule) => queryOptions({
  queryKey: binQueryKeys.list(module),
  queryFn: ({ signal }) => binApi.list(module, signal),
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
