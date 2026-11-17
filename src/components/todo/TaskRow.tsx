import { useContext, useState, type FormEvent } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2, MapPin, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import { isOverdue, taskWhen } from '@/lib/tasks';
import type { TaskActions } from '@/hooks/use-task-actions';
import { useSourceEmailUnlink } from '@/hooks/use-source-email-unlink';
import { AuthContext } from '@/contexts/auth-context';
import type { CalendarPermission } from '@/lib/calendar-shares-api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DragHandle, SortableList, draggingRowClass, type SortableRow } from '@/components/ui/sortable-list';
import { SourceEmailBlock } from '@/components/todo/SourceEmail';

const statusText: Partial<Record<NonNullable<CalendarEvent['todo_status']>, string>> = {
  changed: 'Changed',
  time_moved: 'Moved',
};

/** The row's place in its section, for the menu's Move up and Move down. */
export interface RowOrder {
  index: number;
  count: number;
  up: () => void;
  down: () => void;
}

interface Props {
  task: CalendarEvent;
  actions: TaskActions;
  timezone: string | null;
  onEdit: (task: CalendarEvent) => void;
  onMove: (task: CalendarEvent) => void;
  /** Opens "Move to another list"; absent where lists cannot be changed. */
  onMoveList?: (task: CalendarEvent) => void;
  /** Color of the task's calendar, shown as a dot. */
  calendarColor?: string;
  /** The row's drag state from its SortableList; absent where nothing is reordered (Done, offline). */
  sortable?: SortableRow;
  order?: RowOrder;
  /** Whether the order can be changed at all (not offline, list loaded); subtasks follow it. */
  canReorder?: boolean;
  /** The list the task is being moved to while the calendar server has not confirmed (move_pending 'creating'). */
  movingTo?: string | null;
  /** Cancels that move; absent offline, where it cannot be sent. */
  onCancelMove?: (task: CalendarEvent) => void;
  /** What the person may do in the task's list; absent means everything (an older server, a task without a list). */
  level?: CalendarPermission;
  /** Whose list it is, when not the person's own. */
  listOwner?: string | null;
}

/**
 * One task with everything it holds in view: title and when it is due, its
 * description, the email it came from and its subtasks. The circle marks it
 * done; the ≡ handle (shown on hover with a mouse, always on touch screens)
 * drags it within its section; the remaining actions sit in the row's menu.
 */
export function TaskRow({ task, actions, timezone, onEdit, onMove, onMoveList, calendarColor, sortable, order, canReorder = true, movingTo = null, onCancelMove, level, listOwner }: Props) {
  const unlink = useSourceEmailUnlink();
  // Below edit the task itself is read-only: a contributor adds subtasks and
  // changes their own, a reader none. The order stays each person's own.
  const edits = !level || level === 'edit' || level === 'manage';
  const contributes = level === 'contribute';
  const done = task.todo_status === 'done';
  const overdue = !done && isOverdue(task);
  // While a move waits for the calendar server, the server refuses the changes
  // that would reach the server (the title, dates, another time or list); the
  // done state, subtasks and the order stay local and keep working.
  const moving = movingTo !== null;
  const movingReasonId = `task-${task.id}-moving`;
  const busy = actions.setStatus.isPending && actions.setStatus.variables?.id === task.id;
  const cancellingMove = actions.cancelMove.isPending && actions.cancelMove.variables?.id === task.id;
  // The first subtask is added from the menu; a task with subtasks always offers the next one.
  const [addingSubtask, setAddingSubtask] = useState(false);
  const subtasks = task.subtasks.length > 0 || (addingSubtask && !done);
  const dragging = sortable?.dragging ?? false;

  return (
    <li id={`task-${task.id}`} ref={sortable?.setNodeRef} style={sortable?.style}
      className={cn('group grid grid-cols-[auto_1fr_auto] gap-x-3 border-b border-border py-3', dragging && draggingRowClass)}>
      <button type="button" disabled={busy || !edits} title={edits ? undefined : 'Only people who can edit this list tick its tasks'}
        aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
        onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: done ? null : 'done' })}
        className={cn('tap-area mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] touch:h-6 touch:w-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !edits && 'cursor-not-allowed opacity-50',
          done ? 'border-accent bg-accent text-accent-foreground' : edits ? 'border-muted-foreground/60 text-transparent hover:border-accent hover:text-accent' : 'border-muted-foreground/60 text-transparent')}>
        <Check aria-hidden="true" className="h-3 w-3 touch:h-3.5 touch:w-3.5" strokeWidth={3} />
      </button>
      <div className="min-w-0">
        <p className={cn('break-words font-medium', done && 'text-muted-foreground line-through')}>{task.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className={cn(overdue && 'text-warning')}>{overdue ? `Overdue · ${taskWhen(task, timezone)}` : taskWhen(task, timezone)}</span>
          {task.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin aria-hidden="true" className="h-3 w-3" /><span className="truncate">{task.location}</span></span>}
          {task.todo_status && statusText[task.todo_status] && <span>{statusText[task.todo_status]}</span>}
          {moving && (
            <span role="status" className="inline-flex items-center gap-1 text-accent">
              <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none" />Moving to {movingTo}…
            </span>
          )}
          {done && task.done_at && <span>Done {formatEventTime(task.done_at, 'd MMM yyyy, HH:mm', timezone)}</span>}
          {calendarColor && <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: calendarColor }} />}
          {listOwner && <span className="min-w-0 truncate">{listOwner}</span>}
        </p>
      </div>
      {done || (!edits && !sortable && !(contributes && task.subtasks.length === 0)) ? <span /> : (
        // The handle and the menu keep a gap on touch screens so their tap areas never overlap (P-11).
        <div className="-my-1 -mr-1 flex items-start touch:gap-x-1">
          {sortable && <DragHandle {...sortable.handle} label={`Reorder ${task.title}`} revealOnHover dragging={dragging} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`More actions for ${task.title}`}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {edits && moving && <>
                {/* The reason the greyed-out actions name, then the one the server takes meanwhile. */}
                <DropdownMenuItem id={movingReasonId} disabled>Still being moved to {movingTo}</DropdownMenuItem>
                {onCancelMove && <DropdownMenuItem disabled={cancellingMove} onClick={() => onCancelMove(task)}>Cancel move</DropdownMenuItem>}
                <DropdownMenuSeparator />
              </>}
              {edits && <DropdownMenuItem disabled={moving} aria-describedby={moving ? movingReasonId : undefined} onClick={() => onEdit(task)}>Edit</DropdownMenuItem>}
              {(edits || contributes) && task.subtasks.length === 0 && <DropdownMenuItem onClick={() => setAddingSubtask(true)}>Add a subtask</DropdownMenuItem>}
              {order && <>
                {(edits || (contributes && task.subtasks.length === 0)) && <DropdownMenuSeparator />}
                <DropdownMenuItem disabled={order.index === 0} onClick={order.up}>Move up</DropdownMenuItem>
                <DropdownMenuItem disabled={order.index >= order.count - 1} onClick={order.down}>Move down</DropdownMenuItem>
              </>}
              {edits && <>
                {(!task.is_todo_only || onMoveList) && <DropdownMenuSeparator />}
                {!task.is_todo_only && <DropdownMenuItem disabled={moving} aria-describedby={moving ? movingReasonId : undefined} onClick={() => onMove(task)}>Move to another time</DropdownMenuItem>}
                {onMoveList && <DropdownMenuItem disabled={moving} aria-describedby={moving ? movingReasonId : undefined} onClick={() => onMoveList(task)}>Move to another list</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => actions.setStatus.mutate({ id: task.id, todo_status: 'cancelled' })}>Cancel task</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {(task.description || task.source_email) && (
        <div className="col-start-2 mt-2 min-w-0 space-y-2.5">
          {task.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>}
          {task.source_email && <SourceEmailBlock source={task.source_email} timezone={timezone} onUnlink={done ? undefined : () => unlink.mutate(task)} unlinking={unlink.isPending} />}
        </div>
      )}
      {/* Subtasks reach under the row's handle and menu, so their own handle and menu line up there and a title keeps its width on a phone. */}
      {subtasks && (
        <div className="col-span-2 col-start-2 mt-2 min-w-0">
          <Subtasks task={task} actions={actions} readOnly={done || !(edits || contributes)} ownOnly={contributes} canReorder={canReorder && !done && edits} autoFocus={addingSubtask} />
        </div>
      )}
    </li>
  );
}

type Subtask = CalendarEvent['subtasks'][number];

/**
 * A task's or event's subtasks. With `ownOnly` (the contribute level) the
 * person adds subtasks and changes, ticks and deletes those they added;
 * the others are read-only and nothing is reordered. Where several people
 * added subtasks, each says who added it.
 */
export function Subtasks({ task, actions, readOnly, canReorder, autoFocus, ownOnly = false }: { task: CalendarEvent; actions: TaskActions; readOnly: boolean; canReorder: boolean; autoFocus: boolean; ownOnly?: boolean }) {
  const me = useContext(AuthContext)?.user?.id;
  const named = ownOnly || task.subtasks.some(subtask => subtask.created_by && subtask.created_by !== me);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    actions.addSubtask.mutate({ eventId: task.id, title }, { onSuccess: () => setDraft('') });
  };
  const subtaskId = (subtask: Subtask) => subtask.id;
  const subtaskName = (subtask: Subtask) => subtask.title;
  return (
    <div>
      {task.subtasks.length > 0 && (
        <SortableList items={task.subtasks} getId={subtaskId} getName={subtaskName} label={`subtasks of ${task.title}`} disabled={!canReorder}
          aria-label="Subtasks" className="space-y-0.5"
          onReorder={({ order }) => actions.reorderSubtasks.mutate({ eventId: task.id, subtaskIds: order.map(subtask => subtask.id) })}>
          {(subtask, row, index) => {
            const locked = readOnly || (ownOnly && subtask.created_by !== me);
            const author = named && subtask.created_by ? (subtask.created_by === me ? 'You' : subtask.created_by_name) : null;
            return (
            <li key={subtask.id} ref={row.setNodeRef} style={row.style}
              className={cn('group/subtask flex min-h-8 items-center gap-2.5 touch:min-h-11', row.dragging && draggingRowClass)}>
              <Checkbox checked={subtask.is_done} disabled={locked} aria-label={subtask.title}
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
                {author && <span className="shrink-0 text-xs text-muted-foreground">{author}</span>}
                {!locked && (
                  // With a mouse the handle and the actions appear on hover; a touch screen shows the handle and one menu, so the title keeps its width.
                  <span className="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/subtask:opacity-100 motion-reduce:transition-none touch:gap-x-1 [@media(hover:none)]:opacity-100">
                    {canReorder && <DragHandle {...row.handle} label={`Reorder ${subtask.title}`} dragging={row.dragging} className="h-7 w-7" />}
                    <span className="flex touch:hidden">
                      {!ownOnly && <>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${subtask.title} up`} disabled={index === 0}
                          onClick={() => actions.moveSubtask(task, subtask.id, -1)}><ChevronUp aria-hidden="true" /></Button>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${subtask.title} down`} disabled={index === task.subtasks.length - 1}
                          onClick={() => actions.moveSubtask(task, subtask.id, 1)}><ChevronDown aria-hidden="true" /></Button>
                      </>}
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
                        {!ownOnly && <DropdownMenuItem disabled={index === 0} onClick={() => actions.moveSubtask(task, subtask.id, -1)}>Move up</DropdownMenuItem>}
                        {!ownOnly && <DropdownMenuItem disabled={index === task.subtasks.length - 1} onClick={() => actions.moveSubtask(task, subtask.id, 1)}>Move down</DropdownMenuItem>}
                        <DropdownMenuItem onClick={() => setEditing({ id: subtask.id, title: subtask.title })}>Rename</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => actions.deleteSubtask.mutate({ eventId: task.id, subtaskId: subtask.id })}>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                )}
              </>}
            </li>
            );
          }}
        </SortableList>
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
