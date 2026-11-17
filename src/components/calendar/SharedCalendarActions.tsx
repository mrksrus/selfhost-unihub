import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { usePeople } from '@/hooks/use-organisation';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { invalidateCalendarQueries } from '@/lib/calendar-api';
import { calendarSharesApi, type SharedCalendarSummary } from '@/lib/calendar-shares-api';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { personTarget } from '@/components/admin/person-words';
import { CalendarShareDialog } from '@/components/calendar/CalendarShareDialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';

// What a group's manager and an administrator do to a calendar no person
// owns (new, name and colour, share, delete), and an administrator to any
// calendar of Server › Calendars (hand over at once, archive): one
// implementation of each change and of its confirmation, for the group page
// and Server › Calendars alike. The server decides who may.

/** A calendar by name: a row of the Calendar panel's list or of Server › Calendars. */
export type SharedCalendar = Pick<SharedCalendarSummary, 'id' | 'name' | 'color'> & Partial<Pick<SharedCalendarSummary, 'owner_kind' | 'owner' | 'archived_at'>>;
type Open = { action: 'edit' | 'share' | 'delete' | 'hand-over' | 'archive'; calendar: SharedCalendar }
  | { action: 'new'; calendar?: undefined; groupId: string | null; groups?: readonly { id: string; name: string }[] };

const count = (number: number, one: string, many: string) => `${number} ${number === 1 ? one : many}`;
/** "Group Support, 3 shares, 12 events, archived", as administrators see a calendar. */
export const calendarMeta = (calendar: SharedCalendarSummary) => [
  calendar.owner_kind === 'group' ? `Group ${calendar.group?.name ?? ''}` : calendar.owner_kind === 'organisation' ? 'Organisation' : calendar.owner?.full_name || calendar.owner?.email,
  count(calendar.share_count, 'share', 'shares'), count(calendar.event_count, 'event', 'events'), calendar.archived_at && 'archived',
].filter(Boolean).join(', ');

/**
 * Where a calendar goes: an organisation calendar or an active person's;
 * `first` and `last` are the choices around those (leave it, the bin).
 * shortcut: every active person in one list, fine for an organisation of some hundreds; a search when it grows.
 */
export function NewOwnerSelect({ id, value, onChange, first = [], last = [], except, organisation = true }: {
  id: string; value: string; onChange: (to: string) => void; first?: [string, string][]; last?: [string, string][]; except?: string | null; organisation?: boolean;
}) {
  const people = (usePeople().data ?? []).filter(person => person.is_active && person.id !== except);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue placeholder="Choose what happens to it" /></SelectTrigger>
      <SelectContent>
        {first.map(([choice, label]) => <SelectItem key={choice} value={choice}>{label}</SelectItem>)}
        {organisation && <SelectItem value="organisation">Make it an organisation calendar</SelectItem>}
        <SelectGroup>
          <SelectLabel>Hand it to</SelectLabel>
          {people.map(person => <SelectItem key={person.id} value={person.id}>{personTarget(person)}</SelectItem>)}
        </SelectGroup>
        {last.map(([choice, label]) => <SelectItem key={choice} value={choice}>{label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function useSharedCalendarActions() {
  const client = useQueryClient();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<Open | null>(null);
  const [form, setForm] = useState({ name: '', color: '#3b82f6', groupId: '' });
  const [to, setTo] = useState('');
  const open = (next: Open) => {
    setForm(next.action === 'new' ? { name: '', color: '#3b82f6', groupId: next.groupId ?? '' } : { name: next.calendar.name, color: next.calendar.color, groupId: '' });
    setTo('');
    setDialog(next);
  };
  const close = () => setDialog(null);
  const done = (title: string, description?: string) => { void invalidateCalendarQueries(client); close(); toast({ title, description }); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });
  const calendar = dialog?.calendar;
  const archived = !!calendar?.archived_at;

  const save = useSessionMutation({
    mutationFn: () => calendar ? calendarSharesApi.update(calendar.id, { name: form.name.trim(), color: form.color })
      : calendarSharesApi.create({ name: form.name.trim(), color: form.color, group_id: form.groupId || null }),
    onSuccess: saved => done(calendar ? `${saved.name} saved` : `${saved.name} created`,
      calendar ? undefined : saved.group ? `Every member of ${saved.group.name} finds it in their Calendar panel.` : 'Share it with people or groups next.'),
    onError: failed('Could not save the calendar'),
  });
  const remove = useSessionMutation({
    mutationFn: (target: SharedCalendar) => calendarSharesApi.remove(target.id),
    onSuccess: (_answer, target) => done(`${target.name} deleted`, 'An administrator can restore it under Server › Calendars.'),
    onError: failed('Could not delete the calendar'),
  });
  // The administrator's two changes carry their password.
  const change = useSecretMutation({
    mutationFn: ({ target, password, handTo }: { target: SharedCalendar; password: string; handTo: string | null }) =>
      handTo ? calendarSharesApi.adminHandOver(target.id, handTo, password) : calendarSharesApi.adminArchive(target.id, !target.archived_at, password),
    onSuccess: (_answer, { target, handTo }) => done(handTo ? `${target.name} handed over` : target.archived_at ? `${target.name} can be changed again` : `${target.name} archived`,
      handTo && target.owner ? 'Its former owner was told and can still edit it.' : undefined),
    onError: failed('Could not change the calendar'),
  });

  /** One calendar as a row: its colour, name and numbers, and its actions in a menu. */
  const row = (target: SharedCalendar, meta: ReactNode, may: { manage?: boolean; admin?: boolean }) => (
    <li key={target.id} className="flex items-center gap-3 py-3">
      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: target.color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{target.name}</span>
        {meta && <span className="block truncate text-sm text-muted-foreground">{meta}</span>}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${target.name}`}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {may.manage && <DropdownMenuItem onClick={() => open({ action: 'edit', calendar: target })}>Name and color</DropdownMenuItem>}
          {may.manage && <DropdownMenuItem onClick={() => open({ action: 'share', calendar: target })}>Share</DropdownMenuItem>}
          {may.admin && <DropdownMenuItem onClick={() => open({ action: 'hand-over', calendar: target })}>Hand over…</DropdownMenuItem>}
          {may.admin && <DropdownMenuItem onClick={() => open({ action: 'archive', calendar: target })}>{target.archived_at ? 'Unarchive' : 'Archive'}</DropdownMenuItem>}
          {may.manage && <><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => open({ action: 'delete', calendar: target })}>Delete</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );

  const naming = dialog?.action === 'new' || dialog?.action === 'edit';
  const dialogs = (
    <>
      <Dialog open={naming} onOpenChange={next => { if (!next && !save.isPending) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{calendar ? `Name and color of ${calendar.name}` : 'New calendar'}</DialogTitle>
            <DialogDescription>
              {calendar ? 'For everyone who has this calendar. Each person can still pick a color of their own.'
                : form.groupId ? 'A calendar of the group. Every member sees it and adds subtasks to its events; the group\'s managers manage it and can share it further.'
                : 'A calendar of the organisation. Nobody sees it until you share it with people or groups.'}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (form.name.trim() && !save.isPending) save.mutate(); }}>
            <div className="space-y-2">
              <Label htmlFor="shared-calendar-name">Name</Label>
              <Input id="shared-calendar-name" value={form.name} maxLength={100} autoComplete="off" onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))} />
            </div>
            {dialog?.action === 'new' && dialog.groups && (
              <div className="space-y-2">
                <Label htmlFor="shared-calendar-for">For</Label>
                <Select value={form.groupId || 'organisation'} onValueChange={next => setForm(prev => ({ ...prev, groupId: next === 'organisation' ? '' : next }))}>
                  <SelectTrigger id="shared-calendar-for"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="organisation">The organisation</SelectItem>
                    {dialog.groups.map(group => <SelectItem key={group.id} value={group.id}>The group {group.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="shared-calendar-color" className="font-normal">Color</Label>
              <input id="shared-calendar-color" type="color" className="h-8 w-14 cursor-pointer rounded border border-input bg-transparent touch:h-10" value={form.color}
                onChange={event => setForm(prev => ({ ...prev, color: event.target.value }))} />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={close} disabled={save.isPending}>Cancel</Button>
              <Button type="submit" disabled={!form.name.trim() || save.isPending}>{save.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}{calendar ? 'Save' : 'Create calendar'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {calendar && <CalendarShareDialog calendar={calendar} open={dialog.action === 'share'} onClose={close} />}
      <AlertDialog open={dialog?.action === 'delete'} onOpenChange={next => { if (!next) close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {calendar?.name}?</AlertDialogTitle>
            <AlertDialogDescription>It disappears at once for everyone, with its events and tasks. An administrator can restore it under Server › Calendars until the bin's time is over.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (calendar) remove.mutate(calendar); }}>Delete calendar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PasswordConfirmDialog open={dialog?.action === 'hand-over' || dialog?.action === 'archive'} onClose={close} pending={change.isPending}
        title={dialog?.action === 'hand-over' ? `Hand over ${calendar?.name}?` : `${archived ? 'Unarchive' : 'Archive'} ${calendar?.name}?`}
        description={dialog?.action === 'hand-over' ? 'It changes hands at once, with all its events. Everyone it is shared with keeps it; a person who owned it is told and can still edit it.'
          : archived ? 'Everyone who could change it before can change it again.'
          : 'Nobody can change an archived calendar, its owner included: no event, task, subtask or share. Everyone still sees it. Its owner is told.'}
        actionLabel={dialog?.action === 'hand-over' ? 'Hand over' : archived ? 'Unarchive' : 'Archive'} confirmDisabled={dialog?.action === 'hand-over' && !to}
        onConfirm={password => { if (calendar) change.mutate({ target: calendar, password, handTo: dialog.action === 'hand-over' ? to : null }); }}>
        {dialog?.action === 'hand-over' && (
          <div className="space-y-2">
            <Label htmlFor="calendar-new-owner">New owner</Label>
            <NewOwnerSelect id="calendar-new-owner" value={to} onChange={setTo} except={calendar?.owner?.id} organisation={calendar?.owner_kind !== 'organisation'} />
          </div>
        )}
      </PasswordConfirmDialog>
    </>
  );

  return { open, row, dialogs };
}
