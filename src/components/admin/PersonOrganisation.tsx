import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Globe, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { useAdminGroups, usePersonDevices, invalidateOrganisation } from '@/hooks/use-organisation';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { lastActiveLabel } from '@/lib/account-api';
import { endPersonDevices, personDevicesQueryKey, setGroupManager, type Person } from '@/lib/admin-api';
import { deviceLabel } from '@/lib/devices-api';
import { addGroupMembers, removeGroupMember } from '@/lib/groups-api';
import { can } from '@/lib/permissions';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import type { usePersonActions } from '@/components/admin/PersonActions';
import { ROLE_LABELS, ROW_LINK, formatDay, personName, personTarget } from '@/components/admin/person-words';
import { DEVICE_KIND_ICONS, describeDeviceLock } from '@/components/settings/Devices';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PolicyNote } from '@/components/ui/policy-note';
import { Switch } from '@/components/ui/switch';

// The person page's own sections (0.30), above what an administrator does
// with the person's accounts, backups and bin: who they are here, their
// groups, where they are signed in, and the account itself.

type Actions = ReturnType<typeof usePersonActions>;

const ROLE_WORDS: Record<Person['role'], string> = {
  owner: 'The one owner of this server: makes and removes administrators and can hand ownership on.',
  admin: 'Manages people, groups, the rules and this server.',
  user: 'Uses UniHub; manages nothing beyond their own data and the groups they are a manager of.',
};

/** Email, role and how the person signs in. */
export function PersonProfile({ person, actions }: { person: Person; actions: Actions }) {
  const able = actions.abilities(person);
  const signIn = person.status === 'invited' ? 'Has no password yet. A setup link is waiting to be opened.'
    : person.status === 'not_set_up' ? 'Has no password and no setup link: they cannot sign in.'
    : person.status === 'inactive' ? 'Cannot sign in while the account is inactive.'
    : person.two_factor_enabled ? 'Password and two-factor authentication.'
    : person.two_factor_grace_ends_at ? `Password only. Two-factor authentication is required: they have until ${formatDay(person.two_factor_grace_ends_at)} to set it up.`
    : 'Password only.';
  return (
    <SettingsSection title="Profile and role">
      <SettingsRow label="Email"><span className="text-sm [overflow-wrap:anywhere]">{person.email}</span></SettingsRow>
      <SettingsRow label={ROLE_LABELS[person.role]} description={ROLE_WORDS[person.role]} lock={able.role ? able.roleLock : undefined}>
        {able.role && <Button variant="outline" disabled={!!able.roleLock} onClick={() => actions.open('role', person)}>{person.role === 'admin' ? 'Remove administrator rights' : 'Make administrator'}</Button>}
        {able.transfer && <Button variant="outline" onClick={() => actions.open('transfer', person)}>Hand over ownership…</Button>}
      </SettingsRow>
      <SettingsRow label="Sign-in" description={signIn}>
        {able.setupLink && <Button variant="outline" onClick={() => actions.open('setup-link', person)}>New setup link</Button>}
        {able.revokeLink && <Button variant="outline" onClick={() => actions.revokeLink(person)} disabled={actions.busy}>Revoke link</Button>}
        {able.password && <Button variant="outline" onClick={() => actions.open('password', person)}>{able.pending ? 'Set a password' : 'Set a new password'}</Button>}
        {able.resetTwoFactor && <Button variant="outline" onClick={() => actions.open('reset-2fa', person)}>Reset 2FA</Button>}
      </SettingsRow>
    </SettingsSection>
  );
}

/** The person's groups: add, remove, and who manages. A group's rules apply to its members at once. */
export function PersonGroups({ person }: { person: Person }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const groups = useAdminGroups();
  const manage = can(user, 'groups.manage');
  const name = personName(person);
  const change = useSessionMutation({
    mutationFn: async ({ kind, groupId, manager }: { kind: 'add' | 'remove' | 'manager'; groupId: string; groupName: string; manager?: boolean }) => {
      if (kind === 'add') return addGroupMembers(groupId, [person.id]);
      if (kind === 'remove') return removeGroupMember(groupId, person.id);
      return setGroupManager(groupId, person.id, !!manager);
    },
    onSuccess: (_answer, { kind, groupName, manager }) => toast({ title: kind === 'add' ? `${name} added to ${groupName}` : kind === 'remove' ? `${name} removed from ${groupName}` : manager ? `${name} manages ${groupName} now` : `${name} no longer manages ${groupName}` }),
    // A refusal is the server's: a combination of rules that cannot hold names the group or the person.
    onError: (error: Error) => toast({ title: 'Could not change the groups', description: error.message, variant: 'destructive' }),
    onSettled: () => invalidateOrganisation(client),
  });
  const others = (groups.data ?? []).filter(group => !person.groups.some(own => own.id === group.id));
  return (
    <SettingsSection title="Groups" description="A group's rules apply to its members as soon as they are added. A manager adds and removes its members and renames it."
      action={manage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={others.length === 0 || change.isPending}><Plus aria-hidden="true" />Add to group</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {others.map(group => <DropdownMenuItem key={group.id} onClick={() => change.mutate({ kind: 'add', groupId: group.id, groupName: group.name })}>{group.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}>
      {person.groups.length === 0 && <SettingsBlock><p className="text-sm text-muted-foreground">{name} is in no group: only the rules for everyone apply.</p></SettingsBlock>}
      {person.groups.map(group => (
        <SettingsRow key={group.id} label={<Link to={`/admin/groups/${encodeURIComponent(group.id)}`} className={ROW_LINK}>{group.name}</Link>}
          description={manage ? undefined : group.role === 'manager' ? 'Manager' : 'Member'}>
          {manage && <>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Manager
              <Switch aria-label={`${group.name}: manager`} checked={group.role === 'manager'} disabled={change.isPending}
                onCheckedChange={manager => change.mutate({ kind: 'manager', groupId: group.id, groupName: group.name, manager })} />
            </label>
            <Button variant="outline" size="sm" disabled={change.isPending} aria-label={`Remove from ${group.name}`}
              onClick={() => change.mutate({ kind: 'remove', groupId: group.id, groupName: group.name })}>Remove</Button>
          </>}
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}

/** Where the person is signed in, as their own Settings › Security shows it; an administrator signs a device out with their password. */
export function PersonDevices({ person }: { person: Person }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const { modules } = useModules();
  const query = usePersonDevices(person.id);
  const manage = can(user, 'users.manage');
  const name = personName(person);
  // null: every device; the id binds the confirmation to the person it was opened for.
  const [ending, setEnding] = useState<{ userId: string; deviceId: string | null; label: string } | null>(null);
  const end = useSecretMutation({
    mutationFn: ({ userId, deviceId, password }: { userId: string; deviceId: string | null; password: string }) => endPersonDevices(userId, password, deviceId ?? undefined),
    onSuccess: (ended, { userId, deviceId }) => {
      void client.invalidateQueries({ queryKey: personDevicesQueryKey(userId) });
      setEnding(current => (current?.userId === userId && current.deviceId === deviceId ? null : current));
      toast({ title: ended === 1 ? 'Device signed out' : `${ended} devices signed out` });
    },
    onError: (error: Error) => toast({ title: 'Could not sign out', description: error.message, variant: 'destructive' }),
  });
  const devices = query.data ?? [];
  return (
    <SettingsSection title="Devices" description={`Where ${name} is signed in. Signing a device out deletes nothing: it asks for the password again, and the Android app notices at its next request.`}
      action={manage && <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={devices.length === 0}
        onClick={() => setEnding({ userId: person.id, deviceId: null, label: 'every device' })}>Sign out all</Button>}>
      {query.isLoading ? <SettingsBlock><LoadingState compact label="Loading devices…" /></SettingsBlock>
        : query.error ? <SettingsBlock><ErrorState title="Could not load the devices" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /></SettingsBlock>
        : devices.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">{name} is not signed in anywhere.</p></SettingsBlock>
        : devices.map(device => {
          const Icon = DEVICE_KIND_ICONS[device.kind] ?? Globe;
          const label = deviceLabel(device);
          return (
            <SettingsRow key={device.id}
              label={<span className="flex min-w-0 items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{label}</span></span>}
              description={<>
                <span className="block">Last used {lastActiveLabel(device.last_seen_at)} · signed in since {format(new Date(device.created_at), 'd MMM yyyy')}</span>
                <span className="block">{describeDeviceLock(device.lock, modules)} · Notifications {device.notifications ? 'on' : 'off'}</span>
              </>}>
              {manage && <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" aria-label={`Sign out ${label}`}
                onClick={() => setEnding({ userId: person.id, deviceId: device.id, label })}>Sign out</Button>}
            </SettingsRow>
          );
        })}
      <PasswordConfirmDialog open={!!ending && ending.userId === person.id} onClose={() => setEnding(null)} target={personTarget(person)}
        title={ending?.deviceId ? `Sign out ${ending.label}?` : `Sign out every device of ${name}?`}
        description={ending?.deviceId ? 'It is signed out at once and stops receiving notifications. Nothing on the server is deleted.' : 'They are signed out everywhere at once and sign in again with their password. Nothing on the server is deleted.'}
        actionLabel={ending?.deviceId ? 'Sign out' : 'Sign out all'} destructive pending={end.isPending}
        onConfirm={password => { if (ending?.userId === person.id) end.mutate({ userId: ending.userId, deviceId: ending.deviceId, password }); }} />
    </SettingsSection>
  );
}

/** Deactivate (keeps everything) or delete (keeps nothing). The owner is protected until ownership is handed over. */
export function PersonAccount({ person, actions }: { person: Person; actions: Actions }) {
  const able = actions.abilities(person);
  if (!able.manage || able.self) return null;
  return (
    <SettingsSection title="Account">
      {person.is_active ? (
        <SettingsRow label="Deactivate" description="Signs them out everywhere and stops sign-in. Their data, groups and manager roles stay, so activating brings everything back.">
          <Button variant="outline" disabled={!!able.protectedLock} onClick={() => actions.open('deactivate', person)}>Deactivate</Button>
        </SettingsRow>
      ) : (
        <SettingsRow label="Inactive" description="They cannot sign in. Their data, groups and manager roles are kept.">
          <Button onClick={() => actions.activate(person)} disabled={actions.busy}>Activate</Button>
        </SettingsRow>
      )}
      <SettingsRow label="Delete person" tone="destructive" description="Deletes the account with all of its data, for good.">
        <Button variant="outline" className="text-destructive hover:text-destructive" disabled={!!able.protectedLock} onClick={() => actions.open('delete', person)}>Delete person</Button>
      </SettingsRow>
      {able.protectedLock && <SettingsBlock><PolicyNote reason={able.protectedLock} className="mt-0" /></SettingsBlock>}
    </SettingsSection>
  );
}
