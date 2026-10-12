import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';
import { MAIL_FLAG_REFRESH_MS, mailQueryKeys, type Email, type MailListResponse, type MailWriteback } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';
import { applyMailPageWaitBudget, MAIL_PAGE_TEST_TIMEOUT } from '@/test/helpers/mail-page-budget';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type WriteResponse = { data?: { sync_pending: boolean }; error?: string; status?: number };
const bodyText = (id: string) => `Body ${id} ${'message content '.repeat(12)}`.trim();
const message = (id: string, is_read = true): Email => ({
  id, mail_account_id: 'account-1', subject: `Subject ${id}`, from_address: `${id}@example.test`,
  from_name: `Sender ${id}`, to_addresses: ['owner@example.test'], body_text: bodyText(id), body_html: null,
  folder: 'inbox', is_read, is_starred: false, received_at: '2026-09-01T10:00:00Z',
});
const folder = (slug: string, display_name: string, position: number) =>
  ({ id: `f-${slug}`, slug, display_name, is_system: true, position, total_count: 0, unread_count: 0 });
let client: QueryClient;
let stored: Email[];
let operations: MailWriteback[];
let failLists: boolean;
let nextDetail: ReturnType<typeof deferred<{ data: { email: Email } }>> | undefined;
const inboxKey = mailQueryKeys.list({ account: 'all', folder: 'inbox', page: 1, search: '', unreadOnly: false });

function mount() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/mail']}><MailPage /></MemoryRouter></QueryClientProvider>);
}
function row(id: string) {
  return screen.getByRole('button', { name: new RegExp(`^(Unstar|Star) Subject ${id}$`) }).closest('li') as HTMLElement;
}
function cached(id: string) {
  return client.getQueryData<MailListResponse>(inboxKey)?.emails.find(email => email.id === id);
}
/** The unread count next to Inbox in the folder panel; null when none is shown. */
function inboxCount() {
  const nav = screen.getByRole('navigation', { name: 'Mail folders' });
  return within(nav).getByRole('button', { name: /^Inbox/ }).textContent?.match(/, (\d+) unread/)?.[1] ?? null;
}
const calls = (prefix: string) => vi.mocked(api.get).mock.calls.filter(([path]) => path.startsWith(prefix)).length;
const wait = (ms: number) => act(() => new Promise(resolve => setTimeout(resolve, ms)));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setOfflineMode(false);
  stored = [message('a', false), message('b', false), message('c')];
  operations = [];
  failLists = false;
  nextDetail = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/mail/accounts') return { data: { accounts: [
      { id: 'account-1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null, sync_mode: 'sync' },
    ] } };
    if (path === '/mail/folders') return { data: { folders: [folder('inbox', 'Inbox', 0), folder('archive', 'Archive', 1), folder('trash', 'Trash', 2)] } };
    if (path.startsWith('/mail/unread-counts')) {
      const unread = stored.filter(email => !email.is_read).reduce<Record<string, number>>((acc, email) => ({ ...acc, [email.folder]: (acc[email.folder] ?? 0) + 1 }), {});
      return { data: { unreadByFolder: unread, unreadByFolderAccount: Object.fromEntries(Object.entries(unread).map(([slug, count]) => [slug, { 'account-1': count }])) } };
    }
    if (path.startsWith('/contacts')) return { data: { contacts: [] } };
    if (path === '/mail/writebacks') return { data: { operations: structuredClone(operations) } };
    if (path === '/mail/sync/status') return { data: { accounts: [] } };
    if (path.startsWith('/mail/emails?')) {
      if (failLists) return { error: 'List refresh unavailable' };
      const params = new URLSearchParams(path.split('?')[1]);
      const emails = stored.filter(email => (!params.get('folder') || email.folder === params.get('folder'))
        && (params.get('is_read') !== 'false' || !email.is_read));
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

describe('mail actions look done at once while sync state stays visible', { timeout: MAIL_PAGE_TEST_TIMEOUT }, () => {
  it('removes a trashed message and its unread count before the server answers, and restores both on rejection', async () => {
    const trash = deferred<WriteResponse>();
    vi.mocked(api.post).mockReturnValue(trash.promise);
    mount();
    await screen.findByText('Subject a');
    await waitFor(() => expect(inboxCount()).toBe('2'));
    fireEvent.click(within(row('a')).getByRole('button', { name: 'Select Subject a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    // Gone from the list and the count at once; no spinner, no disabled row.
    expect(screen.queryByText('Subject a')).not.toBeInTheDocument();
    expect(inboxCount()).toBe('1');
    expect(cached('a')).toBeUndefined();
    expect(client.getQueryData<MailListResponse>(inboxKey)?.pagination?.total).toBe(2);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/mail/emails/bulk-delete', { email_ids: ['a'] }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } })));
    failLists = true;
    await act(async () => { trash.resolve({ error: 'Mail account is busy' }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not move to Trash', description: 'Mail account is busy', variant: 'destructive' })));
    // Rolled back from the snapshot, not from a refetch (the list refresh fails here).
    expect(row('a')).toBeInTheDocument();
    expect(inboxCount()).toBe('2');
    expect(cached('a')).toMatchObject({ folder: 'inbox', is_read: false });
  });

  it('keeps a star made during a pending trash when the trash is rolled back', async () => {
    const trash = deferred<WriteResponse>();
    vi.mocked(api.post).mockReturnValue(trash.promise);
    mount();
    await screen.findByText('Subject b');
    fireEvent.click(within(row('b')).getByRole('button', { name: 'Select Subject b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    expect(screen.queryByText('Subject b')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Star Subject a' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/a/star', { is_starred: true }, expect.any(Object)));
    failLists = true;
    await act(async () => { trash.resolve({ error: 'Rejected' }); });
    await waitFor(() => expect(row('b')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unstar Subject a' })).toBeInTheDocument();
    expect(cached('a')?.is_starred).toBe(true);
  });

  it('moves a message out of the list at once, closes it in the reader, and sends one request for repeated clicks', async () => {
    const move = deferred<WriteResponse>();
    vi.mocked(api.post).mockReturnValue(move.promise);
    mount();
    fireEvent.click(await screen.findByText('Subject c'));
    await screen.findByText(bodyText('c'));
    fireEvent.contextMenu(row('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Archive' }));
    expect(screen.queryByText('Subject c')).not.toBeInTheDocument();
    expect(screen.queryByText(bodyText('c'))).not.toBeInTheDocument();
    expect(cached('c')).toBeUndefined();
    // The same move again while the first is in flight is not a second request.
    fireEvent.contextMenu(row('a'));
    expect(screen.queryByRole('button', { name: 'Move to Archive' })).toBeInTheDocument();
    fireEvent.click(document.body);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/emails/bulk-move', { email_ids: ['c'], folder: 'archive', account_id: undefined }, expect.any(Object)));
    expect(api.post).toHaveBeenCalledTimes(1);
    stored[2] = { ...stored[2], folder: 'archive' };
    operations = [{ id: 'op-c', email_id: 'c', action: 'move', status: 'pending', error: null, created_at: '2026-09-01T10:00:00Z' }];
    await act(async () => { move.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Moved to Archive', description: 'Waiting for the server' })));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // The accepted provider change is visible in the sync control, not on the row.
    await screen.findByRole('button', { name: 'Sync mail — 1 change waiting — open sync details' });
    expect(screen.queryByText('Subject c')).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('shows a quiet pending mark on the row and in the reader until the provider confirms', async () => {
    const write = deferred<WriteResponse>();
    vi.mocked(api.put).mockReturnValue(write.promise);
    mount();
    fireEvent.click(await screen.findByText('Subject c'));
    await screen.findByText(bodyText('c'));
    expect(screen.queryAllByTestId('mail-pending-mark')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Star message' }));
    // Immediate: the star is filled everywhere and nothing is disabled.
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Unstar Subject c' })).toBeEnabled();
    const marks = screen.getAllByTestId('mail-pending-mark');
    expect(marks).toHaveLength(2);
    expect(marks.map(mark => mark.getAttribute('title'))).toEqual(['Saving…', 'Saving…']);
    expect(screen.getAllByText('Saving…')).toHaveLength(2);
    stored[2] = { ...stored[2], is_starred: true, star_sync_pending: true };
    operations = [{ id: 'op-c', email_id: 'c', action: 'star', status: 'pending', error: null, created_at: '2026-09-01T10:00:00Z' }];
    await act(async () => { write.resolve({ data: { sync_pending: true } }); });
    await waitFor(() => expect(screen.getAllByText('Star change waiting for the server')).toHaveLength(2));
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    stored[2].star_sync_pending = false;
    operations = [{ ...operations[0], status: 'done' }];
    await act(async () => { await client.invalidateQueries({ queryKey: mailQueryKeys.writebacks }); });
    await waitFor(() => expect(screen.queryAllByTestId('mail-pending-mark')).toHaveLength(0));
    expect(screen.getByRole('button', { name: 'Unstar message' })).toBeEnabled();
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('opens a message from its row at once, marks it read before the body arrives, and reverts the count on rejection', async () => {
    const detail = deferred<{ data: { email: Email } }>();
    nextDetail = detail;
    const read = deferred<WriteResponse>();
    vi.mocked(api.put).mockReturnValue(read.promise);
    mount();
    await screen.findByText('Subject a');
    await waitFor(() => expect(inboxCount()).toBe('2'));
    fireEvent.click(within(row('a')).getByText('Subject a'));
    // Header from the row, body loading, no floating spinner; already read.
    expect(screen.getByRole('heading', { name: 'Subject a' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading email…');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeEnabled();
    expect(within(row('a')).getByText('Sender a')).not.toHaveClass('font-semibold');
    expect(inboxCount()).toBe('1');
    expect(api.put).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/read', { is_read: true }, expect.any(Object));
    await act(async () => { detail.resolve({ data: { email: structuredClone(stored[0]) } }); });
    await screen.findByText(bodyText('a'));
    expect(screen.getByRole('button', { name: 'Reply' })).toBeEnabled();
    // The detail (still unread on the server) does not undo the requested read or ask again.
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeEnabled();
    expect(api.put).toHaveBeenCalledTimes(1);
    failLists = true;
    await act(async () => { read.resolve({ error: 'Mail account is busy' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' })).toBeEnabled());
    expect(within(row('a')).getByText('Sender a')).toHaveClass('font-semibold');
    expect(inboxCount()).toBe('2');
    expect(screen.getByText(bodyText('a'))).toBeInTheDocument();
  });

  it('refreshes once after a burst of accepted flag changes instead of refetching the list per message', async () => {
    mount();
    await screen.findByText('Subject a');
    await waitFor(() => expect(inboxCount()).toBe('2'));
    const listsBefore = calls('/mail/emails?');
    const countsBefore = calls('/mail/unread-counts');
    fireEvent.click(within(row('a')).getByRole('button', { name: 'Select Subject a' }));
    fireEvent.click(within(row('b')).getByRole('button', { name: 'Select Subject b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark selected as read' }));
    expect(inboxCount()).toBeNull();
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    stored = stored.map(email => ({ ...email, is_read: true }));
    await wait(MAIL_FLAG_REFRESH_MS + 100);
    await waitFor(() => expect(calls('/mail/unread-counts')).toBe(countsBefore + 1));
    // The inbox list already shows the accepted rows; only filtered views refetch.
    expect(calls('/mail/emails?')).toBe(listsBefore);
    expect(inboxCount()).toBeNull();
    expect(screen.queryAllByTestId('mail-pending-mark')).toHaveLength(0);
  });
});
