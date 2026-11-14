import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, UsersRound } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { invalidateOrganisation, useAdminGroups, usePeople } from '@/hooks/use-organisation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { createGroup } from '@/lib/admin-api';
import { can } from '@/lib/permissions';
import { GroupDialog } from '@/components/organisation/GroupDialog';
import { GroupRow, groupMeta } from '@/components/organisation/GroupRow';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';

// Server › Groups: Everyone first (every active person; its rules are the
// Policies page), then the groups an administrator made. A group gathers
// people for rules stricter than Everyone's and has managers who look after
// its members.

const AdminGroups = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const groups = useAdminGroups();
  const people = usePeople();
  const active = people.data?.filter(person => person.is_active).length;
  const create = useSessionMutation({
    mutationFn: createGroup,
    onSuccess: group => { void invalidateOrganisation(client); setCreating(false); toast({ title: `${group.name} created`, description: 'Add people to it next.' }); navigate(`/admin/groups/${encodeURIComponent(group.id)}`); },
    onError: (error: Error) => toast({ title: 'Could not create the group', description: error.message, variant: 'destructive' }),
  });
  const newGroup = can(user, 'groups.manage') && <Button onClick={() => setCreating(true)}><Plus aria-hidden="true" />New group</Button>;

  return (
    <PageShell panel={<SettingsPanel active="admin-groups" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Groups" />
      <PageBody width="reading">
        {!can(user, 'users.read') ? <p className="text-sm text-muted-foreground">Only administrators can see this page.</p> : (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Groups</h2>
                <p className="mt-1 max-w-prose text-sm text-muted-foreground">People who share rules. A group can only make a rule stricter than it is for everyone, and its managers add and remove its members.</p>
              </div>
              {newGroup}
            </div>
            {groups.isLoading ? <LoadingState label="Loading groups…" />
              : groups.error ? <ErrorState title="Could not load groups" error={groups.error} onRetry={() => void groups.refetch()} retrying={groups.isFetching} />
              : (
                <>
                  <ul aria-label="Groups" className="divide-y divide-border border-y border-border">
                    <GroupRow to="/admin/policies" name="Everyone" description="Every active person. Its rules are the Policies page."
                      meta={active === undefined ? 'All active people' : `${active} ${active === 1 ? 'person' : 'people'}`} />
                    {groups.data!.map(group => <GroupRow key={group.id} to={`/admin/groups/${encodeURIComponent(group.id)}`} name={group.name} description={group.description} meta={groupMeta(group)} />)}
                  </ul>
                  {groups.data!.length === 0 && (
                    <EmptyState icon={UsersRound} title="No groups yet" description="Make one for people who need stricter rules than everyone, such as required two-factor authentication for one team." action={newGroup || undefined} />
                  )}
                </>
              )}
          </>
        )}
      </PageBody>
      <GroupDialog open={creating} pending={create.isPending} onClose={() => setCreating(false)} onSubmit={input => create.mutate(input)} />
    </PageShell>
  );
};

export default AdminGroups;
