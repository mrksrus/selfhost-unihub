import { useMemo } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodoPage from '@/pages/TodoPage';
import GeneralSettings from '@/components/settings/GeneralSettings';
import { MoveListDialog, NewTaskDialog } from '@/components/todo/TaskDialogs';
import { TaskRow } from '@/components/todo/TaskRow';
import { useTaskActions, type TaskActions } from '@/hooks/use-task-actions';
import { useEventActions } from '@/hooks/use-event-actions';
import { EventDialog } from '@/components/calendar/EventDialog';
import { SortableList, DragHandle } from '@/components/ui/sortable-list';
import { api } from '@/lib/api';
import { calendarApi, calendarQueryKeys, normalizeCalendar, type CalendarCalendar, type CalendarEvent, type CalendarSubtask, type TaskMovePending } from '@/lib/calendar-api';
import { SessionScopeContext } from '@/lib/session-scope';
import { MOVE_DEADLINE_MS, WRITE_DEADLINE_MS } from '@/lib/task-order-queue';
import { defaultTaskList, listRefusal, neighboursAt, optimisticRanks, orderTasks, rankBetween, taskSection } from '@/lib/tasks';
import { userSettingsAnswer, savedSettingsAnswer } from './settings-fixtures';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner', timezone: 'UTC' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const hour = 3600_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const task = (id: string, patch: Partial<CalendarEvent>): CalendarEvent => ({
  id, user_id: 'owner', calendar_id: 'list-home', title: id, description: null, start_time: iso(hour), end_time: iso(2 * hour),
  all_day: false, location: null, color: '#3b82f6', recurrence: null, reminder_minutes: null, reminders: [0], todo_status: null,
  is_todo_only: false, done_at: null, created_at: iso(-hour), updated_at: iso(-hour), subtasks: [], attendees: [], ...patch,
});
// Three tasks without a date, in the order the server ranks them: Pay rent, Call Sam, Plan holiday.
const undated = [
  task('Pay rent', { is_todo_only: true, sort_rank: 100, hand_ordered: true }),
  task('Call Sam', { is_todo_only: true, sort_rank: 200, hand_ordered: false }),
  task('Plan holiday', { is_todo_only: true, sort_rank: 300, hand_ordered: false }),
];
const calendar = (patch: Partial<CalendarCalendar> & Pick<CalendarCalendar, 'id' | 'name'>): CalendarCalendar => normalizeCalendar({
  user_id: 'owner', account_id: 'local', external_id: null, color: '#3b82f6', is_visible: true, auto_todo_enabled: true, read_only: false, is_primary: false,
  sync_token: null, account_provider: 'local', account_display_name: null, account_email: null, created_at: iso(-hour), updated_at: iso(-hour), ...patch,
});
const lists = [
  calendar({ id: 'list-home', name: 'Home', default_for_tasks: true, default_for_events: false }),
  calendar({ id: 'list-archive', name: 'Archive', auto_todo_enabled: false }),
  calendar({ id: 'cal-work', name: 'Work', account_id: 'caldav', account_provider: 'caldav', account_display_name: 'Work server', color: '#22c55e',
    default_for_events: true, write_block: null, takes_undated_tasks: false }),
  calendar({ id: 'cal-holidays', name: 'Holidays', account_id: 'ics', account_provider: 'ics', account_email: 'feeds@example.com', read_only: true, color: '#f59e0b',
    write_block: 'read_only', takes_undated_tasks: false }),
];

/** A promise answered by the test, so a request stays pending while the optimistic state is checked. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
// What the server holds; a refetch answers from it, a position request may update it.
let serverEvents: CalendarEvent[];
const serverRank = (id: string, rank: number) => { serverEvents = serverEvents.map(event => event.id === id ? { ...event, sort_rank: rank, hand_ordered: true } : event); };

function mount(ui: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/todo']}>{ui}</MemoryRouter></QueryClientProvider>) };
}
const openMenu = async (task: string) => {
  fireEvent.pointerDown(await screen.findByRole('button', { name: `More actions for ${task}` }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
};

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  serverEvents = undated;
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/calendar/events')) return { data: { events: serverEvents } };
    if (path === '/calendar/calendars') return { data: { calendars: lists } };
    if (path === '/settings/values') return userSettingsAnswer();
    return { data: { modules: [] } };
  });
  vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
    if (path.endsWith('/position')) return { data: { ranks: { [decodeURIComponent(path.split('/')[3])]: 150 } } };
    if (path.endsWith('/todo-status')) {
      const id = decodeURIComponent(path.split('/')[3]);
      return { data: { event: { ...(serverEvents.find(event => event.id === id) ?? undated[0]), ...(body as object) } } };
    }
    if (path === '/settings/values') return savedSettingsAnswer(body);
    return { data: { event: undated[0] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { event: undated[0] } });
});
// resetAllMocks also drops answers queued with mockReturnValueOnce that a test did not consume; beforeEach sets the implementations again.
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('the order of tasks', () => {
  it('follows the rank, then the server\'s sort_key (the id only without one), and gives an answer without ranks its date order', () => {
    // Equal ranks: the sort_key decides, as a plain string comparison, not the id.
    const a = task('a', { sort_rank: 5, sort_key: 'k-2' }), b = task('b', { sort_rank: 5, sort_key: 'k-1' }), c = task('c', { sort_rank: 1, sort_key: 'k-9' });
    expect(orderTasks([a, b, c]).map(t => t.id)).toEqual(['c', 'b', 'a']);
    expect(orderTasks([task('x', { sort_rank: 5, sort_key: 'B' }), task('y', { sort_rank: 5, sort_key: 'a' })]).map(t => t.id)).toEqual(['x', 'y']);
    // An answer without sort_key (an older server or snapshot) falls back to the id; the key is never made up here.
    expect(orderTasks([task('b', { sort_rank: 5 }), task('a', { sort_rank: 5 })]).map(t => t.id)).toEqual(['a', 'b']);
    const later = task('later', { sort_rank: undefined, start_time: iso(5 * hour) });
    const sooner = task('sooner', { sort_rank: undefined, start_time: iso(hour) });
    const madeFirst = task('made first', { sort_rank: undefined, is_todo_only: true, created_at: iso(-10 * hour) });
    const madeLast = task('made last', { sort_rank: undefined, is_todo_only: true, created_at: iso(-hour) });
    expect(orderTasks([later, sooner]).map(t => t.id)).toEqual(['sooner', 'later']);
    expect(orderTasks([madeLast, madeFirst]).map(t => t.id)).toEqual(['made first', 'made last']);
    // The optimistic rank sits strictly between the neighbours, or just past the end.
    expect(rankBetween(undated[0], undated[1])).toBe(150);
    expect(rankBetween(null, undated[0])).toBe(99);
    expect(rankBetween(undated[2], null)).toBe(301);
    expect(neighboursAt(undated, 'Plan holiday', 0)).toEqual({ after: null, before: undated[0] });
    expect(neighboursAt(undated, 'Pay rent', 2)).toEqual({ after: undated[2], before: null });
  });

  it('moves a task up or down from its menu with its neighbours, disabled at the ends, and shows the new place at once', async () => {
    mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']);
    let menu = await openMenu('Pay rent');
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    menu = await openMenu('Plan holiday');
    expect(within(menu).getByRole('menuitem', { name: 'Move down' })).toHaveAttribute('aria-disabled', 'true');
    const answer = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(answer.promise as never);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
    // Shown between the two others while the server has not answered.
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Plan%20holiday/position', { after: 'Pay rent', before: 'Call Sam' }, { signal: expect.any(AbortSignal) }));
    expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']);
    // Then the server's rank is kept and the lists are fetched again.
    serverRank('Plan holiday', 150);
    const fetched = vi.mocked(api.get).mock.calls.length;
    await act(async () => { answer.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(fetched));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('says so when the server refuses and fetches the list again, which puts the task back; a list that changed meanwhile is reloaded', async () => {
    const answer = deferred<{ error: string; status: number }>();
    vi.mocked(api.put).mockReturnValueOnce(answer.promise as never);
    mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    const listCalls = () => vi.mocked(api.get).mock.calls.filter(call => String(call[0]).startsWith('/calendar/events')).length;
    let before = listCalls();
    fireEvent.click(within(await openMenu('Call Sam')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(titles()).toEqual(['Call Sam', 'Pay rent', 'Plan holiday']));
    expect(listCalls()).toBe(before);
    await act(async () => { answer.resolve({ error: 'Database unavailable', status: 500 }); });
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move the task', description: 'Database unavailable', variant: 'destructive' }));
    // Nothing is guessed back: the server's answer to the refresh holds the order.
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']));

    vi.mocked(api.put).mockResolvedValueOnce({ error: 'The list changed in the meantime. It has been reloaded; try again.', status: 409, code: 'ORDER_STALE' });
    before = listCalls();
    fireEvent.click(within(await openMenu('Call Sam')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'The list changed in the meantime', description: 'It has been reloaded. Try again.' }));
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']));
    expect(state.toast).toHaveBeenCalledTimes(2);
  });

  it('keeps done tasks without handles and menus', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/calendar/events')) return { data: { events: [task('Filed taxes', { todo_status: 'done', done_at: iso(-hour) })] } };
      if (path === '/calendar/calendars') return { data: { calendars: lists } };
      return { data: { modules: [] } };
    });
    mount(<TodoPage />);
    // The done view lists the task; nothing on it reorders.
    cleanup();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/todo?view=done']}><TodoPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('Filed taxes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reorder/ })).not.toBeInTheDocument();
  });
});

describe('the sortable list', () => {
  // dnd-kit measures rows; jsdom reports no sizes, so each row gets a box from its place in the list.
  const measured = () => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const row = (this as Element).closest('li');
      const index = row?.parentElement ? Array.from(row.parentElement.children).indexOf(row) : 0;
      const top = index * 50;
      return { x: 0, y: top, top, left: 0, width: 400, height: 50, right: 400, bottom: top + 50, toJSON() { return this; } } as DOMRect;
    };
    return () => { Element.prototype.getBoundingClientRect = original; };
  };

  it('reorders with the keyboard from the handle: Space picks up, the arrows move, Space drops, and it is announced', async () => {
    const restore = measured();
    try {
      const onReorder = vi.fn();
      const items = ['Pay rent', 'Call Sam', 'Plan holiday'];
      render(
        <SortableList items={items} getId={item => item} getName={item => item} label="No date" onReorder={onReorder}>
          {(item, row) => <li key={item} ref={row.setNodeRef} style={row.style}>{item}<DragHandle {...row.handle} label={`Reorder ${item}`} /></li>}
        </SortableList>,
      );
      const handle = screen.getByRole('button', { name: 'Reorder Pay rent' });
      expect(handle).toHaveAttribute('aria-describedby');
      expect(document.getElementById(handle.getAttribute('aria-describedby')!)).toHaveTextContent('Press Space to pick up, the arrow keys to move, Space to drop, Escape to cancel.');
      handle.focus();
      await act(async () => { fireEvent.keyDown(handle, { code: 'Space', key: ' ' }); });
      await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'));
      expect(screen.getByRole('status')).toHaveTextContent('Picked up Pay rent, position 1 of 3 in No date.');
      await act(async () => { fireEvent.keyDown(handle, { code: 'ArrowDown', key: 'ArrowDown' }); });
      await act(async () => { fireEvent.keyDown(handle, { code: 'Space', key: ' ' }); });
      await waitFor(() => expect(onReorder).toHaveBeenCalledWith(expect.objectContaining({ from: 0, to: 1, after: 'Call Sam', before: 'Plan holiday', order: ['Call Sam', 'Pay rent', 'Plan holiday'] })));
      expect(screen.getByRole('status')).toHaveTextContent('Pay rent dropped at position 2 of 3 in No date.');
      // Focus stays on the handle, so the next move can follow at once (P-12).
      await waitFor(() => expect(document.activeElement).toBe(handle));
    } finally { restore(); }
  });

  // A pointer drag on the handle: pressed, moved past the 4 px that start a drag, let go.
  const pointerDrag = (handle: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) => {
    fireEvent.mouseDown(handle, { clientX: from.x, clientY: from.y, button: 0 });
    fireEvent.mouseMove(document, { clientX: from.x, clientY: from.y + 6 });
    fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y });
    fireEvent.mouseUp(document, { clientX: to.x, clientY: to.y });
  };

  /**
   * Rows of the given heights, stacked from 0 in a list 400 px wide; a dragged
   * row's box follows its transform, scaled about its centre as the browser
   * does (dnd-kit scales the dragged row to the row it is over).
   */
  const stacked = (heights: number[]) => {
    const original = Element.prototype.getBoundingClientRect;
    const tops = heights.map((_, index) => heights.slice(0, index).reduce((sum, height) => sum + height, 0));
    const total = heights.reduce((sum, height) => sum + height, 0);
    Element.prototype.getBoundingClientRect = function () {
      const row = (this as HTMLElement).closest('li');
      if (!row) return { x: 0, y: 0, top: 0, left: 0, width: 400, height: total, right: 400, bottom: total, toJSON() { return this; } } as DOMRect;
      const index = row.parentElement ? Array.from(row.parentElement.children).indexOf(row) : 0;
      const shift = Number(/translate3d\([^,]*,\s*(-?[\d.]+)px/.exec(row.style.transform ?? '')?.[1] ?? 0);
      const scale = Number(/scaleY\(([\d.]+)\)/.exec(row.style.transform ?? '')?.[1] ?? 1);
      const height = heights[index] * scale;
      const top = tops[index] + shift + (heights[index] - height) / 2;
      return { x: 0, y: top, top, left: 0, width: 400, height, right: 400, bottom: top + height, toJSON() { return this; } } as DOMRect;
    };
    return () => { Element.prototype.getBoundingClientRect = original; };
  };
  const names = ['Pay rent', 'Call Sam', 'Plan holiday'];
  const renderList = (onReorder: (reorder: unknown) => void) => render(
    <SortableList items={names} getId={name => name} getName={name => name} label="No date" onReorder={onReorder}>
      {(name, row) => <li key={name} ref={row.setNodeRef} style={row.style}>{name}<DragHandle {...row.handle} label={`Reorder ${name}`} /></li>}
    </SortableList>,
  );
  const backAnnouncement = 'Dropped outside No date. Pay rent is back at position 1 of 3 in No date.';

  it('puts a row back when the pointer lets go outside the list, and still places it last at the list\'s bottom edge', async () => {
    const restore = stacked([50, 50, 50]);
    const onReorder = vi.fn();
    try {
      renderList(onReorder);
      // Taken hold of at the first row's middle, let go 200 px below the list (another section): nothing.
      pointerDrag(screen.getByRole('button', { name: 'Reorder Pay rent' }), { x: 380, y: 25 }, { x: 380, y: 350 });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(backAnnouncement));
      expect(onReorder).not.toHaveBeenCalled();
      // Let go just inside the bottom edge: last.
      pointerDrag(screen.getByRole('button', { name: 'Reorder Pay rent' }), { x: 380, y: 25 }, { x: 380, y: 145 });
      await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
      expect(onReorder.mock.calls[0][0]).toMatchObject({ item: 'Pay rent', from: 0, to: 2, after: 'Plan holiday', before: null });
    } finally { restore(); }
  });

  it('judges the drop by the pointer, not by the dragged row\'s box, when rows differ in height', async () => {
    // A tall row (a description, subtasks) dragged over short ones shrinks to their height: let go at 235, inside a list ending at 250, it is placed.
    let restore = stacked([150, 50, 50]);
    const onReorder = vi.fn();
    try {
      const { unmount } = renderList(onReorder);
      pointerDrag(screen.getByRole('button', { name: 'Reorder Pay rent' }), { x: 380, y: 25 }, { x: 380, y: 235 });
      await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
      expect(onReorder.mock.calls[0][0]).toMatchObject({ item: 'Pay rent', from: 0, to: 2 });
      unmount();
      restore();
      // A short row dragged over a tall one grows: let go at 275, below the list's end at 250, it goes back.
      restore = stacked([50, 50, 150]);
      onReorder.mockClear();
      renderList(onReorder);
      pointerDrag(screen.getByRole('button', { name: 'Reorder Pay rent' }), { x: 380, y: 25 }, { x: 380, y: 275 });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(backAnnouncement));
      expect(onReorder).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('judges the drop by the release itself, not by the last move before it', async () => {
    const restore = stacked([50, 50, 50]);
    const onReorder = vi.fn();
    try {
      renderList(onReorder);
      const handle = () => screen.getByRole('button', { name: 'Reorder Pay rent' });
      // The last move just inside the list's right edge, the release just outside it: back.
      fireEvent.mouseDown(handle(), { clientX: 380, clientY: 25, button: 0 });
      fireEvent.mouseMove(document, { clientX: 380, clientY: 31 });
      fireEvent.mouseMove(document, { clientX: 399, clientY: 125 });
      fireEvent.mouseUp(document, { clientX: 401, clientY: 125 });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(backAnnouncement));
      expect(onReorder).not.toHaveBeenCalled();
      // The reverse: the last move outside, the release inside: placed.
      fireEvent.mouseDown(handle(), { clientX: 380, clientY: 25, button: 0 });
      fireEvent.mouseMove(document, { clientX: 380, clientY: 31 });
      fireEvent.mouseMove(document, { clientX: 401, clientY: 125 });
      fireEvent.mouseUp(document, { clientX: 399, clientY: 125 });
      await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
      expect(onReorder.mock.calls[0][0]).toMatchObject({ item: 'Pay rent', from: 0, to: 2 });
    } finally { restore(); }
  });

  it('follows the finger that started a touch drag to where it lifts, and no other input', async () => {
    const restore = stacked([50, 50, 50]);
    const onReorder = vi.fn();
    const finger = (clientX: number, clientY: number, identifier = 1) => ({ clientX, clientY, identifier });
    // Touch events go to the element the finger landed on, as a browser delivers them.
    const touchDrag = async (moves: Array<{ x: number; y: number }>, lift: { x: number; y: number }, meanwhile?: () => void) => {
      const handle = screen.getByRole('button', { name: 'Reorder Pay rent' });
      fireEvent.touchStart(handle, { touches: [finger(380, 25)], changedTouches: [finger(380, 25)] });
      // The touch sensor picks the row up after a 250 ms hold.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
      for (const move of moves) fireEvent.touchMove(handle, { touches: [finger(move.x, move.y)], changedTouches: [finger(move.x, move.y)] });
      meanwhile?.();
      // The finger that lifts is in changedTouches only.
      fireEvent.touchEnd(handle, { touches: [], changedTouches: [finger(lift.x, lift.y)] });
    };
    try {
      renderList(onReorder);
      // Lifted just outside the list after moving inside it: back.
      await touchDrag([{ x: 380, y: 125 }], { x: 401, y: 125 });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(backAnnouncement));
      expect(onReorder).not.toHaveBeenCalled();
      // A second pointer moving inside the list while the finger is outside changes nothing: still back.
      await touchDrag([{ x: 401, y: 125 }], { x: 401, y: 125 }, () => {
        fireEvent.pointerMove(window, { clientX: 380, clientY: 125, pointerId: 2, pointerType: 'touch' });
        fireEvent.mouseMove(window, { clientX: 380, clientY: 125 });
      });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(backAnnouncement));
      expect(onReorder).not.toHaveBeenCalled();
      // And the control: lifted inside, placed.
      await touchDrag([{ x: 380, y: 125 }], { x: 380, y: 125 });
      await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
    } finally { restore(); }
  });

  it('puts a row back when the pointer lets go beside the list, although the row itself cannot leave it sideways', async () => {
    const restore = stacked([50, 50, 50]);
    const onReorder = vi.fn();
    try {
      renderList(onReorder);
      // Moved down one row and 150 px to the right of the list (400 px wide).
      pointerDrag(screen.getByRole('button', { name: 'Reorder Pay rent' }), { x: 380, y: 25 }, { x: 550, y: 125 });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(backAnnouncement));
      expect(onReorder).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('cancels with Escape and leaves the order alone', async () => {
    const restore = measured();
    try {
      const onReorder = vi.fn();
      render(
        <SortableList items={['One', 'Two']} getId={item => item} getName={item => item} label="Pages" onReorder={onReorder}>
          {(item, row) => <li key={item} ref={row.setNodeRef} style={row.style}>{item}<DragHandle {...row.handle} label={`Reorder ${item}`} /></li>}
        </SortableList>,
      );
      const handle = screen.getByRole('button', { name: 'Reorder Two' });
      handle.focus();
      await act(async () => { fireEvent.keyDown(handle, { code: 'Space', key: ' ' }); });
      await act(async () => { fireEvent.keyDown(handle, { code: 'ArrowUp', key: 'ArrowUp' }); });
      await act(async () => { fireEvent.keyDown(handle, { code: 'Escape', key: 'Escape' }); });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reordering cancelled. Two is back at position 2 of 2 in Pages.'));
      expect(onReorder).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});

describe('placements that overlap', () => {
  it('sends the next placement once the first has answered, shows the newer place throughout and ends at the server\'s ranks', async () => {
    const first = deferred<{ data?: { ranks: Record<string, number> }; error?: string; status?: number }>();
    const second = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);
    const { client } = mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    const cached = (id: string) => client.getQueriesData<CalendarEvent[]>({ queryKey: calendarQueryKeys.all }).flatMap(([, events]) => events ?? []).find(event => event.id === id)!;
    const listCalls = () => vi.mocked(api.get).mock.calls.filter(call => String(call[0]).startsWith('/calendar/events')).length;
    const fetched = listCalls();
    // Plan holiday moves up once (to the middle), then up again (to the top) before the first answer.
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(titles()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']));
    // The second request waits for the first: only one is in flight.
    expect(api.put).toHaveBeenCalledTimes(1);
    // The first answer (rank 150, the middle) arrives: the newer place stays shown, and the second request goes out.
    serverRank('Plan holiday', 150);
    await act(async () => { first.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    expect(titles()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put).toHaveBeenLastCalledWith('/calendar/events/Plan%20holiday/position', { after: null, before: 'Pay rent' }, { signal: expect.any(AbortSignal) });
    expect(listCalls()).toBe(fetched);
    serverRank('Plan holiday', 50);
    await act(async () => { second.resolve({ data: { ranks: { 'Plan holiday': 50 } } }); });
    expect(cached('Plan holiday').sort_rank).toBe(50);
    // The queue is empty: one refresh, and the order is the server's.
    await waitFor(() => expect(listCalls()).toBe(fetched + 1));
    await waitFor(() => expect(titles()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']));

    // The same with a failure of the first: nothing is put back by guessing,
    // the second still goes out, and the refresh after it holds the server's order.
    const third = deferred<{ error: string; status: number }>();
    const fourth = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(third.promise as never).mockReturnValueOnce(fourth.promise as never);
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']));
    expect(api.put).toHaveBeenCalledTimes(3);
    await act(async () => { third.resolve({ error: 'Database unavailable', status: 500 }); });
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move the task' }));
    expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(4));
    serverRank('Plan holiday', 400);
    await act(async () => { fourth.resolve({ data: { ranks: { 'Plan holiday': 400 } } }); });
    await waitFor(() => expect(cached('Plan holiday').sort_rank).toBe(400));
    await waitFor(() => expect(listCalls()).toBe(fetched + 2));
    expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']);
  });

  it('keeps the requested place while neighbours tie on rank, whatever their sort_key', async () => {
    // By sort_key the tied three read a, c, z; z is dropped between a and c.
    const a = task('a', { is_todo_only: true, sort_rank: 100, sort_key: 'k-1' }), c = task('c', { is_todo_only: true, sort_rank: 100, sort_key: 'k-2' }), z = task('z', { is_todo_only: true, sort_rank: 100, sort_key: 'k-0' });
    const ranks = optimisticRanks([a, z, c], 'z');
    expect(orderTasks([a, c, z].map(entry => ({ ...entry, sort_rank: ranks[entry.id] ?? entry.sort_rank }))).map(entry => entry.id)).toEqual(['a', 'z', 'c']);
    // Only the moved task counts as placed by hand; a tie elsewhere is nudged, not claimed.
    expect(ranks.z).toBeGreaterThan(ranks.a ?? 100);
    expect(ranks.c).toBeGreaterThan(ranks.z);

    serverEvents = [a, c, z];
    const answer = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(answer.promise as never);
    mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    expect(titles()).toEqual(['z', 'a', 'c']);
    // Move z below a (between a and c): the requested place shows at once although every key says otherwise.
    fireEvent.click(within(await openMenu('z')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/z/position', { after: 'a', before: 'c' }, { signal: expect.any(AbortSignal) }));
    expect(titles()).toEqual(['a', 'z', 'c']);
    serverRank('z', 100); serverRank('c', 101);
    await act(async () => { answer.resolve({ data: { ranks: { z: 100, c: 101 } } }); });
    await waitFor(() => expect(titles()).toEqual(['a', 'z', 'c']));
  });

  it('keeps the requested place while neighbours tie on rank and have no sort_key', async () => {
    const a = task('a', { is_todo_only: true, sort_rank: 100 }), c = task('c', { is_todo_only: true, sort_rank: 100 }), z = task('z', { is_todo_only: true, sort_rank: 100 });
    serverEvents = [a, c, z];
    const answer = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(answer.promise as never);
    mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    expect(titles()).toEqual(['a', 'c', 'z']);
    fireEvent.click(within(await openMenu('z')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/z/position', { after: 'a', before: 'c' }, { signal: expect.any(AbortSignal) }));
    expect(titles()).toEqual(['a', 'z', 'c']);
    serverRank('z', 100); serverRank('c', 101);
    await act(async () => { answer.resolve({ data: { ranks: { z: 100, c: 101 } } }); });
    await waitFor(() => expect(titles()).toEqual(['a', 'z', 'c']));
  });

  it('keeps what changed meanwhile when a subtask reorder fails, and the refresh restores the order', async () => {
    const parent = task('Car service', { is_todo_only: true, sort_rank: 100, subtasks: [
      { id: 's0', event_id: 'Car service', user_id: 'owner', title: 'Call the garage', is_done: false, position: 0, created_at: iso(-hour), updated_at: iso(-hour) },
      { id: 's1', event_id: 'Car service', user_id: 'owner', title: 'Book a slot', is_done: false, position: 1, created_at: iso(-hour), updated_at: iso(-hour) },
    ] });
    serverEvents = [parent, undated[1]];
    const answer = deferred<{ error: string; status: number }>();
    vi.mocked(api.post).mockReturnValueOnce(answer.promise as never);
    const { client } = mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const subtaskTitles = () => within(within(section).getByRole('list', { name: 'Subtasks' })).getAllByRole('checkbox').map(box => box.getAttribute('aria-label'));
    fireEvent.click(screen.getByRole('button', { name: 'Move Book a slot up' }));
    await waitFor(() => expect(subtaskTitles()).toEqual(['Book a slot', 'Call the garage']));
    // Meanwhile another task changed in the cache (another device's answer, a tick, a rename).
    const key = calendarQueryKeys.list({ includeTodos: true, respectAutoTodo: true });
    client.setQueryData<CalendarEvent[]>(key, events => events!.map(event => event.id === 'Call Sam' ? { ...event, title: 'Call Sam back', sort_rank: 5 } : event));
    serverEvents = serverEvents.map(event => event.id === 'Call Sam' ? { ...event, title: 'Call Sam back', sort_rank: 5 } : event);
    await act(async () => { answer.resolve({ error: 'Database unavailable', status: 500 }); });
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not reorder the subtasks' }));
    // The server's answer to the refresh holds the order; what changed meanwhile is in it too.
    await waitFor(() => expect(subtaskTitles()).toEqual(['Call the garage', 'Book a slot']));
    expect(client.getQueryData<CalendarEvent[]>(key)!.find(event => event.id === 'Call Sam')).toMatchObject({ title: 'Call Sam back', sort_rank: 5 });
  });
});

describe('the new-task dialog while lists change', () => {
  function Host({ calendars }: { calendars: CalendarCalendar[] }) {
    const actions = useTaskActions();
    return <NewTaskDialog open onOpenChange={() => {}} actions={actions} timezone="UTC" calendars={calendars} />;
  }
  it('keeps what was typed when the lists are fetched again, and only moves a vanished or blocked choice', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrap = (calendars: CalendarCalendar[]) => <QueryClientProvider client={client}><MemoryRouter><Host calendars={calendars} /></MemoryRouter></QueryClientProvider>;
    const { rerender } = render(wrap(lists));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    const chooser = () => within(dialog).getByRole('combobox', { name: 'List' });
    await waitFor(() => expect(chooser()).toHaveTextContent('Home'));
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Buy stamps' } });
    // A refreshed answer with the same lists (new array) changes nothing.
    rerender(wrap(lists.map(list => ({ ...list }))));
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Buy stamps');
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    // Another list added elsewhere: still nothing.
    const extra = calendar({ id: 'list-extra', name: 'Errands' });
    rerender(wrap([...lists, extra]));
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Buy stamps');
    expect(chooser()).toHaveTextContent('Home');
    // The chosen list vanishes: the selection moves to the list now in effect (Errands, the first own list shown in ToDo), with a note; the title stays.
    rerender(wrap([...lists.filter(list => list.id !== 'list-home'), extra]));
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('The list chosen before is no longer available; Errands is chosen instead.'));
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Buy stamps');
    expect(chooser()).toHaveTextContent('Errands');
  });
});

describe('the move dialog opened again', () => {
  function Host({ task, onClose }: { task: CalendarEvent | null; onClose: () => void }) {
    const actions = useTaskActions();
    return <MoveListDialog task={task} onClose={onClose} actions={actions} calendars={lists} />;
  }
  const wrap = (ui: React.ReactNode, client: QueryClient) => <QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
  it('ignores the answer to an earlier task\'s move', async () => {
    const first = deferred<{ data: { event: null; pending: 'creating' } }>();
    vi.mocked(api.post).mockReturnValueOnce(first.promise as never);
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { rerender } = render(wrap(<Host task={undated[0]} onClose={onClose} />, client));
    const dialog = await screen.findByRole('dialog', { name: 'Move to another list' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'New list' }));
    fireEvent.click(await screen.findByRole('option', { name: /Archive/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events/Pay%20rent/move', { calendar_id: 'list-archive' }, { signal: expect.any(AbortSignal) }));
    // Closed, then opened for another task while the first move is still unanswered.
    rerender(wrap(<Host task={null} onClose={onClose} />, client));
    rerender(wrap(<Host task={undated[1]} onClose={onClose} />, client));
    const second = await screen.findByRole('dialog', { name: 'Move to another list' });
    expect(second).toHaveTextContent('Call Sam');
    await act(async () => { first.resolve({ data: { event: null, pending: 'creating' } }); });
    expect(within(second).queryByRole('status')).not.toBeInTheDocument();
    expect(within(second).getByRole('combobox', { name: 'New list' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // A completed answer to an earlier move does not close this dialog either.
    const third = deferred<{ data: { event: CalendarEvent } }>();
    vi.mocked(api.post).mockReturnValueOnce(third.promise as never);
    fireEvent.click(within(second).getByRole('combobox', { name: 'New list' }));
    fireEvent.click(await screen.findByRole('option', { name: /Archive/ }));
    fireEvent.click(within(second).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    rerender(wrap(<Host task={null} onClose={onClose} />, client));
    rerender(wrap(<Host task={undated[2]} onClose={onClose} />, client));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Move to another list' })).toHaveTextContent('Plan holiday'));
    await act(async () => { third.resolve({ data: { event: { ...undated[1], calendar_id: 'list-archive' } } }); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Move to another list' })).toHaveTextContent('Plan holiday');
  });
});

describe('an item still being moved', () => {
  const movePending = { error: 'This item is still being moved to another calendar. UniHub finishes the move when the calendar server answers; try again then.', status: 409, code: 'CALENDAR_MOVE_PENDING' };

  it('says so plainly on a tick, a placement or a move, and leaves the row and the cache as they are', async () => {
    vi.mocked(api.put).mockResolvedValue(movePending);
    vi.mocked(api.post).mockResolvedValue(movePending);
    const { client } = mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    const key = calendarQueryKeys.list({ includeTodos: true, respectAutoTodo: true });
    const before = client.getQueryData<CalendarEvent[]>(key)!;
    fireEvent.click(within(section).getByRole('button', { name: 'Mark Pay rent done' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'Still being moved to another list', description: 'UniHub finishes the move when the calendar server answers. Try again in a moment.' }));
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(within(section).getByRole('button', { name: 'Mark Pay rent done' })).toBeInTheDocument();
    fireEvent.click(within(await openMenu('Call Sam')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledTimes(2));
    expect(state.toast).toHaveBeenLastCalledWith({ title: 'Still being moved to another list', description: 'UniHub finishes the move when the calendar server answers. Try again in a moment.' });
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']));
    expect(client.getQueryData<CalendarEvent[]>(key)!.map(event => [event.id, event.sort_rank, event.hand_ordered])).toEqual(before.map(event => [event.id, event.sort_rank, event.hand_ordered]));
    fireEvent.click(within(await openMenu('Pay rent')).getByRole('menuitem', { name: 'Move to another list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to another list' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'New list' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /Archive/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledTimes(3));
    expect(state.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Still being moved to another list' }));
    expect(screen.getByRole('dialog', { name: 'Move to another list' })).toBeInTheDocument();
  });
});

describe('the event dialog moving an event', () => {
  const accounts = [
    { id: 'local', provider: 'local' }, { id: 'caldav', provider: 'caldav' }, { id: 'ics', provider: 'ics' },
  ] as never;
  function Host({ event, onClose }: { event: CalendarEvent | null; onClose: () => void }) {
    const actions = useEventActions();
    // The page keeps the open target in state; a new object per render would read as another opening.
    const target = useMemo(() => (event ? { kind: 'edit' as const, event } : null), [event]);
    return <EventDialog target={target} onClose={onClose} calendars={lists} accounts={accounts} actions={actions} timezone="UTC" />;
  }
  it('shows the pending move when the calendar server has not confirmed, and ignores an answer to an earlier opening', async () => {
    const dated = task('Dentist', { calendar_id: 'list-home' });
    const answer = deferred<{ data: { event: CalendarEvent; pending: 'creating' } }>();
    vi.mocked(api.put).mockReturnValueOnce(answer.promise as never);
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrap = (event: CalendarEvent | null) => <QueryClientProvider client={client}><MemoryRouter><Host event={event} onClose={onClose} /></MemoryRouter></QueryClientProvider>;
    const { rerender } = render(wrap(dated));
    const dialog = await screen.findByRole('dialog', { name: 'Edit event' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Calendar' }));
    fireEvent.click(await screen.findByRole('option', { name: /Work/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Dentist', expect.objectContaining({ calendar_id: 'cal-work' })));
    // Closed and opened for another event before the server answers: the late answer changes nothing there.
    rerender(wrap(null));
    rerender(wrap(task('Haircut', { calendar_id: 'list-home' })));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Edit event' })).getByLabelText('Title')).toHaveValue('Haircut'));
    await act(async () => { answer.resolve({ data: { event: { ...dated, calendar_id: 'cal-work' }, pending: 'creating' } }); });
    expect(within(screen.getByRole('dialog')).queryByRole('status')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Moving…' }));

    // The dialog that submitted the move stays open with the pending state until closed.
    vi.mocked(api.put).mockResolvedValueOnce({ data: { event: { ...dated, calendar_id: 'cal-work' }, pending: 'creating' } });
    const second = screen.getByRole('dialog', { name: 'Edit event' });
    fireEvent.click(within(second).getByRole('combobox', { name: 'Calendar' }));
    fireEvent.click(await screen.findByRole('option', { name: /Work/ }));
    fireEvent.click(within(second).getByRole('button', { name: 'Save' }));
    expect(await within(second).findByRole('status')).toHaveTextContent('Moving… UniHub finishes this in the background and the event shows in Work once the calendar server has stored it.');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(second).getAllByRole('button', { name: 'Close' }).find(button => !button.querySelector('svg'))!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('subtasks offline', () => {
  function Row({ item, canReorder }: { item: CalendarEvent; canReorder: boolean }) {
    const actions: TaskActions = useTaskActions();
    return <ul><TaskRow task={item} actions={actions} timezone="UTC" onEdit={() => {}} onMove={() => {}} canReorder={canReorder} /></ul>;
  }
  it('shows no subtask handles when the order cannot be changed', async () => {
    const parent = task('Car service', { is_todo_only: true, subtasks: [{ id: 's0', event_id: 'Car service', user_id: 'owner', title: 'Call the garage', is_done: false, position: 0, created_at: iso(-hour), updated_at: iso(-hour) }] });
    mount(<Row item={parent} canReorder={false} />);
    expect(await screen.findByRole('checkbox', { name: 'Call the garage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reorder Call the garage' })).not.toBeInTheDocument();
    cleanup();
    mount(<Row item={parent} canReorder />);
    expect(await screen.findByRole('button', { name: 'Reorder Call the garage' })).toBeInTheDocument();
  });
});

describe('the list chooser', () => {
  it('names the reasons a list cannot take a task, and preselects the default the server marks', async () => {
    expect(defaultTaskList(lists)?.id).toBe('list-home');
    expect(listRefusal(lists[2], { undated: true })).toBe('Tasks without a date stay in UniHub');
    expect(listRefusal(lists[2], { undated: false })).toBeNull();
    expect(listRefusal(lists[3], { undated: false })).toBe('Read-only');
    // Without the server's marks (an older server) the first own list shown in ToDo stands in.
    expect(defaultTaskList(lists.map(list => normalizeCalendar({ ...list, default_for_tasks: undefined, takes_undated_tasks: undefined, write_block: undefined } as never)))?.id).toBe('list-home');

    mount(<TodoPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    const chooser = within(dialog).getByRole('combobox', { name: 'List' });
    await waitFor(() => expect(chooser).toHaveTextContent('Home'));
    fireEvent.click(chooser);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('On this UniHub')).toBeInTheDocument();
    expect(within(listbox).getByText('Work server')).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /Work/ })).toHaveAttribute('aria-disabled', 'true');
    expect(within(listbox).getByRole('option', { name: /Work/ })).toHaveTextContent('Tasks without a date stay in UniHub');
    expect(within(listbox).getByRole('option', { name: /Holidays/ })).toHaveTextContent('Read-only');
    expect(within(listbox).getByRole('option', { name: /Archive/ })).toHaveTextContent('Not shown in ToDo');
    fireEvent.keyDown(listbox, { key: 'Escape' });

    // With a time, the server calendar can take the task; the chosen list goes with the request.
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Give it a time in the calendar' }));
    fireEvent.click(chooser);
    const work = await screen.findByRole('option', { name: /Work/ });
    expect(work).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(work);
    await waitFor(() => expect(chooser).toHaveTextContent('Work'));
    // Taking the time away again sends the task back to the default list.
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Give it a time in the calendar' }));
    await waitFor(() => expect(chooser).toHaveTextContent('Home'));
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Buy stamps' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events', expect.objectContaining({ title: 'Buy stamps', calendar_id: 'list-home', is_todo_only: true })));
  });

  it('offers Move to another list and sends the task there; a refused move says why', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Moving to another list is not available yet.', status: 501, code: 'NOT_IMPLEMENTED' });
    mount(<TodoPage />);
    fireEvent.click(within(await openMenu('Pay rent')).getByRole('menuitem', { name: 'Move to another list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to another list' });
    expect(dialog).toHaveTextContent('now in Home');
    const chooser = within(dialog).getByRole('combobox', { name: 'New list' });
    fireEvent.click(chooser);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: /Home/ })).toHaveTextContent('Current list');
    fireEvent.click(within(listbox).getByRole('option', { name: /Archive/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events/Pay%20rent/move', { calendar_id: 'list-archive' }, { signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move the task', description: 'Moving to another list is not available yet.' })));

    // A calendar server that has not confirmed yet: the dialog says so and stays until closed.
    vi.mocked(api.post).mockResolvedValueOnce({ data: { event: null, pending: 'creating' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Moving… UniHub finishes this in the background');
    // The footer's Close, not the dialog's corner X (also named Close).
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).find(button => !button.querySelector('svg'))!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Only the old copy still to remove: the task is in its new list, so the
    // dialog closes as moved; an old copy changed elsewhere is mentioned.
    vi.mocked(api.post).mockResolvedValueOnce({ data: { event: null, pending: 'removing', source_kept: true } });
    fireEvent.click(within(await openMenu('Pay rent')).getByRole('menuitem', { name: 'Move to another list' }));
    const again = await screen.findByRole('dialog', { name: 'Move to another list' });
    fireEvent.click(within(again).getByRole('combobox', { name: 'New list' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /Archive/ }));
    fireEvent.click(within(again).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Task moved to Archive', description: expect.stringMatching(/stays in the old calendar too/) }));
  });
});

describe('the default list and calendar in Settings', () => {
  it('saves the chosen list, greys out a locked one, and says where tasks go when the choice is gone', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/calendar/calendars') return { data: { calendars: lists } };
      if (path === '/settings/values') {
        const answer = userSettingsAnswer({ default_task_list_id: 'list-gone', default_calendar_id: 'cal-work' });
        answer.data.settings.default_calendar_id = { ...answer.data.settings.default_calendar_id, locked: true, source: 'policy' };
        return answer;
      }
      throw new Error(`unexpected GET ${path}`);
    });
    mount(<GeneralSettings />);
    const list = await screen.findByRole('combobox', { name: 'New tasks go to' });
    await waitFor(() => expect(list).toHaveTextContent('Let UniHub choose'));
    expect(screen.getByText(/The list chosen before is no longer available; new tasks go to Home/)).toBeInTheDocument();
    const calendar = screen.getByRole('combobox', { name: 'New events go to' });
    expect(calendar).toBeDisabled();
    expect(calendar).toHaveTextContent('Work');
    expect(screen.getAllByText('Set by your administrator').length).toBeGreaterThan(0);

    fireEvent.click(list);
    const listbox = await screen.findByRole('listbox');
    // Only own lists shown in ToDo qualify: no server calendar, no list hidden from ToDo.
    expect(within(listbox).queryByRole('option', { name: /Work/ })).not.toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /Archive/ })).not.toBeInTheDocument();
    fireEvent.click(within(listbox).getByRole('option', { name: /Home/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { default_task_list_id: 'list-home' } }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'New tasks go to' })).toHaveTextContent('Home'));
  });
});

describe('the query cache after a reorder', () => {
  it('writes the server ranks into every cached list, so Today shows the same order', async () => {
    const { client } = mount(<TodoPage />);
    await screen.findByRole('region', { name: 'No date' });
    client.setQueryData(calendarQueryKeys.list({ includeTodos: true, includeDone: false, respectAutoTodo: true }), undated);
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    await waitFor(() => {
      const today = client.getQueryData<CalendarEvent[]>(calendarQueryKeys.list({ includeTodos: true, includeDone: false, respectAutoTodo: true }))!;
      expect(today.find(t => t.id === 'Plan holiday')).toMatchObject({ sort_rank: 150, hand_ordered: true });
    });
  });
});

// The hook alone, with the page's list query: the scenarios of the second
// review round, which need two or three writes pending at once.
let probeActions: TaskActions;
const probeKey = calendarQueryKeys.list({ includeTodos: true, respectAutoTodo: true });
function ProbeHost() {
  probeActions = useTaskActions();
  useQuery({ queryKey: probeKey, queryFn: ({ signal }) => calendarApi.fetchEvents({ includeTodos: true, respectAutoTodo: true }, signal) });
  return null;
}
async function probeMount() {
  const mounted = mount(<ProbeHost />);
  await waitFor(() => expect(mounted.client.getQueryData(probeKey)).toBeDefined());
  return mounted;
}
const undatedSection = { key: 'undated', of: (task: CalendarEvent) => taskSection(task, 'UTC') };
const pair = (eventId: string) => ['s0', 's1'].map((id, position) => ({ id, event_id: eventId, user_id: 'owner', title: id, is_done: false, position, created_at: iso(-hour), updated_at: iso(-hour) }));
const listCalls = () => vi.mocked(api.get).mock.calls.filter(call => String(call[0]).startsWith('/calendar/events')).length;

describe('ordering writes in one queue', () => {
  it('sends an older placement\'s answer no later than a newer one: a neighbour placed again keeps its newer place', async () => {
    serverEvents = ['a', 'b', 'c'].map(id => task(id, { is_todo_only: true, sort_rank: 100, sort_key: id }));
    const first = deferred<{ data: { ranks: Record<string, number> } }>(), second = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);
    const { client } = await probeMount();
    const shown = () => orderTasks(client.getQueryData<CalendarEvent[]>(probeKey)!).map(event => event.id);
    const rank = (id: string) => client.getQueryData<CalendarEvent[]>(probeKey)!.find(event => event.id === id)!.sort_rank;
    // c between a and b, then b to the top: the second waits for the first.
    act(() => probeActions.placeTask(serverEvents, 'c', 1, undatedSection));
    await waitFor(() => expect(shown()).toEqual(['a', 'c', 'b']));
    act(() => probeActions.placeTask(orderTasks(client.getQueryData<CalendarEvent[]>(probeKey)!), 'b', 0, undatedSection));
    await waitFor(() => expect(shown()).toEqual(['b', 'a', 'c']));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    // The first answer spread the tied three, b last among them: b stays at the top it was given since.
    await act(async () => { first.resolve({ data: { ranks: { a: 32768, c: 65536, b: 98304 } } }); });
    expect(shown()).toEqual(['b', 'a', 'c']);
    expect([rank('a'), rank('c')]).toEqual([32768, 65536]);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put).toHaveBeenLastCalledWith('/calendar/events/b/position', { after: null, before: 'a' }, { signal: expect.any(AbortSignal) });
    const fetched = listCalls();
    serverEvents = serverEvents.map(event => ({ ...event, sort_rank: { a: 32768, b: 0, c: 65536 }[event.id] }));
    await act(async () => { second.resolve({ data: { ranks: { b: 0 } } }); });
    expect(rank('b')).toBe(0);
    await waitFor(() => expect(listCalls()).toBe(fetched + 1));
    expect(shown()).toEqual(['b', 'a', 'c']);
  });

  it('refreshes at once for another write and lays the pending order over the answer; a move waits its turn behind a placement and a subtask order', async () => {
    serverEvents = [...undated.map((entry, index) => index === 0 ? { ...entry, subtasks: pair(entry.id) } : entry), task('Archive me', { is_todo_only: true, sort_rank: 400 })];
    const placeAnswer = deferred<{ data: { ranks: Record<string, number> } }>(), subtaskAnswer = deferred<{ data: { subtasks: [] } }>(), moveAnswer = deferred<{ data: { event: CalendarEvent | null; pending?: string } }>();
    vi.mocked(api.put).mockReturnValueOnce(placeAnswer.promise as never);
    vi.mocked(api.post).mockReturnValueOnce(subtaskAnswer.promise as never).mockReturnValueOnce(moveAnswer.promise as never);
    const { client } = await probeMount();
    const data = () => client.getQueryData<CalendarEvent[]>(probeKey)!;
    const fetched = listCalls();
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.reorderSubtasks.mutate({ eventId: 'Pay rent', subtaskIds: ['s1', 's0'] }));
    act(() => probeActions.moveToList.mutate({ id: 'Archive me', calendarId: 'list-archive' }));
    await waitFor(() => expect(data()[0].subtasks.map(subtask => subtask.id)).toEqual(['s1', 's0']));
    expect(api.post).not.toHaveBeenCalled();
    // A tick answered meanwhile: its answer is in the cache at once, its refresh
    // runs at once, and the lists it fetches get the pending order laid over them again.
    serverEvents = serverEvents.map(event => event.id === 'Call Sam' ? { ...event, todo_status: 'done' as const } : event);
    act(() => probeActions.setStatus.mutate({ id: 'Call Sam', todo_status: 'done' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'Task done' }));
    expect(data().find(event => event.id === 'Call Sam')!.todo_status).toBe('done');
    await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(data().find(event => event.id === 'Plan holiday')!.sort_rank).toBe(150);
    expect(data()[0].subtasks.map(subtask => subtask.id)).toEqual(['s1', 's0']);
    expect(api.post).not.toHaveBeenCalled();
    serverEvents = serverEvents.map(event => event.id === 'Plan holiday' ? { ...event, sort_rank: 150 } : event);
    await act(async () => { placeAnswer.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenLastCalledWith('/calendar/events/Pay rent/subtasks/reorder', { subtask_ids: ['s1', 's0'] }, { signal: expect.any(AbortSignal) });
    serverEvents = serverEvents.map(event => event.id === 'Pay rent' ? { ...event, subtasks: [...event.subtasks].reverse() } : event);
    await act(async () => { subtaskAnswer.resolve({ data: { subtasks: [] } }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenLastCalledWith('/calendar/events/Archive%20me/move', { calendar_id: 'list-archive' }, { signal: expect.any(AbortSignal) });
    serverEvents = serverEvents.filter(event => event.id !== 'Archive me');
    const before = listCalls();
    await act(async () => { moveAnswer.resolve({ data: { event: task('Archive me', { calendar_id: 'list-archive' }), pending: 'removing' } }); });
    // The queue is empty: a refresh with everything the server holds.
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(orderTasks(data()).map(event => event.id)).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    expect(data()[0].subtasks.map(subtask => subtask.id)).toEqual(['s1', 's0']);
  });

  it('lays a pending subtask order over a list fetched meanwhile, and keeps a checkbox confirmed meanwhile when the reorder fails', async () => {
    serverEvents = undated.map((entry, index) => index === 0 ? { ...entry, subtasks: pair(entry.id) } : entry);
    const answer = deferred<{ error: string; status: number }>();
    vi.mocked(api.post).mockReturnValueOnce(answer.promise as never);
    const { client } = await probeMount();
    const subtasks = () => client.getQueryData<CalendarEvent[]>(probeKey)![0].subtasks.map(subtask => [subtask.id, subtask.is_done]);
    act(() => probeActions.reorderSubtasks.mutate({ eventId: 'Pay rent', subtaskIds: ['s1', 's0'] }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(subtasks()).toEqual([['s1', false], ['s0', false]]));
    // A fetch for another reason (a live-update hint, a tick's refresh elsewhere) brings s0 ticked: the pending order stays on top.
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: entry.subtasks.map(subtask => subtask.id === 's0' ? { ...subtask, is_done: true } : subtask) } : entry);
    await act(async () => { await client.refetchQueries({ queryKey: probeKey }); });
    expect(subtasks()).toEqual([['s1', false], ['s0', true]]);
    // The reorder fails: nothing from before it is put back, so the tick stays; the refresh then holds the server's order.
    const fetched = listCalls();
    await act(async () => { answer.resolve({ error: 'Could not reorder', status: 500 }); });
    expect(subtasks().find(([id]) => id === 's0')).toEqual(['s0', true]);
    await waitFor(() => expect(listCalls()).toBe(fetched + 1));
    await waitFor(() => expect(subtasks()).toEqual([['s0', true], ['s1', false]]));
  });

  it('keeps a newer placement of the same task while another write still delays the refresh', async () => {
    serverEvents = undated.map((entry, index) => index === 0 ? { ...entry, subtasks: pair(entry.id) } : entry);
    const first = deferred<{ data: { ranks: Record<string, number> } }>(), second = deferred<{ data: { ranks: Record<string, number> } }>(), hold = deferred<{ data: { subtasks: [] } }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);
    vi.mocked(api.post).mockReturnValueOnce(hold.promise as never);
    const { client } = await probeMount();
    const shown = () => orderTasks(client.getQueryData<CalendarEvent[]>(probeKey)!).map(event => event.id);
    const rank = () => client.getQueryData<CalendarEvent[]>(probeKey)!.find(event => event.id === 'Plan holiday')!.sort_rank;
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(shown()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    act(() => probeActions.placeTask(orderTasks(client.getQueryData<CalendarEvent[]>(probeKey)!), 'Plan holiday', 0, undatedSection));
    await waitFor(() => expect(shown()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']));
    act(() => probeActions.reorderSubtasks.mutate({ eventId: 'Pay rent', subtaskIds: ['s1', 's0'] }));
    await waitFor(() => expect(client.getQueryData<CalendarEvent[]>(probeKey)![0].subtasks[0].id).toBe('s1'));
    expect(api.put).toHaveBeenCalledTimes(1);
    const fetched = listCalls();
    await act(async () => { first.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    // The older answer (the middle) is in the cache, with the newer place laid over it.
    expect(shown()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve({ data: { ranks: { 'Plan holiday': 50 } } }); });
    expect(rank()).toBe(50);
    expect(shown()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']);
    // The subtask order is still pending, so no refresh could have repaired anything.
    expect(listCalls()).toBe(fetched);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await act(async () => { hold.resolve({ data: { subtasks: [] } }); });
    await waitFor(() => expect(listCalls()).toBe(fetched + 1));
  });
});

describe('a move the server refuses with a reason', () => {
  const chooseArchive = async (dialog: HTMLElement) => {
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'New list' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /Archive/ }));
  };
  it('says the reason plainly, keeps the dialog and the cache, and reloads the list after a conflict on the calendar server', async () => {
    const unsupported = 'This item shares its calendar entry with other items, so it cannot be moved on its own.';
    const changed = 'The event was changed on the calendar server in the meantime. It is being refreshed; please review it and try again.';
    const recurring = 'Recurring events cannot be moved to another calendar.';
    vi.mocked(api.post)
      .mockResolvedValueOnce({ error: unsupported, status: 400, code: 'CALENDAR_MOVE_UNSUPPORTED' })
      .mockResolvedValueOnce({ error: changed, status: 409, code: 'CALDAV_CONFLICT' })
      .mockResolvedValueOnce({ error: recurring, status: 400, code: 'CALENDAR_RECURRING_MOVE' });
    const { client } = mount(<TodoPage />);
    await screen.findByRole('region', { name: 'No date' });
    const before = client.getQueryData<CalendarEvent[]>(probeKey)!;
    fireEvent.click(within(await openMenu('Pay rent')).getByRole('menuitem', { name: 'Move to another list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to another list' });
    await chooseArchive(dialog);
    let fetched = listCalls();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(state.toast).toHaveBeenLastCalledWith({ title: 'This item cannot be moved on its own', description: unsupported }));
    expect(screen.getByRole('dialog', { name: 'Move to another list' })).toBeInTheDocument();
    expect(client.getQueryData<CalendarEvent[]>(probeKey)).toBe(before);
    // The queue is empty after the refusal: one refresh, as after any write.
    await waitFor(() => expect(listCalls()).toBe(fetched + 1));

    fetched = listCalls();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(state.toast).toHaveBeenLastCalledWith({ title: 'Changed on the calendar server', description: changed }));
    await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));
    expect(screen.getByRole('dialog', { name: 'Move to another list' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(state.toast).toHaveBeenLastCalledWith({ title: 'Repeating events stay in their calendar', description: recurring }));
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(screen.getByRole('dialog', { name: 'Move to another list' })).toBeInTheDocument();
  });

  it('keeps the event dialog open with what was typed when the server copy changed, and reloads', async () => {
    const changed = 'The event was changed on the calendar server in the meantime. It is being refreshed; please review it and try again.';
    vi.mocked(api.put).mockResolvedValueOnce({ error: changed, status: 409, code: 'CALDAV_CONFLICT' });
    const event = task('Dentist', { calendar_id: 'cal-work' });
    const onClose = vi.fn();
    function Host() {
      const actions = useEventActions();
      const target = useMemo(() => ({ kind: 'edit' as const, event }), []);
      return <EventDialog target={target} onClose={onClose} calendars={lists} accounts={[{ id: 'local', provider: 'local' }, { id: 'caldav', provider: 'caldav' }] as never} actions={actions} timezone="UTC" />;
    }
    const { client } = mount(<Host />);
    client.setQueryData(probeKey, [event]);
    const dialog = await screen.findByRole('dialog', { name: 'Edit event' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Dentist, new time' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Calendar' }));
    fireEvent.click(await screen.findByRole('option', { name: /Home/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'Changed on the calendar server', description: changed }));
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Dentist, new time');
    expect(onClose).not.toHaveBeenCalled();
    expect(client.getQueryState(probeKey)?.isInvalidated).toBe(true);
    expect(client.getQueryData(probeKey)).toEqual([event]);
  });
});

describe('the queue through a session end, a changed section and a missing answer', () => {
  it('never sends a write still queued when the session ended, and shows nothing of it in the next session', async () => {
    const scope = { ended: false }, first = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never);
    const oldClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const old = mount(<SessionScopeContext.Provider value={scope}><ProbeHost /></SessionScopeContext.Provider>, oldClient);
    await waitFor(() => expect(oldClient.getQueryData(probeKey)).toBeDefined());
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.reorderSubtasks.mutate({ eventId: 'Pay rent', subtaskIds: [] }));
    act(() => probeActions.moveToList.mutate({ id: 'Call Sam', calendarId: 'list-archive' }));
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalled();
    // Signed out and in again (the same account or another): a new session, a new client.
    scope.ended = true; old.unmount(); oldClient.clear(); state.toast.mockClear();
    serverEvents = [task('Account B', { user_id: 'other', sort_rank: 10, is_todo_only: true })];
    const { client } = await probeMount();
    const fetched = listCalls();
    await act(async () => { first.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalled();
    expect(client.getQueryData<CalendarEvent[]>(probeKey)!.map(event => event.id)).toEqual(['Account B']);
    expect(listCalls()).toBe(fetched);
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('drops a placement once its task is in another section, and the server\'s rank there stands', async () => {
    serverEvents = ['a', 'b', 'c'].map((id, index) => task(id, { start_time: iso(48 * hour), end_time: iso(49 * hour), sort_rank: (index + 1) * 100 }));
    serverEvents.push(task('x', { sort_rank: 40 }), task('y', { sort_rank: 60 }));
    const first = deferred<{ error: string; status: number; code: string }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never);
    const { client } = await probeMount();
    const later = { key: 'later', of: (entry: CalendarEvent) => taskSection(entry, 'UTC') };
    act(() => probeActions.placeTask(serverEvents.slice(0, 3), 'c', 1, later));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    // Meanwhile c was given today's date elsewhere and the list was fetched again.
    serverEvents = serverEvents.map(entry => entry.id === 'c' ? { ...entry, start_time: iso(hour), end_time: iso(2 * hour), sort_rank: 50 } : entry);
    await act(async () => { await client.refetchQueries({ queryKey: probeKey }); });
    const data = client.getQueryData<CalendarEvent[]>(probeKey)!;
    expect(data.find(entry => entry.id === 'c')!.sort_rank).toBe(50);
    expect(orderTasks(data.filter(entry => ['x', 'y', 'c'].includes(entry.id))).map(entry => entry.id)).toEqual(['x', 'c', 'y']);
    await act(async () => { first.resolve({ error: 'The list changed', status: 409, code: 'ORDER_STALE' }); });
  });

  it('leaves the neighbours alone once the placed task is gone', async () => {
    serverEvents = ['a', 'b', 'c'].map((id, index) => task(id, { is_todo_only: true, sort_rank: (index + 1) * 100 }));
    const first = deferred<{ error: string; status: number }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never);
    const { client } = await probeMount();
    act(() => probeActions.placeTask(serverEvents, 'c', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    serverEvents = [{ ...serverEvents[0], sort_rank: 200 }, { ...serverEvents[1], sort_rank: 100 }];
    await act(async () => { await client.refetchQueries({ queryKey: probeKey }); });
    expect(orderTasks(client.getQueryData<CalendarEvent[]>(probeKey)!).map(entry => entry.id)).toEqual(['b', 'a']);
    await act(async () => { first.resolve({ error: 'Not found', status: 404 }); });
  });

  it('gives up on a write without an answer at its deadline, says so, sends the next and reloads', async () => {
    const never = deferred<never>();
    vi.mocked(api.put).mockReturnValueOnce(never.promise as never);
    await probeMount();
    // The clock is faked from here (still moving with real time), so the deadline can be reached.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(api.put).toHaveBeenCalledTimes(1);
      const signal = vi.mocked(api.put).mock.calls[0][2]!.signal!;
      act(() => probeActions.moveToList.mutate({ id: 'Call Sam', calendarId: 'list-archive' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(api.post).not.toHaveBeenCalled();
      const fetched = listCalls();
      await act(async () => { await vi.advanceTimersByTimeAsync(WRITE_DEADLINE_MS + 1); });
      expect(signal.aborted).toBe(true);
      expect(state.toast).toHaveBeenCalledWith({ title: 'Could not confirm the change', description: 'The server has not answered. The list is being reloaded.' });
      expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
      expect(api.post).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Task moved' })));
      await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));
    } finally { vi.useRealTimers(); }
  });
});

describe('a move not confirmed yet', () => {
  const creating: TaskMovePending = { state: 'creating', target_calendar_id: 'list-archive', since: iso(-60_000), attempts: 1 };
  const removing: TaskMovePending = { state: 'removing', target_calendar_id: 'list-archive', since: iso(-60_000), attempts: 0 };
  const cancelledNotice = "The task stays in Home. If Archive received a copy anyway, it will show up there; delete it if you don't want it.";
  // The rows' markers, apart from the sortable lists' own live regions.
  // (hidden: the page behind an open dialog is aria-hidden)
  const markers = (section: HTMLElement) => within(section).queryAllByRole('status', { hidden: true }).map(status => status.textContent).filter(text => text?.startsWith('Moving'));

  it('is marked on the row from the server\'s field, blocks the other changes, and can be cancelled from the menu', async () => {
    serverEvents = [{ ...undated[0], move_pending: creating, subtasks: pair('Pay rent') }, { ...undated[1], move_pending: removing }, undated[2]];
    vi.mocked(api.delete).mockResolvedValueOnce({ data: { event: { ...undated[0], move_pending: null }, cancelled: true } });
    mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    // Only the copy still to confirm is marked; the old copy still to remove ('removing') is a task in its new list already.
    expect(markers(section)).toEqual(['Moving to Archive…']);
    // What stays in UniHub keeps working: the done state, the subtasks, the order.
    expect(within(section).getByRole('button', { name: 'Mark Pay rent done' })).toBeEnabled();
    expect(within(section).getByRole('checkbox', { name: 's0' })).toBeEnabled();
    expect(within(section).getByRole('button', { name: 'Rename s0' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Reorder s0' })).toBeInTheDocument();
    const menu = await openMenu('Pay rent');
    const reason = within(menu).getByRole('menuitem', { name: 'Still being moved to Archive' });
    expect(reason).toHaveAttribute('aria-disabled', 'true');
    // What would reach the calendar server is greyed out, each pointing at the reason.
    for (const name of ['Edit', 'Move to another list']) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAttribute('aria-describedby', reason.id);
    }
    for (const name of ['Move down', 'Cancel task']) expect(within(menu).getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Cancel move' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/calendar/events/Pay%20rent/move', undefined, { signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'Move cancelled', description: cancelledNotice }));
    expect(markers(section)).toEqual([]);
    expect(within(section).getByRole('button', { name: 'Mark Pay rent done' })).toBeEnabled();
  });

  it('is marked offline too, without a way to cancel', async () => {
    function Row() {
      const actions = useTaskActions();
      return <ul><TaskRow task={{ ...undated[0], move_pending: creating }} actions={actions} timezone="UTC" onEdit={() => {}} onMove={() => {}} canReorder={false} movingTo="Archive" /></ul>;
    }
    mount(<Row />);
    expect(await screen.findByRole('status')).toHaveTextContent('Moving to Archive…');
    const menu = await openMenu('Pay rent');
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel move' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('says when there was nothing to cancel without claiming where the task is, and gives up on a cancellation without an answer', async () => {
    // Nothing to cancel, and the answer shows the task still in its old list: no claim about the new one.
    vi.mocked(api.delete).mockResolvedValueOnce({ data: { event: { ...undated[0], move_pending: null }, cancelled: false } });
    const { client } = await probeMount();
    let fetched = listCalls();
    act(() => probeActions.cancelMove.mutate({ id: 'Pay rent', from: 'Home', to: 'Archive' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'Nothing to cancel', description: 'No move was waiting on the calendar server.' }));
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringMatching(/Archive|new list/) }));
    expect(client.getQueryData<CalendarEvent[]>(probeKey)![0].calendar_id).toBe('list-home');
    await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));

    const never = deferred<never>();
    vi.mocked(api.delete).mockReturnValueOnce(never.promise as never);
    fetched = listCalls();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => probeActions.cancelMove.mutate({ id: 'Pay rent', from: 'Home', to: 'Archive' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(api.delete).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(MOVE_DEADLINE_MS + 1); });
      expect(state.toast).toHaveBeenLastCalledWith({ title: 'Could not confirm the change', description: 'The server has not answered. The list is being reloaded.' });
      vi.useRealTimers();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));
    } finally { vi.useRealTimers(); }
  });

  it('can be cancelled from the move dialog\'s waiting state and from the event dialog', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: { event: { ...undated[0], move_pending: creating }, pending: 'creating' } });
    vi.mocked(api.delete).mockResolvedValue({ data: { event: { ...undated[0], move_pending: null }, cancelled: true } });
    mount(<TodoPage />);
    fireEvent.click(within(await openMenu('Pay rent')).getByRole('menuitem', { name: 'Move to another list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to another list' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'New list' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /Archive/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Moving…');
    // The row is marked meanwhile, from the move's own answer.
    expect(markers(screen.getByRole('region', { name: 'No date' }))).toEqual(['Moving to Archive…']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.toast).toHaveBeenLastCalledWith({ title: 'Move cancelled', description: cancelledNotice });
    cleanup();

    const onClose = vi.fn();
    function Host() {
      const actions = useEventActions();
      const target = useMemo(() => ({ kind: 'edit' as const, event: task('Dentist', { calendar_id: 'list-home', move_pending: { ...creating, target_calendar_id: 'cal-work' } }) }), []);
      return <EventDialog target={target} onClose={onClose} calendars={lists} accounts={[{ id: 'local', provider: 'local' }, { id: 'caldav', provider: 'caldav' }] as never} actions={actions} timezone="UTC" />;
    }
    mount(<Host />);
    const eventDialog = await screen.findByRole('dialog', { name: 'Edit event' });
    expect(within(eventDialog).getByRole('status')).toHaveTextContent('the event shows in Work once the calendar server has stored it');
    expect(within(eventDialog).queryByLabelText('Title')).not.toBeInTheDocument();
    fireEvent.click(within(eventDialog).getByRole('button', { name: 'Cancel move' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.toast).toHaveBeenLastCalledWith({ title: 'Move cancelled', description: "The event stays in Home. If Work received a copy anyway, it will show up there; delete it if you don't want it." });
  });
});

describe('answers of the other writes while the queue is busy', () => {
  it('merges an added subtask a refetch already holds instead of adding it twice', async () => {
    const hold = deferred<{ data: { ranks: Record<string, number> } }>(), answer = deferred<{ data: { subtask: CalendarSubtask } }>();
    vi.mocked(api.put).mockReturnValueOnce(hold.promise as never);
    vi.mocked(api.post).mockReturnValueOnce(answer.promise as never);
    const { client } = await probeMount();
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.addSubtask.mutate({ eventId: 'Pay rent', title: 'Pack bag' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const subtask = { ...pair('Pay rent')[0], id: 'new-sub', title: 'Pack bag' };
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: [subtask] } : entry);
    await act(async () => { await client.refetchQueries({ queryKey: probeKey }); });
    expect(client.getQueryData<CalendarEvent[]>(probeKey)![0].subtasks.map(entry => entry.id)).toEqual(['new-sub']);
    await act(async () => { answer.resolve({ data: { subtask } }); });
    expect(client.getQueryData<CalendarEvent[]>(probeKey)![0].subtasks.map(entry => entry.id)).toEqual(['new-sub']);
    await act(async () => { hold.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
  });

  it('lets a late tick answer confirm the status only, not an older set of subtasks', async () => {
    const hold = deferred<{ data: { ranks: Record<string, number> } }>(), tick = deferred<{ data: { event: CalendarEvent } }>();
    vi.mocked(api.put).mockReturnValueOnce(hold.promise as never).mockReturnValueOnce(tick.promise as never);
    const subtask = { ...pair('Pay rent')[0], id: 'new-sub', title: 'Pack bag' };
    vi.mocked(api.post).mockResolvedValueOnce({ data: { subtask } });
    const { client } = await probeMount();
    const payRent = () => client.getQueryData<CalendarEvent[]>(probeKey)![0];
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.setStatus.mutate({ id: 'Pay rent', todo_status: 'done' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    // The tick was stored with no subtasks; its answer waits on the network while a subtask is confirmed.
    const tickAnswer = { ...serverEvents[0], todo_status: 'done' as const, done_at: iso(0) };
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, todo_status: 'done' as const, subtasks: [subtask] } : entry);
    act(() => probeActions.addSubtask.mutate({ eventId: 'Pay rent', title: 'Pack bag' }));
    await waitFor(() => expect(payRent().subtasks).toHaveLength(1));
    await act(async () => { tick.resolve({ data: { event: tickAnswer } }); });
    expect(payRent().todo_status).toBe('done');
    expect(payRent().subtasks.map(entry => entry.id)).toEqual(['new-sub']);
    await act(async () => { hold.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
  });
});

describe('an item that moved or changed while its dialog was open', () => {
  it('says so, keeps the draft for another try and fetches the lists again', async () => {
    const changed = 'This item moved to another calendar or changed in the meantime. It has been refreshed; please try again.';
    vi.mocked(api.put).mockResolvedValueOnce({ error: changed, status: 409, code: 'CALENDAR_EVENT_CHANGED' });
    const { client } = mount(<TodoPage />);
    await screen.findByRole('region', { name: 'No date' });
    fireEvent.click(within(await openMenu('Pay rent')).getByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Pay rent and bills' } });
    const fetched = listCalls();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'Changed in the meantime', description: changed }));
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(within(screen.getByRole('dialog', { name: 'Edit task' })).getByLabelText('Title')).toHaveValue('Pay rent and bills');
    await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));
    expect(client.getQueryData<CalendarEvent[]>(probeKey)![0].title).toBe('Pay rent');
  });
});

describe('replies that arrive after a newer write for the same task or subtask', () => {
  it('lets a late done reply confirm the status only, not the dates an edit changed since', async () => {
    const hold = deferred<{ data: { ranks: Record<string, number> } }>(), tick = deferred<{ data: { event: CalendarEvent } }>();
    serverEvents = undated.map(entry => ({ ...entry, is_todo_only: false }));
    vi.mocked(api.put).mockReturnValueOnce(hold.promise as never).mockReturnValueOnce(tick.promise as never);
    const { client } = await probeMount();
    const payRent = () => client.getQueryData<CalendarEvent[]>(probeKey)![0];
    const later = { key: 'later', of: (entry: CalendarEvent) => taskSection(entry, 'UTC') };
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, later));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.setStatus.mutate({ id: 'Pay rent', todo_status: 'done' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    const tickAnswer = { ...serverEvents[0], todo_status: 'done' as const, done_at: iso(0) };
    const edited = { ...tickAnswer, todo_status: 'changed' as const, start_time: '2099-01-01T10:00:00Z', end_time: '2099-01-01T11:00:00Z', sort_rank: 987654 };
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? edited : entry);
    vi.mocked(api.put).mockResolvedValueOnce({ data: { event: edited } }).mockResolvedValueOnce({ data: { event: edited } });
    act(() => probeActions.update.mutate({ id: 'Pay rent', update: { start_time: edited.start_time, end_time: edited.end_time } }));
    await waitFor(() => expect(payRent().start_time).toBe(edited.start_time));
    expect(payRent().sort_rank).toBe(987654);
    await act(async () => { tick.resolve({ data: { event: tickAnswer } }); });
    expect([payRent().start_time, payRent().end_time, payRent().todo_status]).toEqual([edited.start_time, edited.end_time, 'changed']);
    await act(async () => { hold.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
  });

  it('never brings back a subtask deleted since: not by a late tick reply, nor by a fetch that started before the deletion', async () => {
    const hold = deferred<{ data: { ranks: Record<string, number> } }>(), toggle = deferred<{ data: { subtask: CalendarSubtask } }>(), oldFetch = deferred<{ data: { events: CalendarEvent[] } }>();
    serverEvents = undated.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: pair(entry.id) } : entry);
    vi.mocked(api.put).mockReturnValueOnce(hold.promise as never).mockReturnValueOnce(toggle.promise as never);
    vi.mocked(api.delete).mockResolvedValueOnce({ data: { success: true } });
    const { client } = await probeMount();
    const ids = () => client.getQueryData<CalendarEvent[]>(probeKey)![0].subtasks.map(subtask => subtask.id);
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.updateSubtask.mutate({ eventId: 'Pay rent', subtaskId: 's0', update: { is_done: true } }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    // A fetch under way (started before the deletion) will answer with s0 still there.
    const withS0 = serverEvents;
    vi.mocked(api.get).mockReturnValueOnce(oldFetch.promise as never);
    const fetching = client.refetchQueries({ queryKey: probeKey });
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: entry.subtasks.filter(subtask => subtask.id !== 's0') } : entry);
    act(() => probeActions.deleteSubtask.mutate({ eventId: 'Pay rent', subtaskId: 's0' }));
    await waitFor(() => expect(ids()).toEqual(['s1']));
    await act(async () => { toggle.resolve({ data: { subtask: { ...pair('Pay rent')[0], is_done: true } } }); });
    expect(ids()).toEqual(['s1']);
    await act(async () => { oldFetch.resolve({ data: { events: withS0 } }); await fetching; });
    expect(ids()).toEqual(['s1']);
    // A fetch started after the deletion is the truth, whatever it says.
    serverEvents = withS0;
    await act(async () => { await client.refetchQueries({ queryKey: probeKey }); });
    expect(ids()).toEqual(['s0', 's1']);
    await act(async () => { hold.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
  });

  it('lets a late creation reply stand back from a tick confirmed since on the fetched copy', async () => {
    const hold = deferred<{ data: { ranks: Record<string, number> } }>(), add = deferred<{ data: { subtask: CalendarSubtask } }>();
    vi.mocked(api.put).mockReturnValueOnce(hold.promise as never);
    vi.mocked(api.post).mockReturnValueOnce(add.promise as never);
    const { client } = await probeMount();
    const subtasks = () => client.getQueryData<CalendarEvent[]>(probeKey)![0].subtasks;
    act(() => probeActions.placeTask(serverEvents, 'Plan holiday', 1, undatedSection));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => probeActions.addSubtask.mutate({ eventId: 'Pay rent', title: 'new' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const subtask = { ...pair('Pay rent')[0], id: 'new', title: 'new' };
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: [subtask] } : entry);
    await act(async () => { await client.refetchQueries({ queryKey: probeKey }); });
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: [{ ...subtask, is_done: true }] } : entry);
    vi.mocked(api.put).mockResolvedValueOnce({ data: { subtask: { ...subtask, is_done: true } } });
    act(() => probeActions.updateSubtask.mutate({ eventId: 'Pay rent', subtaskId: 'new', update: { is_done: true } }));
    await waitFor(() => expect(subtasks()[0].is_done).toBe(true));
    await act(async () => { add.resolve({ data: { subtask } }); });
    expect(subtasks().map(entry => [entry.id, entry.is_done])).toEqual([['new', true]]);
    await act(async () => { hold.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
  });
});

describe('a deletion while an older fetch of another list is still outstanding', () => {
  it('stays deleted in the older answer although a fresh fetch of another list settled first, and a fetch started after the deletion may show it', async () => {
    serverEvents = undated.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: pair(entry.id) } : entry);
    vi.mocked(api.delete).mockResolvedValue({ data: { success: true } });
    const { client } = await probeMount();
    const ids = (key: readonly unknown[]) => client.getQueryData<CalendarEvent[]>(key)![0].subtasks.map(subtask => subtask.id);
    // Another list (the reminders' filters) with an answer still on its way, from before the deletion.
    const otherKey = calendarQueryKeys.list({ includeTodos: true, includeDone: false, visibleOnly: true });
    const old = deferred<{ data: { events: CalendarEvent[] } }>();
    const withS0 = serverEvents;
    vi.mocked(api.get).mockReturnValueOnce(old.promise as never);
    const older = client.fetchQuery({ queryKey: otherKey, queryFn: ({ signal }) => calendarApi.fetchEvents({ includeTodos: true, includeDone: false, visibleOnly: true }, signal) });
    serverEvents = serverEvents.map(entry => entry.id === 'Pay rent' ? { ...entry, subtasks: entry.subtasks.filter(subtask => subtask.id !== 's0') } : entry);
    act(() => probeActions.deleteSubtask.mutate({ eventId: 'Pay rent', subtaskId: 's0' }));
    await waitFor(() => expect(ids(probeKey)).toEqual(['s1']));
    // The deletion's own refresh of the page's list answers first (a fresh fetch): the older answer must still be stripped.
    await waitFor(() => expect(client.isFetching({ queryKey: probeKey })).toBe(0));
    await act(async () => { old.resolve({ data: { events: withS0 } }); await older; });
    expect(ids(otherKey)).toEqual(['s1']);
    // Restored on the server: a fetch started after the deletion shows it.
    serverEvents = withS0;
    await act(async () => { await client.refetchQueries({ queryKey: otherKey }); });
    expect(ids(otherKey)).toEqual(['s0', 's1']);
  });
});
