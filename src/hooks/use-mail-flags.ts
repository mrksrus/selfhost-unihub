import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isOfflineMode } from '@/lib/offline';
import { invalidateMailFlagViews, mailQueryKeys, recordMailFlagEdit, type Email, type MailFlagKind, type MailFlagPatch } from '@/lib/mail-api';

const fields = {
  read: { value: 'is_read', pending: 'read_sync_pending' },
  star: { value: 'is_starred', pending: 'star_sync_pending' },
} as const;

// A slow HTTP acceptance is different from an accepted provider writeback.
// Guard only the former; a user may reverse an already-queued intent.
export function useMailFlags(setSelectedEmail: Dispatch<SetStateAction<Email | null>>, onError: (kind: MailFlagKind, message: string) => void) {
  const client = useQueryClient();
  const requests = useRef(new Set<string>());
  const [flagRequests, setFlagRequests] = useState(new Set<string>());
  const publish = useCallback((id: string, kind: MailFlagKind, patch: MailFlagPatch, pending: boolean) => {
    recordMailFlagEdit(client, id, kind, patch, pending);
    setSelectedEmail(current => current?.id === id ? { ...current, ...patch } : current);
  }, [client, setSelectedEmail]);

  const mutation = useMutation({
    mutationFn: async ({ email, kind, value }: { email: Email; kind: MailFlagKind; value: boolean }) => {
      const response = await api.put<{ sync_pending?: boolean }>(`/mail/emails/${encodeURIComponent(email.id)}/${kind}`, { [fields[kind].value]: value });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    retry: false,
    onMutate: async ({ email, kind, value }) => {
      // Cancel a pre-edit response; later polls are reconciled at fetch time.
      await client.cancelQueries({ queryKey: mailQueryKeys.all });
      publish(email.id, kind, { [fields[kind].value]: value }, true);
    },
    onSuccess: (data, { email, kind, value }) => {
      publish(email.id, kind, { [fields[kind].value]: value, [fields[kind].pending]: data?.sync_pending === true }, false);
    },
    onError: (error: Error, { email, kind }) => {
      // Restore only this flag, not a whole list/detail snapshot that would
      // erase concurrent changes to other flags or other messages.
      publish(email.id, kind, { [fields[kind].value]: email[fields[kind].value], [fields[kind].pending]: email[fields[kind].pending] }, false);
      onError(kind, error.message);
    },
    onSettled: (_data, _error, { email, kind }) => {
      requests.current.delete(`${kind}:${email.id}`);
      setFlagRequests(new Set(requests.current));
      void invalidateMailFlagViews(client);
      void client.invalidateQueries({ queryKey: mailQueryKeys.writebacks });
    },
  });
  const mutate = mutation.mutate;
  const requestFlag = useCallback((email: Email, kind: MailFlagKind, value: boolean) => {
    const key = `${kind}:${email.id}`;
    if (requests.current.has(key) || isOfflineMode() || !navigator.onLine) return;
    requests.current.add(key);
    setFlagRequests(new Set(requests.current));
    mutate({ email, kind, value });
  }, [mutate]);
  return { flagRequests, requestFlag };
}
