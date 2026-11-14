import { useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { invalidateOrganisation } from '@/hooks/use-organisation';
import { useToast } from '@/hooks/use-toast';
import {
  createSetupLink, deleteAdminUser, resetUserTwoFactor, revokeSetupLink, setUserActive, setUserPassword, setUserRole, transferOwnership,
  type Person, type SetupLink,
} from '@/lib/admin-api';
import { can } from '@/lib/permissions';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { SetupLinkDialog } from '@/components/admin/SetupLink';
import { personName, personTarget } from '@/components/admin/person-words';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// What an administrator does to a person's account, for the People list's
// row menus and the person page alike: one implementation of each change and
// of its confirmation. Every change that needs it carries the
// administrator's own password (useSecretMutation keeps it for the request
// only) and names the person in the dialog. A dialog has a generation: an
// answer closes only the dialog it was sent from, never one opened since for
// someone else.

export type PersonAction = 'role' | 'password' | 'reset-2fa' | 'deactivate' | 'delete' | 'setup-link' | 'transfer';

export const OWNER_ONLY_REASON = 'Only the owner makes or removes administrators.';
export const OWNER_PROTECTED_REASON = 'The owner cannot be deactivated or deleted. They hand ownership to another administrator first.';

type Open = { action: PersonAction; person: Person; generation: number };

/** What each action may do for this person, as the page shows it; the server decides anyway. */
export function personAbilities(viewer: Parameters<typeof can>[0] & { id?: string } | null | undefined, person: Person) {
  const manage = can(viewer, 'users.manage');
  const self = person.id === viewer?.id;
  const owner = person.role === 'owner';
  const pending = person.status === 'invited' || person.status === 'not_set_up';
  return {
    manage, self, owner, pending,
    role: manage && !owner && !self,
    roleLock: can(viewer, 'admins.manage') ? undefined : OWNER_ONLY_REASON,
    password: manage,
    setupLink: manage && pending,
    revokeLink: manage && person.status === 'invited',
    resetTwoFactor: manage && person.two_factor_enabled && !self,
    deactivate: manage && person.is_active && !self,
    activate: manage && !person.is_active,
    remove: manage && !self,
    protectedLock: owner ? OWNER_PROTECTED_REASON : undefined,
    transfer: owner && self && can(viewer, 'owner.transfer'),
  };
}

export function usePersonActions({ people = [], onDeleted }: { people?: readonly Person[]; onDeleted?: (person: Person) => void } = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Open | null>(null);
  const [link, setLink] = useState<{ link: SetupLink; name: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [heir, setHeir] = useState('');
  const generations = useRef(0);
  const open = (action: PersonAction, person: Person) => { setNewPassword(''); setHeir(''); setDialog({ action, person, generation: ++generations.current }); };
  const close = (generation: number) => setDialog(current => (current?.generation === generation ? null : current));
  const refresh = () => { void invalidateOrganisation(client); };

  type Run = { action: PersonAction; person: Person; generation: number; password: string; newPassword: string; heir: string };
  const run = useSecretMutation({
    mutationFn: async ({ action, person, password, newPassword: next, heir: to }: Run): Promise<SetupLink | void> => {
      if (action === 'role') return setUserRole(person.id, person.role === 'admin' ? 'user' : 'admin', password);
      if (action === 'password') return setUserPassword(person.id, next, password);
      if (action === 'reset-2fa') return resetUserTwoFactor(person.id, password);
      if (action === 'deactivate') return setUserActive(person.id, false, password);
      if (action === 'delete') return deleteAdminUser(person.id, password);
      if (action === 'transfer') return transferOwnership(to, password);
      return createSetupLink(person.id, password);
    },
    // Reports on the person the request was sent for; the dialog may be open for someone else by now.
    onSuccess: (answer, { action, person, generation }) => {
      refresh();
      close(generation);
      const name = personName(person);
      if (action === 'setup-link' && answer) { setLink({ link: answer, name }); return; }
      if (action === 'delete') onDeleted?.(person);
      toast({
        role: { title: person.role === 'admin' ? `${name} is a member now` : `${name} is an administrator now` },
        password: { title: `Password set for ${person.email}`, description: 'They were signed out everywhere.' },
        'reset-2fa': { title: `Two-factor authentication reset for ${person.email}`, description: 'They were signed out and can sign in with their password.' },
        deactivate: { title: `${name} deactivated`, description: 'Their devices were signed out. Their data and groups stay.' },
        delete: { title: `${name} deleted` },
        transfer: { title: 'Ownership handed over', description: 'You are an administrator now.' },
        'setup-link': { title: 'Setup link created' },
      }[action]);
    },
    onError: (error: Error, { action, person }) => toast({
      title: {
        role: 'Could not change the role', password: 'Could not set the password', 'reset-2fa': `Could not reset two-factor authentication for ${person.email}`,
        deactivate: 'Could not deactivate the account', delete: 'Could not delete the person', transfer: 'Could not hand over ownership', 'setup-link': 'Could not create a setup link',
      }[action], description: error.message, variant: 'destructive',
    }),
  });
  // Activating and revoking a link need no password: neither opens anything that was closed for a reason of security.
  const activate = useSessionMutation({
    mutationFn: (person: Person) => setUserActive(person.id, true),
    onSuccess: (_answer, person) => { refresh(); toast({ title: `${personName(person)} activated` }); },
    onError: (error: Error) => toast({ title: 'Could not activate the account', description: error.message, variant: 'destructive' }),
  });
  const revoke = useSessionMutation({
    mutationFn: (person: Person) => revokeSetupLink(person.id),
    onSuccess: (_answer, person) => { refresh(); toast({ title: 'Setup link revoked', description: `${personName(person)} cannot set a password until you create a new link or set one.` }); },
    onError: (error: Error) => toast({ title: 'Could not revoke the setup link', description: error.message, variant: 'destructive' }),
  });

  const person = dialog?.person;
  const email = person?.email ?? '';
  // The server hands ownership only to an administrator who can sign in.
  const admins = people.filter(entry => entry.role === 'admin' && entry.status === 'active');
  const copy: Record<PersonAction, { title: string; description: ReactNode; action: string; destructive?: boolean }> = {
    role: person?.role === 'admin'
      ? { title: `Remove administrator rights from ${email}?`, description: 'They keep their account and data but can no longer manage people, groups or the server.', action: 'Remove administrator rights' }
      : { title: `Make ${email} an administrator?`, description: 'Administrators manage every account on this server, its groups and its rules. Only you, the owner, can undo this.', action: 'Make administrator' },
    password: { title: `New password for ${email}`, description: 'They are signed out everywhere and sign in with this password. At least 12 characters, more where a rule asks for it.', action: 'Set password' },
    'reset-2fa': { title: `Reset 2FA for ${email}`, description: 'For a person who lost their authenticator and recovery codes. Two-factor authentication is turned off and they are signed out everywhere; they sign in with their password and can set it up again. Check that the request really comes from them first.', action: 'Reset 2FA', destructive: true },
    deactivate: { title: `Deactivate ${email}?`, description: 'They are signed out on every device and cannot sign in until an administrator activates the account again. Their data, groups and manager roles stay.', action: 'Deactivate' },
    delete: { title: `Delete ${email}?`, description: 'Their account and all of their data are deleted permanently. This cannot be undone. To keep the data, deactivate instead.', action: 'Delete person', destructive: true },
    'setup-link': { title: `New setup link for ${email}?`, description: 'A link they open once to choose their password. An earlier link stops working.', action: 'Create link' },
    transfer: { title: 'Hand over ownership?', description: 'The new owner alone makes and removes administrators. You stay an administrator and cannot take ownership back yourself.', action: 'Hand over ownership', destructive: true },
  };
  const shown = dialog ? copy[dialog.action] : null;
  const incomplete = dialog?.action === 'password' ? !newPassword : dialog?.action === 'transfer' ? !heir : false;

  const dialogs = (
    <>
      <PasswordConfirmDialog open={!!dialog} onClose={() => setDialog(null)} title={shown?.title ?? ''} description={shown?.description ?? ''} actionLabel={shown?.action ?? ''}
        target={person && dialog?.action !== 'transfer' ? personTarget(person) : undefined} destructive={shown?.destructive} pending={run.isPending} confirmDisabled={incomplete}
        onConfirm={password => { if (dialog) run.mutate({ ...dialog, password, newPassword, heir }); }}>
        {dialog?.action === 'password' && (
          <div className="space-y-2">
            <Label htmlFor="person-new-password">New password</Label>
            <Input id="person-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} />
          </div>
        )}
        {dialog?.action === 'transfer' && (
          <div className="space-y-2">
            <Label htmlFor="person-heir">New owner</Label>
            <Select value={heir} onValueChange={setHeir} disabled={admins.length === 0}>
              <SelectTrigger id="person-heir"><SelectValue placeholder={admins.length ? 'Choose an administrator' : 'No other active administrator'} /></SelectTrigger>
              <SelectContent>{admins.map(admin => <SelectItem key={admin.id} value={admin.id}>{personTarget(admin)}</SelectItem>)}</SelectContent>
            </Select>
            {admins.length === 0 && <p className="text-xs text-muted-foreground">Make someone an administrator first; ownership goes to an active administrator.</p>}
          </div>
        )}
      </PasswordConfirmDialog>
      <SetupLinkDialog link={link?.link ?? null} name={link?.name ?? ''} onClose={() => setLink(null)} />
    </>
  );

  return {
    open, dialogs, abilities: (target: Person) => personAbilities(user, target),
    activate: (target: Person) => activate.mutate(target), revokeLink: (target: Person) => revoke.mutate(target),
    showLink: (shownLink: SetupLink, name: string) => setLink({ link: shownLink, name }),
    busy: run.isPending || activate.isPending || revoke.isPending,
  };
}
