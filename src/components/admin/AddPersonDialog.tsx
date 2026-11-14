import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useAdminGroups, invalidateOrganisation } from '@/hooks/use-organisation';
import { usePolicy } from '@/hooks/use-policies';
import { useToast } from '@/hooks/use-toast';
import { addPerson, type AddPersonResponse, type AssignableRole } from '@/lib/admin-api';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PolicyNote } from '@/components/ui/policy-note';
import { RadioRow } from '@/components/ui/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const EMPTY = { email: '', name: '', role: 'user' as AssignableRole, groups: [] as string[], way: 'link' as 'link' | 'password', password: '', own: '' };

/**
 * Server › People › Add person. The account exists at once, so it can be put
 * in groups and given mail accounts before the person arrives. They get in
 * with a setup link (the default: the administrator never knows the
 * password) or with an initial password the administrator types and tells
 * them. `onAdded` receives the answer; a setup link in it is shown once.
 */
export function AddPersonDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (answer: AddPersonResponse) => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const groups = useAdminGroups();
  const minimum = usePolicy('auth.password_min_length').value;
  const [form, setForm] = useState(EMPTY);
  const set = (patch: Partial<typeof EMPTY>) => setForm(previous => ({ ...previous, ...patch }));
  useEffect(() => { if (!open) setForm(EMPTY); }, [open]);

  // The administrator's password is a request variable only (useSecretMutation); the field is emptied as it is sent.
  const add = useSecretMutation({
    mutationFn: ({ own, ...input }: { own: string; email: string; full_name: string | null; role: AssignableRole; group_ids: string[]; password?: string }) => addPerson(input, own),
    onSuccess: answer => { void invalidateOrganisation(client); onAdded(answer); },
    onError: (error: Error) => toast({ title: 'Could not add the person', description: error.message, variant: 'destructive' }),
  });

  const email = form.email.trim();
  const ready = /^\S+@\S+\.\S+$/.test(email) && !!form.own && (form.way === 'link' || form.password.length >= minimum);
  const submit = () => {
    if (!ready || add.isPending) return;
    add.mutate({ own: form.own, email, full_name: form.name.trim() || null, role: form.role, group_ids: form.groups, ...(form.way === 'password' ? { password: form.password } : {}) });
    set({ own: '' });
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !add.isPending) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add person</DialogTitle>
          <DialogDescription>The account exists at once, so you can put it in groups and set up its mail before they arrive.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); submit(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="add-person-email">Email</Label>
              <Input id="add-person-email" type="email" autoComplete="off" value={form.email} onChange={event => set({ email: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-person-name">Name</Label>
              <Input id="add-person-name" autoComplete="off" value={form.name} onChange={event => set({ name: event.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-person-role">Role</Label>
            <Select value={form.role} onValueChange={role => set({ role: role as AssignableRole })}>
              <SelectTrigger id="add-person-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">Member</SelectItem>
                <SelectItem value="admin" disabled={!can(user, 'admins.manage')}>Administrator</SelectItem>
              </SelectContent>
            </Select>
            {!can(user, 'admins.manage') && <PolicyNote reason="Only the owner makes administrators." />}
          </div>
          {!!groups.data?.length && (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Groups</legend>
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {groups.data.map(group => (
                  <li key={group.id} className="flex items-center gap-3 py-1.5 touch:py-3">
                    <Checkbox id={`add-person-group-${group.id}`} checked={form.groups.includes(group.id)}
                      onCheckedChange={checked => set({ groups: checked === true ? [...form.groups, group.id] : form.groups.filter(id => id !== group.id) })} />
                    <label htmlFor={`add-person-group-${group.id}`} className="min-w-0 truncate text-sm">{group.name}</label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <fieldset>
            <legend className="mb-1 text-sm font-medium">How they get in</legend>
            <div className="-mx-2">
              <RadioRow id="add-person-link" name="add-person-way" checked={form.way === 'link'} onChange={() => set({ way: 'link', password: '' })}
                label="Setup link" description="They choose their own password. You copy the link next; it works once, for 7 days." />
              <RadioRow id="add-person-password-way" name="add-person-way" checked={form.way === 'password'} onChange={() => set({ way: 'password' })}
                label="Initial password" description="You type a password and tell them. They can change it later." />
            </div>
            {form.way === 'password' && (
              <div className="mt-2 space-y-2">
                <Label htmlFor="add-person-password">Their password</Label>
                <Input id="add-person-password" type="password" autoComplete="new-password" value={form.password} onChange={event => set({ password: event.target.value })} aria-describedby="add-person-password-hint" />
                <p id="add-person-password-hint" className="text-xs text-muted-foreground">At least {minimum} characters.</p>
              </div>
            )}
          </fieldset>
          <div className="space-y-2 border-t border-border pt-4">
            <Label htmlFor="add-person-own">Your password</Label>
            <Input id="add-person-own" type="password" autoComplete="current-password" value={form.own} onChange={event => set({ own: event.target.value })} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={add.isPending}>Cancel</Button>
            <Button type="submit" disabled={!ready || add.isPending}>{add.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Add person</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
