import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Loader2, Repeat } from 'lucide-react';
import {
  REMINDER_OPTIONS, isRemoteCalendarAccount, localDatetimeToIso, toDatetimeLocalValue,
  type CalendarAccount, type CalendarCalendar, type CalendarEvent, type RecurrenceScope,
} from '@/lib/calendar-api';
import type { EventActions } from '@/hooks/use-event-actions';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SourceEmailBlock } from '@/components/todo/SourceEmail';
import { useSourceEmailUnlink } from '@/hooks/use-source-email-unlink';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { defaultEventCalendar } from '@/lib/tasks';
import { ListChooser } from '@/components/todo/ListChooser';

/** What the dialog shows: a new event (optionally on a day) or an existing one. */
export type EventDialogTarget = { kind: 'new'; date?: Date } | { kind: 'edit'; event: CalendarEvent } | null;

type PendingScope = { kind: 'update' | 'delete'; event: CalendarEvent; recurring: boolean };

const emptyForm = { calendar_id: '', title: '', description: '', start_time: '', end_time: '', all_day: false, location: '', color: '#3b82f6', reminders: [0] as number[], attendee_emails: '' };
type Form = typeof emptyForm;

// A new event starts with the account's default reminder (Settings, General).
function formFor(target: Exclude<EventDialogTarget, null>, timezone: string | null, calendarId: string, defaultReminder: number | null): Form {
  if (target.kind === 'edit') {
    const event = target.event;
    return {
      calendar_id: event.calendar_id || '', title: event.title, description: event.description || '',
      start_time: toDatetimeLocalValue(event.start_time, timezone), end_time: toDatetimeLocalValue(event.end_time, timezone),
      all_day: event.all_day, location: event.location || '', color: event.color, reminders: event.reminders || [0],
      attendee_emails: (event.attendees || []).map(attendee => attendee.email).join(', '),
    };
  }
  const day = target.date ?? new Date();
  const start = new Date(day); start.setHours(9, 0, 0, 0);
  const end = new Date(day); end.setHours(10, 0, 0, 0);
  return { ...emptyForm, calendar_id: calendarId, start_time: format(start, "yyyy-MM-dd'T'HH:mm"), end_time: format(end, "yyyy-MM-dd'T'HH:mm"),
    reminders: defaultReminder === null ? [] : [defaultReminder] };
}

interface Props {
  target: EventDialogTarget;
  onClose: () => void;
  calendars: CalendarCalendar[];
  accounts: CalendarAccount[];
  actions: EventActions;
  timezone: string | null;
}

export function EventDialog({ target, onClose, calendars, accounts, actions, timezone }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [formTarget, setFormTarget] = useState<EventDialogTarget>(null);
  const [pendingScope, setPendingScope] = useState<PendingScope | null>(null);
  // A calendar change a server has not confirmed yet (202 'creating'): the
  // dialog says so instead of closing. Each opening is numbered, so a late
  // answer from an earlier opening changes nothing here.
  const [movePending, setMovePending] = useState<string | null>(null);
  const opening = useRef(0);
  const editing = target?.kind === 'edit' ? target.event : null;
  const defaultReminder = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('default_event_reminder') }).data;

  const calendarById = useMemo(() => new Map(calendars.map(calendar => [calendar.id, calendar])), [calendars]);
  const accountOf = (calendarId?: string | null) => {
    const calendar = calendarId ? calendarById.get(calendarId) : undefined;
    return calendar ? accounts.find(account => account.id === calendar.account_id) ?? null : null;
  };
  const isReadOnly = (calendarId?: string | null) => {
    const calendar = calendarId ? calendarById.get(calendarId) : undefined;
    return Boolean(calendar && (calendar.read_only || accountOf(calendarId)?.provider === 'ics'));
  };
  const readOnly = Boolean(editing && isReadOnly(editing.calendar_id));
  const unlink = useSourceEmailUnlink();
  // The open event is a copy from the list; once unlinked, its block goes until the list refreshes.
  const [unlinkedId, setUnlinkedId] = useState<string | null>(null);
  // A read-only event still shows its own calendar in the picker; otherwise
  // every calendar is listed, the ones that take nothing new greyed out with
  // the server's reason (contracts/tasks.ts).
  const options = readOnly && editing?.calendar_id && calendarById.has(editing.calendar_id) ? [calendarById.get(editing.calendar_id)!] : calendars;
  const isRemote = (event: CalendarEvent) => isRemoteCalendarAccount(accountOf(event.calendar_id));

  // The form is filled while rendering a new target, so the dialog never shows
  // an empty form first. Later calendar refreshes do not reset what was typed.
  if (target !== formTarget) {
    setFormTarget(target);
    setMovePending(null);
    opening.current += 1;
    // A new event starts in the calendar the server marks as the default (Settings → General, else UniHub's choice).
    if (target) setForm(formFor(target, timezone, defaultEventCalendar(calendars)?.id || '', defaultReminder === undefined ? 0 : defaultReminder));
  }

  const payload = (): Partial<CalendarEvent> & { title: string } => ({
    calendar_id: form.calendar_id || undefined,
    title: form.title.trim(),
    description: form.description || null,
    start_time: localDatetimeToIso(form.start_time, timezone),
    end_time: localDatetimeToIso(form.end_time, timezone),
    all_day: form.all_day,
    location: form.location || null,
    color: form.color,
    reminders: form.reminders,
    attendees: form.attendee_emails.split(',').map(email => email.trim().toLowerCase()).filter(Boolean)
      .map(email => ({ email, response_status: 'needsAction' as const })) as CalendarEvent['attendees'],
  });

  const save = (scope?: RecurrenceScope) => {
    if (editing) {
      const submitted = { id: editing.id, opening: opening.current, calendarName: calendarById.get(form.calendar_id)?.name ?? 'its new calendar' };
      actions.update.mutate({ id: editing.id, event: payload(), scope }, {
        onSuccess: result => {
          if (submitted.opening !== opening.current || formTarget?.kind !== 'edit' || formTarget.event.id !== submitted.id) return;
          if (result.pending === 'creating') setMovePending(submitted.calendarName); else onClose();
        },
      });
    } else actions.create.mutate(payload(), { onSuccess: onClose });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) { toast({ title: 'Add a title', variant: 'destructive' }); return; }
    if (!form.start_time || !form.end_time) { toast({ title: 'Choose a start and an end', variant: 'destructive' }); return; }
    if (!form.calendar_id) { toast({ title: 'Choose a calendar', variant: 'destructive' }); return; }
    if (new Date(form.end_time).getTime() < new Date(form.start_time).getTime()) { toast({ title: 'The end must be after the start', variant: 'destructive' }); return; }
    // Server events that repeat ask whether the change applies to this occurrence or the series.
    if (editing?.recurrence && isRemote(editing) && form.calendar_id === editing.calendar_id) {
      setPendingScope({ kind: 'update', event: editing, recurring: true });
      return;
    }
    save();
  };

  /** Local events are deleted at once; server events are confirmed, repeating ones with a scope. */
  const requestDelete = (event: CalendarEvent) => {
    if (!isRemote(event)) { actions.remove.mutate({ id: event.id }, { onSuccess: onClose }); return; }
    setPendingScope({ kind: 'delete', event, recurring: Boolean(event.recurrence) });
  };

  const runScope = (scope?: RecurrenceScope) => {
    if (!pendingScope) return;
    if (pendingScope.kind === 'update') save(scope);
    else actions.remove.mutate({ id: pendingScope.event.id, scope }, { onSuccess: onClose });
    setPendingScope(null);
  };

  const saving = actions.create.isPending || actions.update.isPending;

  return <>
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{readOnly ? 'Event' : editing ? 'Edit event' : 'New event'}</DialogTitle>
          {(readOnly || editing?.recurrence) && (
            <DialogDescription>
              {editing?.recurrence && <Repeat className="mr-1.5 inline h-3.5 w-3.5 align-[-0.125em]" aria-hidden />}
              {readOnly ? 'This calendar is read-only. Change the event where the calendar is published.'
                : 'Repeating event. Saving asks whether to change only this event or the whole series.'}
            </DialogDescription>
          )}
        </DialogHeader>
        {editing && editing.attendees.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
            <span className="mr-auto text-muted-foreground">Your reply</span>
            <Button size="sm" variant="outline" disabled={actions.rsvp.isPending} onClick={() => actions.rsvp.mutate({ id: editing.id, status: 'accepted' })}>Accept</Button>
            <Button size="sm" variant="outline" disabled={actions.rsvp.isPending} onClick={() => actions.rsvp.mutate({ id: editing.id, status: 'tentative' })}>Maybe</Button>
            <Button size="sm" variant="outline" disabled={actions.rsvp.isPending} onClick={() => actions.rsvp.mutate({ id: editing.id, status: 'declined' })}>Decline</Button>
          </div>
        )}
        {editing?.source_email && unlinkedId !== editing.id && (
          <SourceEmailBlock source={editing.source_email} timezone={timezone} unlinking={unlink.isPending}
            onUnlink={readOnly ? undefined : () => unlink.mutate(editing, { onSuccess: () => setUnlinkedId(editing.id) })} />
        )}
        {movePending ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm" role="status">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              Moving… UniHub finishes this in the background and the event shows in {movePending} once the calendar server has stored it. Until then it stays where it was.
            </p>
            <DialogFooter>
              <Button type="button" onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={readOnly} className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="event-title">Title</Label>
              <Input id="event-title" autoFocus={!editing} value={form.title} onChange={event => setForm(prev => ({ ...prev, title: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-calendar">Calendar</Label>
              <ListChooser id="event-calendar" calendars={options} value={form.calendar_id} placeholder="Choose a calendar"
                onChange={value => setForm(prev => ({ ...prev, calendar_id: value }))} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event-start">Start</Label>
                <Input id="event-start" type="datetime-local" value={form.start_time} onChange={event => setForm(prev => ({ ...prev, start_time: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-end">End</Label>
                <Input id="event-end" type="datetime-local" value={form.end_time} onChange={event => setForm(prev => ({ ...prev, end_time: event.target.value }))} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="event-all-day" className="font-normal">All day</Label>
              <Switch id="event-all-day" checked={form.all_day} onCheckedChange={checked => setForm(prev => ({ ...prev, all_day: checked }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-location">Location</Label>
              <Input id="event-location" value={form.location} onChange={event => setForm(prev => ({ ...prev, location: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-description">Notes</Label>
              <Textarea id="event-description" rows={3} value={form.description} onChange={event => setForm(prev => ({ ...prev, description: event.target.value }))} />
            </div>
            {/* Attendees are kept in UniHub only; they are not sent to calendar servers. */}
            {!isRemoteCalendarAccount(accountOf(form.calendar_id)) && (
              <div className="space-y-2">
                <Label htmlFor="event-attendees">Attendees</Label>
                <Input id="event-attendees" placeholder="alice@example.com, bob@example.com" value={form.attendee_emails}
                  onChange={event => setForm(prev => ({ ...prev, attendee_emails: event.target.value }))} />
                <p className="text-xs text-muted-foreground">Separate addresses with commas. Kept in UniHub; no invitation is sent.</p>
              </div>
            )}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Reminders (up to 3)</legend>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {REMINDER_OPTIONS.map(option => (
                  <label key={option.value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--accent))]" checked={form.reminders.includes(option.value)}
                      disabled={!form.reminders.includes(option.value) && form.reminders.length >= 3}
                      onChange={event => setForm(prev => ({ ...prev, reminders: event.target.checked
                        ? Array.from(new Set([...prev.reminders, option.value])).slice(0, 3)
                        : prev.reminders.filter(value => value !== option.value) }))} />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>
          <DialogFooter className="gap-2 sm:gap-0">
            {editing && !readOnly && (
              <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={actions.remove.isPending}
                onClick={() => requestDelete(editing)}>Delete</Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
            {!readOnly && (
              <Button type="submit" disabled={saving}>{saving && <Loader2 aria-hidden="true" className="animate-spin" />}{editing ? 'Save' : 'Create'}</Button>
            )}
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>

    <AlertDialog open={pendingScope !== null} onOpenChange={open => { if (!open) setPendingScope(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pendingScope?.kind === 'update' ? 'Change repeating event' : pendingScope?.recurring ? 'Delete repeating event' : 'Delete event'}</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingScope?.kind === 'update'
              ? 'Apply the change to this event only, or to every event in the series? Changing the series time also resets ToDo progress of its events.'
              : pendingScope?.recurring
                ? 'Delete only this event, or every event in the series? It is also deleted on the calendar server.'
                : `Delete “${pendingScope?.event.title ?? ''}”? It is also deleted on the calendar server.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {pendingScope?.recurring ? <>
            <AlertDialogAction className={buttonVariants({ variant: 'outline' })} onClick={() => runScope('occurrence')}>This event</AlertDialogAction>
            <AlertDialogAction onClick={() => runScope('series')}>All events</AlertDialogAction>
          </> : <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => runScope()}>Delete</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
