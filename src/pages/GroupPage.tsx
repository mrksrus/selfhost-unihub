import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { invalidateOrganisation, useGroup } from '@/hooks/use-organisation';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { deleteGroup } from '@/lib/admin-api';
import { hasCode } from '@/lib/api-error';
import { updateGroup } from '@/lib/groups-api';
import { can } from '@/lib/permissions';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { GroupDialog } from '@/components/organisation/GroupDialog';
import { GroupMembers } from '@/components/organisation/GroupMembers';
import { groupMeta } from '@/components/organisation/GroupRow';
import { PolicyEditor } from '@/components/organisation/PolicyEditor';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Button } from '@/components/ui/button';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';

// One group, on two routes. Server › Groups › a group (`admin`): members,
// who manages, the group's rules, and deleting it. Your groups › a group:
// what its manager may do, which is adding and removing members and renaming
// it; a member who manages nothing sees its managers. The server decides
// which of these the person gets (`can_manage`, 404 for a group out of sight).

const GroupPage = ({ admin = false }: { admin?: boolean }) => {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const query = useGroup(id);
  const list = admin ? '/admin/groups' : '/groups';
  const editRules = admin && can(user, 'server.settings');
  const view = editRules && params.get('view') === 'rules' ? 'rules' : 'members';
  const group = query.data?.group;

  const rename = useSessionMutation({
    mutationFn: (input: { name: string; description: string | null }) => updateGroup(id, input),
    onSuccess: () => { void invalidateOrganisation(client); setRenaming(false); toast({ title: 'Group saved' }); },
    onError: (error: Error) => toast({ title: 'Could not save the group', description: error.message, variant: 'destructive' }),
  });
  const remove = useSecretMutation({
    mutationFn: ({ groupId, password }: { groupId: string; password: string }) => deleteGroup(groupId, password),
    onSuccess: () => { void invalidateOrganisation(client); toast({ title: 'Group deleted', description: 'Nobody\'s data was deleted.' }); navigate(list, { replace: true }); },
    onError: (error: Error) => toast({ title: 'Could not delete the group', description: error.message, variant: 'destructive' }),
  });

  const gone = hasCode(query.error, 'GROUP_NOT_FOUND');
  const body = query.isLoading ? <LoadingState label="Loading the group…" />
    : gone ? <ErrorState title="No such group" error={admin ? 'It may have been deleted.' : 'It was deleted, or you are no longer in it.'} />
    : query.error || !query.data || !group ? <ErrorState title="Could not load the group" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
    : (
      <>
        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{group.name}</h2>
            {group.description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{group.description}</p>}
            <p className="mt-1 text-sm text-muted-foreground">{groupMeta(group)}</p>
          </div>
          {query.data.can_manage && <Button variant="outline" onClick={() => setRenaming(true)}>Rename</Button>}
        </div>
        {view === 'rules' ? <PolicyEditor scope={{ groupId: id }} groupName={group.name} /> : (
          <>
            <GroupMembers groupId={id} data={query.data} personHref={admin && can(user, 'users.read') ? userId => `/admin/users/${encodeURIComponent(userId)}` : undefined} />
            {!editRules && (
              <SettingsSection title="Rules">
                <SettingsBlock>
                  <p className="max-w-prose text-sm text-muted-foreground">
                    {group.has_policies ? 'This group has rules of its own. They apply to every member, on top of the rules for everyone.' : 'This group has no rules of its own: the rules for everyone apply.'}
                    {' '}An administrator sets them. The rules that apply to you are under <Link to="/settings?section=account" className="underline underline-offset-2 hover:text-foreground">Settings › Profile</Link>.
                  </p>
                </SettingsBlock>
              </SettingsSection>
            )}
            {admin && can(user, 'groups.manage') && (
              <SettingsSection title="Delete group">
                <SettingsRow label="Delete this group" tone="destructive" description="Its memberships and its rules go with it, so its members may get looser rules. Nobody's account or data is deleted.">
                  <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleting(true)}>Delete group</Button>
                </SettingsRow>
              </SettingsSection>
            )}
          </>
        )}
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active={admin ? 'admin-groups' : 'groups'} />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope={`${admin ? 'Groups' : 'Your groups'}${group ? ` · ${group.name}` : ''}`}
        back={<Button variant="ghost" size="icon" aria-label={admin ? 'Back to groups' : 'Back to your groups'} asChild><Link to={list}><ChevronLeft aria-hidden="true" /></Link></Button>}>
        {editRules && group && (
          <div className="px-4 pb-3 md:px-6">
            <ChipGroup label="View">
              <Chip selected={view === 'members'} onSelect={() => setParams({}, { replace: true })} count={group.member_count} countLabel="members">Members</Chip>
              <Chip selected={view === 'rules'} onSelect={() => setParams({ view: 'rules' }, { replace: true })}>Rules</Chip>
            </ChipGroup>
          </div>
        )}
      </PageHeader>
      <PageBody width="reading">{body}</PageBody>
      <GroupDialog open={renaming} group={group} pending={rename.isPending} onClose={() => setRenaming(false)} onSubmit={input => rename.mutate(input)} />
      <PasswordConfirmDialog open={deleting} onClose={() => setDeleting(false)} title={`Delete ${group?.name ?? 'this group'}?`}
        description="The group, its memberships and its rules are deleted. People who were in it keep their accounts and data; only the rules for everyone and of their other groups still apply to them, which may be looser."
        actionLabel="Delete group" destructive pending={remove.isPending} onConfirm={password => remove.mutate({ groupId: id, password })} />
    </PageShell>
  );
};

export default GroupPage;
