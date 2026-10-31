import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { EVENT_COLOR_OPTIONS, REMINDER_OPTIONS, isWriteTimeout, localDatetimeToIso, toDatetimeLocalValue, type CalendarCalendar, type CalendarEvent } from '@/lib/calendar-api';
import { defaultTaskList, listRefusal } from '@/lib/tasks';
import type { TaskActions } from '@/hooks/use-task-actions';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ListChooser } from '@/components/todo/ListChooser';
import { cn } from '@/lib/utils';

function ColorChoice({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Color</legend>
      <div className="flex flex-wrap gap-2">
        {EVENT_COLOR_OPTIONS.map(color => (
          <button key={color.value} type="button" aria-label={color.label} aria-pressed={value === color.value} onClick={() => onChange(color.value)}
            className={cn('h-8 w-8 rounded-full border-2 touch:h-10 touch:w-10 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              value === color.value ? 'scale-110 border-foreground' : 'border-transparent')}
            style={{ backgroundColor: color.value }} />
        ))}
      </div>
    </fieldset>
  );
}

const emptyNewTask = { title: '', description: '', scheduled: false, start_time: '', end_time: '', location: '', color: '#3b82f6', calendar_id: '' };

export function NewTaskDialog({ open, onOpenChange, actions, timezone, calendars = [] }: {
  open: boolean; onOpenChange: (open: boolean) => void; actions: TaskActions; timezone: string | null;
  /** The person's lists and calendars, for the chooser; the server marks the default. */
  calendars?: CalendarCalendar[];
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(emptyNewTask);
  // Why the chosen list changed under the person: it went away or stopped taking the task.
  const [listNote, setListNote] = useState<string | null>(null);
  const defaultList = defaultTaskList(calendars);
  // The form is set when the dialog opens, never when the lists are fetched
  // again (another device may add a list while a title is being typed).
  const latestLists = useRef(calendars);
  latestLists.current = calendars;
  useEffect(() => {
    if (!open) return;
    setForm({ ...emptyNewTask, calendar_id: defaultTaskList(latestLists.current)?.id ?? '' });
    setListNote(null);
  }, [open]);
  const chosen = calendars.find(calendar => calendar.id === form.calendar_id);
  const refusal = chosen ? listRefusal(chosen, { undated: !form.scheduled }) : null;
  // Lists can arrive after the dialog opened; a chosen list that is gone or
  // blocked since gives way to the default, with a note, and nothing else changes.
  useEffect(() => {
    if (!open || calendars.length === 0) return;
    if (!form.calendar_id) { if (defaultList) setForm(prev => ({ ...prev, calendar_id: defaultList.id })); return; }
    const current = calendars.find(calendar => calendar.id === form.calendar_id);
    const blocked = current ? listRefusal(current, { undated: !form.scheduled }) : null;
    if (current && !blocked) return;
    const fallback = defaultList && defaultList.id !== form.calendar_id ? defaultList : calendars.find(calendar => !listRefusal(calendar, { undated: !form.scheduled }));
    if (!fallback) return;
    setForm(prev => ({ ...prev, calendar_id: fallback.id }));
    setListNote(current ? `${current.name} no longer takes this task (${blocked!.toLowerCase()}); ${fallback.name} is chosen instead.` : `The list chosen before is no longer available; ${fallback.name} is chosen instead.`);
  }, [open, calendars, defaultList, form.calendar_id, form.scheduled]);
  // Taking the time away from a task in a server calendar sends it back to the default list.
  const setScheduled = (scheduled: boolean) => setForm(prev => {
    const current = calendars.find(calendar => calendar.id === prev.calendar_id);
    const keep = !current || !listRefusal(current, { undated: !scheduled });
    return { ...prev, scheduled, calendar_id: keep ? prev.calendar_id : defaultList?.id ?? '' };
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) return;
    if (form.scheduled && (!form.start_time || !form.end_time)) {
      toast({ title: 'Choose a start and an end', description: 'A scheduled task needs both.', variant: 'destructive' });
      return;
    }
    if (refusal) { toast({ title: 'Choose another list', description: `${chosen?.name}: ${refusal.toLowerCase()}.`, variant: 'destructive' }); return; }
    actions.create.mutate({
      title: form.title.trim(),
      description: form.description || null,
      location: form.location || null,
      color: form.color,
      reminders: form.scheduled ? [0] : null,
      ...(form.calendar_id ? { calendar_id: form.calendar_id } : {}),
      ...(form.scheduled
        ? { start_time: localDatetimeToIso(form.start_time, timezone), end_time: localDatetimeToIso(form.end_time, timezone), is_todo_only: false }
        : { is_todo_only: true }),
    }, { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Without a date it waits under No date.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" autoFocus required value={form.title} placeholder="What needs to be done?"
              onChange={event => setForm(prev => ({ ...prev, title: event.target.value }))} />
          </div>
          {calendars.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="task-list">List</Label>
              <ListChooser id="task-list" calendars={calendars} value={form.calendar_id} undated={!form.scheduled} forTask
                onChange={calendar_id => { setForm(prev => ({ ...prev, calendar_id })); setListNote(null); }} />
              {listNote && <p role="status" className="text-xs text-warning">{listNote}</p>}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="task-description">Notes</Label>
            <Textarea id="task-description" rows={3} value={form.description}
              onChange={event => setForm(prev => ({ ...prev, description: event.target.value }))} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="task-scheduled" className="font-normal">Give it a time in the calendar</Label>
            <Switch id="task-scheduled" checked={form.scheduled} onCheckedChange={setScheduled} />
          </div>
          {form.scheduled && <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="task-start">Start</Label>
                <Input id="task-start" type="datetime-local" required value={form.start_time} onChange={event => setForm(prev => ({ ...prev, start_time: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="task-end">End</Label>
                <Input id="task-end" type="datetime-local" required value={form.end_time} onChange={event => setForm(prev => ({ ...prev, end_time: event.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-location">Location</Label>
              <Input id="task-location" value={form.location} placeholder="Optional" onChange={event => setForm(prev => ({ ...prev, location: event.target.value }))} />
            </div>
          </>}
          <ColorChoice value={form.color} onChange={color => setForm(prev => ({ ...prev, color }))} />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={actions.create.isPending}>
              {actions.create.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditTaskDialog({ task, onClose, actions, timezone }: {
  task: CalendarEvent | null; onClose: () => void; actions: TaskActions; timezone: string | null;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({ title: '', description: '', start_time: '', end_time: '', all_day: false, location: '', color: '#3b82f6', reminders: [0] as number[] });
  // Filled while rendering a newly opened task, so the dialog never shows an empty form first.
  const [formTask, setFormTask] = useState<CalendarEvent | null>(null);
  if (task !== formTask) {
    setFormTask(task);
    if (task) setForm({
      title: task.title, description: task.description || '', all_day: task.all_day, location: task.location || '', color: task.color,
      start_time: toDatetimeLocalValue(task.start_time, timezone), end_time: toDatetimeLocalValue(task.end_time, timezone), reminders: task.reminders || [0],
    });
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!task) return;
    if (!form.title.trim()) { toast({ title: 'Add a title', variant: 'destructive' }); return; }
    actions.update.mutate({ id: task.id, update: {
      title: form.title.trim(), description: form.description || null, all_day: form.all_day, location: form.location || null,
      color: form.color, reminders: form.reminders,
      start_time: localDatetimeToIso(form.start_time, timezone), end_time: localDatetimeToIso(form.end_time, timezone),
    } }, { onSuccess: onClose });
  };
  return (
    <Dialog open={!!task} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>Saving marks the task as changed.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-task-title">Title</Label>
            <Input id="edit-task-title" required value={form.title} onChange={event => setForm(prev => ({ ...prev, title: event.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-task-description">Notes</Label>
            <Textarea id="edit-task-description" rows={3} value={form.description} onChange={event => setForm(prev => ({ ...prev, description: event.target.value }))} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="edit-task-start">Start</Label>
              <Input id="edit-task-start" type="datetime-local" required value={form.start_time} onChange={event => setForm(prev => ({ ...prev, start_time: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-task-end">End</Label>
              <Input id="edit-task-end" type="datetime-local" required value={form.end_time} onChange={event => setForm(prev => ({ ...prev, end_time: event.target.value }))} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="edit-task-all-day" className="font-normal">All day</Label>
            <Switch id="edit-task-all-day" checked={form.all_day} onCheckedChange={checked => setForm(prev => ({ ...prev, all_day: checked }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-task-location">Location</Label>
            <Input id="edit-task-location" value={form.location} placeholder="Optional" onChange={event => setForm(prev => ({ ...prev, location: event.target.value }))} />
          </div>
          <ColorChoice value={form.color} onChange={color => setForm(prev => ({ ...prev, color }))} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Reminders (up to 3)</legend>
            {form.reminders.map((reminder, index) => (
              <div key={index} className="flex items-center gap-2">
                <Select value={String(reminder)} onValueChange={value => setForm(prev => ({ ...prev, reminders: prev.reminders.map((item, at) => at === index ? Number(value) : item) }))}>
                  <SelectTrigger className="flex-1" aria-label={`Reminder ${index + 1}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{REMINDER_OPTIONS.map(option => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
                {form.reminders.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove reminder ${index + 1}`}
                    onClick={() => setForm(prev => ({ ...prev, reminders: prev.reminders.filter((_, at) => at !== index) }))}><X aria-hidden="true" /></Button>
                )}
              </div>
            ))}
            {form.reminders.length < 3 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setForm(prev => ({ ...prev, reminders: [...prev.reminders, 15] }))}>
                <Plus aria-hidden="true" />Add reminder
              </Button>
            )}
          </fieldset>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={actions.update.isPending}>Save changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoveTaskDialog({ task, onClose, actions, timezone }: {
  task: CalendarEvent | null; onClose: () => void; actions: TaskActions; timezone: string | null;
}) {
  const [form, setForm] = useState({ start_time: '', end_time: '' });
  useEffect(() => {
    if (task) setForm({ start_time: toDatetimeLocalValue(task.start_time, timezone), end_time: toDatetimeLocalValue(task.end_time, timezone) });
  }, [task, timezone]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!task) return;
    actions.setStatus.mutate({
      id: task.id, todo_status: 'time_moved',
      start_time: localDatetimeToIso(form.start_time, timezone),
      end_time: form.end_time ? localDatetimeToIso(form.end_time, timezone) : undefined,
    }, { onSuccess: onClose });
  };
  return (
    <Dialog open={!!task} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to another time</DialogTitle>
          <DialogDescription>{task?.title}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="move-task-start">New start</Label>
            <Input id="move-task-start" type="datetime-local" required value={form.start_time} onChange={event => setForm(prev => ({ ...prev, start_time: event.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="move-task-end">New end (optional)</Label>
            <Input id="move-task-end" type="datetime-local" value={form.end_time} onChange={event => setForm(prev => ({ ...prev, end_time: event.target.value }))} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={actions.setStatus.isPending}>Move</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Moves a task to another of the person's lists or calendars. The task keeps
 * its subtasks, done state and email. A calendar server that has not
 * confirmed yet leaves the dialog saying so: UniHub finishes the move in the
 * background and the task shows in its new list once it has.
 */
export function MoveListDialog({ task, onClose, actions, calendars }: {
  task: CalendarEvent | null; onClose: () => void; actions: TaskActions; calendars: CalendarCalendar[];
}) {
  const [calendarId, setCalendarId] = useState('');
  // 'creating': the calendar server has not confirmed the copy; 'unknown': the
  // move request got no answer in time, so the move may or may not be under way.
  const [pending, setPending] = useState<'creating' | 'unknown' | null>(null);
  const [formTask, setFormTask] = useState<CalendarEvent | null>(null);
  // Each opening is numbered: an answer to a move submitted from an earlier
  // opening (another task, or the same one opened again) changes nothing here.
  const opening = useRef(0);
  if (task !== formTask) {
    setFormTask(task);
    setCalendarId('');
    setPending(null);
    opening.current += 1;
  }
  const current = task?.calendar_id ? calendars.find(calendar => calendar.id === task.calendar_id) : undefined;
  const target = calendars.find(calendar => calendar.id === calendarId);
  const refusal = target && task ? listRefusal(target, { undated: task.is_todo_only }) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!task || !target || refusal || target.id === task.calendar_id) return;
    const submitted = { id: task.id, opening: opening.current };
    actions.moveToList.mutate({ id: task.id, calendarId: target.id, list: target }, {
      // Only a copy not yet confirmed keeps the dialog open: with 'removing'
      // the task is in its new list. An answer to a move submitted from an
      // earlier opening (another task) changes nothing here.
      onSuccess: result => {
        if (submitted.opening !== opening.current || submitted.id !== formTask?.id) return;
        if (result.pending === 'creating') setPending(result.pending); else onClose();
      },
      onError: error => {
        if (submitted.opening !== opening.current || submitted.id !== formTask?.id || !isWriteTimeout(error)) return;
        setPending('unknown');
      },
    });
  };
  const cancelMove = () => {
    if (!task) return;
    const submitted = { id: task.id, opening: opening.current };
    actions.cancelMove.mutate({ id: task.id, from: current?.name, to: target?.name }, {
      onSuccess: () => { if (submitted.opening === opening.current && submitted.id === formTask?.id) onClose(); },
    });
  };
  return (
    <Dialog open={!!task} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to another list</DialogTitle>
          <DialogDescription>{task?.title}{current ? ` · now in ${current.name}` : ''}</DialogDescription>
        </DialogHeader>
        {pending ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm" role="status">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              {pending === 'creating'
                ? `Moving… UniHub finishes this in the background and the task shows in ${target?.name ?? 'its new list'} once the calendar server has stored it.`
                : `The server has not answered yet. If the move went through, the task shows in ${target?.name ?? 'its new list'} once the list is reloaded.`}
            </p>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" disabled={actions.cancelMove.isPending} onClick={cancelMove}>
                {actions.cancelMove.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Cancel move
              </Button>
              <Button type="button" onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="move-task-list">New list</Label>
              <ListChooser id="move-task-list" calendars={calendars} value={calendarId} onChange={setCalendarId} forTask
                undated={!!task?.is_todo_only} unavailable={task?.calendar_id ? { [task.calendar_id]: 'Current list' } : {}} />
              <p className="text-xs text-muted-foreground">Subtasks, the done state and the email stay with the task.</p>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!target || !!refusal || target.id === task?.calendar_id || actions.moveToList.isPending}>
                {actions.moveToList.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Move
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
