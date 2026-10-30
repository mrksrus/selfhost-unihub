import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { Toaster } from '@/components/ui/toaster';
import { useContactActions } from '@/hooks/use-contact-actions';
import { ContactEditor, type ContactEditorTarget } from '@/components/contacts/ContactEditor';
import { api } from '@/lib/api';
import { saveFile } from '@/lib/platform';
import { contact } from './contact-fixtures';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn(), postBlob: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));
vi.mock('@/lib/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), saveFile: vi.fn().mockResolvedValue(undefined) }));

// A's private contact, answered only after the page has switched to B.
const annaOfA = contact('a-1', { name: { given: 'Annaprivate', family: 'Ofaccount' }, emails: ['anna.private@example.com'] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let clients: QueryClient[] = [];
function Actions({ editor }: { editor?: ContactEditorTarget }) {
  const actions = useContactActions();
  clients.push(useQueryClient());
  return (
    <>
      <button type="button" onClick={() => actions.merge.mutate({ contact_ids: ['a-1', 'a-2'], versions: { 'a-1': 1, 'a-2': 1 } })}>Merge</button>
      <button type="button" onClick={() => actions.undoMerge.mutate('m-1')}>Undo</button>
      <button type="button" onClick={() => actions.exportContacts.mutate({ ids: null, format: 'vcard4' })}>Export</button>
      <button type="button" onClick={() => actions.remove.mutate('a-1')}>Delete</button>
      <ContactEditor target={editor ?? null} onClose={() => {}} actions={actions} />
    </>
  );
}

function Session({ user, editor }: { user: string; editor?: ContactEditorTarget }) {
  return (
    <SessionQueryProvider key={user} privateSession>
      <Toaster />
      <p>Signed in as {user}</p>
      <Actions editor={editor} />
    </SessionQueryProvider>
  );
}

beforeEach(() => {
  clients = [];
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  globalThis.URL.createObjectURL ??= () => 'blob:preview';
  globalThis.URL.revokeObjectURL ??= () => {};
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('contacts answers after an account switch', () => {
  it('a delayed merge, undo, export and delete of A show, cache and save nothing in B', async () => {
    const merge = deferred<unknown>();
    const undo = deferred<unknown>();
    const exported = deferred<unknown>();
    const removed = deferred<unknown>();
    vi.mocked(api.post).mockImplementation(async (path: string) => (path === '/contacts/merges' ? merge.promise : undo.promise) as never);
    vi.mocked(api.getBlob).mockReturnValue(exported.promise as never);
    vi.mocked(api.delete).mockReturnValue(removed.promise as never);
    const { rerender } = render(<Session user="A" />);
    for (const name of ['Merge', 'Undo', 'Export', 'Delete']) fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(api.getBlob).toHaveBeenCalled());

    rerender(<Session user="B" />);
    expect(await screen.findByText('Signed in as B')).toBeInTheDocument();
    const clientOfB = clients[clients.length - 1];
    await act(async () => {
      merge.resolve({ data: { merge_id: 'm-1', contact: annaOfA, merged_ids: ['a-2'] } });
      undo.resolve({ data: { restored_ids: ['a-2'], survivor_restored: true, message: 'Anna Privateofaccount is back as it was.' } });
      exported.resolve({ blob: new Blob(['BEGIN:VCARD\r\nFN:Annaprivate Ofaccount\r\nEND:VCARD\r\n']), filename: 'contacts.vcf' });
      removed.resolve({ data: { message: 'Contact deleted' } });
      await new Promise(done => setTimeout(done, 50));
    });
    expect(screen.queryByText(/Annaprivate|Privateofaccount|Merge undone|Contact deleted|Contacts exported/)).not.toBeInTheDocument();
    expect(saveFile).not.toHaveBeenCalled();
    // Nothing was refetched or written into B's cache on A's behalf.
    expect(clientOfB.getQueryCache().getAll()).toEqual([]);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a notice shown to A is gone in B', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { merge_id: 'm-1', contact: annaOfA, merged_ids: ['a-2'] } });
    vi.mocked(api.get).mockResolvedValue({ data: { contacts: [], has_more: false } });
    const { rerender } = render(<Session user="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText('Merged into Annaprivate Ofaccount')).toBeInTheDocument();
    rerender(<Session user="B" />);
    expect(await screen.findByText('Signed in as B')).toBeInTheDocument();
    expect(screen.queryByText(/Annaprivate/)).not.toBeInTheDocument();
  });

  it('an editor save answered after the switch uploads no photo into the next session', async () => {
    const saved = deferred<unknown>();
    vi.mocked(api.put).mockReturnValue(saved.promise as never);
    const { rerender } = render(<Session user="A" editor={{ kind: 'edit', contact: annaOfA }} />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit contact' });
    fireEvent.change(dialog.querySelector('input[type=file][accept="image/*"]')!, { target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    rerender(<Session user="B" />);
    await act(async () => {
      saved.resolve({ data: { contact: { ...annaOfA, version: 2 } } });
      await new Promise(done => setTimeout(done, 50));
    });
    expect(api.uploadBlob).not.toHaveBeenCalled();
    expect(screen.queryByText(/Annaprivate|Contact saved/)).not.toBeInTheDocument();
  });
});
