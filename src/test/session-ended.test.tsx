import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/contexts/AuthContext';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';

vi.mock('@/utils/service-worker', () => ({
  resetBackgroundNotificationState: vi.fn(async () => {}),
  revokeDevicePushSubscription: vi.fn(async () => {}),
}));
vi.mock('@/lib/offline', () => ({
  clearOfflineData: vi.fn(async () => {}), loadOfflineSession: vi.fn(async () => null),
  setOfflineAccount: vi.fn(), setOfflineMode: vi.fn(), isOfflineMode: vi.fn(() => false),
  readOfflineResponse: vi.fn(async () => null),
}));

const SESSION_ENDED = { error: 'Your session has ended. Sign in again; nothing was changed.', code: 'SESSION_ENDED' };
const jsonAnswer = (status: number, body: unknown) => ({ ok: status < 400, status, statusText: '', headers: { get: () => 'application/json' }, json: async () => body });

beforeEach(() => { localStorage.clear(); api.setCsrfToken(null); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 401 SESSION_ENDED from a password-confirmed change (caller-proof): the shared
// 401 path ends the session, so the person lands on sign-in; nothing was changed.
describe('a session that ended under a change', () => {
  it('the API client reports a 401 answer as the session having expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonAnswer(401, SESSION_ENDED)) as unknown as typeof fetch);
    const expired = vi.fn();
    window.addEventListener('unihub:session-expired', expired);
    api.setCsrfToken('csrf-token-value');
    const response = await api.delete('/settings/account', { current_password: 'typed' });
    expect(response).toMatchObject({ status: 401, code: 'SESSION_ENDED', error: SESSION_ENDED.error });
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener('unihub:session-expired', expired);
  });

  it('the session provider then reads the session again and signs the person out', async () => {
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ data: { user: { id: 'A', email: 'a@example.com' }, csrfToken: 'a-token' } })
      .mockResolvedValueOnce({ error: 'Not signed in', status: 401 });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.user?.id).toBe('A'));
    act(() => window.dispatchEvent(new Event('unihub:session-expired')));
    // The user is cleared before the session is read again; wait for that read to settle.
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.user).toBeNull();
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
