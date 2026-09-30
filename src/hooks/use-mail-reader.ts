import { isOfflineMode } from '@/lib/offline';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { captureMailFlagReconciler, type Email } from '@/lib/mail-api';

interface ReaderActions {
  onDraft: (draft: Email) => void;
  onMarkRead: (email: Email) => void;
  reconcileEmail?: (email: Email) => Email;
  onError: (message: string) => void;
}

/**
 * The message open in the reader. Only the latest request may fill it: each
 * load, close, or change of `scope` (the selected account view) invalidates
 * requests started earlier, so a late response for an earlier selection or
 * account is dropped. The first scope (restoring the account on page load)
 * does not cancel a message opened from a link.
 */
export function useMailReader(scope: string | null = null) {
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [isReaderLoading, setIsReaderLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const cancel = useCallback(() => {
    ++generation.current;
    pending.current?.abort();
    pending.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const previousScope = useRef(scope);
  useEffect(() => {
    const before = previousScope.current;
    previousScope.current = scope;
    // A message already open stays open; only a load still in flight for the
    // previous account view is abandoned.
    if (before !== null && before !== scope && pending.current) {
      cancel();
      setIsReaderLoading(false);
    }
  }, [scope, cancel]);

  const closeReader = useCallback(() => {
    cancel();
    setSelectedEmail(null);
    setIsReaderLoading(false);
  }, [cancel]);

  const loadEmail = useCallback(async (id: string, actions: ReaderActions) => {
    cancel();
    // Never display the previous message while a different selection loads.
    setSelectedEmail(null);
    const current = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setIsReaderLoading(true);
    try {
      const response = await api.get<{ email: Email }>(`/mail/emails/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (current !== generation.current || controller.signal.aborted) return;
      if (response.error) throw new Error(response.error);
      let email = response.data?.email;
      if (!email || email.id !== id) throw new Error('The server did not return the selected email.');
      email = actions.reconcileEmail?.(email) ?? email;
      if (email.is_draft || email.folder === 'drafts') {
        setSelectedEmail(null);
        actions.onDraft(email);
      } else {
        const canMarkRead = !isOfflineMode() && navigator.onLine;
        setSelectedEmail(email);
        // Pending unread intent must not be undone by simply opening it.
        if (!email.is_read && !email.read_sync_pending && canMarkRead) actions.onMarkRead(email);
      }
    } catch (error) {
      if (current !== generation.current || controller.signal.aborted) return;
      actions.onError(error instanceof Error ? error.message : 'Could not load email');
    } finally {
      if (current === generation.current) {
        pending.current = null;
        setIsReaderLoading(false);
      }
    }
  }, [cancel]);

  return { selectedEmail, setSelectedEmail, isReaderLoading, closeReader, loadEmail };
}

/**
 * Refreshes the read/star/folder state of the open message after one of its
 * provider writebacks settles. A refresh answers only for the message that
 * was open when it started and loses to any later load or refresh.
 */
export function useMailReaderRefresh(selectedEmailId: string | undefined, setSelectedEmail: Dispatch<SetStateAction<Email | null>>) {
  const queryClient = useQueryClient();
  const revision = useRef(0);
  useEffect(() => { ++revision.current; }, [selectedEmailId]);

  const refreshSettledEmail = useCallback((emailIds: string[]) => {
    if (!selectedEmailId || !emailIds.includes(selectedEmailId)) return;
    const id = selectedEmailId;
    const started = ++revision.current;
    const reconcile = captureMailFlagReconciler(queryClient);
    void api.get<{ email: Email }>(`/mail/emails/${encodeURIComponent(id)}`).then(response => {
      const email = response.data?.email && reconcile(response.data.email);
      if (started === revision.current && !response.error && email?.id === id) {
        setSelectedEmail(current => current?.id === id ? {
          ...current, is_read: email.is_read, is_starred: email.is_starred,
          read_sync_pending: email.read_sync_pending, star_sync_pending: email.star_sync_pending,
          folder: email.folder, remote_missing: email.remote_missing,
        } : current);
      }
    }).catch(() => { /* A failed status refresh must not replace the current message. */ });
  }, [selectedEmailId, setSelectedEmail, queryClient]);

  /** Call when a new message load starts, so an older refresh cannot apply. */
  const supersedeRefresh = useCallback(() => { ++revision.current; }, []);
  return { refreshSettledEmail, supersedeRefresh };
}
