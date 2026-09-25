import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailSyncStatus } from '@/components/mail/MailSyncStatus';
import { api } from '@/lib/api';
import { mailQueryKeys, type MailWriteback } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const operation = (id: string, status: MailWriteback['status'], action: MailWriteback['action']): MailWriteback => ({
  id, status, action, email_id: `email-${id}`, error: 'private provider details', created_at: '2026-09-25T10:00:00Z',
});

function setup(operations: MailWriteback[]) {
  vi.mocked(api.get).mockResolvedValue({ data: { operations } });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'Queued' } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSettled = vi.fn();
  const view = render(<QueryClientProvider client={client}><MailSyncStatus onSettled={onSettled} /></QueryClientProvider>);
  return { ...view, client, onSettled };
}

describe('mail server change feedback', () => {
  beforeEach(() => { vi.clearAllMocks(); setOfflineMode(false); });

  it('shows pending counts and conflicts, offers retries only for failed actions, and hides provider details', async () => {
    setup([operation('pending', 'pending', 'read'), operation('failed', 'failed', 'star'), operation('conflict', 'conflict', 'move')]);
    expect(await screen.findByText('1 recent change is waiting to sync with the email server.')).toBeInTheDocument();
    expect(screen.getByText(/Check the message at your provider, then refresh UniHub/)).toBeInTheDocument();
    expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry star change' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/writebacks/failed/retry'));
  });

  it('refreshes the affected open message when a pending action settles', async () => {
    const { client, onSettled } = setup([operation('pending', 'pending', 'read')]);
    await screen.findByText(/waiting to sync/);
    vi.mocked(api.get).mockResolvedValue({ data: { operations: [] } });
    await client.invalidateQueries({ queryKey: mailQueryKeys.writebacks });
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(['email-pending']));
    expect(screen.queryByRole('region', { name: 'Server change status' })).not.toBeInTheDocument();
  });

  it('shows a retry failure without automatically repeating the command', async () => {
    setup([operation('failed', 'failed', 'move')]);
    vi.mocked(api.post).mockResolvedValue({ error: 'private provider details' });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry folder move' }));
    expect(await screen.findByText(/Retry could not be queued/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
  });

  it('refreshes completed actions even when no pending state was observed, without displaying completed rows', async () => {
    const { client, onSettled } = setup([]);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    vi.mocked(api.get).mockResolvedValue({ data: { operations: [operation('quick', 'done', 'star')] } });
    await client.invalidateQueries({ queryKey: mailQueryKeys.writebacks });
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(['email-quick']));
    expect(screen.queryByRole('region', { name: 'Server change status' })).not.toBeInTheDocument();
    onSettled.mockClear();
    await client.invalidateQueries({ queryKey: mailQueryKeys.writebacks });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('keeps saved offline mail read-only without polling', () => {
    setOfflineMode(true);
    setup([]);
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Server change status' })).not.toBeInTheDocument();
  });
});
