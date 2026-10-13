import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Mail, Paperclip, Plus } from 'lucide-react';
import { calendarApi, calendarQueryKeys, EVENT_COLOR_OPTIONS, formatEventTime, invalidateCalendarQueries, localDatetimeToIso, type CalendarCalendar, type CalendarEvent } from '@/lib/calendar-api';
import { quickDays, rememberTaskList, rememberedTaskList, taskLists, taskTimes, taskTitleFromEmail, type TaskSource } from '@/lib/email-tasks';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chips';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type When = 'none' | 'today' | 'tomorrow' | 'pick';
const NEW_LIST = 'new';

interface Props {
  /** The email (or draft) to make a task from; null closes the dialog. */
  email: TaskSource | null;
  onClose: () => void;
  timezone: string | null;
  /** Called with the new task, so the open message can list it at once. */
  onCreated?: (task: CalendarEvent) => void;
}

const emptyForm = { title: '', list: '', newList: '', when: 'none' as When, day: '', time: '', remind: true, note: '' };



/**
 * Makes a task from an email: a title taken from the subject, the list it goes
 * to (or a new one), and optionally a day with a reminder. The task keeps the
 * email, so the ToDo and Calendar pages lead back to it.
 */
export function EmailTaskDialog({ email, onClose, timezone, onCreated }: Props) {
  const client = useQueryClient();
  const { toast } = useToast();
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal), enabled: !!email });
  const lists = taskLists(calendars.data ?? []);
  const [form, setForm] = useState(emptyForm);
  // Filled while rendering a newly opened email, so the dialog never shows an empty form first.
  const [formEmail, setFormEmail] = useState<TaskSource | null>(null);
  if (email !== formEmail) {
    setFormEmail(email);
    if (email) setForm({ ...emptyForm, title: taskTitleFromEmail(email), list: rememberedTaskList(lists) });
  }
  // Lists can arrive after the dialog opened.
  if (email && !form.list && lists.length && form.newList === '' ) {
    const remembered = rememberedTaskList(lists);
    if (remembered) setForm(prev => ({ ...prev, list: remembered }));
  }
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(prev => ({ ...prev, [key]: value }));
  const days = quickDays(timezone);
  const dated = form.when !== 'none';
  const chosenDay = form.when === 'today' ? days.today : form.when === 'tomorrow' ? days.tomorrow : form.when === 'pick' ? form.day : '';
  const localAccount = lists[0]?.account_id;

  const createList = useMutation({
    mutationFn: (name: string) => calendarApi.createCalendar({ account_id: localAccount!, name, color: EVENT_COLOR_OPTIONS[lists.length % EVENT_COLOR_OPTIONS.length].value }),
    onSuccess: (list: CalendarCalendar) => {
      client.setQueryData<CalendarCalendar[]>(calendarQueryKeys.calendars, previous => [...(previous ?? []), { ...list, account_provider: 'local' }]);
      void client.invalidateQueries({ queryKey: calendarQueryKeys.calendars });
      setForm(prev => ({ ...prev, list: list.id, newList: '' }));
    },
    onError: (error: Error) => toast({ title: 'Could not create the list', description: error.message, variant: 'destructive' }),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!email) throw new Error('No email');
      const times = chosenDay ? taskTimes(chosenDay, form.time) : null;
      return calendarApi.createEvent({
        title: form.title.trim(),
        description: form.note.trim() || null,
        calendar_id: form.list || undefined,
        color: lists.find(list => list.id === form.list)?.color || '#3b82f6',
        source_email_id: email.id,
        ...(times
          ? { start_time: localDatetimeToIso(times.start, timezone), end_time: localDatetimeToIso(times.end, timezone), all_day: times.allDay, is_todo_only: false, reminders: form.remind ? [0] : null }
          : { is_todo_only: true, reminders: null }),
      });
    },
    onSuccess: task => {
      const list = lists.find(entry => entry.id === task.calendar_id);
      if (task.calendar_id) rememberTaskList(task.calendar_id);
      void invalidateCalendarQueries(client);
      void client.invalidateQueries({ queryKey: ['emails'] });
      toast({ title: list ? `Task added to ${list.name}` : 'Task added' });
      onCreated?.(task);
      onClose();
    },
    onError: (error: Error) => toast({ title: 'Could not add the task', description: error.message, variant: 'destructive' }),
  });

  const submitNewList = () => {
    const name = form.newList.trim();
    if (name && localAccount && !createList.isPending) createList.mutate(name);
  };
  const newListKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); submitNewList(); }
    if (event.key === 'Escape') { event.stopPropagation(); set('list', rememberedTaskList(lists)); set('newList', ''); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) { toast({ title: 'Add a title', variant: 'destructive' }); return; }
    if (form.list === NEW_LIST) { submitNewList(); return; }
    if (form.when === 'pick' && !form.day) { toast({ title: 'Choose a day', variant: 'destructive' }); return; }
    create.mutate();
  };

  const received = email ? formatEventTime(email.received_at, 'd MMM yyyy', timezone) : '';
  const attachments = email?.attachments?.length ?? 0;

  return (
    <Dialog open={!!email} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
        </DialogHeader>
        {email && (
          <form onSubmit={submit} className="space-y-5">
            <div className="flex items-start gap-3 rounded-md bg-muted/50 px-3 py-2.5 text-sm" aria-label="From email">
              <Mail aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{email.subject || '(No subject)'}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {email.is_draft ? 'Draft' : email.from_name || email.from_address} · {received}
                  {attachments > 0 && <span className="ml-2 inline-flex items-center gap-1"><Paperclip aria-hidden="true" className="h-3 w-3" />{attachments}</span>}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email-task-title">Title</Label>
              <Input id="email-task-title" autoFocus required value={form.title} onChange={event => set('title', event.target.value)} />
            </div>

            <div className="space-y-2">
              <Label id="email-task-list-label">List</Label>
              <div role="radiogroup" aria-labelledby="email-task-list-label" className="flex flex-wrap gap-2">
                {lists.map(list => (
                  <Chip key={list.id} selected={form.list === list.id} color={list.color} onSelect={() => { set('list', list.id); set('newList', ''); }}>{list.name}</Chip>
                ))}
                {localAccount && (
                  <Chip selected={form.list === NEW_LIST} onSelect={() => set('list', NEW_LIST)} icon={Plus} className="border-dashed">New list</Chip>
                )}
              </div>
              {form.list === NEW_LIST && (
                <div className="flex gap-2">
                  <Input autoFocus value={form.newList} placeholder="Name, for example Payments" aria-label="New list name"
                    onChange={event => set('newList', event.target.value)} onKeyDown={newListKey} />
                  <Button type="button" variant="outline" disabled={!form.newList.trim() || createList.isPending} onClick={submitNewList}>
                    {createList.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Create
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label id="email-task-when-label">When</Label>
              <div role="radiogroup" aria-labelledby="email-task-when-label" className="flex flex-wrap gap-2">
                <Chip selected={form.when === 'none'} onSelect={() => set('when', 'none')}>No date</Chip>
                <Chip selected={form.when === 'today'} onSelect={() => set('when', 'today')}>Today</Chip>
                <Chip selected={form.when === 'tomorrow'} onSelect={() => set('when', 'tomorrow')}>Tomorrow</Chip>
                <Chip selected={form.when === 'pick'} onSelect={() => set('when', 'pick')}>Choose a day</Chip>
              </div>
              {dated && (
                <div className="grid grid-cols-2 gap-2">
                  {form.when === 'pick'
                    ? <Input type="date" aria-label="Day" required value={form.day} min={days.today} onChange={event => set('day', event.target.value)} />
                    : <span className="flex h-10 items-center px-1 text-sm text-muted-foreground">{formatEventTime(`${chosenDay}T12:00:00`, 'EEEE, d MMM', null)}</span>}
                  <Input type="time" aria-label="Time (optional)" value={form.time} onChange={event => set('time', event.target.value)} />
                </div>
              )}
              {dated && (
                <div className="flex items-center justify-between gap-4 pt-1">
                  <Label htmlFor="email-task-remind" className="font-normal">Remind me{form.time ? '' : ' in the morning'}</Label>
                  <Switch id="email-task-remind" checked={form.remind} onCheckedChange={checked => set('remind', checked)} />
                </div>
              )}
              <p className="text-xs text-muted-foreground">{dated ? 'Shows in the calendar on that day.' : 'Without a day it waits under No date.'}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email-task-note">Note</Label>
              <Textarea id="email-task-note" rows={2} value={form.note} placeholder="Optional" onChange={event => set('note', event.target.value)} />
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || createList.isPending}>
                {create.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Add task
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
