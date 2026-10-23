import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useMailList, useMailThreads } from '@/hooks/use-mail-queries';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import type { MailThreadSummary } from '@/lib/mail-api';

/**
 * Search, unread filter and page of the message list for one account/folder
 * view. The list query is keyed by all of them, so a response for another
 * account or folder never shows up here.
 *
 * With the threaded view on (Settings, Mail) the same view lists
 * conversations, paged by the cursor each page returns; `emails` then holds
 * each conversation's latest message, so selection, flags and the reader work
 * on rows as before.
 */
export function useMailListView(account: string | null, folder: string) {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery.trim());
  const [page, setPage] = useState(1);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const threaded = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('mail_threaded_view') }).data ?? false;
  // The cursors that led to the current conversation page, so Previous can go back.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1];

  // Reset page and unread filter when folder or account changes
  useEffect(() => {
    setPage(1);
    setCursors([null]);
    setShowUnreadOnly(false);
  }, [folder, account]);

  // Reset to page 1 when search query or unread filter changes
  useEffect(() => {
    setPage(1);
    setCursors([null]);
  }, [debouncedSearch, showUnreadOnly]);

  const filters = { account, folder, page: threaded ? cursors.length : page, search: debouncedSearch, unreadOnly: showUnreadOnly };
  const messages = useMailList(filters, !threaded);
  const conversations = useMailThreads(filters, cursor, threaded);
  const { data, isLoading } = threaded ? conversations : messages;

  const threads = useMemo<MailThreadSummary[] | undefined>(() => threaded ? conversations.data?.threads ?? [] : undefined, [threaded, conversations.data?.threads]);
  const emails = useMemo(() => threaded ? (threads ?? []).map(thread => thread.latest) : messages.data?.emails ?? [], [threaded, threads, messages.data?.emails]);
  const pagination = data?.pagination;
  const nextCursor = conversations.data?.pagination.next_cursor ?? null;
  return {
    searchQuery, setSearchQuery, page: threaded ? cursors.length : page, setPage, showUnreadOnly, setShowUnreadOnly,
    emails, threads, isLoading, pagination,
    totalMatching: pagination?.total ?? emails.length,
    totalPages: pagination?.totalPages ?? 1,
    /** Conversation pages: the next page exists, and the way back. */
    hasNextPage: threaded && !!nextCursor && (conversations.data?.pagination.hasMore ?? false),
    nextPage: () => { if (nextCursor) setCursors(current => [...current, nextCursor]); },
    previousPage: () => setCursors(current => current.length > 1 ? current.slice(0, -1) : current),
  };
}

export type MailListView = ReturnType<typeof useMailListView>;
