import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedInDevices } from '@/components/settings/SignedInDevices';
import { AuditLog } from '@/components/settings/AuditLog';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const today = new Date().toISOString();
const laptop = { id: 'session-laptop', current: true, createdAt: today, lastActiveAt: today, ipAddress: '192.0.2.10', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/140.0' };
const phone = { id: 'session-phone', current: false, createdAt: today, lastActiveAt: today, ipAddress: '198.51.100.7', userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile UniHubAndroid/0.23.0 (23000)' };

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => vi.resetAllMocks());

describe('Signed-in devices', () => {
  it('signs out another device and keeps this one without a sign-out action', async () => {
    let sessions = [laptop, phone];
    vi.mocked(api.get).mockImplementation(async () => ({ data: { sessions } }));
    vi.mocked(api.delete).mockImplementation(async () => { sessions = [laptop]; return { data: { signedOut: true } }; });
    mount(<SignedInDevices />);

    expect(await screen.findByText('Firefox on Linux')).toBeInTheDocument();
    expect(screen.getByText('This device · 192.0.2.10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out Firefox on Linux' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out UniHub app on Android' }));
    await waitFor(() => expect(screen.queryByText('UniHub app on Android')).not.toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith('/auth/sessions/session-phone');
    expect(toast).toHaveBeenCalledWith({ title: 'Device signed out' });
  });

  it('names the request id of a server failure so it can be found in the server log', async () => {
    vi.mocked(api.get).mockResolvedValue({ status: 500, error: 'Failed to list sessions', requestId: 'req-7f3a' });
    mount(<SignedInDevices />);
    expect(await screen.findByText('Failed to list sessions')).toBeInTheDocument();
    expect(screen.getByText('Reference req-7f3a')).toBeInTheDocument();
  });

  it('reports a failed sign-out and keeps the device listed', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { sessions: [laptop, phone] } });
    vi.mocked(api.delete).mockResolvedValue({ error: 'Device not found' });
    mount(<SignedInDevices />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out UniHub app on Android' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not sign out the device', variant: 'destructive' })));
    expect(screen.getByText('UniHub app on Android')).toBeInTheDocument();
  });
});

describe('Activity log', () => {
  it('pages back through older entries with the server cursor', async () => {
    const entry = (id: string, action: string, details: Record<string, string> | null = null) => ({
      id, createdAt: today, action, details, ipAddress: '203.0.113.5', requestId: null,
      actor: { id: 'admin-1', email: 'admin@example.test' }, target: { id: 'user-2', email: 'person@example.test' },
    });
    vi.mocked(api.get).mockImplementation(async (path: string) => path.includes('before=')
      ? { data: { entries: [entry('e2', 'admin.password_reset')], cursor: null } }
      : { data: { entries: [entry('e1', 'admin.role_changed', { role: 'admin' })], cursor: `${today}|e1` } });
    mount(<AuditLog />);

    expect(await screen.findByText('Changed the role to admin')).toBeInTheDocument();
    expect(screen.getByText(/^person@example\.test · by admin@example\.test · 203\.0\.113\.5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('Set a new password')).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith(`/admin/audit?before=${encodeURIComponent(`${today}|e1`)}`, expect.anything());
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });
});
