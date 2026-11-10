import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { DeviceSummary } from '@/lib/devices-api';
import { Devices } from '@/components/settings/Devices';
import { mountSignedIn, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, pages: [],
  modules: [{ id: 'mail', label: 'Mail' }, { id: 'contacts', label: 'Contacts' }] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const now = new Date().toISOString();
const laptop: DeviceSummary = { id: 'dev-laptop', current: true, kind: 'web', app_version: null, user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/140.0',
  created_at: '2026-06-01T08:00:00.000Z', last_seen_at: now, lock: null, notifications: false };
const phone: DeviceSummary = { id: 'dev-phone', current: false, kind: 'android', app_version: '0.29.0', user_agent: 'Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile UniHubAndroid/0.29.0 (29000)',
  created_at: '2026-06-10T08:00:00.000Z', last_seen_at: now, lock: { scope: ['mail', 'contacts'], method: 'biometric' }, notifications: true };

beforeEach(() => stubBrowserApis());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Settings → Security → Devices', () => {
  it('lists the devices with their lock and notifications, marks this one, and signs another out after a confirmation', async () => {
    let devices = [laptop, phone];
    vi.mocked(api.get).mockImplementation(async () => ({ data: { devices } }));
    vi.mocked(api.delete).mockImplementation(async () => { devices = [laptop]; return { data: { removed: true } }; });
    mountSignedIn(<Devices />);

    expect(await screen.findByText('Firefox on Linux')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText(/^In use now · signed in since 1 Jun 2026/)).toBeInTheDocument();
    expect(screen.getByText('App lock off · Notifications off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out Firefox on Linux' })).not.toBeInTheDocument();

    expect(screen.getByText('UniHub app 0.29.0 on Android')).toBeInTheDocument();
    expect(screen.getByText('App lock: fingerprint or face, Mail and Contacts · Notifications on')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out UniHub app 0.29.0 on Android' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out UniHub app 0.29.0 on Android?' });
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/devices/dev-phone'));
    await waitFor(() => expect(screen.queryByText('UniHub app 0.29.0 on Android')).not.toBeInTheDocument());
    expect(state.toast).toHaveBeenCalledWith({ title: 'Device signed out' });
    expect(screen.getByText('No other device is signed in.')).toBeInTheDocument();
  });

  it('keeps a device listed when the server refuses, and says why', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { devices: [laptop, phone] } });
    vi.mocked(api.delete).mockResolvedValue({ status: 404, error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
    mountSignedIn(<Devices />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out UniHub app 0.29.0 on Android' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not sign out the device', description: 'Device not found', variant: 'destructive' })));
    expect(screen.getByText('UniHub app 0.29.0 on Android')).toBeInTheDocument();
  });

  it('names the request id of a server failure', async () => {
    vi.mocked(api.get).mockResolvedValue({ status: 500, error: 'Failed to list devices', requestId: 'req-7f3a' });
    mountSignedIn(<Devices />);
    expect(await screen.findByText('Failed to list devices')).toBeInTheDocument();
    expect(screen.getByText('Reference req-7f3a')).toBeInTheDocument();
  });
});
