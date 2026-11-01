import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useSessionScope } from '@/lib/session-scope';
import { binApi, invalidateBinQueries, type BinModule, type BinRestoreResponse } from '@/lib/bin-api';
import { invalidateCalendarQueries } from '@/lib/calendar-api';
import { invalidateContactQueries } from '@/lib/contacts-api';
import { recordingsQueryKeys } from '@/lib/recordings-api';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The lists a restored item returns to. */
export function refreshAfterRestore(client: QueryClient, modules: Iterable<BinModule | undefined>) {
  const wanted = new Set(modules);
  const all = wanted.has(undefined) || wanted.size === 0;
  void invalidateBinQueries(client);
  if (all || wanted.has('contacts')) void invalidateContactQueries(client);
  if (all || wanted.has('calendar')) void invalidateCalendarQueries(client);
  if (all || wanted.has('recordings')) void client.invalidateQueries({ queryKey: recordingsQueryKeys.all });
}

function restoredNotice(result: BinRestoreResponse) {
  const notes = result.restored.map(entry => entry.note).filter((note): note is string => !!note);
  const failed = result.failed.length ? `${plural(result.failed.length, 'item')} could not be restored: ${result.failed.map(entry => entry.error).join('; ')}` : '';
  return {
    title: result.restored.length === 0 ? 'Nothing restored' : result.restored.length === 1 ? 'Restored' : `${plural(result.restored.length, 'item')} restored`,
    description: [...notes, failed].filter(Boolean).join(' ') || undefined,
    variant: result.restored.length === 0 && result.failed.length ? 'destructive' as const : undefined,
  };
}

/**
 * Restoring, deleting for good and emptying, with their feedback, and the
 * "Moved to the bin · Undo" notice every delete shows. An answer after an
 * account switch shows and caches nothing (useSessionMutation).
 */
export function useBinActions(module?: BinModule) {
  const client = useQueryClient();
  const { toast } = useToast();
  const scope = useSessionScope();
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  const restore = useSessionMutation({
    mutationFn: ({ ids }: { ids: string[]; modules?: BinModule[] }) => binApi.restore(ids),
    onSuccess: (result, { modules }) => { refreshAfterRestore(client, modules ?? [module]); toast(restoredNotice(result)); },
    onError: failed('Could not restore'),
  });

  const remove = useSessionMutation({
    mutationFn: (id: string) => binApi.delete(id),
    onSuccess: () => { void invalidateBinQueries(client); toast({ title: 'Deleted for good' }); },
    onError: failed('Could not delete'),
  });

  const empty = useSessionMutation({
    mutationFn: (target: BinModule | undefined) => binApi.empty(target),
    onSuccess: deleted => { void invalidateBinQueries(client); toast({ title: deleted === 0 ? 'The bin was already empty' : `${plural(deleted, 'item')} deleted for good` }); },
    onError: failed('Could not empty the bin'),
  });

  /**
   * The notice after a delete: what went to the bin and one Undo, which
   * restores the same items. Pass the ids the delete route answered with.
   * A delete answered after the session ended names nothing: the caller's
   * callbacks may run unguarded (plain useMutation), so the check is here.
   */
  const movedToBin = (what: string, binItemIds: string[], target: BinModule | undefined = module) => {
    if (scope.ended) return;
    void invalidateBinQueries(client);
    toast({
      title: 'Moved to the bin',
      description: what,
      action: binItemIds.length ? <ToastAction altText={`Undo: bring ${what} back`} onClick={() => restore.mutate({ ids: binItemIds, modules: target ? [target] : undefined })}>Undo</ToastAction> : undefined,
    });
  };

  return { restore, remove, empty, movedToBin };
}

export type BinActions = ReturnType<typeof useBinActions>;
