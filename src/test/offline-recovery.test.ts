import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOfflineMode, saveOfflineSnapshot, setOfflineAccount, setOfflineMode, type OfflineSnapshot } from '@/lib/offline';
import { api } from '@/lib/api';
import { controlledIndexedDB } from './helpers/controlled-indexed-db';

const user = { id: 'A', email: 'a@example.test' };
const snapshot: OfflineSnapshot = {
  version: 1, userId: 'A', savedAt: '2026-09-06T10:00:00Z', bytes: 0,
  contacts: [{ id: 'contact', first_name: 'Saved' }], events: [], calendars: [], calendarAccounts: [], mailAccounts: [], folders: [], emails: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  vi.stubGlobal('indexedDB', controlledIndexedDB().factory);
  setOfflineAccount('A');
  await saveOfflineSnapshot(snapshot, user);
  setOfflineMode(false);
});
afterEach(() => { api.setCsrfToken(null); setOfflineAccount(null); setOfflineMode(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('offline mode after a transient failure', () => {
  it('ends as soon as the API answers again during a live session', async () => {
    api.setCsrfToken('csrf');
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await api.get('/contacts')).data).toBeTruthy();
    expect(isOfflineMode()).toBe(true);
    fetchMock.mockImplementation(async () => json({ contacts: [] }));
    await api.get('/contacts');
    expect(isOfflineMode()).toBe(false);
    fetchMock.mockImplementation(async () => json({ ok: true }));
    expect((await api.delete('/mail/accounts/x')).error).toBeUndefined();
  });

  it('stays offline while a proxy reports the API unavailable', async () => {
    api.setCsrfToken('csrf');
    setOfflineMode(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad gateway', { status: 502, headers: { 'Content-Type': 'text/html' } })));
    await api.get('/contacts');
    expect(isOfflineMode()).toBe(true);
  });

  it('refuses a write while offline but checks the connection without rotating the session', async () => {
    api.setCsrfToken('csrf');
    setOfflineMode(true);
    const fetchMock = vi.fn(async (_url: string) => json({ signup_mode: 'disabled' }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await api.delete('/mail/accounts/x')).error).toMatch(/Offline mode is read-only/);
    await vi.waitFor(() => expect(isOfflineMode()).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/signup-mode$/);
  });

  it('asks for a full session check when the identity came from a cold start', async () => {
    setOfflineMode(true);
    const retry = vi.fn();
    window.addEventListener('unihub:retry-session', retry);
    vi.stubGlobal('fetch', vi.fn(async () => json({ contacts: [] })));
    await api.get('/contacts');
    await api.get('/contacts');
    window.removeEventListener('unihub:retry-session', retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(isOfflineMode()).toBe(true);
  });
});
