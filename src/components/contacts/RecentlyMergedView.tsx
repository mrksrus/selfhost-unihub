import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { mergesQueryOptions } from '@/lib/contacts-api';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';

const formatDay = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
};

/** The merges of the last 30 days, each undoable until its expiry. The first piece of the bin (0.28). */
export function RecentlyMergedView({ actions }: { actions: ContactActions }) {
  const query = useQuery(mergesQueryOptions);
  if (query.isLoading) return <LoadingState label="Loading recent merges…" />;
  if (query.error) return <ErrorState title="Could not load recent merges" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const merges = query.data ?? [];
  if (!merges.length) return <EmptyState icon={History} title="Nothing merged in the last 30 days" description="A merge can be undone here until it expires." />;
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">Undo puts the merged contacts back as they were. Entries leave this list after 30 days.</p>
      <ul className="-mx-2 divide-y divide-border">
        {merges.map(merge => {
          const undone = !!merge.undone_at;
          const names = merge.merged.map(entry => entry.display_name || 'No name').join(', ');
          return (
            <li key={merge.id} className="flex items-center gap-3 px-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{merge.survivor_name || 'No name'}</p>
                <p className="truncate text-xs text-muted-foreground">{undone ? 'Undone' : `Folded in ${names}`}</p>
                <p className="text-xs text-muted-foreground">Merged {formatDay(merge.created_at)}{!undone && ` · Undo until ${formatDay(merge.purge_after)}`}</p>
              </div>
              <Button variant="outline" size="sm" disabled={undone || actions.undoMerge.isPending} onClick={() => actions.undoMerge.mutate(merge.id)}
                aria-label={`Undo the merge into ${merge.survivor_name || 'this contact'}`}>Undo</Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
