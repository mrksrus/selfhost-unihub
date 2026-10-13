import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/contexts/AuthContext';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';

vi.mock('@/utils/service-worker', () => ({
  resetBackgroundNotificationState: vi.fn(async () => {}),
  revokeDevicePushSubscription: vi.fn(async () => {}),
}));
vi.mock('@/lib/offline', () => ({
  clearOfflineData: vi.fn(async () => {}), loadOfflineSession: vi.fn(async () => null),
  setOfflineAccount: vi.fn(), setOfflineMode: vi.fn(), isOfflineMode: vi.fn(() => false),
  readOfflineResponse: vi.fn(async () => null),
}));
vi.mock('@/hooks/use-background-notification-checks', () => ({ useBackgroundNotificationChecks: () => {} }));
vi.mock('@/hooks/use-calendar-notifications', () => ({ useCalendarNotifications: () => {} }));
vi.mock('@/hooks/use-mail-notifications', () => ({ useMailNotifications: () => {} }));
vi.mock('@/hooks/use-recording-uploads', () => ({ useRecordingUploadRunner: () => {} }));
vi.mock('@/components/layout/NavRail', () => ({ default: () => null }));
vi.mock('@/components/layout/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/GlobalCommandPalette', () => ({ default: () => null }));
vi.mock('@/components/mail/MailPeek', () => ({ MailPeek: () => null }));
vi.mock('@/components/offline/OfflineBanner', () => ({ default: () => null }));

afterEach(() => vi.restoreAllMocks());
beforeEach(() => localStorage.clear());

describe('a server that gives no answer', () => {
  it('is not treated as a sign-out: the page waits and retries until the server answers', async () => {
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ error: 'Request failed (502 Bad Gateway).', status: 502 })
      .mockResolvedValueOnce({ data: { user: { id: 'A', email: 'a@example.com' }, csrfToken: 'token' } });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.serverUnavailable).toBe(true);

    await act(async () => { await result.current.retrySession(); });
    expect(result.current.user?.id).toBe('A');
    expect(result.current.serverUnavailable).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a 401 is a sign-out, not an unavailable server', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.serverUnavailable).toBe(false);
  });

  it('shows the waiting screen instead of the sign-in page', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ error: 'Request failed (503 Service Unavailable).', status: 503 });
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/mail']}>
          <Routes>
            <Route element={<AppLayout />}><Route path="/mail" element={<p>Mail page</p>} /></Route>
            <Route path="/auth" element={<p>Sign in</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(await screen.findByText("UniHub's server is not answering")).toBeInTheDocument();
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
