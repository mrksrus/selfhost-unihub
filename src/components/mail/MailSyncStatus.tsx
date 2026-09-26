import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { invalidateMailQueries, mailQueryKeys, type MailWriteback } from '@/lib/mail-api';
import { isOfflineMode } from '@/lib/offline';
import { Button } from '@/components/ui/button';

const actionLabels = { read: 'Read status change', star: 'Star change', move: 'Folder move' };

export function MailSyncStatus({ onSettled }: { onSettled?: (emailIds: string[]) => void }) {
  const client = useQueryClient();
  const previous = useRef<MailWriteback[]>([]);
  const status = useQuery({
    queryKey: mailQueryKeys.writebacks,
    queryFn: async ({ signal }) => {
      const response = await api.get<{ operations: MailWriteback[] }>('/mail/writebacks', { signal });
      if (response.error) throw new Error('Could not check server changes.');
      if (!Array.isArray(response.data?.operations)) throw new Error('Could not check server changes.');
      return response.data.operations;
    },
    enabled: !isOfflineMode(),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (!status.data) return;
    const current = status.data;
    const settled = previous.current.filter(operation => operation.status === 'pending'
      && !current.some(next => next.id === operation.id && next.status === 'pending'));
    const changedOutcomes = current.filter(operation => operation.status !== 'pending'
      && !previous.current.some(old => old.id === operation.id && old.status === operation.status && old.error === operation.error));
    previous.current = current;
    if (settled.length || changedOutcomes.length) {
      void invalidateMailQueries(client);
      onSettled?.([...new Set([...settled, ...changedOutcomes].map(operation => operation.email_id))]);
    }
  }, [status.data, client, onSettled]);
  const retry = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/mail/writebacks/${encodeURIComponent(id)}/retry`);
      if (response.error) throw new Error('Retry could not be queued. Check your connection and try again.');
    },
    retry: false,
    onSettled: () => { void invalidateMailQueries(client); },
  });
  const operations = status.data ?? [];
  const pendingCount = operations.filter(operation => operation.status === 'pending').length;
  const problems = operations.filter(operation => operation.status === 'failed' || operation.status === 'conflict');
  if (isOfflineMode() || (!status.isError && pendingCount === 0 && problems.length === 0)) return null;

  return <section aria-label="Server change status" className="shrink-0 border-b border-border bg-muted/30 p-3 text-xs">
    <div role="status" className="space-y-1">
      {pendingCount > 0 && <p>{pendingCount} {pendingCount === 1 ? 'change is' : 'changes are'} waiting for provider confirmation. Mail shows the requested state meanwhile.</p>}
      {status.isError && <p>Server change status is unavailable. Changes may still be waiting to sync.</p>}
      {retry.isError && <p className="text-destructive">{retry.error.message}</p>}
      {problems.length > 0 && <p>Recent changes that did not sync, across all accounts:</p>}
    </div>
    {problems.length > 0 && <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
      {problems.map(operation => <li key={operation.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>{actionLabels[operation.action]}: {operation.status === 'conflict'
          ? 'not synced. Check the message at your provider, then refresh UniHub.'
          : 'not synced. Retry to send this change to the server.'}</span>
        {operation.status === 'failed' && <Button size="sm" variant="outline" className="h-7 text-xs"
          disabled={retry.isPending || !navigator.onLine}
          aria-label={`Retry ${actionLabels[operation.action].toLowerCase()}`}
          onClick={() => retry.mutate(operation.id)}>
          {retry.isPending && retry.variables === operation.id ? 'Retrying…' : 'Retry'}
        </Button>}
      </li>)}
    </ul>}
  </section>;
}
