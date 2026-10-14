import { useState, type FormEvent } from 'react';
import { Check, ChevronDown, ChevronUp, MapPin, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import { isOverdue, taskWhen } from '@/lib/tasks';
import type { TaskActions } from '@/hooks/use-task-actions';
import { useSourceEmailUnlink } from '@/hooks/use-source-email-unlink';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SourceEmailBlock } from '@/components/todo/SourceEmail';

const statusText: Partial<Record<NonNullable<CalendarEvent['todo_status']>, string>> = {
  changed: 'Changed',
  time_moved: 'Moved',
};

interface Props {
  task: CalendarEvent;
  actions: TaskActions;
  timezone: string | null;
  onEdit: (task: CalendarEvent) => void;
  onMove: (task: CalendarEvent) => void;
  /** Color of the task's calendar, shown as a dot. */
  calendarColor?: string;
}

/**
 * One task with everything it holds in view: title and when it is due, its
 * description, the email it came from and its subtasks. The circle marks it
 * done; the remaining actions sit in the row's menu.
 */
export function TaskRow({ task, actions, timezone, onEdit, onMove, calendarColor }: Props) {
  const unlink = useSourceEmailUnlink();
  const done = task.todo_status === 'done';
  const overdue = !done && isOverdue(task);
  const busy = actions.setStatus.isPending && actions.setStatus.variables?.id === task.id;
  // The first subtask is added from the menu; a task with subtasks always offers the next one.
  const [addingSubtask, setAddingSubtask] = useState(false);
  const subtasks = task.subtasks.length > 0 || (addingSubtask && !done);

  return (
    <li id={`task-${task.id}`} className="grid grid-cols-[auto_1fr_auto] gap-x-3 border-b border-border py-3">
      <button type="button" disabled={busy}
        aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
        onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: done ? null : 'done' })}
        className={cn('tap-area mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] touch:h-6 touch:w-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          done ? 'border-accent bg-accent text-accent-foreground' : 'border-muted-foreground/60 text-transparent hover:border-accent hover:text-accent')}>
        <Check aria-hidden="true" className="h-3 w-3 touch:h-3.5 touch:w-3.5" strokeWidth={3} />
      </button>
      <div className="min-w-0">
        <p className={cn('break-words font-medium', done && 'text-muted-foreground line-through')}>{task.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className={cn(overdue && 'text-warning')}>{overdue ? `Overdue · ${taskWhen(task, timezone)}` : taskWhen(task, timezone)}</span>
          {task.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin aria-hidden="true" className="h-3 w-3" /><span className="truncate">{task.location}</span></span>}
          {task.todo_status && statusText[task.todo_status] && <span>{statusText[task.todo_status]}</span>}
          {done && task.done_at && <span>Done {formatEventTime(task.done_at, 'd MMM yyyy, HH:mm', timezone)}</span>}
          {calendarColor && <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: calendarColor }} />}
        </p>
      </div>
      {done ? <span /> : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-my-1 -mr-1 text-muted-foreground" aria-label={`More actions for ${task.title}`}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(task)}>Edit</DropdownMenuItem>
            {task.subtasks.length === 0 && <DropdownMenuItem onClick={() => setAddingSubtask(true)}>Add a subtask</DropdownMenuItem>}
            {!task.is_todo_only && <DropdownMenuItem onClick={() => onMove(task)}>Move to another time</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: 'cancelled' })}>Cancel task</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {(task.description || task.source_email || subtasks) && (
        <div className="col-start-2 mt-2 space-y-2.5">
          {task.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>}
          {task.source_email && <SourceEmailBlock source={task.source_email} timezone={timezone} onUnlink={done ? undefined : () => unlink.mutate(task)} unlinking={unlink.isPending} />}
          {subtasks && <Subtasks task={task} actions={actions} readOnly={done} autoFocus={addingSubtask} />}
        </div>
      )}
    </li>
  );
}

function Subtasks({ task, actions, readOnly, autoFocus }: { task: CalendarEvent; actions: TaskActions; readOnly: boolean; autoFocus: boolean }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    actions.addSubtask.mutate({ eventId: task.id, title }, { onSuccess: () => setDraft('') });
  };
  return (
    <div>
      {task.subtasks.length > 0 && (
        <ul aria-label="Subtasks" className="space-y-0.5">
          {task.subtasks.map((subtask, index) => (
            <li key={subtask.id} className="group flex min-h-8 items-center gap-2.5 touch:min-h-11">
              <Checkbox checked={subtask.is_done} disabled={readOnly} aria-label={subtask.title}
                onCheckedChange={checked => actions.updateSubtask.mutate({ eventId: task.id, subtaskId: subtask.id, update: { is_done: checked === true } })} />
              {editing?.id === subtask.id ? (
                <form className="flex flex-1 gap-2" onSubmit={event => {
                  event.preventDefault();
                  actions.updateSubtask.mutate({ eventId: task.id, subtaskId: subtask.id, update: { title: editing.title } }, { onSuccess: () => setEditing(null) });
                }}>
                  <Input autoFocus value={editing.title} aria-label="Subtask title" className="h-8 touch:h-10"
                    onChange={event => setEditing({ id: subtask.id, title: event.target.value })}
                    onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }} />
                  <Button type="submit" size="sm">Save</Button>
                </form>
              ) : <>
                <span className={cn('flex-1 text-sm', subtask.is_done && 'text-muted-foreground line-through')}>{subtask.title}</span>
                {!readOnly && <>
                  {/* With a mouse the actions appear on hover; a touch screen gets one menu so the title keeps its width. */}
                  <span className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 touch:hidden [@media(hover:none)]:opacity-100">
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${subtask.title} up`} disabled={index === 0}
                      onClick={() => actions.moveSubtask(task, subtask.id, -1)}><ChevronUp aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${subtask.title} down`} disabled={index === task.subtasks.length - 1}
                      onClick={() => actions.moveSubtask(task, subtask.id, 1)}><ChevronDown aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Rename ${subtask.title}`}
                      onClick={() => setEditing({ id: subtask.id, title: subtask.title })}><Pencil aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${subtask.title}`}
                      onClick={() => actions.deleteSubtask.mutate({ eventId: task.id, subtaskId: subtask.id })}><Trash2 aria-hidden="true" /></Button>
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon-sm" className="hidden text-muted-foreground touch:inline-flex" aria-label={`More actions for ${subtask.title}`}>
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={index === 0} onClick={() => actions.moveSubtask(task, subtask.id, -1)}>Move up</DropdownMenuItem>
                      <DropdownMenuItem disabled={index === task.subtasks.length - 1} onClick={() => actions.moveSubtask(task, subtask.id, 1)}>Move down</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setEditing({ id: subtask.id, title: subtask.title })}>Rename</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => actions.deleteSubtask.mutate({ eventId: task.id, subtaskId: subtask.id })}>Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>}
              </>}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form onSubmit={add} className="flex items-center gap-2.5">
          <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input autoFocus={autoFocus} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Add a subtask" aria-label={`Add a subtask to ${task.title}`}
            className="h-8 border-transparent bg-transparent px-2 shadow-none focus-visible:ring-offset-0" />
          {draft.trim() && <Button type="submit" size="sm" disabled={actions.addSubtask.isPending}>Add</Button>}
        </form>
      )}
    </div>
  );
}
