import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';
import type { Email, MailThreadSummary } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';
import type { UserSettingValues } from '@/lib/settings-api';
import { applyMailPageWaitBudget, MAIL_PAGE_TEST_TIMEOUT } from '@/test/helpers/mail-page-budget';
import { userSettingsAnswer } from './settings-fixtures';

// Snooze and the conversation list (0.24) through the whole Mail page with
// only the network mocked: the row leaves and returns with the request's
// outcome, the Snoozed view lists and unsnoozes, and the conversation list
// pages by cursor without ever showing another account's late page.

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Reply = { data?: unknown; error?: string; status?: number };

const SOON = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const message = (id: string, fields: Partial<Email> = {}): Email => ({
  id, mail_account_id: 'account-1', subject: `Subject ${id}`, from_address: `${id}@example.test`, from_name: `Sender ${id}`,
  to_addresses: ['owner@example.test'], body_text: `Body ${id}`, body_html: null, folder: 'inbox', is_read: true, is_starred: false,
  received_at: '2026-09-01T10:00:00Z', snoozed_until: null, snooze_returned_at: null, ...fields,
});
const folder = (slug: string, display_name: string, position: number) =>
  ({ id: `f-${slug}`, slug, display_name, is_system: true, position, total_count: 0, unread_count: 0 });
const conversation = (id: string, count: number, unread = 0, fields: Partial<Email> = {}): MailThreadSummary => ({
  thread_key: `key-${id}`, latest: message(id, fields) as MailThreadSummary['latest'], message_count: count, unread_count: unread, total_count: count,
  has_attachments: false, is_starred: false, participants: [{ address: `${id}@example.test`, name: `Sender ${id}` }, { address: 'owner@example.test', name: 'Owner' }],
});
const snoozedNow = (email: Email) => !!email.snoozed_until && Date.parse(email.snoozed_until) > Date.now();

let client: QueryClient;
let stored: Email[];
let settings: Partial<UserSettingValues>;
let failLists: boolean;
/** Conversation pages by `${account}|${cursor}`; a page with a deferred reply waits for it. */
let threadPages: Record<string, { threads: MailThreadSummary[]; next_cursor: string | null }>;
let slowPages: Partial<Record<string, Promise<Reply>>>;

function mount() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/mail']}><MailPage /></MemoryRouter></QueryClientProvider>);
}
function row(id: string) {
  return screen.getByRole('button', { name: new RegExp(`^(Unstar|Star) Subject ${id}$`) }).closest('li') as HTMLElement;
}
const wait = (ms: number) => act(() => new Promise(resolve => setTimeout(resolve, ms)));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setOfflineMode(false);
  stored = [message('a', { is_read: false }), message('b'), message('c')];
  settings = {};
  failLists = false;
  threadPages = {};
  slowPages = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/mail/accounts') return { data: { accounts: [
      { id: 'account-1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null, sync_mode: 'sync' },
      { id: 'account-2', email_address: 'other@example.test', display_name: 'Other', provider: 'custom', is_active: true, last_synced_at: null, sync_mode: 'sync' },
    ] } };
    if (path === '/mail/folders') return { data: { folders: [folder('inbox', 'Inbox', 0), folder('drafts', 'Drafts', 1), folder('archive', 'Archive', 2), folder('trash', 'Trash', 3)] } };
    if (path.startsWith('/mail/unread-counts')) return { data: { unreadByFolder: {}, unreadByFolderAccount: {} } };
    if (path.startsWith('/contacts')) return { data: { contacts: [] } };
    if (path === '/mail/writebacks') return { data: { operations: [] } };
    if (path === '/mail/sync/status') return { data: { accounts: [] } };
    if (path === '/settings/values') return userSettingsAnswer(settings);
    if (path.startsWith('/mail/emails?')) {
      if (failLists) return { error: 'List refresh unavailable' };
      const params = new URLSearchParams(path.split('?')[1]);
      const emails = stored.filter(email => (params.get('folder') === 'snoozed' ? snoozedNow(email)
        : (!params.get('folder') || email.folder === params.get('folder')) && (settings.snoozed_messages === 'keep' || !snoozedNow(email)))
        && (!params.get('account_id') || email.mail_account_id === params.get('account_id')));
      return { data: { emails: structuredClone(emails), pagination: { total: emails.length, limit: 50, offset: 0, page: 1, totalPages: 1 } } };
    }
    if (path.startsWith('/mail/threads?')) {
      const params = new URLSearchParams(path.split('?')[1]);
      const key = `${params.get('account_id') ?? 'all'}|${params.get('cursor') ?? ''}`;
      const slow = slowPages[key];
      if (slow) return slow;
      const page = threadPages[key];
      if (!page) throw new Error(`No conversation page for ${key}`);
      return { data: { threads: structuredClone(page.threads), pagination: { total: null, limit: 50, offset: 0, page: 1, totalPages: null, hasMore: !!page.next_cursor, next_cursor: page.next_cursor } } };
    }
    if (/^\/mail\/emails\/[^/]+\/thread$/.test(path)) return { data: { thread_key: null, messages: [], truncated: false } };
    if (path.startsWith('/mail/emails/')) return { data: { email: structuredClone(stored.find(email => email.id === path.split('/').pop())) } };
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  });
  vi.mocked(api.put).mockResolvedValue({ data: { sync_pending: false } });
  // The synthetic server accepts a snooze and its end at once.
  vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
    const email = stored.find(entry => path === `/mail/emails/${entry.id}/snooze`);
    if (!email) throw new Error(`Unexpected POST ${path}`);
    email.snoozed_until = (body as { until: string }).until;
    return { data: { email_id: email.id, snoozed_until: email.snoozed_until } };
  });
  vi.mocked(api.delete).mockImplementation(async (path: string) => {
    const email = stored.find(entry => path === `/mail/emails/${entry.id}/snooze`);
    if (!email) throw new Error(`Unexpected DELETE ${path}`);
    email.snoozed_until = null;
    return { data: { email_id: email.id, snoozed_until: null } };
  });
});
afterEach(() => { cleanup(); client.clear(); });

applyMailPageWaitBudget();

async function snoozeFromRow(id: string) {
  fireEvent.contextMenu(row(id), { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByRole('button', { name: 'Snooze…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Snooze until' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^In 1 hour/ }));
}

describe('snooze', { timeout: MAIL_PAGE_TEST_TIMEOUT }, () => {
  it('takes the message out of the list at once and puts it back from the snapshot when the server refuses', async () => {
    const request = deferred<Reply>();
    vi.mocked(api.post).mockReturnValue(request.promise as never);
    mount();
    await screen.findByText('Subject a');
    await snoozeFromRow('a');
    await waitFor(() => expect(screen.queryByText('Subject a')).not.toBeInTheDocument());
    expect(screen.getByText('Subject b')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/snooze', { until: expect.any(String) });
    // Rolled back from the snapshot, not from a refetch (the list refresh fails here).
    failLists = true;
    await act(async () => { request.resolve({ error: 'Mail is paused' }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not snooze', description: 'Mail is paused', variant: 'destructive' })));
    expect(await screen.findByText('Subject a')).toBeInTheDocument();
  });

  it('offers Undo on the toast, which brings the message back', async () => {
    mount();
    await screen.findByText('Subject a');
    await snoozeFromRow('a');
    await waitFor(() => expect(screen.queryByText('Subject a')).not.toBeInTheDocument());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Snoozed until /) })));
    const snoozed = toast.mock.calls.map(([entry]) => entry).find(entry => /^Snoozed until /.test(entry.title));
    expect(stored.find(email => email.id === 'a')?.snoozed_until).toBeTruthy();
    await act(async () => { snoozed.action.props.onClick(); });
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/emails/a/snooze'));
    expect(await screen.findByText('Subject a')).toBeInTheDocument();
  });

  it('the Snoozed view lists the waiting messages with their return time and brings one back', async () => {
    stored[1].snoozed_until = SOON;
    mount();
    await screen.findByText('Subject a');
    expect(screen.queryByText('Subject b')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Mail folders' });
    fireEvent.click(within(nav).getByRole('button', { name: /^Snoozed/ }));
    await screen.findByText('Subject b');
    expect(screen.queryByText('Subject a')).not.toBeInTheDocument();
    expect(within(row('b')).getByText(/^Until /)).toBeInTheDocument();
    fireEvent.click(within(row('b')).getByRole('button', { name: 'Unsnooze' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/mail/emails/b/snooze'));
    await waitFor(() => expect(screen.queryByText('Subject b')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Brought back' }));
    fireEvent.click(within(nav).getByRole('button', { name: /^Inbox/ }));
    expect(await screen.findByText('Subject b')).toBeInTheDocument();
  });

  it('kept in the folder, the row stays with its time, loses it when the server refuses, and loses it when brought back', async () => {
    settings = { snoozed_messages: 'keep' };
    const request = deferred<Reply>();
    vi.mocked(api.post).mockReturnValueOnce(request.promise as never);
    mount();
    await screen.findByText('Subject a');
    await snoozeFromRow('a');
    expect(await within(row('a')).findByText(/^Snoozed until /)).toBeInTheDocument();
    await act(async () => { request.resolve({ error: 'Mail is paused' }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not snooze' })));
    await waitFor(() => expect(within(row('a')).queryByText(/^Snoozed until /)).not.toBeInTheDocument());

    await snoozeFromRow('a');
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Snoozed until /),
      description: 'It stays in its folder. You get a notification then.' })));
    // Still listed after the refresh that follows the answer.
    await wait(50);
    expect(within(row('a')).getByText(/^Snoozed until /)).toBeInTheDocument();
    fireEvent.contextMenu(row('a'), { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByRole('button', { name: 'Unsnooze' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/mail/emails/a/snooze'));
    await waitFor(() => expect(within(row('a')).queryByText(/^Snoozed until /)).not.toBeInTheDocument());
  });

  it('is not offered while offline', async () => {
    setOfflineMode(true);
    mount();
    await screen.findByText('Subject a');
    fireEvent.contextMenu(row('a'), { clientX: 20, clientY: 20 });
    expect(await screen.findByRole('button', { name: 'Snooze…' })).toBeDisabled();
  });
});

describe('conversation list', { timeout: MAIL_PAGE_TEST_TIMEOUT }, () => {
  it('pages by cursor, and a slow page of the previous account never shows after switching', async () => {
    settings = { mail_threaded_view: true };
    threadPages['all|'] = { threads: [conversation('a', 3, 1), conversation('b', 1)], next_cursor: 'cursor-2' };
    threadPages['all|cursor-2'] = { threads: [conversation('c', 2)], next_cursor: null };
    threadPages['account-2|'] = { threads: [conversation('z', 1)], next_cursor: null };
    const slow = deferred<Reply>();
    slowPages['all|cursor-2'] = slow.promise;
    mount();
    await screen.findByText('Subject a');
    expect(screen.getByLabelText('3 messages')).toBeInTheDocument();
    expect(within(row('a')).getByText('Sender a, Owner')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/mail\/emails\?/), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/mail\/threads\?.*cursor=cursor-2/), expect.anything()));
    // Switch accounts while page 2 of "All accounts" is still on its way.
    fireEvent.click(within(screen.getByRole('region', { name: 'Mail accounts' })).getByRole('button', { name: /^Other/ }));
    await screen.findByText('Subject z');
    await act(async () => { slow.resolve({ data: { threads: [conversation('c', 2)], pagination: { total: null, limit: 50, offset: 0, page: 2, totalPages: null, hasMore: false, next_cursor: null } } }); });
    await wait(50);
    expect(screen.getByText('Subject z')).toBeInTheDocument();
    expect(screen.queryByText('Subject c')).not.toBeInTheDocument();
    expect(screen.queryByText('Subject a')).not.toBeInTheDocument();
  });
});
