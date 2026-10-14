import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { EVENT_COLOR_OPTIONS, REMINDER_OPTIONS, localDatetimeToIso, toDatetimeLocalValue, type CalendarEvent } from '@/lib/calendar-api';
import type { TaskActions } from '@/hooks/use-task-actions';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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

const emptyNewTask = { title: '', description: '', scheduled: false, start_time: '', end_time: '', location: '', color: '#3b82f6' };

export function NewTaskDialog({ open, onOpenChange, actions, timezone }: {
  open: boolean; onOpenChange: (open: boolean) => void; actions: TaskActions; timezone: string | null;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(emptyNewTask);
  useEffect(() => { if (open) setForm(emptyNewTask); }, [open]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) return;
    if (form.scheduled && (!form.start_time || !form.end_time)) {
      toast({ title: 'Choose a start and an end', description: 'A scheduled task needs both.', variant: 'destructive' });
      return;
    }
    actions.create.mutate({
      title: form.title.trim(),
      description: form.description || null,
      location: form.location || null,
      color: form.color,
      reminders: form.scheduled ? [0] : null,
      ...(form.scheduled
        ? { start_time: localDatetimeToIso(form.start_time, timezone), end_time: localDatetimeToIso(form.end_time, timezone), is_todo_only: false }
        : { is_todo_only: true }),
    }, { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
          <div className="space-y-2">
            <Label htmlFor="task-description">Notes</Label>
            <Textarea id="task-description" rows={3} value={form.description}
              onChange={event => setForm(prev => ({ ...prev, description: event.target.value }))} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="task-scheduled" className="font-normal">Give it a time in the calendar</Label>
            <Switch id="task-scheduled" checked={form.scheduled} onCheckedChange={checked => setForm(prev => ({ ...prev, scheduled: checked }))} />
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
