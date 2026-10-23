import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useServerEventsConnected } from '@/hooks/use-server-events';
import { LIVE_POLL_MS } from '@/lib/server-events';
import { captureMailFlagReconciler, mailQueryKeys, fetchMailList, fetchMailThreads, type MailAccount, type MailFolder, type MailUnreadCountsResponse, type MailListFilters } from '@/lib/mail-api';

export async function fetchMailAccounts({ signal }: { signal?: AbortSignal } = {}) {
  const response = await api.get<{ accounts: MailAccount[] }>('/mail/accounts', { signal });
  if (response.error) throw new Error(response.error);
  return response.data?.accounts ?? [];
}

export const useMailAccounts = () => useQuery({ queryKey: mailQueryKeys.accounts, queryFn: fetchMailAccounts });

export const useMailFolders = () => useQuery({
  queryKey: mailQueryKeys.folders,
  queryFn: async ({ signal }) => {
    const response = await api.get<{ folders: MailFolder[] }>('/mail/folders', { signal });
    if (response.error) throw new Error(response.error);
    return response.data?.folders ?? [];
  },
});
/** One account's folders (GET /api/mail/folders?account_id=), for the notification folder picker. */
export const useMailAccountFolders = (accountId: string) => useQuery({
  queryKey: [...mailQueryKeys.folders, 'account', accountId],
  queryFn: async ({ signal }) => {
    const response = await api.get<{ folders: MailFolder[] }>(`/mail/folders?account_id=${encodeURIComponent(accountId)}`, { signal });
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

export const useMailList = (filters: MailListFilters, enabled = true) => {
  const client = useQueryClient();
  const live = useServerEventsConnected();
  return useQuery({
    queryKey: mailQueryKeys.list(filters),
    queryFn: async ({ signal }) => {
      const reconcile = captureMailFlagReconciler(client);
      const result = await fetchMailList(filters, signal);
      return { ...result, emails: result.emails.map(reconcile) };
    },
    enabled: enabled && !!filters.account,
    staleTime: 60000,
    // Fetch the bounded list directly; row count alone misses deletes/read/star
    // changes. Live list-change events replace most of this while connected.
    refetchInterval: live ? LIVE_POLL_MS.mailList : 60000,
    refetchIntervalInBackground: false,
  });
};

/**
 * The conversation view of the same list (mail_threaded_view), one page at a
 * time by cursor. Keyed like the message list, so the same server events,
 * flag refreshes and account switches reach it; a page of another account or
 * folder answers into its own key, never this one.
 */
export const useMailThreads = (filters: MailListFilters, cursor: string | null, enabled = true) => {
  const client = useQueryClient();
  const live = useServerEventsConnected();
  return useQuery({
    queryKey: mailQueryKeys.threads(filters, cursor),
    queryFn: async ({ signal }) => {
      const reconcile = captureMailFlagReconciler(client);
      const result = await fetchMailThreads(filters, signal, cursor);
      return { ...result, threads: result.threads.map(thread => ({ ...thread, latest: reconcile(thread.latest) as typeof thread.latest })) };
    },
    enabled: enabled && !!filters.account,
    staleTime: 60000,
    refetchInterval: live ? LIVE_POLL_MS.mailList : 60000,
    refetchIntervalInBackground: false,
  });
};
