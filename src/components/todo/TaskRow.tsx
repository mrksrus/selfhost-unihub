import { useState, type FormEvent } from 'react';
import { Check, ChevronDown, ChevronUp, MapPin, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import { isOverdue, taskWhen } from '@/lib/tasks';
import type { TaskActions } from '@/hooks/use-task-actions';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const statusText: Partial<Record<NonNullable<CalendarEvent['todo_status']>, string>> = {
  changed: 'Changed',
  time_moved: 'Moved',
};

interface Props {
  task: CalendarEvent;
  actions: TaskActions;
  timezone: string | null;
  open: boolean;
  onToggle: () => void;
  onEdit: (task: CalendarEvent) => void;
  onMove: (task: CalendarEvent) => void;
  /** Color of the task's calendar, shown as a dot. */
  calendarColor?: string;
}

/**
 * One task: a checkbox, the title and when it is due. Opening the row shows
 * its subtasks and the remaining actions, so the list stays quiet.
 */
export function TaskRow({ task, actions, timezone, open, onToggle, onEdit, onMove, calendarColor }: Props) {
  const done = task.todo_status === 'done';
  const overdue = !done && isOverdue(task);
  const subtasksDone = task.subtasks.filter(subtask => subtask.is_done).length;
  const busy = actions.setStatus.isPending && actions.setStatus.variables?.id === task.id;
  const detailsId = `task-${task.id}-details`;

  return (
    <li className={cn('border-b border-border', open && 'my-2 rounded-lg border bg-card')}>
      <div className={cn('flex items-start gap-3 py-2.5', open ? 'px-3' : 'px-1')}>
        <button type="button" disabled={busy}
          aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
          onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: done ? null : 'done' })}
          className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            done ? 'border-accent bg-accent text-accent-foreground' : 'border-muted-foreground/60 text-transparent hover:border-accent hover:text-accent')}>
          <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
        </button>
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailsId}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
          <span className={cn('block break-words', done && 'text-muted-foreground line-through', open && 'font-medium')}>{task.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className={cn(overdue && 'text-warning')}>{overdue ? `Overdue · ${taskWhen(task, timezone)}` : taskWhen(task, timezone)}</span>
            {task.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin aria-hidden="true" className="h-3 w-3" /><span className="truncate">{task.location}</span></span>}
            {task.subtasks.length > 0 && <span>{subtasksDone}/{task.subtasks.length} subtasks</span>}
            {task.todo_status && statusText[task.todo_status] && <span>{statusText[task.todo_status]}</span>}
            {calendarColor && <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: calendarColor }} />}
          </span>
        </button>
        {!done && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-mr-1 h-8 w-8 shrink-0 text-muted-foreground" aria-label={`More actions for ${task.title}`}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(task)}>Edit</DropdownMenuItem>
              {!task.is_todo_only && <DropdownMenuItem onClick={() => onMove(task)}>Move to another time</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: 'cancelled' })}>Cancel task</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {open && (
        <div id={detailsId} className="space-y-3 pb-3 pl-11 pr-3">
          {task.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>}
          <Subtasks task={task} actions={actions} readOnly={done} />
          {done ? (
            task.done_at && <p className="text-xs text-muted-foreground">Done {formatEventTime(task.done_at, 'd MMM yyyy, HH:mm', timezone)}</p>
          ) : (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: 'done' })}>Done</Button>
              <Button size="sm" variant="outline" onClick={() => onEdit(task)}>Edit</Button>
              {!task.is_todo_only && <Button size="sm" variant="outline" onClick={() => onMove(task)}>Move</Button>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Subtasks({ task, actions, readOnly }: { task: CalendarEvent; actions: TaskActions; readOnly: boolean }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    actions.addSubtask.mutate({ eventId: task.id, title }, { onSuccess: () => setDraft('') });
  };
  if (readOnly && task.subtasks.length === 0) return null;
  return (
    <div>
      {task.subtasks.length > 0 && (
        <ul aria-label="Subtasks" className="space-y-0.5">
          {task.subtasks.map((subtask, index) => (
            <li key={subtask.id} className="group flex min-h-8 items-center gap-2.5">
              <Checkbox checked={subtask.is_done} disabled={readOnly} aria-label={subtask.title}
                onCheckedChange={checked => actions.updateSubtask.mutate({ eventId: task.id, subtaskId: subtask.id, update: { is_done: checked === true } })} />
              {editing?.id === subtask.id ? (
                <form className="flex flex-1 gap-2" onSubmit={event => {
                  event.preventDefault();
                  actions.updateSubtask.mutate({ eventId: task.id, subtaskId: subtask.id, update: { title: editing.title } }, { onSuccess: () => setEditing(null) });
                }}>
                  <Input autoFocus value={editing.title} aria-label="Subtask title" className="h-8"
                    onChange={event => setEditing({ id: subtask.id, title: event.target.value })}
                    onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }} />
                  <Button type="submit" size="sm">Save</Button>
                </form>
              ) : <>
                <span className={cn('flex-1 text-sm', subtask.is_done && 'text-muted-foreground line-through')}>{subtask.title}</span>
                {!readOnly && (
                  <span className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${subtask.title} up`} disabled={index === 0}
                      onClick={() => actions.moveSubtask(task, subtask.id, -1)}><ChevronUp aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${subtask.title} down`} disabled={index === task.subtasks.length - 1}
                      onClick={() => actions.moveSubtask(task, subtask.id, 1)}><ChevronDown aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Rename ${subtask.title}`}
                      onClick={() => setEditing({ id: subtask.id, title: subtask.title })}><Pencil aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Delete ${subtask.title}`}
                      onClick={() => actions.deleteSubtask.mutate({ eventId: task.id, subtaskId: subtask.id })}><Trash2 aria-hidden="true" /></Button>
                  </span>
                )}
              </>}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form onSubmit={add} className="mt-1 flex items-center gap-2.5">
          <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input value={draft} onChange={event => setDraft(event.target.value)} placeholder="Add a subtask" aria-label={`Add a subtask to ${task.title}`}
            className="h-8 border-transparent bg-transparent px-2 shadow-none focus-visible:ring-offset-0" />
          {draft.trim() && <Button type="submit" size="sm" disabled={actions.addSubtask.isPending}>Add</Button>}
        </form>
      )}
    </div>
  );
}
