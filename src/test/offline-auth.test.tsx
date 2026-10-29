import { act, render, screen, waitFor } from '@testing-library/react';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/contexts/AuthContext';
import ModuleGuard from '@/components/modules/ModuleGuard';
import { useAuth } from '@/contexts/useAuth';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { clearOfflineData, loadOfflineSession, saveOfflineSnapshot, setOfflineAccount, setOfflineMode, type OfflineSnapshot } from '@/lib/offline';
import { api } from '@/lib/api';
import { controlledIndexedDB } from './helpers/controlled-indexed-db';

vi.mock('@/utils/service-worker', () => ({
  resetBackgroundNotificationState: vi.fn(async () => {}),
  revokeDevicePushSubscription: vi.fn(async () => {}),
}));
const savedUser = { id: 'A', email: 'a@example.test' };
const saved: OfflineSnapshot = {
  version: 1, userId: 'A', savedAt: '2026-09-06T10:00:00Z', bytes: 0,
  contacts: [{ id: 'contact', first_name: 'Alice saved contact' }],
  events: [], calendars: [], calendarAccounts: [], mailAccounts: [], folders: [], emails: [],
};
function Contacts({ enabled }: { enabled: boolean }) {
  const query = useQuery({ queryKey: ['contacts'], enabled, retry: false, staleTime: 300000, queryFn: async ({ signal }) => {
    const response = await api.get<{ contacts: Array<{ first_name: string }> }>('/contacts', { signal });
    if (response.error) throw new Error(response.error);
    return response.data?.contacts ?? [];
  } });
  return <div>{query.data?.map(contact => <p key={contact.first_name}>{contact.first_name}</p>)}</div>;
}
function SessionContent() {
  const { user, isOffline, loading } = useAuth();
  return <SessionQueryProvider key={user?.id ?? 'signed-out'}>
    <p>{loading ? 'Checking session' : user ? `${user.id} ${isOffline ? 'offline' : 'online'}` : 'Signed out'}</p>
    <Contacts enabled={!!user} />
  </SessionQueryProvider>;
}
const start = () => render(<AuthProvider><SessionContent /></AuthProvider>);

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('indexedDB', controlledIndexedDB().factory);
  setOfflineAccount('A');
  await saveOfflineSnapshot(saved, savedUser);
  setOfflineAccount(null);
  setOfflineMode(false);
});
afterEach(() => { setOfflineAccount(null); setOfflineMode(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('offline cold-start and authentication boundaries', () => {
  it('restores an explicit saved identity only after network failure, then drops its content when cleared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    start();
    await screen.findByText('A offline');
    await screen.findByText('Alice saved contact');
    await act(async () => { await clearOfflineData(); });
    await screen.findByText('Signed out');
    expect(screen.queryByText('Alice saved contact')).not.toBeInTheDocument();
    expect(await loadOfflineSession()).toBeNull();
  });
  it('removes offline identity and private cached content after confirmed session expiry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    start();
    await screen.findByText('Alice saved contact');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Expired' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    act(() => window.dispatchEvent(new Event('unihub:retry-session')));
    await screen.findByText('Signed out');
    expect(screen.queryByText('Alice saved contact')).not.toBeInTheDocument();
    await waitFor(async () => expect(await loadOfflineSession()).toBeNull());
  });
  it('opens a page from the saved copy when the browser went offline before the first module lookup', async () => {
    // React Query pauses an ordinary query while the browser is offline; the
    // module lookup must still reach the saved copy, not hold the start screen
    // over the offline notice and the navigation.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onlineManager.setOnline(false);
    try {
      render(<AuthProvider><SessionQueryProvider><ModuleGuard id="contacts"><p>Contacts page</p></ModuleGuard></SessionQueryProvider></AuthProvider>);
      await screen.findByText('Contacts page');
      expect(screen.queryByText('Opening UniHub…')).not.toBeInTheDocument();
    } finally {
      onlineManager.setOnline(true);
    }
  });
  it('does not sign into a cached identity on an HTTP server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
    start();
    await screen.findByText('Signed out');
    expect(screen.queryByText('Alice saved contact')).not.toBeInTheDocument();
    expect(await loadOfflineSession()).toMatchObject({ user: { id: 'A' } });
  });
});
