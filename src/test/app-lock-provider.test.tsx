import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import { AppLockProvider } from '@/contexts/AppLockProvider';
import { useAppLock } from '@/hooks/use-app-lock';
import { deleteLockRecords } from '@/lib/app-lock/db';
import { savePin, setPinIterationsForTests } from '@/lib/app-lock/pin';
import { noteSignIn } from '@/lib/app-lock/session';
import { writeTimelineConfig } from '@/lib/app-lock/timeline';

// The provider is the lock's one entry for the screens: keyed by the
// account, it reads that account's records only, and ends the previous
// account's lock when another signs in. The server cannot be reached here.
vi.mock('@/lib/devices-api', () => ({
  adoptDeviceKey: vi.fn(async () => {}),
  fetchCurrentDevice: vi.fn(async () => { throw new Error('Could not reach the UniHub API.'); }),
  saveDeviceSettings: vi.fn(), reportDeviceLock: vi.fn(async () => {}), reportLockState: vi.fn(async () => {}),
}));

beforeAll(() => setPinIterationsForTests(1000));
afterEach(async () => { await deleteLockRecords(); });

function Probe() {
  const lock = useAppLock();
  return <p>{`${lock.status} app:${lock.locked('app')} mail:${lock.locked('mail')} calendar:${lock.locked('calendar')}`}</p>;
}

function mount(userId: string | null) {
  const auth = { user: userId ? { id: userId, email: `${userId}@example.com` } : null, signOut: vi.fn(async () => {}) } as unknown as AuthContextType;
  const tree = (value: AuthContextType) => (
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient()}><AppLockProvider><Probe /></AppLockProvider></QueryClientProvider>
    </AuthContext.Provider>
  );
  const view = render(tree(auth));
  return { switchTo: (next: string) => view.rerender(tree({ ...auth, user: { id: next, email: `${next}@example.com` } })) };
}

describe('AppLockProvider', () => {
  it('a module lock covers that module only, and an account switch starts the next account’s lock fresh', async () => {
    noteSignIn('nobody');
    await savePin('alex', '482913');
    await writeTimelineConfig('alex', { scope: ['mail'], relockAfterMs: 60_000, onDeviceLock: false, method: 'pin' });
    const view = mount('alex');
    expect(screen.getByText(/^checking/)).toHaveTextContent('checking app:true mail:true calendar:true');
    await waitFor(() => expect(screen.getByText(/^locked/)).toHaveTextContent('locked app:false mail:true calendar:false'));
    view.switchTo('blair');
    await waitFor(() => expect(screen.getByText(/^off/)).toHaveTextContent('off app:false mail:false calendar:false'));
  });

  it('signed out, nothing is locked', () => {
    mount(null);
    expect(screen.getByText(/^off/)).toBeInTheDocument();
  });
});
