import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useSessionScope } from '@/lib/session-scope';
import { ApiError } from '@/lib/api-error';
import { binApi, destinationAsked, invalidateBinQueries, restoreRefusal, type BinDestinationKind, type BinModule, type BinRestoreResponse } from '@/lib/bin-api';
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
  const pending = result.restored.filter(entry => entry.pending).length;
  if (pending) notes.push(`${plural(pending, 'item')} ${pending === 1 ? 'is' : 'are'} being created on the calendar server again.`);
  const failed = result.failed.length ? `${plural(result.failed.length, 'item')} could not be restored: ${[...new Set(result.failed.map(entry => restoreRefusal(entry.code, entry.error)))].join(' ')}` : '';
  return {
    title: result.restored.length === 0 ? 'Nothing restored' : result.restored.length === 1 ? 'Restored' : `${plural(result.restored.length, 'item')} restored`,
    description: [...notes, failed].filter(Boolean).join(' ') || undefined,
    variant: result.restored.length === 0 && result.failed.length ? 'destructive' as const : undefined,
  };
}

/** The items the server could restore only to a calendar or list the person chooses. */
export interface DestinationAsk { ids: string[]; kind: BinDestinationKind; modules?: BinModule[] }
export interface RestoreVariables { ids: string[]; modules?: BinModule[]; calendarId?: string }

/**
 * Restoring, deleting for good and emptying, with their feedback, and the
 * "Moved to the bin · Undo" notice every delete shows. An answer after an
 * account switch shows and caches nothing (useSessionMutation).
 */
export function useBinActions(module?: BinModule, { onDestinationAsked }: { onDestinationAsked?: (ask: DestinationAsk) => void } = {}) {
  const client = useQueryClient();
  const { toast } = useToast();
  const scope = useSessionScope();
  const failed = (title: string) => (error: Error) => toast({ title, description: error instanceof ApiError ? restoreRefusal(error.code, error.message) : error.message, variant: 'destructive' });

  const restore = useSessionMutation({
    mutationFn: ({ ids, calendarId }: RestoreVariables) => binApi.restore(ids, calendarId),
    onSuccess: (result, { modules }) => {
      refreshAfterRestore(client, modules ?? [module]);
      // An item whose own calendar is gone or read-only waits for the person's choice; the rest is reported.
      const asked = result.failed.filter(entry => destinationAsked(entry.code));
      const rest = { ...result, failed: result.failed.filter(entry => !destinationAsked(entry.code)) };
      if (rest.restored.length || rest.failed.length) toast(restoredNotice(rest));
      if (asked.length && onDestinationAsked) onDestinationAsked({ ids: asked.map(entry => entry.id), kind: destinationAsked(asked[0].code)!, modules });
      else if (asked.length) toast({ title: 'Nothing restored', description: restoreRefusal(asked[0].code, asked[0].error), variant: 'destructive' });
    },
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
   * restores the same items. Pass the ids the delete route answered with:
   * one item, or one group (a list with its events, several contacts at
   * once), which the server restores as a unit from any one of its members,
   * so Undo sends the first id and stays under the request's id limit.
   * A delete answered after the session ended names nothing: the caller's
   * callbacks may run unguarded (plain useMutation), so the check is here.
   */
  const movedToBin = (what: string, binItemIds: string[], target: BinModule | undefined = module) => {
    if (scope.ended) return;
    void invalidateBinQueries(client);
    toast({
      title: 'Moved to the bin',
      description: what,
      action: binItemIds.length ? <ToastAction altText={`Undo: bring ${what} back`} onClick={() => restore.mutate({ ids: binItemIds.slice(0, 1), modules: target ? [target] : undefined })}>Undo</ToastAction> : undefined,
    });
  };

  return { restore, remove, empty, movedToBin };
}

export type BinActions = ReturnType<typeof useBinActions>;
