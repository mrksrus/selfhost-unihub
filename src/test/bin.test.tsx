import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { api } from '@/lib/api';
import { BinView } from '@/components/bin/BinView';
import BinSettings from '@/components/settings/BinSettings';
import Contacts from '@/pages/Contacts';
import Recordings from '@/pages/Recordings';
import CalendarPage from '@/pages/CalendarPage';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import type { BinItem } from '@/lib/bin-api';
import { contact } from './contact-fixtures';
import { userSettingsAnswer } from './settings-fixtures';
import { OWNER, mountSignedIn, policiesAnswer, stubBrowserApis, testClient } from './helpers/data-safety';

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
// The person's calendars, as the server lists them: a UniHub list, a server calendar and a read-only subscription.
const calendar = (id: string, name: string, provider: 'local' | 'caldav' | 'ics', fields: Record<string, unknown> = {}) => ({
  id, user_id: 'user-ada', account_id: `acct-${provider}`, name, external_id: null, color: '#2563eb', is_visible: true, auto_todo_enabled: true, read_only: provider === 'ics', is_primary: false, sync_token: null,
  account_provider: provider, account_display_name: provider === 'local' ? null : `${provider} account`, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  default_for_tasks: false, default_for_events: false, write_block: provider === 'ics' ? 'read_only' : null, takes_undated_tasks: provider === 'local', ...fields,
});
const CALENDARS = [calendar('cal-inbox', 'Inbox', 'local'), calendar('cal-team', 'Team', 'caldav'), calendar('cal-holidays', 'Holidays', 'ics')];
const refused = (id: string, code: string) => ({ data: { restored: [], failed: [{ id, error: `Refused: ${code}`, code }] } });

function answerGets(bin: BinItem[], policies = policiesAnswer()) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/bin')) return { data: { items: path.includes('module=contacts') ? bin.filter(entry => entry.module === 'contacts') : bin, retention: '30' } };
    if (path === '/calendar/calendars') return { data: { calendars: CALENDARS } };
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
    // One member names the group; the server restores the group from it.
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Restore Jane Doe' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bin/restore', { ids: ['bin-merge-a'] }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restored' })));
  });

  it('a list with 500 events is one group of 501 items, restored with one id (the request takes at most 500), also to a chosen list', { timeout: 20_000 }, async () => {
    const list = item('bin-list', { module: 'calendar', item_type: 'calendar', title: 'Garden club', group_id: 'list-1', deleted_at: '2026-06-13T09:00:00.000Z' });
    const events = Array.from({ length: 500 }, (_, index) => item(`bin-event-${index}`, { module: 'calendar', item_type: 'event', title: `Event ${index}`, reason: 'calendar_deleted', group_id: 'list-1', deleted_at: '2026-06-13T09:00:00.000Z' }));
    answerGets([list, ...events]);
    mountSignedIn(<BinView module="calendar" />);
    const rows = within(await screen.findByRole('list', { name: 'Deleted items' }, { timeout: 10_000 })).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('With 500 items');
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-list', 'BIN_RESTORE_NEEDS_LIST'));
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Restore Garden club' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bin/restore', { ids: ['bin-list'] }));
    // The chosen destination is sent for the group once too, not for every member.
    const dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'List' }));
    fireEvent.click(await screen.findByRole('option', { name: /Inbox/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore there' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/bin/restore', { ids: ['bin-list'], calendar_id: 'cal-inbox' }));
    expect(vi.mocked(api.post).mock.calls.every(call => (call[1] as { ids: string[] }).ids.length === 1)).toBe(true);
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

  // Emptying runs in batches; a rule set meanwhile stops it between two. The answer says how many
  // items went before, and the list is read again so it no longer shows them.
  it('an emptying the server stopped says how many items went before, and reads the bin again', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    vi.mocked(api.post).mockResolvedValueOnce({ error: DELETE_REASON, status: 403, code: 'POLICY_FORBIDS', details: { deleted: 2 } } as never);
    mountSignedIn(<BinView module="contacts" />);
    await screen.findAllByRole('listitem');
    const reads = () => vi.mocked(api.get).mock.calls.filter(([path]) => String(path).startsWith('/bin')).length;
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Empty bin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Emptying stopped', description: expect.stringContaining('2 items were deleted before your administrator stopped deleting from the bin') })));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // Without a count, the refusal reads as the rule; the list is read again all the same.
    vi.mocked(api.post).mockResolvedValueOnce({ error: DELETE_REASON, status: 403, code: 'POLICY_FORBIDS' } as never);
    const again = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Empty bin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not empty the bin', description: DELETE_REASON })));
    await waitFor(() => expect(reads()).toBeGreaterThan(again));
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

  it('a delete answered after the session ended names nothing: no notice, no Undo', { timeout: 20_000 }, async () => {
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

  it('a synced item whose calendar is gone asks for one of the server calendars, and is restored there', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    mountSignedIn(<BinView module="calendar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    expect(dialog).toHaveTextContent('The calendar Reply to Grace came from is gone or read-only.');
    expect(state.toast).not.toHaveBeenCalled();
    const chooser = within(dialog).getByRole('combobox', { name: 'Calendar' });
    expect(within(dialog).getByRole('button', { name: 'Restore there' })).toBeDisabled();
    fireEvent.click(chooser);
    // A UniHub list cannot hold a synced item, and a read-only subscription takes nothing new.
    expect(await screen.findByRole('option', { name: /Inbox/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Inbox/ })).toHaveTextContent('A UniHub list cannot hold a synced item');
    expect(screen.getByRole('option', { name: /Holidays/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: /Team/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore there' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/bin/restore', { ids: ['bin-task'], calendar_id: 'cal-team' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument());
  });

  it('a UniHub item that needs a UniHub list offers only the lists', { timeout: 20_000 }, async () => {
    answerGets([item('bin-local-task', { module: 'calendar', item_type: 'task', title: 'Water the plants', provider: 'local', origin: 'Home' })]);
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-local-task', 'BIN_RESTORE_NEEDS_LIST'));
    mountSignedIn(<BinView module="calendar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Water the plants' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    expect(dialog).toHaveTextContent('Water the plants belongs to UniHub, so it needs one of your UniHub lists.');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'List' }));
    expect(await screen.findByRole('option', { name: /Team/ })).toHaveTextContent('Only a UniHub list can hold it');
    expect(screen.getByRole('option', { name: /Team/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: /Inbox/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore there' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/bin/restore', { ids: ['bin-local-task'], calendar_id: 'cal-inbox' }));
  });

  it('a destination ask closes when its item left the bin meanwhile, and a late ask for a gone item never opens', { timeout: 20_000 }, async () => {
    const client = testClient();
    let bin = ITEMS;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/bin')) return { data: { items: bin, retention: '30' } };
      if (path === '/policies/effective') return policiesAnswer();
      if (path === '/calendar/calendars') return { data: { calendars: CALENDARS } };
      return { data: {} };
    });
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    mountSignedIn(<BinView module="calendar" />, { client });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    await screen.findByRole('dialog', { name: 'Where should it go?' });
    // Another tab restored the task: the refetched bin no longer has it, and the ask has nothing to offer.
    bin = ITEMS.filter(item => item.id !== 'bin-task');
    await act(async () => { await client.invalidateQueries({ queryKey: ['bin'] }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument(), { timeout: 10_000 });
    // A destination answer that arrives after its item left the bin opens nothing and sends nothing.
    bin = ITEMS;
    await act(async () => { await client.invalidateQueries({ queryKey: ['bin'] }); });
    let late!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }) as never);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    bin = ITEMS.filter(item => item.id !== 'bin-task');
    await act(async () => { await client.invalidateQueries({ queryKey: ['bin'] }); });
    await act(async () => late(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('a choice made for one ask does not carry into the next, and only an eligible destination can be sent', { timeout: 20_000 }, async () => {
    const client = testClient();
    const localTask = item('bin-local-task', { module: 'calendar', item_type: 'task', title: 'Water the plants', provider: 'local', origin: 'Home' });
    let bin = [...ITEMS, localTask];
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/bin')) return { data: { items: bin, retention: '30' } };
      if (path === '/policies/effective') return policiesAnswer();
      if (path === '/calendar/calendars') return { data: { calendars: CALENDARS } };
      return { data: {} };
    });
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    mountSignedIn(<BinView module="calendar" />, { client });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    let dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Calendar' }));
    fireEvent.click(await screen.findByRole('option', { name: /Team/ }));
    expect(within(dialog).getByRole('button', { name: 'Restore there' })).toBeEnabled();
    // The synced task leaves the bin before the choice is sent: the ask closes on its own.
    bin = [localTask];
    await act(async () => { await client.invalidateQueries({ queryKey: ['bin'] }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument(), { timeout: 10_000 });
    // The next ask, for a UniHub item, starts without a choice; the server calendar cannot be sent for it.
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-local-task', 'BIN_RESTORE_NEEDS_LIST'));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Water the plants' }, { timeout: 10_000 }));
    dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    expect(within(dialog).getByRole('combobox', { name: 'List' })).toHaveTextContent('Choose a list');
    expect(within(dialog).getByRole('button', { name: 'Restore there' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore there' }));
    expect(api.post).not.toHaveBeenCalledWith('/bin/restore', expect.objectContaining({ calendar_id: 'cal-team' }));
  });

  it('focus lands on something enabled after the dialog closes for a pending restore or an emptied bin', { timeout: 20_000 }, async () => {
    const client = testClient();
    let bin = [ITEMS.find(entry => entry.id === 'bin-task')!];
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/bin')) return { data: { items: bin, retention: '30' } };
      if (path === '/policies/effective') return policiesAnswer();
      if (path === '/calendar/calendars') return { data: { calendars: CALENDARS } };
      return { data: {} };
    });
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    mountSignedIn(<BinView module="calendar" />, { client });
    // Restore there closes the dialog while the restore runs and every Restore button is disabled.
    const restore = await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 });
    restore.focus();
    fireEvent.click(restore);
    let dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Calendar' }));
    fireEvent.click(await screen.findByRole('option', { name: /Team/ }));
    let finish!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore there' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument());
    expect(restore).toBeDisabled();
    // Not the row's menu, which goes with the row once the restore succeeds: the view itself.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.getAttribute('aria-label') ?? '').not.toMatch(/^More actions/);
    // The restore succeeds and the refetched bin is empty: the row and the list are gone, focus stays in the view.
    bin = [];
    await act(async () => finish({ data: { restored: [{ id: 'bin-task', item_type: 'task', item_id: 't', note: null }], failed: [] } }));
    await screen.findByText('The bin is empty', {}, { timeout: 10_000 });
    expect(document.activeElement).not.toBe(document.body);
    // The only row leaves the bin while its dialog is open: the list is gone, the view itself takes focus.
    bin = [ITEMS.find(entry => entry.id === 'bin-task')!];
    await act(async () => { await client.invalidateQueries({ queryKey: ['bin'] }); });
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    bin = [];
    await act(async () => { await client.invalidateQueries({ queryKey: ['bin'] }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument(), { timeout: 10_000 });
    await screen.findByText('The bin is empty');
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it('after a submission focus goes to the view, so a fast answer and a late refetch that drops the row lose nothing', { timeout: 20_000 }, async () => {
    const client = testClient();
    let bin = [ITEMS.find(entry => entry.id === 'bin-task')!];
    let holdList: ((value: unknown) => void) | null = null;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/bin')) return holdList ? new Promise(resolve => { holdList = value => resolve(value); }) as never : { data: { items: bin, retention: '30' } };
      if (path === '/policies/effective') return policiesAnswer();
      if (path === '/calendar/calendars') return { data: { calendars: CALENDARS } };
      return { data: {} };
    });
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    mountSignedIn(<BinView module="calendar" />, { client });
    const restore = await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 });
    restore.focus();
    fireEvent.click(restore);
    const dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Calendar' }));
    fireEvent.click(await screen.findByRole('option', { name: /Team/ }));
    // The restore answers at once; the refetched list is held, so the old row stays with its Restore enabled.
    let release!: (value: unknown) => void;
    holdList = value => { release = value as never; };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/bin')) return new Promise(resolve => { release = resolve; }) as never;
      if (path === '/policies/effective') return policiesAnswer();
      if (path === '/calendar/calendars') return { data: { calendars: CALENDARS } };
      return { data: {} };
    });
    vi.mocked(api.post).mockResolvedValueOnce({ data: { restored: [{ id: 'bin-task', item_type: 'task', item_id: 't', note: null }], failed: [] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore there' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument());
    await waitFor(() => expect(restore).toBeEnabled());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).not.toBe(restore);
    // The late refetch empties the bin: the row goes, focus stays in the view.
    bin = [];
    await act(async () => release({ data: { items: [], retention: '30' } }));
    await screen.findByText('The bin is empty', {}, { timeout: 10_000 });
    expect(document.activeElement).not.toBe(document.body);
  });

  it('cancelling the destination dialog with the keyboard returns focus to the Restore button that opened it', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_NEEDS_CALENDAR'));
    mountSignedIn(<BinView module="calendar" />);
    const restore = await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 });
    restore.focus();
    fireEvent.click(restore);
    const dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(restore));
  });

  it('says plainly when the chosen calendar is not the person\'s', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_CALENDAR_NOT_FOUND'));
    mountSignedIn(<BinView module="calendar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nothing restored', description: expect.stringContaining('The chosen calendar is not one of yours.'), variant: 'destructive' })));
  });

  it('says plainly when the calendar is read-only', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'CALENDAR_READ_ONLY'));
    mountSignedIn(<BinView module="calendar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nothing restored', description: expect.stringContaining('read-only or a subscription') })));
  });

  it('asks to try again shortly while the calendar is syncing', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'A sync is running', status: 409, code: 'CALENDAR_SYNC_BUSY' } as never);
    mountSignedIn(<BinView module="calendar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not restore', description: 'The calendar is syncing right now. Try again shortly.' })));
  });

  it('an item whose earlier restore is still being confirmed says so, as a failed entry and as a refusal, and opens no chooser', { timeout: 20_000 }, async () => {
    answerGets(ITEMS);
    const sentence = 'This item is still being put back on its server calendar. Try again in a moment, or restore it to the same calendar.';
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-task', 'BIN_RESTORE_PENDING'));
    mountSignedIn(<BinView module="calendar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Reply to Grace' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nothing restored', description: expect.stringContaining(sentence), variant: 'destructive' })));
    expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument();
    state.toast.mockClear();
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Pending', status: 409, code: 'BIN_RESTORE_PENDING' } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Reply to Grace' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not restore', description: sentence })));
    expect(screen.queryByRole('dialog', { name: 'Where should it go?' })).not.toBeInTheDocument();
  });

  it('a recording being changed asks to try again shortly, as a failed entry and as a refusal', { timeout: 20_000 }, async () => {
    answerGets([item('bin-rec', { module: 'recordings', item_type: 'recording', title: 'Standup notes' })]);
    vi.mocked(api.post).mockResolvedValueOnce(refused('bin-rec', 'RECORDING_BUSY'));
    mountSignedIn(<BinView module="recordings" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Standup notes' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nothing restored', description: expect.stringContaining('The recording is being changed right now. Try again shortly.') })));
    state.toast.mockClear();
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Busy', status: 409, code: 'RECORDING_BUSY' } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Standup notes' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not restore', description: 'The recording is being changed right now. Try again shortly.' })));
  });

  it('names the administrator when the recordings folder is unsafe', { timeout: 20_000 }, async () => {
    answerGets([item('bin-rec', { module: 'recordings', item_type: 'recording', title: 'Standup notes' })]);
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Unsafe folder', status: 409, code: 'RECORDING_FOLDER_UNSAFE' } as never);
    mountSignedIn(<BinView module="recordings" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Standup notes' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not restore', description: expect.stringContaining('Ask your administrator') })));
  });

  // bin_retention and the bin's minimum: 30 days by default; an administrator's minimum greys the shorter choices with its reason.
  it('Settings → Bin greys the choices under the administrator\'s minimum out with the reason', async () => {
    answerGets([]);
    const settings = userSettingsAnswer();
    settings.data.settings.bin_retention = { value: '90', source: 'policy', locked: false, floor: '90' };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/settings/values') return settings;
      if (path.startsWith('/bin')) return { data: { items: [], retention: '90' } };
      if (path === '/policies/effective') return policiesAnswer();
      return { data: {} };
    });
    mountSignedIn(<BinSettings />);
    const select = await screen.findByRole('combobox', { name: 'Keep deleted items for' });
    await waitFor(() => expect(select).toHaveTextContent('90 days'));
    expect(select).toBeEnabled();
    expect(screen.getByText('Your administrator keeps deleted items at least 90 days.')).toBeInTheDocument();
    fireEvent.click(select);
    for (const shorter of ['7 days', '30 days']) expect(await screen.findByRole('option', { name: shorter })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Until I delete them' })).not.toHaveAttribute('aria-disabled');
    fireEvent.click(screen.getByRole('option', { name: '7 days' }));
    expect(api.put).not.toHaveBeenCalled();
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

// The bin is shown in place of a page's list (?view=bin); the page's panel stays
// in charge of where the page goes and what its actions open.
function CurrentRoute() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }

describe('the bin inside a page', () => {
  it('Recordings: All recordings or a category leaves the bin in one step', { timeout: 20_000 }, async () => {
    answerGets([item('bin-rec', { module: 'recordings', item_type: 'recording', title: 'Standup notes' })]);
    const gets = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path: string, ...rest: unknown[]) => path.startsWith('/recordings') ? { data: { recordings: [] } } : (gets as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never);
    mountSignedIn(<><Recordings /><CurrentRoute /></>, { path: '/recordings?view=bin' });
    expect(await screen.findByRole('list', { name: 'Deleted items' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search recordings' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'All recordings' }));
    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent(/^\/recordings$/));
    expect(screen.queryByRole('list', { name: 'Deleted items' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search recordings' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Bin' }));
    expect(await screen.findByRole('list', { name: 'Deleted items' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Music' }));
    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent(/^\/recordings\?category=music$/));
    expect(screen.queryByRole('list', { name: 'Deleted items' })).not.toBeInTheDocument();
  });

  it('Calendar: New event and Add calendar account open their dialogs over the bin', { timeout: 20_000 }, async () => {
    answerGets([ITEMS[3]]);
    mountSignedIn(<><CalendarPage /><CurrentRoute /></>, { path: '/calendar?view=bin' });
    expect(await screen.findByRole('list', { name: 'Deleted items' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    // Still the bin: the dialog does not wait for "Back to the calendar".
    expect(screen.getByRole('status', { name: 'Current route', hidden: true })).toHaveTextContent('/calendar?view=bin');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Back to the calendar' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar account' }));
    expect(await screen.findByRole('dialog', { name: 'Add calendar account' })).toBeInTheDocument();
    // The bin is still underneath (the open dialog hides the page from assistive technology).
    expect(screen.getByRole('list', { name: 'Deleted items', hidden: true })).toBeInTheDocument();
  });
});

// The server answers the bin a page at a time (up to 2,000 items in whole groups). Covered here
// with network-mocked pages: an e2e with that many items would be too heavy.
type BinPage = { items: BinItem[]; next_cursor: string | null };
/** The bin's pages, newest first: no cursor answers the first, `before=cursor-N` the Nth; `refuse` answers that cursor instead while set. */
function answerPages(pages: BinPage[], refuse: { before: string; answer: unknown } | null = null) {
  const state = { refuse };
  answerGets([]);
  const gets = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path: string, ...rest: unknown[]) => {
    if (!path.startsWith('/bin')) return (gets as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never;
    const before = new URLSearchParams(path.split('?')[1] ?? '').get('before');
    if (state.refuse && before === state.refuse.before) return state.refuse.answer as never;
    return { data: { retention: '30', ...(before ? pages[Number(before.replace('cursor-', ''))] : pages[0]) } } as never;
  });
  return state;
}
const firstPageReads = () => vi.mocked(api.get).mock.calls.filter(([path]) => typeof path === 'string' && path.startsWith('/bin') && !path.includes('before=')).length;
const INVALID = { status: 400, error: 'This link to older bin items is not valid. Load the bin again from the newest items.', code: 'BIN_INVALID' };

describe('the bin in pages', () => {
  const PAGES: BinPage[] = [{ items: [ITEMS[0], ITEMS[3]], next_cursor: 'cursor-1' }, { items: [ITEMS[1], ITEMS[2]], next_cursor: null }];

  it('shows the newest page with "Show older items", appends the next page, and hides the row on the last page', { timeout: 20_000 }, async () => {
    answerPages(PAGES);
    mountSignedIn(<BinView />);
    const list = await screen.findByRole('list', { name: 'Deleted items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/bin?before=cursor-1', expect.anything()));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(within(list).getAllByRole('listitem').find(row => row.textContent?.includes('Jane Doe'))).toHaveTextContent('With 1 item: J. Doe');
    expect(screen.queryByRole('button', { name: 'Show older items' })).not.toBeInTheDocument();
    // A group from an older page restores as the others do.
    fireEvent.click(screen.getByRole('button', { name: 'Restore Jane Doe' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bin/restore', { ids: ['bin-merge-a'] }));
  });

  it('Show older items waits while the bin is read again after a restore (the same read Undo starts), so the refresh is not lost', { timeout: 20_000 }, async () => {
    answerPages(PAGES);
    const paged = vi.mocked(api.get).getMockImplementation()!;
    let firstPageSeen = 0;
    let refetched!: () => void;
    vi.mocked(api.get).mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (!path.startsWith('/bin') || path.includes('before=')) return (paged as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never;
      firstPageSeen += 1;
      if (firstPageSeen === 1) return (paged as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never;
      // The read after the restore: held until the test lets it answer, without Alan.
      return new Promise(resolve => { refetched = () => resolve({ data: { items: [ITEMS[3]], retention: '30', next_cursor: 'cursor-1' } }); }) as never;
    });
    mountSignedIn(<BinView />);
    const list = await screen.findByRole('list', { name: 'Deleted items' });
    fireEvent.click(within(list).getByRole('button', { name: 'Restore Alan Turing' }));
    await waitFor(() => expect(firstPageSeen).toBe(2));
    const older = screen.getByRole('button', { name: 'Show older items' });
    expect(older).toBeDisabled();
    fireEvent.click(older);
    await act(async () => refetched());
    await waitFor(() => expect(within(list).queryByText('Alan Turing')).not.toBeInTheDocument());
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('before='), expect.anything());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show older items' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByText('Jane Doe')).toBeInTheDocument();
  });

  it('a cursor the server no longer accepts reloads the bin from the newest items and says so in the server\'s words', { timeout: 20_000 }, async () => {
    answerPages(PAGES, { before: 'cursor-1', answer: INVALID });
    mountSignedIn(<BinView />);
    await screen.findByRole('list', { name: 'Deleted items' });
    const before = firstPageReads();
    fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not load older items', description: INVALID.error })));
    await waitFor(() => expect(firstPageReads()).toBeGreaterThan(before));
    const list = await screen.findByRole('list', { name: 'Deleted items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(await screen.findByRole('button', { name: 'Show older items' })).toBeInTheDocument();
  });

  it('an older page that fails keeps the loaded items and offers to try again', { timeout: 20_000 }, async () => {
    const pages = answerPages(PAGES, { before: 'cursor-1', answer: { status: 500, error: 'The database is busy.' } });
    mountSignedIn(<BinView />);
    const list = await screen.findByRole('list', { name: 'Deleted items' });
    fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load older items. The database is busy.');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    pages.refuse = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
