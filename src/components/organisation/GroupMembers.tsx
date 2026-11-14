import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, UserPlus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { invalidateOrganisation, useGroupCandidates } from '@/hooks/use-organisation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { setGroupManager } from '@/lib/admin-api';
import { addGroupMembers, removeGroupMember, type GroupCandidate, type GroupMember, type GroupResponse } from '@/lib/groups-api';
import { can } from '@/lib/permissions';
import { ROW_LINK, formatDay } from '@/components/admin/person-words';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// A group's members, for whoever may see them: an administrator, or the
// group's manager, who adds and removes members and nothing more. Someone
// who is only a member sees the managers, to know whom to ask. The server
// checks every change again (404 for a group out of sight, 403 for one the
// person may not manage), so a manager demoted meanwhile is refused there.

const MANAGER_REMOVAL_REASON = 'Only an administrator removes a manager.';
const name = (person: Pick<GroupMember, 'full_name' | 'email'>) => person.full_name || person.email;

/** People to add: searched by name or address, ticked, and added together. */
function AddMembersDialog({ groupId, groupName, open, onClose }: { groupId: string; groupName: string; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  // Ticked people stay ticked while the search changes.
  const [picked, setPicked] = useState<GroupCandidate[]>([]);
  useEffect(() => { if (!open) { setQuery(''); setPicked([]); } }, [open]);
  const candidates = useGroupCandidates(groupId, query, open);
  const add = useSessionMutation({
    mutationFn: (people: GroupCandidate[]) => addGroupMembers(groupId, people.map(person => person.id)),
    onSuccess: (_answer, people) => { toast({ title: people.length === 1 ? `${name(people[0])} added to ${groupName}` : `${people.length} people added to ${groupName}` }); onClose(); },
    // A refusal is the server's: a combination of rules that cannot hold names the person.
    onError: (error: Error) => toast({ title: 'Could not add them', description: error.message, variant: 'destructive' }),
    onSettled: () => invalidateOrganisation(client),
  });
  const found = candidates.data ?? [];
  const listed = [...picked.filter(person => !found.some(entry => entry.id === person.id)), ...found];
  const toggle = (person: GroupCandidate, on: boolean) => setPicked(current => (on ? [...current.filter(entry => entry.id !== person.id), person] : current.filter(entry => entry.id !== person.id)));
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !add.isPending) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Add people to {groupName}</DialogTitle>
          <DialogDescription>The group's rules apply to them as soon as they are added.</DialogDescription>
        </DialogHeader>
        <div className="shrink-0 space-y-2">
          <Label htmlFor="group-candidates-search">Name or email</Label>
          <Input id="group-candidates-search" type="search" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="min-h-24 flex-1 overflow-y-auto overscroll-contain">
          {candidates.error ? <p role="alert" className="py-3 text-sm text-destructive">{candidates.error.message}</p>
            : listed.length === 0 && !candidates.isLoading ? <p className="py-3 text-sm text-muted-foreground">{query.trim() ? 'Nobody active matches who is not in the group already.' : 'Everyone active is in this group already.'}</p>
            : (
              <ul aria-label="People to add" className="divide-y divide-border">
                {listed.map(person => (
                  <li key={person.id} className="flex items-center gap-3 py-2 touch:py-3">
                    <Checkbox id={`candidate-${person.id}`} checked={picked.some(entry => entry.id === person.id)} onCheckedChange={checked => toggle(person, checked === true)} />
                    <label htmlFor={`candidate-${person.id}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block truncate text-sm">{name(person)}</span>
                      {person.full_name && <span className="block truncate text-xs text-muted-foreground">{person.email}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          {/* The ticked people stay in the list while a new search runs. */}
          {candidates.isLoading && <p role="status" className="py-3 text-sm text-muted-foreground">Searching…</p>}
        </div>
        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={onClose} disabled={add.isPending}>Cancel</Button>
          <Button type="button" disabled={picked.length === 0 || add.isPending} onClick={() => add.mutate(picked)}>
            {add.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {picked.length > 1 ? `Add ${picked.length} people` : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GroupMembers({ groupId, data, personHref }: {
  groupId: string; data: GroupResponse;
  /** Server › Groups links each member to their person page; a manager's view has no such page. */
  personHref?: (userId: string) => string;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState<GroupMember | null>(null);
  const setManagers = can(user, 'groups.manage');
  const { group, can_manage: manage, members } = data;
  const change = useSessionMutation({
    mutationFn: ({ member, manager }: { member: GroupMember; manager?: boolean }) => manager === undefined ? removeGroupMember(groupId, member.id) : setGroupManager(groupId, member.id, manager),
    onSuccess: (_answer, { member, manager }) => {
      setLeaving(null);
      toast({ title: manager === undefined ? `${name(member)} removed from ${group.name}` : manager ? `${name(member)} manages ${group.name} now` : `${name(member)} no longer manages ${group.name}` });
    },
    onError: (error: Error) => toast({ title: 'Could not change the group', description: error.message, variant: 'destructive' }),
    onSettled: () => invalidateOrganisation(client),
  });

  if (!manage) {
    return (
      <SettingsSection title="Managers" description="A manager adds and removes this group's members. Ask one of them, or an administrator.">
        {members.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">This group has no manager. An administrator looks after it.</p></SettingsBlock>
          : members.map(member => <SettingsRow key={member.id} label={name(member)} description={member.full_name ? member.email : undefined} />)}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Members" description={`${members.length} ${members.length === 1 ? 'person' : 'people'}. A manager adds and removes members and renames the group.`}
      action={<Button size="sm" variant="outline" onClick={() => setAdding(true)}><UserPlus aria-hidden="true" />Add people</Button>}>
      {members.length === 0 && <SettingsBlock><p className="text-sm text-muted-foreground">Nobody is in this group yet. Its rules apply to nobody until you add people.</p></SettingsBlock>}
      {members.map(member => {
        const manager = member.role === 'manager';
        // A manager's membership ends only through an administrator.
        const lock = manager && !setManagers ? MANAGER_REMOVAL_REASON : undefined;
        return (
          <SettingsRow key={member.id} lock={lock}
            label={personHref ? <Link to={personHref(member.id)} className={ROW_LINK}>{name(member)}</Link> : name(member)}
            description={[member.full_name ? member.email : null, manager && !setManagers ? 'Manager' : null, `added ${formatDay(member.added_at)}`].filter(Boolean).join(', ')}>
            {setManagers && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Manager
                <Switch aria-label={`${name(member)}: manager`} checked={manager} disabled={change.isPending} onCheckedChange={next => change.mutate({ member, manager: next })} />
              </label>
            )}
            <Button variant="outline" size="sm" disabled={!!lock || change.isPending} aria-label={`Remove ${name(member)}`} onClick={() => setLeaving(member)}>Remove</Button>
          </SettingsRow>
        );
      })}
      <AddMembersDialog groupId={groupId} groupName={group.name} open={adding} onClose={() => setAdding(false)} />
      <AlertDialog open={leaving !== null} onOpenChange={open => { if (!open && !change.isPending) setLeaving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {leaving ? name(leaving) : 'this person'} from {group.name}?</AlertDialogTitle>
            <AlertDialogDescription>The group's rules stop applying to them at once. Their account and data are not touched, and they can be added again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={change.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={change.isPending} onClick={event => { event.preventDefault(); if (leaving) change.mutate({ member: leaving }); }}>
              {change.isPending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
