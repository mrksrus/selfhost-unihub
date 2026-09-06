import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { mailQueryKeys, fetchMailList, type MailAccount, type MailFolder, type MailUnreadCountsResponse, type MailListFilters } from '@/lib/mail-api';

export const useMailAccounts = () => useQuery({
  queryKey: mailQueryKeys.accounts,
  queryFn: async ({ signal }) => {
    const response = await api.get<{ accounts: MailAccount[] }>('/mail/accounts', { signal });
    if (response.error) throw new Error(response.error);
    return response.data?.accounts ?? [];
  },
});

export const useMailFolders = () => useQuery({
  queryKey: mailQueryKeys.folders,
  queryFn: async ({ signal }) => {
    const response = await api.get<{ folders: MailFolder[] }>('/mail/folders', { signal });
    if (response.error) throw new Error(response.error);
    return response.data?.folders ?? [];
  },
});

export const useMailUnreadCounts = (account: string | null) => useQuery({
  queryKey: mailQueryKeys.unread(account),
  queryFn: async ({ signal }) => {
    const params = new URLSearchParams({ include_by_account: 'true' });
    if (account !== 'all' && account) params.set('account_id', account);
    const response = await api.get<MailUnreadCountsResponse>(`/mail/unread-counts?${params}`, { signal });
    if (response.error) throw new Error(response.error);
    return response.data ?? { unreadByFolder: {} };
  },
  enabled: !!account,
});

export const useMailList = (filters: MailListFilters) => useQuery({
  queryKey: mailQueryKeys.list(filters),
  queryFn: ({ signal }) => fetchMailList(filters, signal),
  enabled: !!filters.account,
  staleTime: 60000,
  // Fetch the bounded list directly; row count alone misses deletes/read/star changes.
  refetchInterval: 60000,
  refetchIntervalInBackground: false,
});
