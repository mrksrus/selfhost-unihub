import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import CalendarPage from '@/pages/CalendarPageRefactored';
import TodoPage from '@/pages/TodoPageRefactored';
import { useNotificationEventLink } from '@/hooks/use-notification-event-link';
import { api } from '@/lib/api';

const state = vi.hoisted(() => ({ user: { id: 'owner', timezone: 'UTC' }, toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));

const event = (userId = 'owner') => ({
  id: 'target', user_id: userId, calendar_id: 'calendar-1', title: 'Selected notification event', description: 'Exact event body',
  start_time: '2027-12-18T12:00:00Z', end_time: '2027-12-18T13:00:00Z', all_day: false, color: '#2563eb',
  reminders: [0], subtasks: [], attendees: [],
});
function LocationProbe() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}{location.hash}</output>; }
function renderPage(page: React.ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{page}<LocationProbe /></MemoryRouter></QueryClientProvider>);
}
function LinkHarness({ open }: { open: Parameters<typeof useNotificationEventLink>[0] }) {
  useNotificationEventLink(open);
  return null;
}

beforeEach(() => {
  state.user = { id: 'owner', timezone: 'UTC' }; state.toast.mockClear(); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('notification event navigation', () => {
  for (const [path, Page, title] of [['calendar', CalendarPage, 'Edit Event'], ['todo', TodoPage, 'Edit Task Details']] as const) {
    it(`opens the exact ${path} item even when absent from the current list`, async () => {
      const get = vi.spyOn(api, 'get').mockImplementation(async endpoint => {
        if (endpoint === '/calendar/events/target') return { data: { event: event() } };
        if (endpoint === '/calendar/accounts') return { data: { accounts: [] } };
        if (endpoint === '/calendar/calendars') return { data: { calendars: [] } };
        return { data: { events: [] } };
      });
      const put = vi.spyOn(api, 'put'); const post = vi.spyOn(api, 'post');
      renderPage(<Page />, `/${path}?event=target&keep=1#details`);
      const dialog = await screen.findByRole('dialog', { name: title });
      expect(within(dialog).getByDisplayValue('Selected notification event')).toBeInTheDocument();
      expect(get).toHaveBeenCalledWith('/calendar/events/target', expect.objectContaining({ signal: expect.any(AbortSignal) }));
      await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent(`/${path}?keep=1#details`));
      expect(put).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    });
  }

  it('rejects an event from another account without opening details', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { event: event('other') } });
    const open = vi.fn();
    renderPage(<LinkHarness open={open} />, '/calendar?event=target');
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();
  });

  it('aborts pending event selection at an account boundary and ignores its late response', async () => {
    let resolveOld!: (value: { data: { event: ReturnType<typeof event> } }) => void;
    const get = vi.spyOn(api, 'get')
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ data: { event: event('next-owner') } });
    const open = vi.fn();
    const client = new QueryClient();
    const tree = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={['/calendar?event=target']}><LinkHarness open={open} /></MemoryRouter></QueryClientProvider>;
    const view = render(tree());
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const oldSignal = get.mock.calls[0][1]?.signal;
    state.user = { id: 'next-owner', timezone: 'UTC' };
    view.rerender(tree());
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld({ data: { event: event() } }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0].user_id).toBe('next-owner');
  });
});
