import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';
import { mailQueryKeys, type Email, type MailListResponse, type MailWriteback } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';
import type { MailSyncJob } from '@/hooks/use-mail-sync-jobs';
import { applyMailPageWaitBudget, MAIL_PAGE_TEST_TIMEOUT } from '@/test/helpers/mail-page-budget';

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
let syncStatus: MailSyncJob[];
let secondAccount: boolean;
const job = (account_id: string, state: MailSyncJob['state'], phase: string | null = null): MailSyncJob => ({
  account_id, state, phase, processed: 2, total: 10, started_at: '2026-09-29T12:00:00Z', updated_at: '2026-09-29T12:01:00Z', error: null,
});
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
  syncStatus = [];
  secondAccount = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/mail/accounts') return { data: { accounts: [
      { id: 'account-1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null },
      ...(secondAccount ? [{ id: 'account-2', email_address: 'second@example.test', display_name: 'Second', provider: 'custom', is_active: true, last_synced_at: null }] : []),
    ] } };
    if (path === '/mail/folders') return { data: { folders: [{ id: 'inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 0, total_count: 2, unread_count: 0 }] } };
    if (path.startsWith('/mail/unread-counts')) return { data: { unreadByFolder: {}, unreadByFolderAccount: {} } };
    if (path.startsWith('/contacts')) return { data: { contacts: [] } };
    if (path === '/mail/writebacks') return { data: { operations: structuredClone(operations) } };
    if (path === '/mail/sync/status') return { data: { accounts: structuredClone(syncStatus) } };
    if (path.startsWith('/mail/emails?')) {
      if (failLists) return { error: 'List refresh unavailable' };
      const params = new URLSearchParams(path.split('?')[1]);
      const emails = stored.filter(email => (!params.get('account_id') || email.mail_account_id === params.get('account_id'))
        && (params.get('folder') !== 'starred' || email.is_starred) && (params.get('is_read') !== 'false' || !email.is_read));
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

applyMailPageWaitBudget();

describe('mail flag interactions with slow HTTP and provider writebacks', { timeout: MAIL_PAGE_TEST_TIMEOUT }, () => {
  it('keeps an unresolved HTTP admission visible instead of rolling back or reporting rejection', async () => {
    vi.mocked(api.put).mockResolvedValue({ status: 503, error: 'API temporarily unavailable' });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Star request outcome unknown' })));
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    expect(cached('a')?.is_starred).toBe(true);
    expect(vi.mocked(api.put).mock.calls.every(([, , options]) => (options?.headers as Record<string, string>)['Idempotency-Key'] ===
      (vi.mocked(api.put).mock.calls[0][2]?.headers as Record<string, string>)['Idempotency-Key'])).toBe(true);
  });
  it('keeps a reversal while a lost HTTP acknowledgement is resolved by receipt lookup', async () => {
    const receipt = deferred<{ data: { found: boolean; response: { sync_pending: boolean }; operations: never[] } }>();
    const existingGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path, options) => path.startsWith('/mail/operations?') ? receipt.promise : existingGet(path, options));
    vi.mocked(api.put).mockImplementation(async (_path, body) => {
      if ((body as { is_starred: boolean }).is_starred) return { status: 504, error: 'Gateway timeout' };
      stored[0] = { ...stored[0], is_starred: false, star_sync_pending: true };
      return { data: { sync_pending: true } };
    });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unstar message' }));
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('/mail/operations?key='))).toBe(true));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(cached('a')?.is_starred).toBe(false);
    await act(async () => { receipt.resolve({ data: { found: true, response: { sync_pending: true }, operations: [] } }); });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.put).mock.calls;
    expect(calls.map(([, body]) => (body as { is_starred: boolean }).is_starred)).toEqual([true, false]);
    expect((calls[0][2]?.headers as Record<string, string>)['Idempotency-Key']).not.toEqual((calls[1][2]?.headers as Record<string, string>)['Idempotency-Key']);
    expect(screen.getByRole('button', { name: 'Star message' })).toBeEnabled();
  });
  it('sends the latest third click after slow acceptance, without out-of-order submissions', async () => {
    const first = deferred<WriteResponse>();
    vi.mocked(api.put).mockImplementation((path, body) => {
      const value = (body as { is_starred: boolean }).is_starred;
      if (path.endsWith('/star') && value) return first.promise;
      stored[0] = { ...stored[0], is_starred: false, star_sync_pending: true };
      return Promise.resolve({ data: { sync_pending: true } });
    });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unstar message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unstar message' }));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(cached('a')?.is_starred).toBe(false);
    await act(async () => { first.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.put).mock.calls.map(([, body]) => (body as { is_starred: boolean }).is_starred)).toEqual([true, false]);
    expect(screen.getByRole('button', { name: 'Star message' })).toBeEnabled();
  });
  it('keeps reading, flagging, folders and another account usable during a slow sync acceptance', async () => {
    secondAccount = true;
    stored.push({ ...message('c'), mail_account_id: 'account-2' });
    const slow = deferred<{ data: { success: boolean; started: boolean; alreadyRunning: boolean; account_id: string; message: string } }>();
    vi.mocked(api.post).mockImplementation((path, body) => {
      if (path === '/mail/sync' && (body as { account_id: string }).account_id === 'account-1') return slow.promise;
      return Promise.resolve({ data: { success: true, started: true, alreadyRunning: false, account_id: 'account-2', message: 'Queued' } });
    });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(screen.getByRole('button', { name: /Owner owner@example\.test/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync mail' }));
    expect(screen.getByRole('button', { name: 'Requesting mail sync' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/star', { is_starred: true }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } })));
    fireEvent.click(screen.getByRole('button', { name: /Second second@example\.test/ }));
    expect(screen.getByRole('button', { name: 'Sync mail' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Sync mail' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/sync', { account_id: 'account-2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(await screen.findByText('Subject c')).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
    await act(async () => { slow.resolve({ data: { success: true, started: true, alreadyRunning: false, account_id: 'account-1', message: 'Queued' } }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync queued' })));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
  });

  it('distinguishes already running from completion and refreshes once on terminal success or failure', async () => {
    // The scheduler started a job the status poll has not seen yet.
    syncStatus = [job('account-1', 'idle')];
    vi.mocked(api.post).mockResolvedValue({ data: { success: true, started: false, alreadyRunning: true, account_id: 'account-1', message: 'Already running' } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Owner owner@example\.test/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync mail' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync already in progress' })));
    fireEvent.click(screen.getByRole('button', { name: 'Sync details' }));
    await screen.findByRole('dialog', { name: 'Mail sync' });
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
    syncStatus = [job('account-1', 'idle')];
    await act(async () => { await client.invalidateQueries({ queryKey: ['mail-sync-jobs'] }); });
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync coverage current' }));
    const completions = toast.mock.calls.filter(([args]) => args.title === 'Mail sync coverage current');
    await act(async () => { await client.invalidateQueries({ queryKey: ['mail-sync-jobs'] }); });
    expect(toast.mock.calls.filter(([args]) => args.title === 'Mail sync coverage current')).toHaveLength(completions.length);
    syncStatus = [job('account-1', 'running', 'Importing')];
    await act(async () => { await client.invalidateQueries({ queryKey: ['mail-sync-jobs'] }); });
    await screen.findByText(/Importing/);
    syncStatus = [{ ...job('account-1', 'error'), error: 'Provider authentication failed' }];
    await act(async () => { await client.invalidateQueries({ queryKey: ['mail-sync-jobs'] }); });
    expect(await screen.findByText(/Provider authentication failed/)).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync failed', variant: 'destructive' }));
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('polls active sync progress and stops polling after a terminal status', async () => {
    vi.useFakeTimers();
    try {
      syncStatus = [job('account-1', 'running', 'Scanning')];
      mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(screen.getByRole('button', { name: 'Syncing — open sync details' })).toBeInTheDocument();
      const initialChecks = vi.mocked(api.get).mock.calls.filter(([path]) => path === '/mail/sync/status').length;
      syncStatus = [job('account-1', 'idle')];
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync coverage current' }));
      const terminalChecks = vi.mocked(api.get).mock.calls.filter(([path]) => path === '/mail/sync/status').length;
      expect(terminalChecks).toBeGreaterThan(initialChecks);
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === '/mail/sync/status')).toHaveLength(terminalChecks);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes bulk flags through field lanes while a failed move leaves the reader unchanged', async () => {
    vi.mocked(api.post).mockResolvedValue({ error: 'Account busy; move not accepted' });
    vi.mocked(api.put).mockImplementation(async (path) => {
      if (path.endsWith('/star')) stored[0] = { ...stored[0], is_starred: true, star_sync_pending: true };
      return { data: { sync_pending: true } };
    });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/star', { is_starred: true }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } })));
    await waitFor(() => expect(screen.getAllByText('Star change awaiting provider')).toHaveLength(2));
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Trash request rejected', description: 'Account busy; move not accepted' })));
    expect(screen.getByText(bodyText('a'))).toBeInTheDocument();
    expect(row('a')).toBeInTheDocument();
  });
  it('keeps another field interactive during slow bulk read acceptance', async () => {
    const slowRead = deferred<{ error: string }>();
    vi.mocked(api.put).mockImplementation((path) => {
      if (path.endsWith('/read')) return slowRead.promise;
      stored[0] = { ...stored[0], is_starred: true, star_sync_pending: true };
      return Promise.resolve({ data: { sync_pending: true } });
    });
    mount();
    await screen.findByText('Subject a');
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Unread' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/read', { is_read: false }, expect.any(Object)));
    fireEvent.click(screen.getByRole('button', { name: 'Star Subject a' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/star', { is_starred: true }, expect.any(Object)));
    failLists = true;
    await act(async () => { slowRead.resolve({ error: 'Read change rejected' }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to update read status' })));
    expect(cached('a')).toMatchObject({ is_read: true, is_starred: true });
  });

  it('does not claim cancellation before the server confirms it', async () => {
    syncStatus = [job('account-1', 'running', 'Importing')];
    vi.mocked(api.post).mockResolvedValue({ error: 'Cancellation unavailable' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Syncing — open sync details' }));
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sync for owner@example.test' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/sync/cancel', { account_id: 'account-1' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not cancel mail sync', variant: 'destructive' }));
    expect(screen.getByText(/Syncing · Importing/)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync cancelled' }));
  });
  it('reports cancellation only after the polled job reaches cancelled', async () => {
    syncStatus = [job('account-1', 'queued', 'Waiting for provider')];
    vi.mocked(api.post).mockResolvedValue({ data: { success: true } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Syncing — open sync details' }));
    await screen.findByText('Queued · Waiting for provider · 2 of 10');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sync for owner@example.test' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/sync/cancel', { account_id: 'account-1' }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync cancelled' }));
    syncStatus = [job('account-1', 'cancelled')];
    await act(async () => { await client.invalidateQueries({ queryKey: ['mail-sync-jobs'] }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync cancelled' })));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
  });
  it('serializes a slow bulk star before a later reader unstar, preserving the last click', async () => {
    const slowBulk = deferred<{ data: { sync_pending: boolean } }>();
    vi.mocked(api.put).mockImplementation((path, body) => {
      if (path.endsWith('/star') && (body as { is_starred: boolean }).is_starred) return slowBulk.promise;
      stored[0] = { ...stored[0], is_starred: false, star_sync_pending: true };
      return Promise.resolve({ data: { sync_pending: true } });
    });
    mount();
    fireEvent.click(await screen.findByText('Subject a'));
    await screen.findByText(bodyText('a'));
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Unstar message' }));
    expect(cached('a')?.is_starred).toBe(false);
    expect(api.put).toHaveBeenCalledTimes(1);
    await act(async () => { slowBulk.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/star', { is_starred: false }, expect.any(Object)));
    expect(cached('a')?.is_starred).toBe(false);
    expect(screen.getByRole('button', { name: 'Star message' })).toBeEnabled();
  });
  it('rolls back a rejected bulk read and star per field without mutating another field', async () => {
    stored[0].is_read = false;
    vi.mocked(api.put).mockResolvedValue({ error: 'Mail account is busy. Nothing was changed; please retry.' });
    mount();
    await screen.findByText('Subject a');
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Read' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to update read status' })));
    expect(cached('a')?.is_read).toBe(false);
    fireEvent.click(row('a').querySelector('.email-checkbox button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to update star' })));
    expect(cached('a')).toMatchObject({ is_read: false, is_starred: false });
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
    // Opening the reader again is not a second flag request.
    fireEvent.click(within(originalRow).getByText('Subject a'));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/star', { is_starred: true }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Unstar Subject a' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Star Subject b' })).toBeEnabled();
    expect(screen.getAllByText('Saving change…')).toHaveLength(2);
    expect(cached('a', searchKey)?.is_starred).toBe(true);

    await act(async () => { await client.invalidateQueries({ queryKey: mailQueryKeys.all }); });
    expect(cached('a')?.is_starred).toBe(true);
    expect(row('a')).toBe(originalRow);
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    stored[0] = { ...stored[0], is_starred: true, star_sync_pending: true };
    operations = [outcome('pending')];
    await act(async () => { write.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled());
    expect(screen.queryByText('Saving change…')).not.toBeInTheDocument();
    expect(screen.getAllByText('Star change awaiting provider')).toHaveLength(2);
    await screen.findByRole('button', { name: 'Sync mail — 1 change waiting — open sync details' });

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
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/read', { is_read: true }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark unread' })).toBeEnabled());
    expect(within(row('a')).getByText('Sender a')).not.toHaveClass('font-semibold');
    fireEvent.click(within(row('a')).getByText('Subject a'));
    await screen.findByText(bodyText('a'));
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeEnabled();
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
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/read', { is_read: true }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } })));
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled());
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
