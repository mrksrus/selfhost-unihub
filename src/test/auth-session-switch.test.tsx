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

afterEach(() => vi.restoreAllMocks());
beforeEach(() => localStorage.clear());

describe('authentication changes in other tabs', () => {
  it('drops the previous identity before a cross-tab session check resolves', async () => {
    let resolve!: (value: { data: { user: { id: string; email: string } } }) => void;
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ data: { user: { id: 'A', email: 'a@example.com' }, csrfToken: 'a-token' } })
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.user?.id).toBe('A'));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unihub:auth-change', newValue: 'changed' })));
    expect(result.current.user).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { resolve({ data: { user: { id: 'B', email: 'b@example.com' } } }); });
    expect(result.current.user?.id).toBe('B');
    expect(result.current.loading).toBe(false);
  });
});
