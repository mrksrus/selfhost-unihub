import { isOfflineMode } from '@/lib/offline';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Email } from '@/lib/mail-api';

interface ReaderActions {
  onDraft: (draft: Email) => void;
  onMarkRead: (id: string) => void;
  onError: (message: string) => void;
}

export function useMailReader() {
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

  const closeReader = useCallback(() => {
    cancel();
    setSelectedEmail(null);
    setIsReaderLoading(false);
  }, [cancel]);

  const loadEmail = useCallback(async (id: string, actions: ReaderActions) => {
    cancel();
    const current = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setIsReaderLoading(true);
    try {
      const response = await api.get<{ email: Email }>(`/mail/emails/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (current !== generation.current || controller.signal.aborted) return;
      if (response.error) throw new Error(response.error);
      const email = response.data?.email;
      if (!email || email.id !== id) throw new Error('The server did not return the selected email.');
      if (email.is_draft || email.folder === 'drafts') {
        setSelectedEmail(null);
        actions.onDraft(email);
      } else {
        const canMarkRead = !isOfflineMode() && navigator.onLine;
        if (!email.is_read && canMarkRead) actions.onMarkRead(email.id);
        setSelectedEmail({ ...email, is_read: canMarkRead ? true : email.is_read });
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
