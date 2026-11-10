import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { copyText } from '@/lib/platform';
import type { BackupCapabilities, BackupJob, RestoreJob } from '@/lib/backup-api';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import { AppLockContext, type AppLockValue } from '@/hooks/use-app-lock';
import Settings from '@/pages/Settings';
import { fakeAppLock } from './helpers/app-lock';
import { OWNER, policiesAnswer, stubBrowserApis, testClient } from './helpers/data-safety';

// Backup and restore under the app lock, with the real section: its dialogs
// render through portals outside the hidden section, so a relock must take
// them away too. What they held (a once-shown recovery password, a restore
// waiting for its confirmation) comes back with the unlock.

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, pages: [],
  modules: [{ id: 'mail', label: 'Mail' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'contacts', label: 'Contacts' }, { id: 'recordings', label: 'Recordings and Music' }] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), downloadTicket: vi.fn(), saveFile: vi.fn().mockResolvedValue(undefined), copyText: vi.fn().mockResolvedValue(true) }));

const PASSWORD = 'synthetic-recovery-password-0042';
const SECTIONS = [{ id: 'settings', label: 'Settings' }, { id: 'contacts', label: 'Contacts' }];
const capabilities: BackupCapabilities = { enabled: true, version: 7, sections: SECTIONS, export_sections: SECTIONS, exclusions: [], download_mail: { value: true, forced: false, reason: null, forced_account_ids: [] } };
const backup: BackupJob = {
  id: 'a', scope: 'full', status: 'ready', phase: 'done', progress: 100, cancel_requested: false, requested_sections: [], file_size: 12_400_000, file_sha256: 'abc', content_type: 'application/zip',
  encryption_enabled: true, backup_uuid: 'uuid-a', recovery_password_available: true, recovery_password_revealed: false, server_unlock_available: true, keep_until: null,
  contents: { included: ['local', 'config'], left_out: [], notes: [] },
  error: null, created_at: '2026-06-03T10:00:00.000Z', updated_at: '2026-06-03T10:05:00.000Z', started_at: '2026-06-03T10:00:00.000Z', completed_at: '2026-06-03T10:05:00.000Z', downloaded_at: null,
};
const restore: RestoreJob = {
  id: 'restore-me', source_type: 'generated', source_export_job_id: 'a', status: 'validated', operation: 'validate', phase: 'validated', progress: 100, cancel_requested: false,
  requested_sections: ['full'], conflict_mode: 'keep_existing', calendar_mode: 'merge_same_name', credentials_mode: 'keep_existing', archive_available: true, archive_size: 1000, archive_sha256: null,
  backup_uuid: null, is_encrypted: true, result_counts: null, error: null, attempt_count: 1, created_at: '2026-06-14T10:00:00.000Z', started_at: null, completed_at: null, expires_at: null,
  validation_result: { dry_run: true, valid: true, errors: [], warnings: [], counts: { contacts: 7 }, notes: [] },
};

function mount(lock: AppLockValue) {
  const session = { user: OWNER, session: { authenticated: true }, loading: false, serverUnavailable: false, isOffline: false } as unknown as AuthContextType;
  const client = testClient();
  const tree = (value: AppLockValue) => (
    <AuthContext.Provider value={session}>
      <QueryClientProvider client={client}>
        <AppLockContext.Provider value={value}>
          <MemoryRouter initialEntries={['/settings?section=backup']}>
            <Routes><Route path="/settings" element={<Settings />} /></Routes>
          </MemoryRouter>
        </AppLockContext.Provider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  const view = render(tree(lock));
  return { relock: (value: AppLockValue) => view.rerender(tree(value)) };
}
const unlocked = () => fakeAppLock({ status: 'unlocked', scope: ['mail'] });
const locked = () => fakeAppLock({ status: 'locked', scope: ['mail'] });

beforeEach(() => {
  stubBrowserApis();
  // The shared dialog content leaves with a 200 ms animation; Radix keeps closing content
  // mounted until it ends. jsdom runs no animations, so the exit state is reported by hand.
  const real = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const styles = real.call(window, element, pseudo);
    if (element instanceof HTMLElement && element.hasAttribute('data-state')) {
      Object.defineProperty(styles, 'animationName', { get: () => (element.dataset.state === 'closed' ? 'exit' : 'none') });
    }
    return styles;
  });
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/backup/capabilities') return { data: capabilities };
    if (path === '/backup/jobs') return { data: { jobs: [backup] } };
    if (path === '/backup/restore-jobs') return { data: { jobs: [restore] } };
    if (path === '/policies/effective') return policiesAnswer();
    return { data: {} };
  });
  vi.mocked(api.post).mockImplementation(async (path: string) => {
    if (path === '/backup/jobs/a/recovery-password/reveal') return { data: { recovery_password: PASSWORD } };
    if (path === '/backup/restore-jobs/restore-me/start') return { data: { job: { ...restore, status: 'queued' } } };
    return { data: {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Backup dialogs under the app lock', () => {
  it('a relock takes the shown recovery password out of the page and brings it back with the unlock', { timeout: 20_000 }, async () => {
    const { relock } = mount(unlocked());
    // The section loads lazily, then its lists.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Download Full backup' }, { timeout: 10_000 }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    expect(await within(dialog).findByLabelText('Recovery password')).toHaveTextContent(PASSWORD);

    relock(locked());
    // At once, not after the exit animation: nothing of the password is left, and Copy copies nothing.
    expect(document.body.textContent).not.toContain(PASSWORD);
    for (const button of screen.queryAllByRole('button', { name: 'Copy' })) fireEvent.click(button);
    expect(copyText).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Recovery password' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unlock to continue' })).toBeInTheDocument();

    // The server shows a password once: the unlock shows it again from the page's memory, with no second reveal.
    relock(unlocked());
    const back = await screen.findByRole('dialog', { name: 'Recovery password' });
    expect(within(back).getByLabelText('Recovery password')).toHaveTextContent(PASSWORD);
    expect(vi.mocked(api.post).mock.calls.filter(([path]) => path === '/backup/jobs/a/recovery-password/reveal')).toHaveLength(1);
  });

  it('a relock closes the restore confirmation, so nothing can start the restore until the unlock', { timeout: 20_000 }, async () => {
    const { relock } = mount(unlocked());
    const section = (await screen.findByRole('heading', { name: 'Restore jobs' }, { timeout: 10_000 })).closest('section')!;
    const start = await within(section).findByRole('button', { name: 'Restore' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole('alertdialog', { name: 'Restore this backup?' })).toBeInTheDocument();

    relock(locked());
    // At once, not after the exit animation: a Restore still on the page starts nothing.
    for (const button of screen.queryAllByRole('button', { name: 'Restore' })) fireEvent.click(button);
    expect(api.post).not.toHaveBeenCalledWith('/backup/restore-jobs/restore-me/start');
    expect(screen.queryByRole('alertdialog', { name: 'Restore this backup?' })).not.toBeInTheDocument();

    relock(unlocked());
    const again = await screen.findByRole('alertdialog', { name: 'Restore this backup?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/restore-jobs/restore-me/start'));
  });
});
