import { useMyGroups } from '@/hooks/use-organisation';
import { GroupRow } from '@/components/organisation/GroupRow';
import { SettingsBlock, SettingsSection } from '@/components/settings/SettingsLayout';
import { ErrorState } from '@/components/ui/page-states';

/**
 * "Your groups": the groups the signed-in person is in, with their role in
 * each. A group's rules apply to its members; a manager opens it to add and
 * remove members. Shown under Settings › Profile and as its own page.
 */
export function MyGroups() {
  const query = useMyGroups();
  return (
    <SettingsSection title="Your groups" description="An administrator puts people in groups; a group's rules apply to its members. You can add and remove members of a group you manage.">
      {query.isLoading ? <SettingsBlock><p role="status" className="text-sm text-muted-foreground">Loading your groups…</p></SettingsBlock>
        : query.error ? <SettingsBlock><ErrorState title="Could not load your groups" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /></SettingsBlock>
        : !query.data?.length ? <SettingsBlock><p className="text-sm text-muted-foreground">You are in no group. The rules for everyone apply to you.</p></SettingsBlock>
        : (
          <ul aria-label="Your groups" className="divide-y divide-border">
            {query.data.map(group => (
              <GroupRow key={group.id} to={`/groups/${encodeURIComponent(group.id)}`} name={group.name} description={group.description}
                meta={group.role === 'manager' ? `You manage it, ${group.member_count} ${group.member_count === 1 ? 'member' : 'members'}` : 'Member'} />
            ))}
          </ul>
        )}
    </SettingsSection>
  );
}
