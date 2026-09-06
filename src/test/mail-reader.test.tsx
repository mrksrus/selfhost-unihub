import { setOfflineMode } from '@/lib/offline';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { api } from '@/lib/api';
import { useMailReader } from '@/hooks/use-mail-reader';
import type { Email } from '@/lib/mail-api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const email = (id: string) => ({ id, folder: 'inbox', is_read: false, subject: id } as Email);
const actions = () => ({ onDraft: vi.fn(), onMarkRead: vi.fn(), onError: vi.fn() });

afterEach(() => { setOfflineMode(false); vi.restoreAllMocks(); });

describe('mail reader requests', () => {
  it('keeps the latest selection when an older response arrives last', async () => {
    const a = deferred<{ data: { email: Email } }>();
    const b = deferred<{ data: { email: Email } }>();
    const get = vi.spyOn(api, 'get').mockImplementation((path) => path.endsWith('/a') ? a.promise : b.promise);
    const { result } = renderHook(() => useMailReader());
    const callbacks = actions();
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = result.current.loadEmail('a', callbacks); });
    const firstSignal = get.mock.calls[0][1]?.signal;
    act(() => { second = result.current.loadEmail('b', callbacks); });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { b.resolve({ data: { email: email('b') } }); await second; });
    await act(async () => { a.resolve({ data: { email: email('a') } }); await first; });
    expect(result.current.selectedEmail?.id).toBe('b');
    expect(callbacks.onMarkRead).toHaveBeenCalledExactlyOnceWith('b');
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('does not reopen a closed reader or toast when a cancelled response arrives', async () => {
    const request = deferred<{ data: { email: Email } }>();
    vi.spyOn(api, 'get').mockReturnValue(request.promise);
    const { result } = renderHook(() => useMailReader());
    const callbacks = actions();
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadEmail('a', callbacks); });
    act(() => result.current.closeReader());
    await act(async () => { request.resolve({ data: { email: email('a') } }); await pending; });
    expect(result.current.selectedEmail).toBeNull();
    expect(result.current.isReaderLoading).toBe(false);
    expect(callbacks.onMarkRead).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
  it('opens unread offline content without attempting a mark-read write', async () => {
    setOfflineMode(true);
    vi.spyOn(api, 'get').mockResolvedValue({ data: { email: email('offline') } });
    const { result } = renderHook(() => useMailReader());
    const callbacks = actions();
    await act(async () => { await result.current.loadEmail('offline', callbacks); });
    expect(result.current.selectedEmail).toMatchObject({ id: 'offline', is_read: false });
    expect(callbacks.onMarkRead).not.toHaveBeenCalled();
  });

});
