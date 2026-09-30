import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import ModuleGuard from '@/components/modules/ModuleGuard';
import { useModules, type ModulePreference } from '@/hooks/use-modules';
import { NoteDraftProvider } from '@/hooks/use-note-draft';
import Notes from '@/pages/Notes';
import { api } from '@/lib/api';
import type { NoteDetail } from '@/lib/notes-api';

vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function renderWithClient(children: React.ReactNode, modules?: ModulePreference[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (modules) client.setQueryData(['modules'], modules);
  return render(<QueryClientProvider client={client}><MemoryRouter><NoteDraftProvider>{children}</NoteDraftProvider></MemoryRouter></QueryClientProvider>);
}
function NavigationProbe() { const { canNavigate } = useModules(); return <span>{canNavigate('/notes') ? 'Navigation shown' : 'Navigation hidden'}</span>; }
const note: NoteDetail = { note: { id: 'note-1', title: 'Trip plans', body: 'Original text', revision: 3, trashed_at: null, created_at: '2026-09-19T12:00:00Z', updated_at: '2026-09-19T12:00:00Z' }, links: [], attachments: [], revisions: [{ revision: 3, title: 'Trip plans', created_at: '2026-09-19T12:00:00Z' }] };
function mockNotes() { return vi.spyOn(api, 'get').mockImplementation(async endpoint => endpoint === '/notes/note-1' ? { data: note } : { data: { notes: [note.note] } }); }

describe('optional module access', () => {
  it('keeps hidden modules accessible by direct route', () => {
    renderWithClient(<><NavigationProbe /><ModuleGuard id="notes"><p>Note content</p></ModuleGuard></>, [{ id: 'notes', label: 'Notes', enabled: true, visible: false, background: true }]);
    expect(screen.getByText('Navigation hidden')).toBeInTheDocument();
    expect(screen.getByText('Note content')).toBeInTheDocument();
  });
  it('does not mount a disabled page and keeps recovery reachable', () => {
    const mounted = vi.fn(); function Page() { mounted(); return <p>Private content</p>; }
    renderWithClient(<ModuleGuard id="notes"><Page /></ModuleGuard>, [{ id: 'notes', label: 'Notes', enabled: false, visible: true, background: true }]);
    expect(mounted).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Data management' })).toHaveAttribute('href', '/settings?tab=data');
    expect(screen.getByText('Notes is disabled')).toBeInTheDocument();
  });
});

describe('note editing', () => {
  it('sends the original revision and preserves text on conflict', async () => {
    mockNotes(); const put = vi.spyOn(api, 'put').mockResolvedValue({ error: 'Note has changed. Reload before saving.', status: 409 });
    renderWithClient(<Notes />);
    fireEvent.click(await screen.findByRole('button', { name: /Trip plans/ }));
    await screen.findByDisplayValue('Original text');
    fireEvent.change(screen.getByLabelText('Text or Markdown'), { target: { value: 'My unsaved revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Note has changed. Reload before saving.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('My unsaved revision')).toBeInTheDocument();
    expect(put).toHaveBeenCalledWith('/notes/note-1', { title: 'Trip plans', body: 'My unsaved revision', linked_note_ids: [], expected_revision: 3 });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved note' }));
    expect(screen.getByDisplayValue('My unsaved revision')).toBeInTheDocument();
  });
  it('retains an unsaved draft across page navigation and warns on closing', async () => {
    mockNotes();
    renderWithClient(<><Link to="/">Notes page</Link><Link to="/elsewhere">Leave page</Link><Routes><Route path="/" element={<Notes />} /><Route path="/elsewhere" element={<p>Other page</p>} /></Routes></>);
    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Keep this draft' } });
    fireEvent.change(screen.getByLabelText('Text or Markdown'), { target: { value: 'Not yet saved' } });
    fireEvent.click(screen.getByRole('link', { name: 'Leave page' }));
    const closing = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Notes page' }));
    expect(screen.getByDisplayValue('Not yet saved')).toBeInTheDocument();
  });
  it('keeps an in-flight save locked across navigation so a late response cannot overwrite a new edit', async () => {
    mockNotes();
    let finish!: (value: { data: NoteDetail }) => void;
    vi.spyOn(api, 'put').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderWithClient(<><Link to="/">Notes page</Link><Link to="/elsewhere">Leave page</Link><Routes><Route path="/" element={<Notes />} /><Route path="/elsewhere" element={<p>Other page</p>} /></Routes></>);
    fireEvent.click(await screen.findByRole('button', { name: /Trip plans/ }));
    await screen.findByDisplayValue('Original text');
    fireEvent.change(screen.getByLabelText('Text or Markdown'), { target: { value: 'Saving this text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    fireEvent.click(screen.getByRole('link', { name: 'Leave page' }));
    fireEvent.click(screen.getByRole('link', { name: 'Notes page' }));
    expect(screen.getByLabelText('Text or Markdown')).toBeDisabled();
    await act(async () => finish({ data: { ...note, note: { ...note.note, body: 'Saving this text', revision: 4 } } }));
    expect(screen.getByDisplayValue('Saving this text')).not.toBeDisabled();
    expect(screen.getByText('Saved revision 4')).toBeInTheDocument();
  });
  it('requires saving before attachment changes and rejects oversized files locally', async () => {
    mockNotes(); const post = vi.spyOn(api, 'post');
    renderWithClient(<Notes />); fireEvent.click(await screen.findByRole('button', { name: /Trip plans/ }));
    await screen.findByDisplayValue('Original text');
    fireEvent.change(screen.getByLabelText('Text or Markdown'), { target: { value: 'changed' } });
    expect(screen.getByLabelText('Attach a file')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Text or Markdown'), { target: { value: 'Original text' } });
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.bin');
    fireEvent.change(screen.getByLabelText('Attach a file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('up to 2 MiB'));
    expect(post).not.toHaveBeenCalled();
  });
});
