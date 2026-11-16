// The company directory (api/src/contracts/directory.ts): every active
// person with the phone, job title and department they fill in. Reading it
// is the Contacts module's; a person's own entry is saved under Settings ›
// Profile, an administrator's correction under Server › People.
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { DirectoryEntry, DirectoryEntryInput, DirectoryEntryResponse, DirectoryResponse } from '../../api/src/contracts/directory';

export type { DirectoryEntry, DirectoryEntryInput } from '../../api/src/contracts/directory';

export const directoryQueryKeys = { all: ['directory'] as const };

const entryOf = (answer: DirectoryEntryResponse | undefined) => {
  if (!answer?.entry) throw new Error('The server sent no directory entry.');
  return answer.entry;
};

export const directoryApi = {
  list: async (signal?: AbortSignal): Promise<DirectoryEntry[]> => unwrap(await api.get<DirectoryResponse>('/directory', { signal }))?.entries ?? [],
  /** The signed-in person's own fields; null or '' clears one. */
  updateMine: async (input: DirectoryEntryInput) => entryOf(unwrap(await api.put<DirectoryEntryResponse>('/directory/me', input))),
  /** An administrator's correction (users.manage), recorded in the activity log. */
  correct: async (userId: string, input: DirectoryEntryInput) => entryOf(unwrap(await api.put<DirectoryEntryResponse>(`/admin/users/${encodeURIComponent(userId)}/directory`, input))),
};

export const directoryQueryOptions = queryOptions({
  queryKey: directoryQueryKeys.all,
  queryFn: ({ signal }) => directoryApi.list(signal),
  staleTime: 5 * 60 * 1000,
});
