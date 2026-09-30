import { useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useMailList } from '@/hooks/use-mail-queries';

/**
 * Search, unread filter and page of the message list for one account/folder
 * view. The list query is keyed by all of them, so a response for another
 * account or folder never shows up here.
 */
export function useMailListView(account: string | null, folder: string) {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery.trim());
  const [page, setPage] = useState(1);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  // Reset page and unread filter when folder or account changes
  useEffect(() => {
    setPage(1);
    setShowUnreadOnly(false);
  }, [folder, account]);

  // Reset to page 1 when search query or unread filter changes
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, showUnreadOnly]);

  const { data, isLoading } = useMailList({
    account, folder, page,
    search: debouncedSearch, unreadOnly: showUnreadOnly,
  });

  const emails = useMemo(() => data?.emails ?? [], [data?.emails]);
  const pagination = data?.pagination;
  return {
    searchQuery, setSearchQuery, page, setPage, showUnreadOnly, setShowUnreadOnly,
    emails, isLoading, pagination,
    totalMatching: pagination?.total ?? emails.length,
    totalPages: pagination?.totalPages ?? 1,
  };
}

export type MailListView = ReturnType<typeof useMailListView>;
