import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/contexts/AuthContext';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { hasCode } from '@/lib/api-error';
import { inviteTokenFromHash, takeInviteToken } from '@/lib/auth-api';
import { can, managesGroups } from '@/lib/permissions';
import { readPin, savePin, setPinIterationsForTests } from '@/lib/app-lock/pin';
import { recentSignIn, signedInInThisPage } from '@/lib/app-lock/session';
import { readTimeline, writeTimelineConfig } from '@/lib/app-lock/timeline';

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

describe('the app lock across sign-in and sign-out', () => {
  const record = (userId: string) => Promise.all([
    savePin(userId, '482913'),
    writeTimelineConfig(userId, { scope: ['app'], relockAfterMs: 60_000, onDeviceLock: false, method: 'pin' }),
  ]);
  beforeEach(() => setPinIterationsForTests(1000));

  it('sign-out tells the server the device is locked first, then removes this browser’s PIN and lock timeline', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { user: { id: 'A', email: 'a@example.com' }, csrfToken: 'a-token' } });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.user?.id).toBe('A'));
    await record('A');
    await act(() => result.current.signOut());
    expect(post.mock.calls.map(([path]) => path)).toEqual(['/devices/current/lock-state', '/auth/signout']);
    expect(post).toHaveBeenCalledWith('/devices/current/lock-state', { state: 'locked' }, { keepalive: false });
    expect(await readPin('A')).toBeUndefined();
    expect(await readTimeline('A')).toBeUndefined();
  });

  it('a session of another person removes the previous person’s lock records and keeps the current one’s', async () => {
    await record('A');
    await record('B');
    vi.spyOn(api, 'get').mockResolvedValue({ data: { user: { id: 'B', email: 'b@example.com' }, csrfToken: 'b-token' } });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.user?.id).toBe('B'));
    await waitFor(async () => expect(await readPin('A')).toBeUndefined());
    expect(await readTimeline('A')).toBeUndefined();
    expect(await readPin('B')).toBeDefined();
  });

  it('an ended session removes every lock record', async () => {
    await record('A');
    vi.spyOn(api, 'get').mockResolvedValue({ status: 401, error: 'Session expired' });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(async () => expect(await readPin('A')).toBeUndefined());
  });

  it('a sign-in sends this browser’s device key and opens the lock for that person only', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ status: 401, error: 'Sign in' });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { user: { id: 'A', email: 'a@example.com' }, csrfToken: 'a-token' } });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.signIn('a@example.com', 'a-password'); });
    expect(post).toHaveBeenCalledWith('/auth/signin', { email: 'a@example.com', password: 'a-password', device: { key: expect.stringMatching(/^[\w-]{43}$/), kind: 'web' } });
    expect(signedInInThisPage('A')).toBe(true);
    expect(recentSignIn('A')).toBe(true);
    expect(signedInInThisPage('B')).toBe(false);
  });
});

describe('a setup link (0.30)', () => {
  const TOKEN = 'k3J9xQ2mV7pL0aZ8bN4cR6tY1uW5eS-_';

  it('reads the token from the fragment and removes it from the address bar', () => {
    expect(inviteTokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFromHash('#short')).toBeNull();
    expect(inviteTokenFromHash('#<script>alert(1)</script>xxxxxxxx')).toBeNull();
    window.history.replaceState(null, '', `/invite?from=mail#${TOKEN}`);
    expect(takeInviteToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/invite?from=mail');
  });

  it('accepting signs the new person in with the rights the server reports; a dead link keeps its code and signs nobody in', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ error: 'Not signed in', status: 401 });
    const post = vi.spyOn(api, 'post')
      .mockResolvedValueOnce({ error: 'This setup link no longer works.', status: 404, code: 'INVITE_INVALID' })
      .mockResolvedValueOnce({ data: { user: { id: 'N', email: 'new@example.test', role: 'user', permissions: [], manages_groups: false }, csrfToken: 'n-token' } });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome!: { error: Error | null };
    await act(async () => { outcome = await result.current.acceptInvite(TOKEN, 'a long enough password', 'New Person', 4); });
    expect(hasCode(outcome.error, 'INVITE_INVALID')).toBe(true);
    expect(result.current.user).toBeNull();

    await act(async () => { outcome = await result.current.acceptInvite(TOKEN, 'a long enough password', ' ', 4); });
    expect(outcome.error).toBeNull();
    expect(result.current.user).toMatchObject({ id: 'N', permissions: [] });
    expect(post).toHaveBeenLastCalledWith('/auth/invite/accept', expect.objectContaining({ token: TOKEN, password: 'a long enough password', rules_revision: 4 }));
    expect(post.mock.lastCall?.[1]).not.toHaveProperty('full_name');
  });

  it('rights come from the reported permissions, never from the role name', () => {
    expect(can({ permissions: ['users.read'] }, 'users.read')).toBe(true);
    expect(can({ permissions: ['users.read'] }, 'admins.manage')).toBe(false);
    // An offline copy saved before 0.30 has a role but no permissions.
    expect(can({ role: 'admin' } as { permissions?: string[] }, 'users.read')).toBe(false);
    expect(can(null, 'users.read')).toBe(false);
    expect(managesGroups({ manages_groups: true })).toBe(true);
    expect(managesGroups(undefined)).toBe(false);
  });
});
