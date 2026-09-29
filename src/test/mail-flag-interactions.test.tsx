import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';
import { mailQueryKeys, type Email, type MailListResponse, type MailWriteback } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type WriteResponse = { data?: { sync_pending: boolean }; error?: string };
const bodyText = (id: string) => `Body ${id} ${'message content '.repeat(12)}`.trim();
const message = (id: string, is_read = true): Email => ({
  id, mail_account_id: 'account-1', subject: `Subject ${id}`, from_address: `${id}@example.test`,
  from_name: `Sender ${id}`, to_addresses: ['owner@example.test'], body_text: bodyText(id), body_html: null,
  folder: 'inbox', is_read, is_starred: false, received_at: '2026-09-01T10:00:00Z',
});
let client: QueryClient;
let stored: Email[];
let operations: MailWriteback[];
let failLists: boolean;
let nextDetail: ReturnType<typeof deferred<{ data: { email: Email } }>> | undefined;
const cacheKey = mailQueryKeys.list({ account: 'all', folder: 'inbox', page: 1, search: '', unreadOnly: false });
const searchKey = mailQueryKeys.list({ account: 'all', folder: 'all', page: 1, search: 'Subject', unreadOnly: false });

function mount() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/mail']}><MailPage /></MemoryRouter></QueryClientProvider>);
}
function row(id: string) {
  return screen.getByRole('button', { name: new RegExp(`^(Unstar|Star) Subject ${id}$`) }).closest('[class*="cursor-pointer"]') as HTMLElement;
}
function cached(id: string, key: readonly unknown[] = cacheKey) {
  return client.getQueryData<MailListResponse>(key)?.emails.find(email => email.id === id);
}
function outcome(status: MailWriteback['status'], action: MailWriteback['action'] = 'star'): MailWriteback {
  return { id: 'operation-a', email_id: 'a', action, status, error: null, created_at: '2026-09-01T10:00:00Z' };
}
async function poll() {
  await act(async () => { await client.invalidateQueries({ queryKey: mailQueryKeys.writebacks }); });
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setOfflineMode(false);
  stored = [message('a'), message('b')];
  operations = [];
  failLists = false;
  nextDetail = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/mail/accounts') return { data: { accounts: [{ id: 'account-1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null }] } };
    if (path === '/mail/folders') return { data: { folders: [{ id: 'inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 0, total_count: 2, unread_count: 0 }] } };
    if (path.startsWith('/mail/unread-counts')) return { data: { unreadByFolder: {}, unreadByFolderAccount: {} } };
    if (path.startsWith('/contacts')) return { data: { contacts: [] } };
    if (path === '/mail/writebacks') return { data: { operations: structuredClone(operations) } };
    if (path.startsWith('/mail/emails?')) {
      if (failLists) return { error: 'List refresh unavailable' };
      const params = new URLSearchParams(path.split('?')[1]);
      const emails = stored.filter(email => (params.get('folder') !== 'starred' || email.is_starred) && (params.get('is_read') !== 'false' || !email.is_read));
      return { data: { emails: structuredClone(emails), pagination: { total: emails.length, limit: 50, offset: 0, page: 1, totalPages: 1 } } };
    }
    if (path.startsWith('/mail/emails/')) {
      if (nextDetail) {
        const pending = nextDetail;
        nextDetail = undefined;
        return pending.promise;
      }
      return { data: { email: structuredClone(stored.find(email => email.id === path.split('/').pop())) } };
    }
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  });
  vi.mocked(api.put).mockResolvedValue({ data: { sync_pending: false } });
});
afterEach(() => { cleanup(); client.clear(); });

describe('mail flag interactions with slow HTTP and provider writebacks', () => {
  it('keeps a rejected bulk read unchanged and reports a rejected bulk star', async () => {
    stored[0].is_read = false;
    const write = deferred<{ error: string }>();
    vi.mocked(api.post).mockReturnValue(write.promise);
    mount();
    await screen.findByText('Subject a');
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Read' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/emails/bulk-update', { email_ids: ['a'], is_read: true }));
    expect(cached('a')?.is_read).toBe(false);
    failLists = true;
    await act(async () => { write.resolve({ error: 'Mail account is busy. Nothing was changed; please retry.' }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to mark emails as read' })));
    expect(cached('a')?.is_read).toBe(false);
    vi.mocked(api.post).mockResolvedValue({ error: 'Mail account is busy. Nothing was changed; please retry.' });
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to star emails' })));
    expect(cached('a')?.is_starred).toBe(false);
  });

  it('keeps list, reader and other cached lists starred during a slow write and background refetch, without double submitting', async () => {
    const write = deferred<WriteResponse>();
    vi.mocked(api.put).mockReturnValue(write.promise);
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    client.setQueryData(searchKey, { emails: structuredClone(stored) });
    const originalRow = row('a');
    fireEvent.click(within(originalRow).getByRole('button', { name: 'Star Subject a' }));
    fireEvent.click(screen.getByRole('button', { name: /^(Unstar|Star) message$/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/star', { is_starred: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Unstar Subject a' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Star Subject b' })).toBeEnabled();
    expect(screen.getAllByText('Saving change…')).toHaveLength(2);
    expect(cached('a', searchKey)?.is_starred).toBe(true);

    await act(async () => { await client.invalidateQueries({ queryKey: mailQueryKeys.all }); });
    expect(cached('a')?.is_starred).toBe(true);
    expect(row('a')).toBe(originalRow);
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeDisabled();
    stored[0] = { ...stored[0], is_starred: true, star_sync_pending: true };
    operations = [outcome('pending')];
    await act(async () => { write.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled());
    expect(screen.queryByText('Saving change…')).not.toBeInTheDocument();
    expect(screen.getAllByText('Star change awaiting provider')).toHaveLength(2);
    await screen.findByText(/waiting for provider confirmation/);

    stored[0].star_sync_pending = false;
    operations = [outcome('done')];
    await poll();
    await waitFor(() => expect(screen.queryByText('Star change awaiting provider')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(row('a')).toBe(originalRow);
  });

  it('automatically marks unread mail once while HTTP is pending and does not repeat accepted queued intent on reopening', async () => {
    stored[0].is_read = false;
    const write = deferred<WriteResponse>();
    vi.mocked(api.put).mockReturnValue(write.promise);
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/read', { is_read: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark unread' })).toBeDisabled());
    expect(within(row('a')).getByText('Sender a')).not.toHaveClass('font-semibold');
    fireEvent.click(within(row('a')).getByText('Subject a'));
    await screen.findByText(bodyText('a'));
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeDisabled();
    expect(api.put).toHaveBeenCalledTimes(1);
    stored[0] = { ...stored[0], is_read: true, read_sync_pending: true };
    await act(async () => { write.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark unread' })).toBeEnabled());
    fireEvent.click(within(row('a')).getByText('Subject a'));
    await screen.findByText(bodyText('a'));
    expect(screen.getAllByText('Read change awaiting provider')).toHaveLength(2);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed automatic read without erasing a concurrent successful star, even when the list refresh fails', async () => {
    stored[0].is_read = false;
    const read = deferred<WriteResponse>();
    const star = deferred<WriteResponse>();
    vi.mocked(api.put).mockImplementation(path => path.endsWith('/read') ? read.promise : star.promise);
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/read', { is_read: true }));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    stored[0].is_starred = true;
    await act(async () => { star.resolve({ data: { sync_pending: false } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled());
    failLists = true;
    await act(async () => { read.resolve({ error: 'Mail account is busy. Try again.' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    expect(cached('a')).toMatchObject({ is_read: false, is_starred: true });
    expect(within(row('a')).getByText('Sender a')).toHaveClass('font-semibold');
    expect(screen.getByText(bodyText('a'))).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to update read status', description: 'Mail account is busy. Try again.' }));
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  it('rolls back a failed star immediately in both views without depending on a successful refetch', async () => {
    const write = deferred<WriteResponse>();
    vi.mocked(api.put).mockReturnValue(write.promise);
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeDisabled());
    failLists = true;
    await act(async () => { write.resolve({ error: 'Account busy' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Star message' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Star Subject a' })).toBeEnabled();
    expect(cached('a')?.is_starred).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to update star' }));
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('does not let an older detail refresh overwrite a newly accepted star', async () => {
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    const oldEmail = structuredClone(stored[0]);
    const detail = deferred<{ data: { email: Email } }>();
    nextDetail = detail;
    operations = [outcome('done', 'read')];
    await poll();
    await waitFor(() => expect(nextDetail).toBeUndefined());
    vi.mocked(api.put).mockImplementation(async () => {
      stored[0] = { ...stored[0], is_starred: true, star_sync_pending: true };
      return { data: { sync_pending: true } };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled());
    await act(async () => { detail.resolve({ data: { email: oldEmail } }); });
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    expect(screen.getAllByText('Star change awaiting provider')).toHaveLength(2);
  });

  it('does not overwrite an accepted star when a reader load that began before the edit finally arrives', async () => {
    const detail = deferred<{ data: { email: Email } }>();
    nextDetail = detail;
    const oldEmail = structuredClone(stored[0]);
    vi.mocked(api.put).mockImplementation(async () => {
      stored[0] = { ...stored[0], is_starred: true };
      return { data: { sync_pending: false } };
    });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText('Loading email…');
    fireEvent.click(screen.getByRole('button', { name: 'Star Subject a' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar Subject a' })).toBeEnabled());
    await act(async () => { detail.resolve({ data: { email: oldEmail } }); });
    await screen.findByText(bodyText('a'));
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
  });

  it('does not auto-read an accepted pending unread intent', async () => {
    stored[0] = { ...stored[0], is_read: false, read_sync_pending: true };
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeEnabled();
    expect(screen.getAllByText('Read change awaiting provider')).toHaveLength(2);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('removes an accepted unstar from the Starred view while keeping the open reader stable', async () => {
    stored[0].is_starred = true;
    vi.mocked(api.put).mockImplementation(async () => {
      stored[0] = { ...stored[0], is_starred: false, star_sync_pending: true };
      return { data: { sync_pending: true } };
    });
    mount();
    await screen.findByText('Subject a');
    fireEvent.click(screen.getByRole('button', { name: /starred/i }));
    await waitFor(() => expect(screen.queryByText('Subject b')).not.toBeInTheDocument());
    await waitFor(() => expect(row('a')).toBeVisible());
    fireEvent.click(within(row('a')).getByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Unstar message' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(Unstar|Star) Subject a$/ })).not.toBeInTheDocument());
    expect(screen.getByText(bodyText('a'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Star message' })).toBeEnabled();
    expect(screen.getByText('Star change awaiting provider')).toBeInTheDocument();
  });
});
