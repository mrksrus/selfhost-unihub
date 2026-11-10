import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { emitAppEvent } from '@/lib/app-events';
import { openMailPeek, closeMailPeek } from '@/lib/mail-peek';
import { AppLockContext, type AppLockValue } from '@/hooks/use-app-lock';
import { useBackgroundNotificationChecks } from '@/hooks/use-background-notification-checks';
import { useRecordingUploadRunner } from '@/hooks/use-recording-uploads';
import AppLayout from '@/components/layout/AppLayout';
import ModuleGuard from '@/components/modules/ModuleGuard';
import { fakeAppLock } from './helpers/app-lock';
import { policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-ada', email: 'ada@example.com', full_name: 'Ada Example', timezone: 'UTC' }, loading: false, serverUnavailable: false, isOffline: false, retrySession: vi.fn(), signOut: vi.fn() }), useUserTimezone: () => 'UTC' }));
const PAGES = [
  { id: 'mail', label: 'Mail', module: 'mail', visible: true },
  { id: 'calendar', label: 'Calendar', module: 'calendar', visible: true },
  { id: 'contacts', label: 'Contacts', module: 'contacts', visible: true },
  { id: 'today', label: 'Today', module: null, visible: true },
];
const MODULES = [{ id: 'mail', label: 'Mail' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'contacts', label: 'Contacts' }, { id: 'recordings', label: 'Recordings and Music' }];
vi.mock('@/hooks/use-modules', async () => {
  const { moduleForPath } = await vi.importActual<typeof import('@/lib/modules')>('@/lib/modules');
  return { moduleForPath, useModules: () => ({ isPending: false, error: null, isEnabled: () => true, canAccess: () => true, canNavigate: () => true, pages: PAGES, modules: MODULES }) };
});
vi.mock('@/hooks/use-navigation-counts', () => ({ useNavigationCounts: () => ({ mail: 3 }) }));
vi.mock('@/hooks/use-attention', () => ({ useAttentionItems: () => [] }));
vi.mock('@/hooks/use-background-notification-checks', () => ({ useBackgroundNotificationChecks: vi.fn() }));
vi.mock('@/hooks/use-calendar-notifications', () => ({ useCalendarNotifications: vi.fn() }));
vi.mock('@/hooks/use-mail-notifications', () => ({ useMailNotifications: vi.fn() }));
vi.mock('@/hooks/use-recording-uploads', () => ({ useRecordingUploadRunner: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}
function mount(lock: AppLockValue, path = '/mail') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (value: AppLockValue) => (
    <QueryClientProvider client={client}>
      <AppLockContext.Provider value={value}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/mail" element={<ModuleGuard id="mail"><p>Inbox content</p><Where /></ModuleGuard>} />
              <Route path="/calendar" element={<ModuleGuard id="calendar"><p>Calendar content</p></ModuleGuard>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AppLockContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree(lock));
  return { ...view, relock: (value: AppLockValue) => view.rerender(tree(value)) };
}

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/policies/effective') return policiesAnswer();
    if (path.startsWith('/search?')) return { data: { results: [
      { id: 'r-mail', type: 'mail', title: 'Grace: invoice for March', href: '/mail?email=e1' },
      { id: 'r-contact', type: 'contact', title: 'Grace Hopper', href: '/contacts?contact=c1' },
    ] } };
    if (path.startsWith('/mail/emails/')) return { data: { email: { id: 'e1', subject: 'Invoice for March', body_text: 'Pay 84.20 EUR', from_address: 'billing@example.com', to_addresses: [], attachments: [], tasks: [], received_at: '2026-06-01T08:00:00.000Z', folder: 'inbox', is_read: true, is_starred: false, mail_account_id: 'a1' } } };
    return { data: {} };
  });
});
afterEach(() => { cleanup(); closeMailPeek(); vi.clearAllMocks(); });

describe('the whole-app lock', () => {
  it('replaces the shell with the lock screen, keeps the background hooks mounted, and shows nothing while checking', () => {
    const { relock } = mount(fakeAppLock({ status: 'checking' }));
    expect(screen.getByText('Opening UniHub…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /locked/ })).not.toBeInTheDocument();

    relock(fakeAppLock({ status: 'locked', scope: ['app'] }));
    expect(screen.getByRole('heading', { name: 'UniHub is locked' })).toBeInTheDocument();
    expect(screen.getByText('Ada Example')).toBeInTheDocument();
    expect(screen.getByLabelText('PIN')).toHaveFocus();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByText('Inbox content')).not.toBeInTheDocument();
    expect(useRecordingUploadRunner).toHaveBeenCalled();
    expect(useBackgroundNotificationChecks).toHaveBeenCalled();
  });

  it('a wrong PIN says so, the tries left are announced, and the tenth signs out', async () => {
    const unlock = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'wrong', pin: { failures: 7, waitUntil: null, attemptsLeft: 3 } })
      .mockResolvedValueOnce({ ok: false, reason: 'signed-out' });
    mount(fakeAppLock({ status: 'locked', scope: ['app'], unlock }));
    const pin = screen.getByLabelText('PIN');
    fireEvent.change(pin, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('That is not the PIN.'));
    expect(status).toHaveTextContent('3 tries left before this device is signed out.');
    expect(unlock).toHaveBeenCalledWith('000000');
    fireEvent.change(pin, { target: { value: '000001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(status).toHaveTextContent('Too many wrong PINs: this device is signed out.'));
  });

  it('"Forgot PIN? Sign out" says what goes and what stays before signing out', async () => {
    const signOut = vi.fn(async () => undefined);
    mount(fakeAppLock({ status: 'locked', scope: ['app'], signOut }));
    fireEvent.click(screen.getByRole('button', { name: 'Forgot PIN? Sign out' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out of this device?' });
    expect(dialog).toHaveTextContent('Recordings not uploaded yet stay here.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});

describe('a module lock', () => {
  it('locks Mail inside its page while Calendar opens, hides the count, and shows the target after the unlock', async () => {
    const { relock } = mount(fakeAppLock({ status: 'locked', scope: ['mail'] }), '/mail?email=e1');
    expect(screen.getByRole('heading', { name: 'Mail is locked' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Mail' })).toBeInTheDocument();
    expect(screen.queryByText('Inbox content')).not.toBeInTheDocument();
    // The rail and the bottom bar both render here (no media queries in jsdom); neither shows the count.
    for (const nav of screen.getAllByRole('navigation', { name: 'Main' })) {
      expect(within(nav).getByRole('link', { name: 'Mail' })).toBeInTheDocument();
      expect(within(nav).queryByRole('link', { name: 'Mail, 3 unread' })).not.toBeInTheDocument();
    }

    relock(fakeAppLock({ status: 'unlocked', scope: ['mail'] }));
    expect(await screen.findByText('Inbox content')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/mail?email=e1');
    expect(within(screen.getAllByRole('navigation', { name: 'Main' })[0]).getByRole('link', { name: 'Mail, 3 unread' })).toBeInTheDocument();
  });

  it('leaves Calendar open while Mail is locked', () => {
    mount(fakeAppLock({ status: 'locked', scope: ['mail'] }), '/calendar');
    expect(screen.getByText('Calendar content')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /is locked/ })).not.toBeInTheDocument();
  });

  it('the email peek asks for the Mail lock and fetches nothing', async () => {
    const unlock = vi.fn(async () => ({ ok: true as const }));
    const { relock } = mount(fakeAppLock({ status: 'locked', scope: ['mail'], unlock }), '/calendar');
    act(() => openMailPeek('e1'));
    const peek = await screen.findByRole('dialog', { name: 'Email' });
    expect(within(peek).getByText('Mail is locked')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/mail/emails/e1', expect.anything());
    fireEvent.click(within(peek).getByRole('button', { name: 'Unlock' }));
    const ask = await screen.findByRole('dialog', { name: 'Unlock UniHub' });
    fireEvent.change(within(ask).getByLabelText('PIN'), { target: { value: '123456' } });
    fireEvent.click(within(ask).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith('123456'));
    relock(fakeAppLock({ status: 'unlocked', scope: ['mail'] }));
    expect(await screen.findByText('Pay 84.20 EUR')).toBeInTheDocument();
  });

  it('the search leaves the locked module out and offers its unlock in one row', async () => {
    mount(fakeAppLock({ status: 'locked', scope: ['mail'] }), '/calendar');
    act(() => emitAppEvent('unihub:open-search'));
    const input = await screen.findByPlaceholderText('Search or go to…');
    expect(screen.queryByText('New email')).not.toBeInTheDocument();
    expect(screen.getByText('New contact')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'grace' } });
    expect(await screen.findByText('Mail is locked: unlock to search it')).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/search?q=grace'), expect.anything()));
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByText('Grace: invoice for March')).not.toBeInTheDocument();
  });
});
