import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { mailQueryKeys, type MailWriteback } from '@/lib/mail-api';
import { groupWritebacks, writebackLifecycle } from '@/hooks/use-mail-writebacks';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

const actionLabels = { read: 'Read status change', star: 'Star change', move: 'Folder move' };
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function describe(operation: MailWriteback, check: boolean) {
  switch (writebackLifecycle(operation)) {
    case 'reconciling': return 'checking what happened at the provider.';
    case 'rejected': return 'request rejected; no provider confirmation.';
    case 'needs_attention': return check ? 'outcome uncertain; do not send this move again.' : 'provider change needs review.';
    case 'executing': return 'sending to the server.';
    case 'verifying': return 'confirming with the server.';
    case 'retry_wait': {
      const due = operation.due_at ? new Date(operation.due_at) : null;
      return due && !Number.isNaN(due.getTime()) && due.getTime() > Date.now()
        ? `server busy; retry ${formatDistanceToNowStrict(due, { addSuffix: true })}.` : 'server busy; retrying soon.';
    }
    default: return 'waiting for the server.';
  }
}

/**
 * Provider writebacks with the server-approved actions. `can_retry`,
 * `can_cancel` and `can_accept_server_state` decide which buttons exist.
 */
export function MailPendingChanges({ operations, unavailable, focusAttention }: {
  operations: MailWriteback[];
  unavailable: boolean;
  focusAttention?: boolean;
}) {
  const client = useQueryClient();
  const refresh = () => { void client.invalidateQueries({ queryKey: mailQueryKeys.writebacks }); };
  const retry = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/mail/writebacks/${encodeURIComponent(id)}/retry`);
      if (response.error) throw new Error('Outcome check could not be requested. Check your connection and try again.');
    },
    retry: false,
    onSuccess: refresh,
  });
  const discard = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/mail/writebacks/${encodeURIComponent(id)}/cancel`);
      if (response.error) throw new Error('The change could not be discarded. Check your connection and try again.');
    },
    retry: false,
    onSuccess: refresh,
  });
  const [confirmAccept, setConfirmAccept] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/mail/writebacks/${encodeURIComponent(id)}/accept-server-state`);
      if (response.error) throw new Error('The server state could not be accepted. Check your connection and try again.');
    },
    retry: false,
    onSuccess: () => { setConfirmAccept(null); refresh(); },
  });
  const { waiting, attention, rejected } = groupWritebacks(operations);
  const problems = [...attention, ...rejected];

  const row = (operation: MailWriteback) => {
    // Only a dispatched MOVE is an outcome check; an unsent move is retried normally.
    const check = operation.retry_action ? operation.retry_action === 'check_outcome' : operation.action === 'move';
    const canRetry = operation.can_retry ?? (operation.status === 'failed' && operation.action !== 'move');
    return <li key={operation.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1">
      <span className="min-w-0">{actionLabels[operation.action]}: {describe(operation, check)}</span>
      <span className="flex gap-1">
        {canRetry && <Button size="sm" variant="outline" className="h-7 text-xs"
          disabled={retry.isPending || !navigator.onLine}
          aria-label={`${check ? 'Check outcome of' : 'Retry'} ${actionLabels[operation.action].toLowerCase()}`}
          onClick={() => retry.mutate(operation.id)}>
          {retry.isPending && retry.variables === operation.id ? 'Checking…' : check ? 'Check outcome' : 'Retry'}
        </Button>}
        {operation.can_cancel && <Button size="sm" variant="ghost" className="h-7 text-xs"
          disabled={discard.isPending || !navigator.onLine}
          aria-label={`Discard ${actionLabels[operation.action].toLowerCase()}`}
          onClick={() => discard.mutate(operation.id)}>
          {discard.isPending && discard.variables === operation.id ? 'Discarding…' : 'Discard'}
        </Button>}
        {operation.can_accept_server_state && confirmAccept !== operation.id && <Button size="sm" variant="ghost" className="h-7 text-xs"
          disabled={accept.isPending || !navigator.onLine}
          onClick={() => setConfirmAccept(operation.id)}>
          Accept server state
        </Button>}
      </span>
      {operation.can_accept_server_state && confirmAccept === operation.id && <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <span id={`accept-server-state-${operation.id}`} className="text-muted-foreground">
          UniHub will stop tracking this move and sync the account again. The message stays wherever the provider has it; nothing is sent to the provider.
        </span>
        <span className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" aria-describedby={`accept-server-state-${operation.id}`}
            disabled={accept.isPending || !navigator.onLine} onClick={() => accept.mutate(operation.id)}>
            {accept.isPending && accept.variables === operation.id ? 'Accepting…' : 'Stop tracking and sync'}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={accept.isPending}
            onClick={() => setConfirmAccept(null)}>
            Keep tracking
          </Button>
        </span>
      </div>}
    </li>;
  };

  if (!unavailable && !waiting.length && !problems.length && !retry.isError && !discard.isError && !accept.isError) {
    return <p className="text-xs text-muted-foreground">All your changes are confirmed by the server.</p>;
  }
  return <div className="space-y-2 text-xs">
    <div role="status" className="space-y-1 empty:hidden">
      {unavailable && <p>Server change status is unavailable. Accepted changes may still be waiting.</p>}
      {retry.isError && <p className="text-destructive">{retry.error.message}</p>}
      {discard.isError && <p className="text-destructive">{discard.error.message}</p>}
      {accept.isError && <p className="text-destructive">{accept.error.message}</p>}
    </div>
    {problems.length > 0 && <section aria-labelledby="mail-sync-attention-heading">
      <h3 id="mail-sync-attention-heading" tabIndex={-1} data-autofocus={focusAttention ? '' : undefined}
        className="flex items-center gap-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warning" />
        {attention.length > 0 ? `${plural(attention.length, 'change needs', 'changes need')} your attention` : 'Changes not applied'}
      </h3>
      <ul className="divide-y divide-border">{problems.map(row)}</ul>
    </section>}
    {waiting.length > 0 && <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-sm py-1 text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-90" />
        {plural(waiting.length, 'change', 'changes')} waiting for the server
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="py-1 text-muted-foreground">Mail already shows what you asked for while UniHub waits for the provider.</p>
        <ul className="max-h-48 divide-y divide-border overflow-y-auto">{waiting.map(row)}</ul>
      </CollapsibleContent>
    </Collapsible>}
  </div>;
}
