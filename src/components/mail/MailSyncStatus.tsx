import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { mailQueryKeys, type MailWriteback } from '@/lib/mail-api';
import { isOfflineMode } from '@/lib/offline';
import { Button } from '@/components/ui/button';

const actionLabels = { read: 'Read status change', star: 'Star change', move: 'Folder move' };
const lifecycle = (operation: MailWriteback) => operation.state ?? (
  operation.status === 'done' ? 'confirmed' : operation.status === 'pending' ? 'queued' : 'needs_attention');
const unsettled = (operation: MailWriteback) => !['confirmed', 'cancelled', 'superseded', 'rejected'].includes(lifecycle(operation));

export function MailSyncStatus({ onSettled }: { onSettled?: (emailIds: string[]) => void }) {
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
    refetchInterval: query => query.state.data?.some(unsettled) ? 3000 : 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (!status.data) return;
    const old = previous.current;
    const changed = status.data.filter(operation => !old.some(before => before.id === operation.id &&
      lifecycle(before) === lifecycle(operation) && before.error === operation.error));
    const vanished = old.filter(operation => unsettled(operation) && !status.data?.some(next => next.id === operation.id));
    previous.current = status.data;
    if (!initialized.current) {
      initialized.current = true;
      if (!changed.some(operation => lifecycle(operation) === 'confirmed')) return;
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
  const retry = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/mail/writebacks/${encodeURIComponent(id)}/retry`);
      if (response.error) throw new Error('Outcome check could not be requested. Check your connection and try again.');
    },
    retry: false,
    onSuccess: () => { void client.invalidateQueries({ queryKey: mailQueryKeys.writebacks }); },
  });
  const operations = status.data ?? [];
  const queued = operations.filter(operation => ['queued', 'executing', 'verifying', 'retry_wait'].includes(lifecycle(operation)));
  const checking = operations.filter(operation => lifecycle(operation) === 'reconciling');
  const problems = operations.filter(operation => ['needs_attention', 'rejected'].includes(lifecycle(operation)));
  if (isOfflineMode() || (!status.isError && !queued.length && !checking.length && !problems.length)) return null;

  return <section aria-label="Server change status" className="shrink-0 border-b border-border bg-muted/30 p-3 text-xs">
    <div role="status" className="space-y-1">
      {queued.length > 0 && <p>{queued.length} {queued.length === 1 ? 'change is' : 'changes are'} saved in UniHub, waiting for provider confirmation. Mail shows the requested state meanwhile.</p>}
      {checking.length > 0 && <p>{checking.length} {checking.length === 1 ? 'change is' : 'changes are'} being checked against the provider. The outcome is not yet confirmed.</p>}
      {status.isError && <p>Server change status is unavailable. Accepted changes may still be waiting.</p>}
      {retry.isError && <p className="text-destructive">{retry.error.message}</p>}
      {problems.length > 0 && <p>Changes needing your attention:</p>}
    </div>
    {(checking.length > 0 || problems.length > 0) && <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
      {[...checking, ...problems].map(operation => {
        const check = operation.action === 'move' || operation.retry_action === 'check_outcome';
        const canRetry = operation.can_retry ?? (operation.status === 'failed' && operation.action !== 'move');
        return <li key={operation.id} className="flex flex-wrap items-center justify-between gap-2">
          <span>{actionLabels[operation.action]}: {lifecycle(operation) === 'reconciling' ? 'checking what happened at the provider.' :
            lifecycle(operation) === 'rejected' ? 'request rejected; no provider confirmation.' :
            check ? 'outcome uncertain; do not send this move again.' : 'provider change needs review.'}</span>
          {canRetry && <Button size="sm" variant="outline" className="h-7 text-xs"
            disabled={retry.isPending || !navigator.onLine}
            aria-label={`${check ? 'Check outcome of' : 'Retry'} ${actionLabels[operation.action].toLowerCase()}`}
            onClick={() => retry.mutate(operation.id)}>
            {retry.isPending && retry.variables === operation.id ? 'Checking…' : check ? 'Check outcome' : 'Retry'}
          </Button>}
        </li>;
      })}
    </ul>}
  </section>;
}
