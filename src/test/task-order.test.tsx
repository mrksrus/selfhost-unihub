import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodoPage from '@/pages/TodoPage';
import GeneralSettings from '@/components/settings/GeneralSettings';
import { SortableList, DragHandle } from '@/components/ui/sortable-list';
import { api } from '@/lib/api';
import { calendarQueryKeys, normalizeCalendar, type CalendarCalendar, type CalendarEvent } from '@/lib/calendar-api';
import { defaultTaskList, listRefusal, neighboursAt, orderTasks, rankBetween } from '@/lib/tasks';
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
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/calendar/events')) return { data: { events: undated } };
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
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
    // Shown between the two others before the server answers; then the server's rank is kept.
    await waitFor(() => expect(titles()).toEqual(['Pay rent', 'Plan holiday', 'Call Sam']));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Plan%20holiday/position', { after: 'Pay rent', before: 'Call Sam' }));
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
