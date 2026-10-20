import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useMailCompose } from '@/hooks/use-mail-compose';
import type { Email, MailAccount } from '@/lib/mail-api';

// A message closed or replaced while its draft is saved or its attachments
// are read: the late result belongs to that message only.
const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const account = { id: 'account-a', email_address: 'alex@example.test', display_name: 'Alex', provider: 'custom', is_active: true, last_synced_at: null } as MailAccount;
const draft = { id: 'draft-a', mail_account_id: account.id, folder: 'drafts', is_draft: true, subject: 'A', from_address: account.email_address,
  to_addresses: ['someone@example.test'], body_html: '<p>A</p>', received_at: '2026-10-10T08:00:00Z', is_read: true, is_starred: false } as Email;

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderHook(() => useMailCompose({ activeMailAccountId: account.id, selectedAccount: account.id, isMobile: false }),
    { wrapper: ({ children }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider> });
}
const send = (hook: ReturnType<typeof mount>) => act(() => hook.result.current.handleSendEmail({ preventDefault() {} } as React.FormEvent));
/** Attachment reads that finish when the test says. */
function pendingReads() {
  const reads: (() => void)[] = [];
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    reads.push(() => { Object.defineProperty(this, 'result', { value: 'data:text/plain;base64,SGVsbG8=' }); this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>); });
  });
  return reads;
}

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async path => ({ data: path.startsWith('/mail/accounts') ? { accounts: [account] } : path === '/settings/preferences' ? { preferences: {} } : { contacts: [] } }));
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'sent' } });
  vi.mocked(api.put).mockResolvedValue({ data: { draft } });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('a send or save that ends after its message was closed', () => {
  it('a late draft save neither sends nor gives the next message its draft or drops its attachment', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.put>>>();
    vi.mocked(api.put).mockReturnValueOnce(save.promise);
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    send(hook);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/drafts/draft-a', expect.anything()));
    // The stored draft is unchanged, so Cancel closes it while the save runs; B is started.
    act(() => hook.result.current.closeComposeFlow());
    act(() => hook.result.current.openCompose());
    act(() => hook.result.current.updateComposeForm({ to: 'b@example.test', subject: 'Unsaved B', body: '<p>B</p>' }));
    act(() => hook.result.current.addComposeFiles([new File(['B'], 'b.txt', { type: 'text/plain' })]));

    await act(async () => save.resolve({ data: { draft } }));
    expect(api.post).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not sent' }));
    const current = hook.result.current;
    expect({ subject: current.composeForm.subject, draftId: current.activeDraftId, attachments: current.composeAttachments.map(item => item.file.name), dirty: current.isDirty })
      .toEqual({ subject: 'Unsaved B', draftId: null, attachments: ['b.txt'], dirty: true });
  });

  it('Discard stops a draft send at once, even while the draft is still being deleted', async () => {
    const deletion = deferred<Awaited<ReturnType<typeof api.delete>>>();
    vi.mocked(api.delete).mockReturnValueOnce(deletion.promise);
    const reads = pendingReads();
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.addComposeFiles([new File(['A'], 'a.txt', { type: 'text/plain' })]));
    send(hook);
    expect(reads).toHaveLength(1);
    let discarding!: Promise<void>;
    act(() => { discarding = hook.result.current.discardCurrentCompose(); });
    expect(api.delete).toHaveBeenCalledWith('/mail/drafts/draft-a');
    // The attachment is read before the deletion answers.
    await act(async () => reads[0]());
    await act(async () => { deletion.resolve({ data: {} }); await discarding; });
    expect(vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith('/send'))).toHaveLength(0);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('a Discard that fails leaves the message usable once its autosave ends', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.put>>>();
    vi.mocked(api.put).mockReturnValueOnce(save.promise);
    vi.mocked(api.delete).mockResolvedValueOnce({ error: 'Temporary outage', status: 503 });
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.updateComposeForm({ subject: 'A edited' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled(), { timeout: 2500 });
    await act(async () => hook.result.current.discardCurrentCompose());
    await act(async () => save.resolve({ data: { draft } }));
    expect(hook.result.current.isComposeOpen).toBe(true);
    expect(hook.result.current.isDraftSaving).toBe(false);
  });

  it('a Discard that answers after the message was saved and closed leaves the next message open', async () => {
    const deletion = deferred<Awaited<ReturnType<typeof api.delete>>>();
    vi.mocked(api.delete).mockReturnValueOnce(deletion.promise);
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.updateComposeForm({ subject: 'A edited' }));
    act(() => hook.result.current.closeComposeFlow());
    let discarding!: Promise<void>;
    act(() => { discarding = hook.result.current.discardCurrentCompose(); });
    // The same prompt's Save draft is chosen while the deletion runs.
    act(() => hook.result.current.saveAndClose());
    await waitFor(() => expect(hook.result.current.isComposeOpen).toBe(false));
    act(() => hook.result.current.openCompose());
    act(() => hook.result.current.updateComposeForm({ to: 'b@example.test', subject: 'Unsaved B' }));
    await act(async () => { deletion.resolve({ data: {} }); await discarding; });
    expect(hook.result.current.isComposeOpen).toBe(true);
    expect(hook.result.current.composeForm.subject).toBe('Unsaved B');
  });
});

describe('edits made while a draft is saved', () => {
  it('stay unsaved, and the next autosave stores them', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.put>>>();
    vi.mocked(api.put).mockReturnValueOnce(save.promise);
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.updateComposeForm({ subject: 'first edit' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1), { timeout: 2500 });
    act(() => hook.result.current.updateComposeForm({ subject: 'second edit' }));
    await act(async () => save.resolve({ data: { draft } }));
    expect(vi.mocked(api.put).mock.calls[0][1]).toEqual(expect.objectContaining({ subject: 'first edit' }));
    expect(hook.result.current.isDirty).toBe(true);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(vi.mocked(api.put).mock.calls[1][1]).toEqual(expect.objectContaining({ subject: 'second edit' }));
  });
});
