import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';
import { setOfflineMode } from '@/lib/offline';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
// The real hook returns a stable toast function. A new vi.fn() per render
// would change every callback/effect that depends on toast on each render.
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
let disconnected = false;
let blocked = false;
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); setOfflineMode(false); disconnected = false; blocked = false;
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/mail/accounts') return { data: { accounts: [{ id: 'account-1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: !disconnected, disconnected_at: disconnected ? '2026-09-29T00:00:00Z' : null, last_synced_at: null }] } };
    if (path === '/mail/accounts/account-1/purge-preview') return { data: { account_id: 'account-1', email_count: 2, attachment_count: 1, raw_count: 2, unresolved_operations: blocked ? 1 : 0, blocked, reason: blocked ? 'Move outcome unresolved' : null } };
    if (path === '/mail/folders') return { data: { folders: [] } };
    if (path === '/mail/writebacks') return { data: { operations: [] } };
    if (path === '/mail/sync/status') return { data: { accounts: [] } };
    if (path.startsWith('/mail/unread-counts')) return { data: { unreadByFolder: {} } };
    if (path.startsWith('/mail/emails?')) return { data: { emails: [{ id: 'm1', mail_account_id: 'account-1', subject: 'Retained subject', from_address: 'sender@example.test', from_name: 'Sender', to_addresses: [], body_text: 'Retained body', body_html: null, folder: 'inbox', is_read: true, is_starred: false, remote_missing: true, received_at: '2026-09-01T10:00:00Z' }], pagination: { total: 1, limit: 50, offset: 0, page: 1, totalPages: 1 } } };
    if (path === '/mail/emails/m1') return { data: { email: { id: 'm1', mail_account_id: 'account-1', subject: 'Retained subject', from_address: 'sender@example.test', from_name: 'Sender', to_addresses: [], body_text: 'Retained body', body_html: null, folder: 'inbox', is_read: true, is_starred: false, remote_missing: true, received_at: '2026-09-01T10:00:00Z' } } };
    throw new Error(`Unexpected fixture path ${path}`);
  });
  vi.mocked(api.delete).mockImplementation(async path => {
    if (path === '/mail/accounts/account-1') { disconnected = true; return { data: { success: true } }; }
    if (path === '/mail/accounts/account-1?purge=true&confirm_purge=account-1') return { data: { success: true } };
    throw new Error(`Unexpected DELETE ${path}`);
  });
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/mail']}><MailPage /></MemoryRouter></QueryClientProvider>);
}

describe('mail retention controls', { timeout: 15000 }, () => {
  // These tests drive the whole mail page, where each *ByRole query computes
  // roles and names for a large DOM. Wait for data with cheap text queries and
  // run role queries once afterwards: a cold role query polled by findByRole
  // could use up its 1 s budget on its own under load. Disconnect and purge are
  // separate tests because as one ~20-step test the flow ran close to the 5 s
  // per-test limit when the full suite competed for CPU. The first test in a
  // worker also pays the cold first render and role computation, so the
  // describe timeout is for CPU time, not for waiting on anything asynchronous.
  it('disconnects by default without purging and keeps retained mail readable', async () => {
    mount();
    await screen.findByText('owner@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect owner@example.test' }));
    expect(screen.getByText(/Your local emails and attachments stay in UniHub/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect and keep mail' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/mail/accounts/account-1'));
    expect(await screen.findByText('Disconnected · local mail')).toBeInTheDocument();
    expect(screen.getByText('Local copy · provider presence unverified')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retained subject'));
    expect(await screen.findByText('Disconnected · retained locally; provider presence unverified')).toBeInTheDocument();
    expect(screen.getAllByText('Retained body')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Preview purge for owner@example.test' })).toBeInTheDocument();
    expect(api.delete).toHaveBeenCalledTimes(1);
  });
  it('requires a preview and the typed account ID before an explicit purge', async () => {
    disconnected = true; mount();
    await screen.findByText('Disconnected · local mail retained');
    fireEvent.click(screen.getByRole('button', { name: 'Preview purge for owner@example.test' }));
    expect(await screen.findByText(/2 emails, 1 attachments, 2 raw messages; 0 unresolved operations/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Purge local mail' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the account ID/), { target: { value: 'wrong' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the account ID/), { target: { value: 'account-1' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/mail/accounts/account-1?purge=true&confirm_purge=account-1'));
  });
  it('does not offer purge while provider effects are unresolved', async () => {
    disconnected = true; blocked = true; mount();
    await screen.findByText('Disconnected · local mail retained');
    fireEvent.click(screen.getByRole('button', { name: 'Preview purge for owner@example.test' }));
    expect(await screen.findByText(/Purge blocked: Move outcome unresolved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purge local mail' })).toBeDisabled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
