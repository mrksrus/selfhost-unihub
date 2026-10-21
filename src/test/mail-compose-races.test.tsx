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

  it('Save draft in the close prompt does not close a message edited again meanwhile', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.put>>>();
    vi.mocked(api.put).mockReturnValueOnce(save.promise);
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.updateComposeForm({ subject: 'first edit' }));
    act(() => hook.result.current.closeComposeFlow());
    act(() => hook.result.current.saveAndClose());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    // Keep editing, while the save runs.
    act(() => hook.result.current.setComposeClosePromptOpen(false));
    act(() => hook.result.current.updateComposeForm({ subject: 'newest text' }));
    await act(async () => save.resolve({ data: { draft } }));
    expect(hook.result.current.isComposeOpen).toBe(true);
    expect(hook.result.current.composeForm.subject).toBe('newest text');
    expect(hook.result.current.isDirty).toBe(true);
  });
});

describe('attachments and saves of one draft (B-12)', () => {
  const stored = { id: 'att-stored', filename: 'kept.txt', size_bytes: 1, content_type: 'text/plain' };
  const file = (name: string, lastModified = 1) => new File([name], name, { type: 'text/plain', lastModified });
  const putBody = (call: number) => vi.mocked(api.put).mock.calls[call][1] as Record<string, unknown>;
  const answer = (uploaded: Array<{ client_id: string; id: string }> = []) => ({ data: { draft, uploaded } });

  it('an attachment removed while a text autosave runs stays removed', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.put>>>();
    const withAttachment = { ...draft, attachments: [stored] } as Email;
    vi.mocked(api.put).mockReturnValueOnce(save.promise).mockResolvedValue({ data: { draft: withAttachment } });
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(withAttachment));
    act(() => hook.result.current.updateComposeForm({ subject: 'edited' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1), { timeout: 2500 });
    act(() => hook.result.current.removeExistingDraftAttachment('att-stored'));
    await act(async () => save.resolve({ data: { draft: withAttachment } }));
    expect(hook.result.current.existingDraftAttachments).toEqual([]);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(putBody(1)).toHaveProperty('existing_attachment_ids', []);
  });

  it('a file removed while it is being uploaded stays removed, and the draft drops it', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.put>>>();
    vi.mocked(api.put).mockReturnValueOnce(save.promise).mockResolvedValue(answer());
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.addComposeFiles([file('private.txt')]));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1), { timeout: 2500 });
    const [sent] = putBody(0).attachments as Array<{ client_id: string }>;
    act(() => hook.result.current.removeComposeAttachment(sent.client_id));
    // The stored draft has the file now; its answer must not bring it back.
    await act(async () => save.resolve({ data: { draft: { ...draft, attachments: [{ ...stored, id: 'att-private', filename: 'private.txt' }] },
      uploaded: [{ client_id: sent.client_id, id: 'att-private' }] } }));
    expect(hook.result.current.composeAttachments).toEqual([]);
    expect(hook.result.current.existingDraftAttachments).toEqual([]);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(putBody(1)).toEqual(expect.objectContaining({ existing_attachment_ids: [], attachments: [] }));
  });

  it('a save asked for while another runs waits for it, and uploads nothing twice', async () => {
    const first = deferred<Awaited<ReturnType<typeof api.put>>>();
    vi.mocked(api.put).mockReturnValueOnce(first.promise).mockResolvedValue(answer());
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.addComposeFiles([file('report.txt')]));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1), { timeout: 2500 });
    const [sent] = putBody(0).attachments as Array<{ client_id: string }>;
    act(() => hook.result.current.updateComposeForm({ subject: 'while uploading' }));
    let second!: Promise<Email | null>;
    act(() => { second = hook.result.current.saveCurrentDraft({ includeAttachments: true }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(api.put).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(answer([{ client_id: sent.client_id, id: 'att-report' }])); await second; });
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(putBody(1)).toEqual(expect.objectContaining({ subject: 'while uploading', existing_attachment_ids: ['att-report'], attachments: [] }));
  });

  it('of two files with the same name and size, the one removed is the one dropped', async () => {
    vi.mocked(api.put).mockImplementation(async (_path, body) => answer(((body as { attachments?: Array<{ client_id: string }> }).attachments ?? [])
      .map((attachment, index) => ({ client_id: attachment.client_id, id: `att-${index}` }))));
    const hook = mount();
    act(() => hook.result.current.openDraftForCompose(draft));
    act(() => hook.result.current.addComposeFiles([file('notes.txt', 1), file('notes.txt', 2)]));
    await act(async () => { await hook.result.current.saveCurrentDraft({ includeAttachments: true }); });
    act(() => hook.result.current.removeComposeAttachment(hook.result.current.composeAttachments[1].id));
    await act(async () => { await hook.result.current.saveCurrentDraft({ includeAttachments: true }); });
    expect(putBody(1)).toEqual(expect.objectContaining({ existing_attachment_ids: ['att-0'], attachments: [] }));
  });

  it('Send while the first autosave is still creating the draft sends that draft and leaves no copy', async () => {
    const created = deferred<Awaited<ReturnType<typeof api.post>>>();
    const fresh = { ...draft, id: 'draft-new' } as Email;
    vi.mocked(api.post).mockImplementation(async path => path === '/mail/drafts' ? created.promise : { data: { message: 'sent' } });
    vi.mocked(api.put).mockResolvedValue({ data: { draft: fresh, uploaded: [] } });
    const hook = mount();
    act(() => hook.result.current.openCompose());
    act(() => hook.result.current.updateComposeForm({ to: 'reader@example.test', subject: 'New', body: '<p>Hi</p>' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/drafts', expect.anything()), { timeout: 2500 });
    send(hook);
    await act(async () => created.resolve({ data: { draft: fresh, uploaded: [] } }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/drafts/draft-new/send', undefined, expect.anything()));
    expect(vi.mocked(api.post).mock.calls.map(([path]) => path)).not.toContain('/mail/send');
  });

  it('Discard while the first autosave is still creating the draft deletes that draft', async () => {
    const created = deferred<Awaited<ReturnType<typeof api.post>>>();
    vi.mocked(api.post).mockImplementation(async path => path === '/mail/drafts' ? created.promise : { data: {} });
    const hook = mount();
    act(() => hook.result.current.openCompose());
    act(() => hook.result.current.updateComposeForm({ to: 'reader@example.test', subject: 'Never mind' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/drafts', expect.anything()), { timeout: 2500 });
    let discarding!: Promise<void>;
    act(() => { discarding = hook.result.current.discardCurrentCompose(); });
    await act(async () => { created.resolve({ data: { draft: { ...draft, id: 'draft-new' }, uploaded: [] } }); await discarding; });
    expect(api.delete).toHaveBeenCalledWith('/mail/drafts/draft-new');
    expect(hook.result.current.isComposeOpen).toBe(false);
  });
});
