import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodoPage from '@/pages/TodoPage';
import GeneralSettings from '@/components/settings/GeneralSettings';
import { MoveListDialog, NewTaskDialog } from '@/components/todo/TaskDialogs';
import { TaskRow } from '@/components/todo/TaskRow';
import { useTaskActions, type TaskActions } from '@/hooks/use-task-actions';
import { SortableList, DragHandle } from '@/components/ui/sortable-list';
import { api } from '@/lib/api';
import { calendarQueryKeys, normalizeCalendar, type CalendarCalendar, type CalendarEvent } from '@/lib/calendar-api';
import { defaultTaskList, listRefusal, neighboursAt, optimisticRanks, orderTasks, rankBetween } from '@/lib/tasks';
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
    if (path === '/settings/values') return savedSettingsAnswer(body);
    return { data: { event: undated[0] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { event: undated[0] } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the order of tasks', () => {
  it('follows the rank, then the id, and gives an answer without ranks its date order', () => {
    const a = task('a', { sort_rank: 5 }), b = task('b', { sort_rank: 5 }), c = task('c', { sort_rank: 1 });
    expect(orderTasks([a, b, c]).map(t => t.id)).toEqual(['c', 'a', 'b']);
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
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Plan%20holiday/position', { after: 'Pay rent', before: 'Call Sam' }));
    expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']);
    // Then the server's rank is kept and the lists are fetched again.
    serverRank('Plan holiday', 150);
    const fetched = vi.mocked(api.get).mock.calls.length;
    await act(async () => { answer.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(fetched));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('puts a task back when the server refuses, and reloads the list when it changed meanwhile', async () => {
    vi.mocked(api.put).mockResolvedValueOnce({ error: 'Database unavailable', status: 500 });
    mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    fireEvent.click(within(await openMenu('Call Sam')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move the task', description: 'Database unavailable', variant: 'destructive' })));
    expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']);

    vi.mocked(api.put).mockResolvedValueOnce({ error: 'The list changed in the meantime. It has been reloaded; try again.', status: 409, code: 'ORDER_STALE' });
    const listCalls = () => vi.mocked(api.get).mock.calls.filter(call => String(call[0]).startsWith('/calendar/events')).length;
    const before = listCalls();
    fireEvent.click(within(await openMenu('Call Sam')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'The list changed in the meantime' })));
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']);
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
  it('lets a newer move of the same task win over an older answer or failure, and ends at the server\'s ranks', async () => {
    const first = deferred<{ data?: { ranks: Record<string, number> }; error?: string; status?: number }>();
    const second = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);
    const { client } = mount(<TodoPage />);
    const section = await screen.findByRole('region', { name: 'No date' });
    const titles = () => within(section).getAllByRole('listitem').map(item => item.querySelector('p')!.textContent);
    const cached = (id: string) => client.getQueriesData<CalendarEvent[]>({ queryKey: calendarQueryKeys.all }).flatMap(([, events]) => events ?? []).find(event => event.id === id)!;
    // Plan holiday moves up once (to the middle), then up again (to the top) before the first answer.
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(titles()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']));
    expect(api.put).toHaveBeenCalledTimes(2);
    // The second answer arrives first: the server put it at 50.
    serverRank('Plan holiday', 50);
    await act(async () => { second.resolve({ data: { ranks: { 'Plan holiday': 50 } } }); });
    expect(cached('Plan holiday').sort_rank).toBe(50);
    // The first, older answer (rank 150) arrives late and changes nothing.
    await act(async () => { first.resolve({ data: { ranks: { 'Plan holiday': 150 } } }); });
    await waitFor(() => expect(cached('Plan holiday').sort_rank).toBe(50));
    expect(titles()).toEqual(['Plan holiday', 'Pay rent', 'Call Sam']);

    // The same with an older failure: its rollback is skipped.
    const third = deferred<{ error: string; status: number }>();
    const fourth = deferred<{ data: { ranks: Record<string, number> } }>();
    vi.mocked(api.put).mockReturnValueOnce(third.promise as never).mockReturnValueOnce(fourth.promise as never);
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    fireEvent.click(within(await openMenu('Plan holiday')).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']));
    serverRank('Plan holiday', 400);
    await act(async () => { fourth.resolve({ data: { ranks: { 'Plan holiday': 400 } } }); });
    await act(async () => { third.resolve({ error: 'Database unavailable', status: 500 }); });
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move the task' })));
    await waitFor(() => expect(cached('Plan holiday').sort_rank).toBe(400));
    expect(titles()).toEqual(['Pay rent', 'Call Sam', 'Plan holiday']);
  });

  it('keeps the requested place while neighbours tie on rank', async () => {
    const a = task('a', { is_todo_only: true, sort_rank: 100 }), c = task('c', { is_todo_only: true, sort_rank: 100 }), z = task('z', { is_todo_only: true, sort_rank: 100 });
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
    expect(titles()).toEqual(['a', 'c', 'z']);
    fireEvent.click(within(await openMenu('z')).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/z/position', { after: 'a', before: 'c' }));
    expect(titles()).toEqual(['a', 'z', 'c']);
    serverRank('z', 100); serverRank('c', 101);
    await act(async () => { answer.resolve({ data: { ranks: { z: 100, c: 101 } } }); });
    await waitFor(() => expect(titles()).toEqual(['a', 'z', 'c']));
  });

  it('puts back only the subtask order when a reorder fails, keeping what changed meanwhile', async () => {
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
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events/Pay%20rent/move', { calendar_id: 'list-archive' }));
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
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events/Pay%20rent/move', { calendar_id: 'list-archive' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move the task', description: 'Moving to another list is not available yet.' })));

    // A calendar server that has not confirmed yet: the dialog says so and stays until closed.
    vi.mocked(api.post).mockResolvedValueOnce({ data: { event: null, pending: 'creating' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Moving… UniHub finishes this in the background');
    // The footer's Close, not the dialog's corner X (also named Close).
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).find(button => !button.querySelector('svg'))!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
