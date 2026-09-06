import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { controlledIndexedDB } from './helpers/controlled-indexed-db';
import { captureOfflineSave, clearOfflineData, getOfflineSnapshotInfo, isOfflineMode, loadOfflineSession, readOfflineResponse, resolveOfflineEndpoint, saveOfflineSnapshot, setOfflineAccount, setOfflineMode, type OfflineSnapshot } from '@/lib/offline';
import { api } from '@/lib/api';

const user = { id: 'A', email: 'a@example.test' };
const snapshot = (userId = 'A'): OfflineSnapshot => ({
  version: 1, userId, savedAt: '2026-09-06T10:00:00Z', bytes: 0,
  contacts: [{ id: 'name', first_name: 'Alice' }, { id: 'address', email2: 'second@example.test' }, { id: 'both', first_name: 'Bob', phone3: '123' }],
  calendars: [{ id: 'visible', is_visible: true, auto_todo_enabled: true }, { id: 'hidden', is_visible: false, auto_todo_enabled: false }],
  calendarAccounts: [{ id: 'calendar-account' }],
  events: [
    { id: 'event', calendar_id: 'visible', start_time: '2026-09-06T10:00:00Z', end_time: '2026-09-06T11:00:00Z', todo_status: null, subtasks: [{ id: 'subtask' }], attendees: [{ email: 'guest@example.test' }] },
    { id: 'hidden', calendar_id: 'hidden', start_time: '2026-09-06T10:00:00Z', end_time: '2026-09-06T11:00:00Z' },
    { id: 'done', calendar_id: 'visible', todo_status: 'done', start_time: '2026-09-06T10:00:00Z', end_time: '2026-09-06T11:00:00Z' },
    { id: 'todo', is_todo_only: true, start_time: '2026-09-06T10:00:00Z', end_time: '2026-09-06T11:00:00Z' },
  ],
  mailAccounts: [{ id: 'mail-1' }, { id: 'mail-2' }], folders: [{ slug: 'inbox' }, { slug: 'archive' }],
  emails: [
    { id: 'one', mail_account_id: 'mail-1', folder: 'inbox', is_read: false, is_starred: true, received_at: '2026-09-06T11:00:00Z', subject: 'Message one', body_text: 'Full body with searchable words', body_html: '<p>Full <b>HTML</b> body</p>', attachments: [{ id: 'attachment', offline_available: false }] },
    { id: 'two', mail_account_id: 'mail-2', folder: 'archive', is_read: false, is_starred: true, received_at: '2026-09-06T10:00:00Z', body_text: 'Archived' },
    { id: 'three', mail_account_id: 'mail-1', folder: 'inbox', is_read: true, is_starred: false, received_at: '2026-09-06T09:00:00Z', body_text: 'Read' },
  ],
});
const data = (endpoint: string) => {
  const result = resolveOfflineEndpoint(snapshot(), endpoint);
  if (!result || !('data' in result)) throw new Error('Expected an offline response');
  return result.data as Record<string, unknown>;
};
let database: ReturnType<typeof controlledIndexedDB>;
beforeEach(() => {
  localStorage.clear();
  database = controlledIndexedDB();
  vi.stubGlobal('indexedDB', database.factory);
  setOfflineAccount('A');
  setOfflineMode(false);
});
afterEach(() => { setOfflineAccount(null); setOfflineMode(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('offline endpoint parity', () => {
  it('reads complete message bodies without serving authentication from the snapshot', () => {
    expect(data('/mail/emails/one').email).toMatchObject({ body_html: '<p>Full <b>HTML</b> body</p>', body_text: 'Full body with searchable words' });
    expect(resolveOfflineEndpoint(snapshot(), '/auth/me')).toBeNull();
    expect(resolveOfflineEndpoint(snapshot(), '/mail/emails/not-saved')).toMatchObject({ status: 404 });
    expect(resolveOfflineEndpoint(snapshot(), '/mail/attachments/attachment')).toMatchObject({ status: 503 });
  });
  it('handles virtual starred, account filters, search, pagination and count opt-out', () => {
    expect(data('/mail/emails?folder=starred&account_id=all').emails).toHaveLength(2);
    expect(data('/mail/emails?folder=starred&account_id=mail-1&search=searchable').emails).toHaveLength(1);
    expect(data('/mail/emails?limit=1&offset=1').emails).toMatchObject([{ id: 'two' }]);
    expect(data('/mail/emails?include_count=false').pagination).toMatchObject({ total: null, totalPages: null });
    expect(data('/mail/unread-counts?include_by_account=true')).toMatchObject({ unreadByFolder: { inbox: 1, archive: 1, starred: 2 }, unreadByFolderAccount: { starred: { 'mail-1': 1, 'mail-2': 1 } } });
    expect(data('/mail/unread-counts?account_id=mail-1')).toEqual({ unreadByFolder: { inbox: 1, starred: 1 } });
  });
  it('counts only upcoming unfinished calendar events in dashboard stats', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T09:00:00Z'));
    expect(data('/stats')).toMatchObject({ upcomingEvents: 2, contacts: 3, unreadEmails: 2 });
  });
  it('preserves contact groups and calendar filters, attendees and subtasks', () => {
    expect(data('/contacts?group=name_only').contacts).toMatchObject([{ id: 'name' }]);
    expect(data('/contacts?group=number_or_email_only&q=second').contacts).toMatchObject([{ id: 'address' }]);
    expect(data('/contacts?limit=2').has_more).toBe(true);
    expect(data('/contacts?limit=2&offset=2').contacts).toMatchObject([{ id: 'both' }]);
    expect(data('/calendar/events?visible_only=true&include_done=false').events).toMatchObject([{ id: 'event', subtasks: [{ id: 'subtask' }], attendees: [{ email: 'guest@example.test' }] }]);
    expect(data('/calendar/events?include_todos=true&respect_auto_todo=true&include_done=false').events).toHaveLength(2);
    expect(data('/calendar/events?calendar_ids=hidden').events).toMatchObject([{ id: 'hidden' }]);
    expect(data('/calendar/events?range_start=2026-09-07T00:00:00Z').events).toEqual([]);
  });
});

describe('offline account ownership and durable clearing', () => {
  it('keeps content inaccessible to another account and after a storage-failed clear', async () => {
    await saveOfflineSnapshot(snapshot(), user);
    expect(await readOfflineResponse('/mail/emails/one')).toMatchObject({ data: { email: { id: 'one' } } });
    setOfflineAccount('B');
    expect(await readOfflineResponse('/mail/emails/one')).toBeNull();
    database.disable();
    await expect(clearOfflineData()).rejects.toThrow('Offline access is disabled');
    expect(await loadOfflineSession()).toBeNull();
  });
  it('preserves the previous snapshot if the replacement exceeds browser quota', async () => {
    await saveOfflineSnapshot(snapshot(), user);
    database.failNextPut();
    await expect(saveOfflineSnapshot({ ...snapshot(), savedAt: '2026-09-06T12:00:00Z' }, user)).rejects.toThrow('previous snapshot was kept');
    expect((await getOfflineSnapshotInfo())?.savedAt).toBe('2026-09-06T10:00:00Z');
    expect(database.records.size).toBe(1);
  });
  it('cannot restore offline access when a delayed write completes after clear/logout', async () => {
    await saveOfflineSnapshot(snapshot(), user);
    database.pauseNextWrite();
    const pending = saveOfflineSnapshot({ ...snapshot(), savedAt: '2026-09-06T12:00:00Z' }, user);
    const rejected = expect(pending).rejects.toThrow('changed');
    await vi.waitFor(() => expect(database.pendingWrites()).toBe(1));
    await clearOfflineData();
    setOfflineAccount(null);
    database.releaseWrite();
    await rejected;
    expect(await loadOfflineSession()).toBeNull();
    expect(database.records.size).toBe(0);
  });
  it('does not re-enable offline reading when a pre-clear network response arrives late', async () => {
    await saveOfflineSnapshot(snapshot(), user);
    const token = captureOfflineSave(user.id);
    await clearOfflineData();
    await expect(saveOfflineSnapshot(snapshot(), user, undefined, token)).rejects.toThrow('changed');
    expect(await loadOfflineSession()).toBeNull();
  });
  it('never deletes a newer account snapshot when an older tab finishes late', async () => {
    await saveOfflineSnapshot(snapshot(), user);
    database.pauseNextWrite();
    const pending = saveOfflineSnapshot(snapshot(), user);
    const rejected = expect(pending).rejects.toThrow('changed');
    await vi.waitFor(() => expect(database.pendingWrites()).toBe(1));
    vi.resetModules();
    const otherTab = await import('@/lib/offline');
    otherTab.setOfflineAccount('B');
    await otherTab.clearOfflineData();
    await otherTab.saveOfflineSnapshot(snapshot('B'), { id: 'B', email: 'b@example.test' });
    database.releaseWrite();
    await rejected;
    expect(await otherTab.loadOfflineSession()).toMatchObject({ user: { id: 'B' } });
    expect(await readOfflineResponse('/mail/emails/one')).toBeNull();
    expect(database.records.size).toBe(1);
  });
});

describe('offline API boundary', () => {
  it('uses saved content only for network failure, never for HTTP authentication or server errors', async () => {
    await saveOfflineSnapshot(snapshot(), user);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.get('/mail/emails/one')).toMatchObject({ data: { email: { id: 'one' } } });
    expect(isOfflineMode()).toBe(true);
    expect(await api.get('/auth/me')).toMatchObject({ error: expect.any(String) });
    for (const status of [401, 403, 500]) {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Unavailable' }), { status, headers: { 'Content-Type': 'application/json' } }));
      const response = await api.get('/mail/emails/one');
      expect(response.status).toBe(status);
      expect(response.data).toBeUndefined();
    }
  });
  it('refuses state changes even when the browser claims to be online', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setOfflineMode(true);
    expect(await api.put('/mail/emails/one/read', { is_read: true })).toMatchObject({ error: expect.stringContaining('read-only') });
    expect(await api.post('/auth/2fa/disable', {})).toMatchObject({ error: expect.stringContaining('read-only') });
    expect(await api.uploadBlob('/recordings', new Blob(['audio']))).toMatchObject({ error: expect.stringContaining('read-only') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
