import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import ModuleSettings from '@/components/settings/ModuleSettings';
import SecuritySettings from '@/components/settings/SecuritySettings';
import OfflineSettings from '@/components/offline/OfflineSettings';
import ModuleGuard from '@/components/modules/ModuleGuard';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { PageShell } from '@/components/layout/PageShell';
import More from '@/pages/More';
import type { User } from '@/contexts/auth-context';
import { ADMIN, OWNER, mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

// What an administrator's 0.30 rules look like for the person under them:
// the control stays where it is, greyed out, with the server's reason, and
// navigation follows the permissions the server gave, never the role's name.

const state = vi.hoisted(() => ({ toast: vi.fn(), user: null as unknown, modules: [] as unknown[], pages: [] as unknown[] }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, isOffline: false, signOut: vi.fn(), setUser: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/components/layout/visible-attention', () => ({ useVisibleAttention: () => [] }));

const MODULES = [
  { id: 'mail', label: 'Mail', visible: true, enabled: true, background: true, backgroundSupported: true },
  { id: 'contacts', label: 'Contacts', visible: true, enabled: true, background: false },
  // The server reports a module a rule forbids as off.
  { id: 'recordings', label: 'Recordings and Music', visible: true, enabled: false, background: false },
];
const PAGES = [
  { id: 'mail', label: 'Mail', module: 'mail', visible: true }, { id: 'contacts', label: 'Contacts', module: 'contacts', visible: true },
  { id: 'recordings', label: 'Recordings', module: 'recordings', visible: true }, { id: 'music', label: 'Music', module: 'recordings', visible: true },
];
const RECORDINGS_OFF = 'Your administrator turned Recordings and Music off.';
const MUSIC_OFF = 'Your administrator turned the Music page off.';
const PHONE_OFF = 'Your administrator does not allow UniHub contacts in the phone\'s contacts.';
const OFFLINE_OFF = 'Your administrator does not allow offline copies.';
const TWO_FACTOR = 'Your administrator requires two-factor authentication.';
const PASSWORD = 'Passwords need at least 16 characters, as your administrator set.';

const signInAs = (user: User) => { state.user = user; return user; };
const answer = (effective: ReturnType<typeof policiesAnswer>, more: Record<string, unknown> = {}) => vi.mocked(api.get).mockImplementation(async (path: string) =>
  path === '/policies/effective' ? effective : path === '/modules' ? { data: { modules: MODULES, pages: PAGES } } : path in more ? { data: more[path] } : { data: {} });

beforeEach(() => { stubBrowserApis(); signInAs(OWNER); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('greyed controls with the server\'s reason', () => {
  it('a forbidden module keeps its switches, off and greyed, with the reason on the module and on its pages', { timeout: 20_000 }, async () => {
    answer(policiesAnswer({ 'modules.recordings': { value: 'forbidden', reason: RECORDINGS_OFF }, 'contacts.phone_sync': { value: 'forbidden', reason: PHONE_OFF } }));
    mountSignedIn(<ModuleSettings />);
    const power = await screen.findByRole('switch', { name: 'Recordings and Music: enabled' }, { timeout: 10_000 });
    await waitFor(() => expect(power).toBeDisabled());
    expect(power).not.toBeChecked();
    // Once on the module, once on each of its two pages.
    expect(screen.getAllByText(RECORDINGS_OFF)).toHaveLength(3);
    expect(screen.getByRole('switch', { name: 'Music: show in navigation' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Mail: enabled' })).toBeEnabled();
    // The phone's copy of the contacts has no switch on the web; its rule shows on the Contacts module, which stays on.
    expect(screen.getByText(PHONE_OFF)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Contacts: enabled' })).toBeEnabled();
  });

  it('the Music page alone: its row is greyed with the reason while Recordings stay, and the page says so when opened by its address', { timeout: 20_000 }, async () => {
    MODULES[2].enabled = true;
    try {
      answer(policiesAnswer({ 'pages.music': { value: 'forbidden', reason: MUSIC_OFF } }));
      const view = mountSignedIn(<ModuleSettings />);
      const music = await screen.findByRole('switch', { name: 'Music: show in navigation' }, { timeout: 10_000 });
      await waitFor(() => expect(music).toBeDisabled());
      expect(screen.getByRole('switch', { name: 'Recordings: show in navigation' })).toBeEnabled();
      expect(screen.getByRole('switch', { name: 'Recordings and Music: enabled' })).toBeEnabled();
      expect(screen.getAllByText(MUSIC_OFF)).toHaveLength(1);
      view.unmount();

      mountSignedIn(<ModuleGuard id="recordings" page="music"><p>the music page</p></ModuleGuard>);
      expect(await screen.findByText('Music is not available', {}, { timeout: 10_000 })).toBeInTheDocument();
      expect(screen.getByText(MUSIC_OFF)).toBeInTheDocument();
      expect(screen.queryByText('the music page')).not.toBeInTheDocument();
      cleanup();
      mountSignedIn(<ModuleGuard id="recordings"><p>the recordings page</p></ModuleGuard>);
      expect(await screen.findByText('the recordings page', {}, { timeout: 10_000 })).toBeInTheDocument();
    } finally { MODULES[2].enabled = false; }
  });

  it('offline reading cannot be turned on while offline copies are forbidden', { timeout: 20_000 }, async () => {
    answer(policiesAnswer({ 'offline.copies': { value: 'forbidden', reason: OFFLINE_OFF } }));
    mountSignedIn(<OfflineSettings />);
    expect(await screen.findByText(OFFLINE_OFF, {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled();
    expect(screen.getByText('Not available on this server.')).toBeInTheDocument();
  });

  it('required two-factor authentication cannot be turned off, and the password dialog names the minimum', { timeout: 30_000 }, async () => {
    answer(policiesAnswer({ 'auth.two_factor': { value: 'required', reason: TWO_FACTOR }, 'auth.password_min_length': { value: 16, allowed: true, reason: PASSWORD } }),
      { '/auth/2fa/status': { enabled: true, recoveryCodesRemaining: 8, secretReadable: true }, '/devices': { devices: [] } });
    mountSignedIn(<SecuritySettings />);
    const off = await screen.findByRole('button', { name: 'Turn off' }, { timeout: 10_000 });
    await waitFor(() => expect(off).toBeDisabled());
    expect(screen.getByText(TWO_FACTOR)).toBeInTheDocument();
    // New recovery codes are still the person's to make.
    expect(screen.getByRole('button', { name: 'New recovery codes' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change password' });
    expect(within(dialog).getByText(PASSWORD)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Current password'), { target: { value: 'the-current-password' } });
    fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: 'fifteen-chars-x' } });
    fireEvent.change(within(dialog).getByLabelText('New password again'), { target: { value: 'fifteen-chars-x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Use at least 16 characters for the new password' })));
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('navigation follows permissions', () => {
  const panel = (user: User) => mountSignedIn(<PageShell panel={<SettingsPanel active="general" />} panelLabel="Settings sections" panelId="settings"><p>page</p></PageShell>, { user: signInAs(user) });
  const SERVER = ['Server settings', 'Policies', 'Instance backup', 'People', 'Groups'];

  it('the Settings panel lists the Server pages a permission opens, and Your groups for a manager', { timeout: 20_000 }, async () => {
    answer(policiesAnswer());
    const view = panel(ADMIN);
    for (const name of SERVER) expect(await screen.findByRole('link', { name })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Your groups' })).not.toBeInTheDocument();
    view.unmount();

    // A role name grants nothing by itself: no permissions from the server, no Server pages.
    panel({ ...OWNER, role: 'admin', permissions: [], manages_groups: true });
    expect(await screen.findByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '/groups');
    for (const name of SERVER) expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    cleanup();

    // People and Groups without the server's settings: only what users.read opens.
    panel({ ...OWNER, permissions: ['users.read'] });
    expect(await screen.findByRole('link', { name: 'People' })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: 'Groups' })).toHaveAttribute('href', '/admin/groups');
    expect(screen.queryByRole('link', { name: 'Policies' })).not.toBeInTheDocument();
  });

  it('the phone\'s More page lists the same pages by the same permissions', { timeout: 20_000 }, async () => {
    answer(policiesAnswer());
    const view = mountSignedIn(<More />, { user: signInAs(ADMIN) });
    const pages = await screen.findByRole('navigation', { name: 'More pages' });
    for (const name of SERVER) expect(within(pages).getByRole('link', { name })).toBeInTheDocument();
    view.unmount();
    mountSignedIn(<More />, { user: signInAs({ ...OWNER, permissions: [], manages_groups: true }) });
    const own = await screen.findByRole('navigation', { name: 'More pages' });
    expect(within(own).getByRole('link', { name: 'Your groups' })).toBeInTheDocument();
    for (const name of SERVER) expect(within(own).queryByRole('link', { name })).not.toBeInTheDocument();
  });
});
