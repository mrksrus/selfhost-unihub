import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { CalendarEvent } from '@/lib/calendar-api';
import type { Email } from '@/lib/mail-api';
import { EmailTaskDialog } from '@/components/mail/EmailTaskDialog';
import { EmailTasks } from '@/components/mail/EmailTasks';
import { TaskRow } from '@/components/todo/TaskRow';
import TodoPage from '@/pages/TodoPage';
import { useTaskActions } from '@/hooks/use-task-actions';
import { taskTimes, taskTitleFromEmail } from '@/lib/email-tasks';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner', timezone: 'UTC' } }), useUserTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const lists = [
  { id: 'list-tasks', name: 'Tasks', color: '#2563eb', account_id: 'local-account', account_provider: 'local', read_only: false, is_visible: true, auto_todo_enabled: true },
  { id: 'list-pay', name: 'Payments', color: '#f59e0b', account_id: 'local-account', account_provider: 'local', read_only: false, is_visible: true, auto_todo_enabled: true },
  { id: 'cal-work', name: 'Work (server)', color: '#22c55e', account_id: 'caldav-account', account_provider: 'caldav', read_only: false, is_visible: true, auto_todo_enabled: true },
];
const email: Email = {
  id: 'email-7', mail_account_id: 'account-1', subject: 'Re: Fwd: Invoice 4711 for October', from_address: 'billing@power.example', from_name: 'Power Co',
  to_addresses: ['alex@example.test'], body_text: 'Please pay 84.20 EUR', body_html: null, folder: 'inbox', is_read: true, is_starred: false,
  received_at: '2026-10-10T08:00:00.000Z', has_attachments: true, attachments: [{ id: 'a1', filename: 'invoice-4711.pdf', content_type: 'application/pdf', size_bytes: 1200 }],
};
const sourceEmail = { email_id: 'email-7', subject: 'Invoice 4711 for October', from_name: 'Power Co', from_address: 'billing@power.example',
  received_at: '2026-10-10T08:00:00.000Z', attachments: ['invoice-4711.pdf'], account: 'alex@example.test', available: true };
const task = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'task-1', user_id: 'owner', calendar_id: 'list-pay', title: 'Invoice 4711 for October', description: null, start_time: '2026-10-14T09:00:00.000Z', end_time: '2026-10-14T09:30:00.000Z',
  all_day: true, location: null, color: '#f59e0b', recurrence: null, reminder_minutes: null, reminders: [0], todo_status: null, is_todo_only: false, done_at: null,
  created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z', subtasks: [], attendees: [], source_email: sourceEmail, ...patch,
});

function wrap(ui: React.ReactNode, path = '/mail') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/mail" element={ui} /><Route path="/todo" element={ui} /></Routes>
  </MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  // The Radix switch measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const created: typeof lists = [];
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/calendar/calendars') return { data: { calendars: [...lists, ...created] } };
    if (path.startsWith('/calendar/events')) return { data: { events: [task()] } };
    return { data: { modules: [] } };
  });
  vi.mocked(api.put).mockResolvedValue({ data: { event: task({ source_email: undefined }) } });
  vi.mocked(api.post).mockImplementation(async (path: string, body: unknown) => {
    if (path === '/calendar/calendars') {
      const list = { id: 'list-new', name: (body as { name: string }).name, color: '#8b5cf6', account_id: 'local-account', account_provider: 'local', read_only: false, is_visible: true, auto_todo_enabled: true };
      created.push(list);
      return { data: { calendar: list } };
    }
    if (path === '/calendar/events') return { data: { event: task({ ...(body as Partial<CalendarEvent>), id: 'task-new' }) } };
    return { data: {} };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('a task from an email', () => {
  it('takes its title from the subject without reply prefixes', () => {
    expect(taskTitleFromEmail(email)).toBe('Invoice 4711 for October');
    expect(taskTitleFromEmail({ subject: '', from_name: null, from_address: 'a@b.test' })).toBe('Email from a@b.test');
    expect(taskTimes('2026-10-14', '')).toEqual({ start: '2026-10-14T09:00', end: '2026-10-14T09:30', allDay: true });
    expect(taskTimes('2026-10-14', '17:45')).toEqual({ start: '2026-10-14T17:45', end: '2026-10-14T18:15', allDay: false });
  });

  it('goes to the chosen list for tomorrow with a reminder and keeps the email', async () => {
    const onCreated = vi.fn(), onClose = vi.fn();
    wrap(<EmailTaskDialog email={email} onClose={onClose} timezone="UTC" onCreated={onCreated} />);
    const dialog = await screen.findByRole('dialog', { name: 'Add task' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Invoice 4711 for October');
    const listGroup = await within(dialog).findByRole('radiogroup', { name: 'List' });
    expect(within(listGroup).queryByRole('radio', { name: 'Work (server)' })).not.toBeInTheDocument();
    fireEvent.click(within(listGroup).getByRole('radio', { name: 'Payments' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Tomorrow' }));
    expect(within(dialog).getByRole('switch', { name: /Remind me/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events', expect.objectContaining({
      title: 'Invoice 4711 for October', calendar_id: 'list-pay', source_email_id: 'email-7', is_todo_only: false, all_day: true, reminders: [0], color: '#f59e0b',
    })));
    const payload = vi.mocked(api.post).mock.calls.find(call => call[0] === '/calendar/events')![1] as { start_time: string; end_time: string };
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(payload.start_time.startsWith(tomorrow)).toBe(true);
    expect(payload.end_time > payload.start_time).toBe(true);
    expect(state.toast).toHaveBeenCalledWith({ title: 'Task added to Payments' });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-new' }));
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem('email-task-list')).toBe('list-pay');
  });

  it('creates a new list in the local account and uses it; without a day the task waits under No date', async () => {
    wrap(<EmailTaskDialog email={email} onClose={() => {}} timezone="UTC" />);
    const dialog = await screen.findByRole('dialog', { name: 'Add task' });
    const listGroup = await within(dialog).findByRole('radiogroup', { name: 'List' });
    fireEvent.click(within(listGroup).getByRole('radio', { name: 'New list' }));
    const name = within(dialog).getByLabelText('New list name');
    fireEvent.change(name, { target: { value: 'Reading' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/calendars', expect.objectContaining({ account_id: 'local-account', name: 'Reading' })));
    await waitFor(() => expect(within(listGroup).getByRole('radio', { name: 'Reading' })).toBeChecked());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/events', expect.objectContaining({ calendar_id: 'list-new', is_todo_only: true, reminders: null, source_email_id: 'email-7' })));
  });

  it('shows the email on the task with its attachments, and opens it while it still exists', async () => {
    function Row({ item }: { item: CalendarEvent }) {
      const actions = useTaskActions();
      return <ul><TaskRow task={item} actions={actions} timezone="UTC" open onToggle={() => {}} onEdit={() => {}} onMove={() => {}} /></ul>;
    }
    wrap(<Row item={task()} />, '/todo');
    const block = await screen.findByLabelText('From email');
    expect(within(block).getByText('Invoice 4711 for October')).toBeInTheDocument();
    expect(within(block).getByText(/Power Co · 10 Oct 2026/)).toBeInTheDocument();
    expect(within(block).getByText('invoice-4711.pdf')).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Show email' })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: 'Remove the link to the email' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/events/task-1', { source_email_id: null }));
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link to the email removed' }));
    cleanup();
    wrap(<Row item={task({ source_email: { ...sourceEmail, available: false } })} />, '/todo');
    const gone = await screen.findByLabelText('From email');
    expect(within(gone).queryByRole('button', { name: 'Show email' })).not.toBeInTheDocument();
    expect(within(gone).getByText('No longer in UniHub')).toBeInTheDocument();
    cleanup();
    wrap(<Row item={task({ source_email: { ...sourceEmail, draft: true, to: 'bob@example.test' } })} />, '/todo');
    const draft = await screen.findByLabelText('From email');
    expect(within(draft).getByText(/Draft to bob@example.test/)).toBeInTheDocument();
    expect(within(draft).getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', '/mail?email=email-7');
  });

  it('lists the tasks made from an email in the reader, each leading to its row in ToDo', async () => {
    wrap(<EmailTasks timezone="UTC" tasks={[
      { id: 'task-1', title: 'Invoice 4711 for October', todo_status: null, start_time: '2026-10-14T09:00:00.000Z', end_time: '2026-10-14T09:30:00.000Z', all_day: true, is_todo_only: false, calendar_id: 'list-pay' },
      { id: 'task-2', title: 'Read the terms', todo_status: 'done', start_time: '', end_time: '', all_day: false, is_todo_only: true, calendar_id: 'list-tasks' },
    ]} />);
    const section = await screen.findByRole('region', { name: 'Tasks' });
    const open = within(section).getByRole('link', { name: /Invoice 4711 for October/ });
    expect(open).toHaveAttribute('href', '/todo?task=task-1');
    await waitFor(() => expect(open).toHaveTextContent('Payments · 14 Oct'));
    expect(within(section).getByRole('link', { name: /Read the terms/ })).toHaveTextContent('(done)');
  });

  it('opens the linked task on the ToDo page and drops the link from the address', async () => {
    wrap(<TodoPage />, '/todo?task=task-1');
    const details = await screen.findByLabelText('From email');
    expect(within(details).getByRole('button', { name: 'Show email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Invoice 4711 for October/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
