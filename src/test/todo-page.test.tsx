import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodoPage from '@/pages/TodoPage';
import { api } from '@/lib/api';
import type { CalendarEvent } from '@/lib/calendar-api';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner', timezone: 'UTC' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const hour = 3600_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const task = (id: string, patch: Partial<CalendarEvent>): CalendarEvent => ({
  id, user_id: 'owner', calendar_id: 'calendar-1', title: id, description: null, start_time: iso(hour), end_time: iso(2 * hour),
  all_day: false, location: null, color: '#3b82f6', recurrence: null, reminder_minutes: null, reminders: [0], todo_status: null,
  is_todo_only: false, done_at: null, created_at: iso(-hour), updated_at: iso(-hour), subtasks: [], attendees: [], ...patch,
});
const tasks = [
  task('Car service', { start_time: iso(-48 * hour), end_time: iso(-47 * hour), subtasks: [{ id: 's0', event_id: 'Car service', user_id: 'owner', title: 'Call the garage', is_done: false, position: 0, created_at: iso(-hour), updated_at: iso(-hour) }] }),
  task('Order printer ink', { start_time: iso(72 * hour), end_time: iso(73 * hour) }),
  task('Plan holiday', { is_todo_only: true }),
  task('Filed taxes', { todo_status: 'done', done_at: iso(-hour) }),
];

function mount(path = '/todo') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><TodoPage /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/calendar/events')) return { data: { events: tasks } };
    if (path === '/calendar/calendars') return { data: { calendars: [] } };
    return { data: { modules: [] } };
  });
  vi.mocked(api.put).mockResolvedValue({ data: { event: tasks[0] } });
  vi.mocked(api.post).mockResolvedValue({ data: { subtask: { id: 's1', title: 'Book a slot', is_done: false, position: 0 } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ToDo', () => {
  it('groups open tasks by when they are due and keeps done tasks out of the open view', async () => {
    mount();
    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(within(overdue).getByText('Car service')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Later' })).getByText('Order printer ink')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'No date' })).getByText('Plan holiday')).toBeInTheDocument();
    expect(screen.queryByText('Filed taxes')).not.toBeInTheDocument();
  });

  it('ticks and adds subtasks right on the row', async () => {
    mount();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Call the garage' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Car service/subtasks/s0', { is_done: true }));
    const add = screen.getByLabelText('Add a subtask to Car service');
    fireEvent.change(add, { target: { value: 'Book a slot' } });
    fireEvent.submit(add);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events/Car service/subtasks', { title: 'Book a slot' }));
    await waitFor(() => expect(add).toHaveValue(''));
  });

  it('marks a task done from its checkbox', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Order printer ink done' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Order printer ink/todo-status', expect.objectContaining({ todo_status: 'done' })));
    expect(state.toast).toHaveBeenCalledWith({ title: 'Task done' });
  });

  it('opens a view from the panel and from the address, with reopen for done tasks', async () => {
    mount('/todo?view=done');
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen Filed taxes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/Filed taxes/todo-status', expect.objectContaining({ todo_status: null })));
    fireEvent.click(screen.getByRole('radio', { name: /^Overdue/ }));
    expect(await screen.findByText('Car service')).toBeInTheDocument();
    expect(screen.queryByText('Order printer ink')).not.toBeInTheDocument();
  });
});
