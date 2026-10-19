import { useInfiniteQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { auditActionLabel, auditLogQueryKey, fetchAuditLog, type AuditEntry } from '@/lib/admin-api';

const person = (who: NonNullable<AuditEntry['actor']>) => who.email ?? 'Deleted account';

/** Sign-ins and account and server changes, newest first; entries are kept for a year. */
export function AuditLog() {
  const query = useInfiniteQuery({
    queryKey: auditLogQueryKey,
    queryFn: ({ pageParam, signal }) => fetchAuditLog(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.cursor,
  });
  const entries = query.data?.pages.flatMap(page => page.entries) ?? [];

  return (
    <SettingsSection title="Activity" description="Sign-ins and changes to accounts and server settings from the last year.">
      {query.isLoading && <SettingsBlock><p className="text-sm text-muted-foreground">Loading activity…</p></SettingsBlock>}
      {query.error && (
        <SettingsBlock>
          <ErrorState title="Could not load the activity" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </SettingsBlock>
      )}
      {query.isSuccess && !entries.length && <SettingsBlock><p className="text-sm text-muted-foreground">No activity yet.</p></SettingsBlock>}
      {entries.map(entry => {
        // An action on one's own account names the person once; a failed sign-in has no actor.
        const own = entry.target && entry.target.id === entry.actor?.id;
        const who = own && entry.actor ? [person(entry.actor)] : [entry.target && person(entry.target), entry.actor && `by ${person(entry.actor)}`];
        return (
          <SettingsRow key={entry.id} label={auditActionLabel(entry)}
            description={[...who, entry.ipAddress, new Date(entry.createdAt).toLocaleString()].filter(Boolean).join(' · ')} />
        );
      })}
      {query.hasNextPage && (
        <SettingsBlock>
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage && <Loader2 aria-hidden="true" className="animate-spin" />}Show older
          </Button>
        </SettingsBlock>
      )}
    </SettingsSection>
  );
}
