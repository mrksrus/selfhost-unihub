import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '@/lib/api';
import { BinView } from '@/components/bin/BinView';
import BinSettings from '@/components/settings/BinSettings';
import Contacts from '@/pages/Contacts';
import Recordings from '@/pages/Recordings';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import type { BinItem } from '@/lib/bin-api';
import { contact } from './contact-fixtures';
import { userSettingsAnswer } from './settings-fixtures';
import { OWNER, mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/hooks/use-audio-capture', () => ({ useAudioCapture: () => ({ state: 'idle', supported: true, start: vi.fn(), stop: vi.fn() }) }));
vi.mock('@/hooks/use-recording-uploads', () => ({ useStoredRecordings: () => ({ recordings: [], progress: {}, available: true }), closeUploadNotices: vi.fn(), kickRecordingUploads: vi.fn(), pageUploadRequest: vi.fn(), stopRecordingUploads: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn(), postBlob: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));

const item = (id: string, fields: Partial<BinItem>): BinItem => ({
  id, module: 'contacts', item_type: 'contact', title: id, reason: 'deleted', group_id: null, deleted_at: '2026-06-10T09:00:00.000Z',
  purge_after: '2026-07-10T09:00:00.000Z', provider: 'local', origin: null, ...fields,
});
const ITEMS: BinItem[] = [
  item('bin-alan', { title: 'Alan Turing' }),
  item('bin-merge-a', { title: 'Jane Doe', reason: 'merged', group_id: 'merge-1', deleted_at: '2026-06-12T09:00:00.000Z' }),
  item('bin-merge-b', { title: 'J. Doe', reason: 'merged', group_id: 'merge-1', deleted_at: '2026-06-12T09:00:00.000Z' }),
  item('bin-task', { module: 'calendar', item_type: 'task', title: 'Reply to Grace', provider: 'caldav', origin: 'Team', purge_after: null, deleted_at: '2026-06-14T09:00:00.000Z' }),
];
const DELETE_REASON = 'Your administrator does not allow deleting items from the bin for good.';

function answerGets(bin: BinItem[], policies = policiesAnswer()) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/bin')) return { data: { items: path.includes('module=contacts') ? bin.filter(entry => entry.module === 'contacts') : bin, retention: '30' } };
    if (path === '/policies/effective') return policies;
    if (path === '/settings/values') return userSettingsAnswer();
    if (path.startsWith('/contacts/duplicates')) return { data: { groups: [] } };
    if (path === '/contacts/merges') return { data: { merges: [] } };
    if (path.startsWith('/contacts')) return { data: { contacts: [contact('ada', { name: { given: 'Ada', family: 'Example' } })], has_more: false } };
    return { data: {} };
  });
}

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.post).mockResolvedValue({ data: { restored: [{ id: 'x', item_type: 'contact', item_id: 'c', note: null }], failed: [] } });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: { deleted: 1 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the bin', () => {
  it('lists deleted items with when they go, a group as one row, and restores the group as a unit', async () => {
    answerGets(ITEMS);
    mountSignedIn(<BinView />);
    const list = await screen.findByRole('list', { name: 'Deleted items' });
    expect(screen.getByText('Items stay here 30 days, then are deleted for good.', { exact: false })).toBeInTheDocument();
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Newest first; the merge group is one row that names the rest of its members.
    expect(rows[0]).toHaveTextContent('Reply to Grace');
    expect(rows[0]).toHaveTextContent('kept until you restore or delete it');
    expect(rows[0]).toHaveTextContent('Restoring creates it on the calendar server again.');
    expect(rows[1]).toHaveTextContent('Jane Doe');
    expect(rows[1]).toHaveTextContent('With 1 item: J. Doe');
    expect(rows[1]).toHaveTextContent('Merged into another contact');
    expect(rows[2]).toHaveTextContent('gone for good');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Restore Jane Doe' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bin/restore', { ids: ['bin-merge-a', 'bin-merge-b'] }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restored' })));
  });

  it('deletes one item for good after a confirmation, and empties the bin', async () => {
    answerGets(ITEMS);
    mountSignedIn(<BinView module="contacts" />);
    const row = (await screen.findAllByRole('listitem')).find(entry => entry.textContent?.includes('Alan Turing'))!;
    fireEvent.pointerDown(within(row).getByRole('button', { name: 'More actions for Alan Turing' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete for good' }));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/bin/bin-alan'));
    fireEvent.click(screen.getByRole('button', { name: 'Empty bin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bin/empty', { module: 'contacts' }));
  });

  it('greys Delete for good and Empty bin out with the reason when a policy forbids deleting', async () => {
    answerGets(ITEMS, policiesAnswer({ 'bin.delete': { value: 'forbidden', reason: DELETE_REASON } }));
    mountSignedIn(<BinView module="contacts" />);
    const empty = await screen.findByRole('button', { name: 'Empty bin' });
    await waitFor(() => expect(empty).toBeDisabled());
    expect(screen.getByText(DELETE_REASON)).toBeInTheDocument();
    const row = screen.getAllByRole('listitem').find(entry => entry.textContent?.includes('Alan Turing'))!;
    expect(within(row).getByRole('button', { name: 'Restore Alan Turing' })).toBeEnabled();
    fireEvent.pointerDown(within(row).getByRole('button', { name: 'More actions for Alan Turing' }), { button: 0, ctrlKey: false });
    const menuItem = await screen.findByRole('menuitem', { name: /Delete for good/ });
    expect(menuItem).toHaveAttribute('aria-disabled', 'true');
    expect(menuItem).toHaveTextContent(DELETE_REASON);
  });

  it('a deleted contact is "Moved to the bin" with an Undo that restores it', async () => {
    answerGets([]);
    vi.mocked(api.delete).mockResolvedValueOnce({ data: { bin_item_ids: ['bin-ada'] } });
    mountSignedIn(<Contacts />, { path: '/contacts?contact=ada' });
    const detail = await screen.findByRole('article', { name: 'Ada Example' });
    fireEvent.pointerDown(within(detail).getByRole('button', { name: 'More actions for Ada Example' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete contact' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/contacts/ada'));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Moved to the bin', description: '1 contact' })));
    const notice = state.toast.mock.calls.find(call => call[0].title === 'Moved to the bin')![0] as { action: ReactElement<{ onClick: () => void }> };
    notice.action.props.onClick();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bin/restore', { ids: ['bin-ada'] }));
  });

  it('a delete answered after the session ended names nothing: no notice, no Undo', async () => {
    answerGets([]);
    const recording = { id: 'rec-a', title: 'Private title of the previous account', recorded_at: '2026-06-03T10:00:00.000Z', duration_seconds: 10, size_bytes: 100, source: 'imported', category: 'none', tags: [], metadata: {}, description: null };
    const gets = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path: string, ...rest: unknown[]) => path.startsWith('/recordings') ? { data: { recordings: [recording] } } : (gets as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never);
    let answer!: (value: unknown) => void;
    vi.mocked(api.delete).mockImplementation(() => new Promise(resolve => { answer = resolve; }) as never);
    const mounted = render(
      <AuthContext.Provider value={{ user: OWNER, isOffline: false } as unknown as AuthContextType}>
        <SessionQueryProvider privateSession><MemoryRouter><Recordings /></MemoryRouter></SessionQueryProvider>
      </AuthContext.Provider>,
    );
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions for Private title of the previous account' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/recordings/rec-a'));
    // The session ends (an account switch) before the server answers.
    mounted.unmount();
    state.toast.mockClear();
    await act(async () => answer({ data: { bin_item_ids: ['bin-rec-a'] } }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('Settings → Bin saves the retention as a user setting', async () => {
    answerGets([]);
    mountSignedIn(<BinSettings />);
    const select = await screen.findByRole('combobox', { name: 'Keep deleted items for' });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('30 days');
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole('option', { name: '90 days' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { bin_retention: '90' } }));
    expect(screen.getByText('The bin is empty')).toBeInTheDocument();
  });
});
