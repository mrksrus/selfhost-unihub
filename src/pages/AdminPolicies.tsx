import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { useAdminGroups } from '@/hooks/use-organisation';
import { can } from '@/lib/permissions';
import { PolicyEditor } from '@/components/organisation/PolicyEditor';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';

// Server › Policies: the rules of Everyone (the installation) or, chosen at
// the top, of one group (0.30). The group's own page shows the same editor
// under its Rules view. The scope is in the address (?group=<id>), so a link
// from a group lands on its rules; changing it drops unsaved changes of the
// other scope (the editor is keyed by it).

const EVERYONE = 'everyone';

const AdminPolicies = () => {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const groups = useAdminGroups();
  const requested = params.get('group');
  // An unknown or deleted group reads as Everyone once the groups are known.
  const group = groups.data?.find(entry => entry.id === requested);
  const scope = requested && (group || groups.isLoading) ? { groupId: requested } : undefined;

  return (
    <PageShell panel={<SettingsPanel active="admin-policies" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope={group ? `Policies · ${group.name}` : 'Policies'} />
      <PageBody width="reading">
        {!can(user, 'server.settings') ? <p className="text-sm text-muted-foreground">Only administrators can see this page.</p> : (
          <>
            {!!groups.data?.length && (
              <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <Label htmlFor="policy-scope" className="shrink-0">Rules for</Label>
                <Select value={scope?.groupId ?? EVERYONE} onValueChange={next => setParams(next === EVERYONE ? {} : { group: next }, { replace: true })}>
                  <SelectTrigger id="policy-scope" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EVERYONE}>Everyone</SelectItem>
                    {groups.data.map(entry => <SelectItem key={entry.id} value={entry.id}>{entry.name}{entry.has_policies ? '' : ' (no rules of its own)'}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <PolicyEditor key={scope?.groupId ?? EVERYONE} scope={scope} groupName={group?.name} />
          </>
        )}
      </PageBody>
    </PageShell>
  );
};

export default AdminPolicies;
