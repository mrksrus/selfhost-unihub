import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { mailQueryKeys, type MailWriteback } from '@/lib/mail-api';
import { isOfflineMode } from '@/lib/offline';

export const writebackLifecycle = (operation: MailWriteback) => operation.state ?? (
  operation.status === 'done' ? 'confirmed' : operation.status === 'pending' ? 'queued' : 'needs_attention');
export const isUnsettledWriteback = (operation: MailWriteback) =>
  !['confirmed', 'cancelled', 'superseded', 'rejected'].includes(writebackLifecycle(operation));

/** Groups provider writebacks the way the sync control presents them. */
export function groupWritebacks(operations: MailWriteback[]) {
  const waiting = operations.filter(operation =>
    ['queued', 'executing', 'verifying', 'retry_wait', 'reconciling'].includes(writebackLifecycle(operation)));
  const attention = operations.filter(operation => writebackLifecycle(operation) === 'needs_attention');
  const rejected = operations.filter(operation => writebackLifecycle(operation) === 'rejected');
  return { waiting, attention, rejected };
}

// Mount once per mail view: the effect refreshes the affected lists when a
// writeback settles, and a second observer would repeat that work.
export function useMailWritebacks(onSettled?: (emailIds: string[]) => void) {
  const client = useQueryClient();
  const previous = useRef<MailWriteback[]>([]);
  const initialized = useRef(false);
  const status = useQuery({
    queryKey: mailQueryKeys.writebacks,
    queryFn: async ({ signal }) => {
      const response = await api.get<{ operations: MailWriteback[] }>('/mail/writebacks', { signal });
      if (response.error || !Array.isArray(response.data?.operations)) throw new Error('Could not check server changes.');
      return response.data.operations;
    },
    enabled: !isOfflineMode(),
    refetchInterval: query => query.state.data?.some(isUnsettledWriteback) ? 3000 : 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (!status.data) return;
    const old = previous.current;
    const changed = status.data.filter(operation => !old.some(before => before.id === operation.id &&
      writebackLifecycle(before) === writebackLifecycle(operation) && before.error === operation.error));
    const vanished = old.filter(operation => isUnsettledWriteback(operation) && !status.data?.some(next => next.id === operation.id));
    previous.current = status.data;
    if (!initialized.current) {
      initialized.current = true;
      if (!changed.some(operation => writebackLifecycle(operation) === 'confirmed')) return;
    }
    const affected = [...changed, ...vanished];
    if (affected.length) {
      // Only active mail lists that show these messages (plus virtual Starred)
      // need another fetch; never invalidate accounts/folders on flag ack.
      const ids = new Set(affected.map(operation => operation.email_id));
      void client.invalidateQueries({ predicate: query => query.isActive() && query.queryKey[0] === 'emails' && (
        query.queryKey[2] === 'starred' || (query.state.data as { emails?: { id: string }[] } | undefined)?.emails?.some(email => ids.has(email.id)) === true
      ) });
      if (affected.some(operation => operation.action === 'read')) void client.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      if (affected.some(operation => operation.action === 'move')) void client.invalidateQueries({ queryKey: mailQueryKeys.folders });
      onSettled?.([...ids]);
    }
  }, [status.data, client, onSettled]);
  return status;
}
