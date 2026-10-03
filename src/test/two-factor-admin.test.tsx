import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminUsers from '@/pages/AdminUsers';
import { TotpQrCode } from '@/components/settings/TotpQrCode';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'admin-1', role: 'admin' } }) }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const users = [
  { id: 'admin-1', email: 'admin@example.test', full_name: 'Admin', role: 'admin', is_active: true, two_factor_enabled: true, created_at: '2026-01-01T00:00:00Z' },
  { id: 'user-2', email: 'person@example.test', full_name: 'Person', role: 'user', is_active: true, two_factor_enabled: true, created_at: '2026-01-02T00:00:00Z' },
  { id: 'user-3', email: 'plain@example.test', full_name: 'Plain', role: 'user', is_active: true, two_factor_enabled: false, created_at: '2026-01-03T00:00:00Z' },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockResolvedValue({ data: { users } });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'Two-factor authentication reset' } });
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminUsers /></QueryClientProvider>);
}

describe('admin 2FA reset', () => {
  it('is offered only for other users with 2FA and needs the admin password', async () => {
    mount();
    await screen.findByText('person@example.test');
    const buttons = screen.getAllByRole('button', { name: 'Reset 2FA' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(screen.getByText('Reset 2FA for person@example.test')).toBeInTheDocument();
    const submit = screen.getAllByRole('button', { name: 'Reset 2FA' }).at(-1)!;
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'synthetic-admin-password' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/users/user-2/2fa/reset', { current_password: 'synthetic-admin-password' }));
    await waitFor(() => expect(screen.queryByText('Reset 2FA for person@example.test')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Two-factor authentication reset for person@example.test' }));
  });

  it('keeps the dialog open and shows the error when the password is wrong', async () => {
    vi.mocked(api.post).mockResolvedValue({ error: 'Current password is incorrect', status: 403 });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset 2FA' }));
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset 2FA' }).at(-1)!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Current password is incorrect', variant: 'destructive' })));
    expect(screen.getByText('Reset 2FA for person@example.test')).toBeInTheDocument();
  });
});

describe('authenticator QR code', () => {
  it('draws the URI as a square code with a quiet zone', () => {
    render(<TotpQrCode uri="otpauth://totp/UniHub%3Aperson%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=UniHub" />);
    const svg = screen.getByRole('img', { name: 'QR code for your authenticator app' });
    const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(width).toBe(height);
    // Version 4 or more for this length (33 modules) plus a 4-module border on each side.
    expect(width).toBeGreaterThanOrEqual(41);
    expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(svg.querySelector('path')?.getAttribute('d')).not.toMatch(/M[0-3] /);
  });
});
