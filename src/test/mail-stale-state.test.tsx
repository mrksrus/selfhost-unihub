import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Email } from '@/lib/mail-api';
import { useMailListSelection } from '@/hooks/use-mail-list-selection';
import { useMailAccountRemoval } from '@/hooks/use-mail-account-removal';
import type { MailPurgePreview } from '@/components/mail/mail-page-model';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const emails = [{ id: 'a' }, { id: 'b' }] as Email[];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('mail list selection', () => {
  it('belongs to the account and folder it was made in', () => {
    const { result, rerender } = renderHook(({ view }) => useMailListSelection(view, emails), { initialProps: { view: 'account-1\ninbox' } });
    act(() => result.current.toggleAll());
    expect(result.current.selectedIds).toEqual(['a', 'b']);
    rerender({ view: 'account-2\ninbox' });
    expect(result.current.selectedIds).toEqual([]);
    rerender({ view: 'account-1\ninbox' });
    // Returning to the earlier view does not bring its old selection back.
    expect(result.current.selectedIds).toEqual([]);
  });
});

describe('mail account purge preview', () => {
  const preview = (id: string): MailPurgePreview => ({ account_id: id, email_count: 1, attachment_count: 0, raw_count: 1, unresolved_operations: 0, blocked: false });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

  it('ignores a preview that arrives after another account was opened', async () => {
    const first = deferred<{ data: MailPurgePreview }>();
    const second = deferred<{ data: MailPurgePreview }>();
    vi.mocked(api.get).mockImplementation((path: string) => (path.includes('account-1') ? first.promise : second.promise) as never);
    const { result } = renderHook(() => useMailAccountRemoval(vi.fn()), { wrapper });
    let a!: Promise<void>; let b!: Promise<void>;
    act(() => { a = result.current.openPurgePreview('account-1'); });
    act(() => { b = result.current.openPurgePreview('account-2'); });
    await act(async () => { second.resolve({ data: preview('account-2') }); await b; });
    await act(async () => { first.resolve({ data: preview('account-1') }); await a; });
    expect(result.current.accountToPurge).toBe('account-2');
    expect(result.current.purgePreview?.account_id).toBe('account-2');
  });

  it('does not fill a closed purge dialog', async () => {
    const pending = deferred<{ data: MailPurgePreview }>();
    vi.mocked(api.get).mockReturnValue(pending.promise as never);
    const { result } = renderHook(() => useMailAccountRemoval(vi.fn()), { wrapper });
    let request!: Promise<void>;
    act(() => { request = result.current.openPurgePreview('account-1'); });
    act(() => result.current.closePurge());
    await act(async () => { pending.resolve({ data: preview('account-1') }); await request; });
    expect(result.current.accountToPurge).toBeNull();
    expect(result.current.purgePreview).toBeNull();
  });
});
