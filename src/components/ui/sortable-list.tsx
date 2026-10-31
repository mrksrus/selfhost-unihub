import { forwardRef, useCallback, useMemo, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type Announcements, type DragEndEvent, type Modifier, type ScreenReaderInstructions, type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS, getEventCoordinates } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useMediaQuery } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// The one place dnd-kit is used (0.27.0): rows a person can reorder by their
// ≡ handle. With a mouse the drag starts after 4 px; on a touch screen after
// a 250 ms hold on the handle (a swipe before that scrolls the page); with
// the keyboard, Space picks the row up, the arrow keys move it, Space drops
// it and Escape cancels. Every change is announced in plain words. The row
// keeps its full content while it moves (P-07): the row itself is
// transformed, nothing is collapsed or replaced by a placeholder.

/** What a reorder gives the owner of the list: the new order and the moved item's neighbours in it. */
export interface Reorder<T> {
  order: T[];
  item: T;
  from: number;
  to: number;
  /** The item just above the moved one in the new order, null at the top. */
  after: T | null;
  /** The item just below it, null at the bottom. */
  before: T | null;
}

/** What a row needs from the list to be draggable: the row's ref and style, the handle's props and its drag state. */
export interface SortableRow {
  setNodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  handle: HandleProps;
  dragging: boolean;
}

export interface HandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref: (node: HTMLElement | null) => void;
}

interface Props<T> {
  items: readonly T[];
  getId: (item: T) => string;
  /** The item's name for announcements ("Pay rent moved to position 2 of 5 in No date"). */
  getName: (item: T) => string;
  /** The list's name for announcements, e.g. the section. */
  label: string;
  onReorder: (reorder: Reorder<T>) => void;
  /** No dragging (offline, loading, read-only): rows render without a live handle. */
  disabled?: boolean;
  /** The list element around the rows; rows are the children's own elements. */
  as?: 'ul' | 'ol' | 'div';
  className?: string;
  /** The list's accessible name, when it is not labelled by a heading around it. */
  'aria-label'?: string;
  children: (item: T, row: SortableRow, index: number) => ReactNode;
}

const INSTRUCTIONS: ScreenReaderInstructions = {
  draggable: 'Press Space to pick up, the arrow keys to move, Space to drop, Escape to cancel.',
};

// Rows move up and down only. The list is the only sortable context the drag
// knows, so a row can never land in another list; a drop outside the list's
// own bounds is cancelled instead (droppedOutside), as the nearest row of the
// list would otherwise take it.
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** A list whose rows a person reorders by handle, mouse, touch or keyboard. */
export function SortableList<T>({ items, getId, getName, label, onReorder, disabled = false, as: Tag = 'ul', className, 'aria-label': ariaLabel, children }: Props<T>) {
  const ids = useMemo(() => items.map(getId), [items, getId]);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const list = useRef<HTMLElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const register = useCallback((id: string, node: HTMLElement | null) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }, []);
  /**
   * Whether the pointer let go outside this list (over another section, its
   * heading, or nothing): then the drop changes nothing and the row goes back
   * (D31: a drag stays within its section). The pointer keeps its hold on the
   * row, so its place is the row's place now plus where it took hold. A
   * keyboard drag has no pointer and stays within the list anyway.
   */
  const droppedOutside = ({ active, activatorEvent }: DragEndEvent) => {
    const pointer = activatorEvent ? getEventCoordinates(activatorEvent) : null;
    const initial = active.rect.current.initial;
    const row = nodes.current.get(String(active.id))?.getBoundingClientRect();
    const bounds = list.current?.getBoundingClientRect();
    if (!pointer || !initial || !row || !bounds) return false;
    const x = row.left + (pointer.x - initial.left), y = row.top + (pointer.y - initial.top);
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  };
  // Read by the announcement of the drop, which dnd-kit makes right after onDragEnd.
  const outside = useRef(false);
  const position = useCallback((id: UniqueIdentifier) => ids.indexOf(String(id)) + 1, [ids]);
  const nameOf = useCallback((id: UniqueIdentifier) => {
    const item = items.find(entry => getId(entry) === String(id));
    return item ? getName(item) : 'Row';
  }, [items, getId, getName]);

  // Picking a row up puts it over itself first; that is not a move worth announcing.
  const moved = useRef(false);
  const announcements = useMemo<Announcements>(() => ({
    onDragStart: ({ active }) => {
      moved.current = false;
      return `Picked up ${nameOf(active.id)}, position ${position(active.id)} of ${ids.length} in ${label}.`;
    },
    onDragOver: ({ active, over }) => {
      if (!over) return `${nameOf(active.id)} is no longer over the list.`;
      if (over.id === active.id) return moved.current ? `${nameOf(active.id)} is back at position ${position(active.id)} of ${ids.length} in ${label}.` : undefined;
      moved.current = true;
      return `${nameOf(active.id)} moved to position ${position(over.id)} of ${ids.length} in ${label}.`;
    },
    onDragEnd: ({ active, over }) => {
      if (outside.current) return `Dropped outside ${label}. ${nameOf(active.id)} is back at position ${position(active.id)} of ${ids.length} in ${label}.`;
      return over && over.id !== active.id
        ? `${nameOf(active.id)} dropped at position ${position(over.id)} of ${ids.length} in ${label}.`
        : `${nameOf(active.id)} stays at position ${position(active.id)} of ${ids.length} in ${label}.`;
    },
    onDragCancel: ({ active }) => `Reordering cancelled. ${nameOf(active.id)} is back at position ${position(active.id)} of ${ids.length} in ${label}.`,
  }), [nameOf, position, ids.length, label]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    outside.current = droppedOutside(event);
    if (!over || over.id === active.id || outside.current) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const order = arrayMove([...items], from, to);
    onReorder({ order, item: order[to], from, to, after: order[to - 1] ?? null, before: order[to + 1] ?? null });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]}
      accessibility={{ announcements, screenReaderInstructions: INSTRUCTIONS }}
      onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={disabled}>
        <Tag ref={list as never} className={className} aria-label={ariaLabel}>
          {items.map((item, index) => (
            <SortableItem key={ids[index]} id={ids[index]} disabled={disabled} reducedMotion={reducedMotion} register={register}>
              {row => children(item, row, index)}
            </SortableItem>
          ))}
        </Tag>
      </SortableContext>
    </DndContext>
  );
}

function SortableItem({ id, disabled, reducedMotion, register, children }: {
  id: string; disabled: boolean; reducedMotion: boolean; register: (id: string, node: HTMLElement | null) => void; children: (row: SortableRow) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef: setSortableNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  // The list keeps the row's element too, to tell where the row is when the pointer lets go.
  const setNodeRef = useCallback((node: HTMLElement | null) => { setSortableNodeRef(node); register(id, node); }, [setSortableNodeRef, register, id]);
  // dnd-kit's role goes: the handle is a real button. aria-describedby points
  // at the instructions DndContext renders.
  const { role: _role, ...handleAttributes } = attributes;
  void _role;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };
  const row: SortableRow = {
    setNodeRef,
    style,
    dragging: isDragging,
    handle: { ref: setActivatorNodeRef, ...handleAttributes, ...listeners, disabled },
  };
  return <>{children(row)}</>;
}

interface DragHandleProps extends HandleProps {
  /** What the handle reorders: "Reorder Pay rent". */
  label: string;
  /** With a mouse the handle shows on row hover and focus; on touch screens always. The row needs `group`. */
  revealOnHover?: boolean;
  dragging?: boolean;
}

/**
 * The ≡ handle of a sortable row. Its tap area is 44 px on touch screens (P-11),
 * nothing is selectable or opens a context menu on a long press, and a swipe
 * started on it without the hold still scrolls the page.
 */
export const DragHandle = forwardRef<HTMLButtonElement, DragHandleProps>(function DragHandle({ label, revealOnHover = false, dragging = false, className, ...props }, ref) {
  return (
    <Button ref={ref} type="button" variant="ghost" size="icon-sm" aria-label={label} title="Drag to reorder"
      onContextMenu={event => event.preventDefault()}
      className={cn('shrink-0 touch-manipulation select-none text-muted-foreground [-webkit-touch-callout:none]',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
        revealOnHover && !dragging && 'opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100',
        className)}
      {...props}>
      <GripVertical aria-hidden="true" />
    </Button>
  );
});

/** The classes a row takes while it is dragged: lifted above its neighbours, its own background, nothing collapsed. */
export const draggingRowClass = 'relative z-10 bg-background shadow-md ring-1 ring-border';
