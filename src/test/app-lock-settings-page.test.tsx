import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import { AppLockContext, type AppLockValue } from '@/hooks/use-app-lock';
import Settings from '@/pages/Settings';
import { fakeAppLock } from './helpers/app-lock';
import { OWNER, policiesAnswer, stubBrowserApis, testClient } from './helpers/data-safety';

// Settings sections that reach several modules under the app lock: Backup and
// restore keeps polling once visited, the Bin lists deleted items of Contacts,
// Calendar and Recordings. Both stay covered while a lock is on.

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, pages: [],
  modules: [{ id: 'mail', label: 'Mail' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'contacts', label: 'Contacts' }, { id: 'recordings', label: 'Recordings and Music' }] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/components/settings/BackupSettings', () => ({ default: ({ active }: { active: boolean }) => <p>Backup content, {active ? 'polling' : 'paused'}</p> }));
vi.mock('@/components/settings/BinSettings', () => ({ default: () => <p>Bin content: deleted contact Grace Hopper</p> }));

function mount(lock: AppLockValue, section: string) {
  const session = { user: OWNER, session: { authenticated: true }, loading: false, serverUnavailable: false, isOffline: false } as unknown as AuthContextType;
  const client = testClient();
  const tree = (value: AppLockValue) => (
    <AuthContext.Provider value={session}>
      <QueryClientProvider client={client}>
        <AppLockContext.Provider value={value}>
          <MemoryRouter initialEntries={[`/settings?section=${section}`]}>
            <Routes><Route path="/settings" element={<Settings />} /></Routes>
          </MemoryRouter>
        </AppLockContext.Provider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  const view = render(tree(lock));
  return { relock: (value: AppLockValue) => view.rerender(tree(value)) };
}

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockResolvedValue(policiesAnswer());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Settings under the app lock', () => {
  it('a relock hides the visited Backup and restore section and stops its polling', async () => {
    const { relock } = mount(fakeAppLock({ status: 'unlocked', scope: ['mail'] }), 'backup');
    expect(await screen.findByText('Backup content, polling')).toBeVisible();

    relock(fakeAppLock({ status: 'locked', scope: ['mail'] }));
    expect(screen.getByRole('heading', { name: 'Unlock to continue' })).toBeInTheDocument();
    expect(screen.queryByText('Backup content, polling')).not.toBeInTheDocument();
    const kept = screen.queryByText('Backup content, paused');
    if (kept) expect(kept).not.toBeVisible();

    relock(fakeAppLock({ status: 'unlocked', scope: ['mail'] }));
    expect(await screen.findByText('Backup content, polling')).toBeVisible();
  });

  it('the Bin waits for the unlock while a module it holds items of is locked, not for Mail alone', async () => {
    const { relock } = mount(fakeAppLock({ status: 'locked', scope: ['contacts'] }), 'bin');
    expect(screen.getByRole('heading', { name: 'Unlock to continue' })).toBeInTheDocument();
    expect(screen.queryByText(/Grace Hopper/)).not.toBeInTheDocument();

    relock(fakeAppLock({ status: 'locked', scope: ['mail'] }));
    expect(await screen.findByText(/Grace Hopper/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Unlock to continue' })).not.toBeInTheDocument();
  });
});
