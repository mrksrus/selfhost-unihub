import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useMailSyncJobs, type MailSyncJob } from '@/hooks/use-mail-sync-jobs';
import { mailQueryKeys, type MailAccount } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const accounts: MailAccount[] = [{ id: 'account', email_address: 'test@example.test', display_name: 'Test', provider: 'custom', is_active: true, last_synced_at: null }];
const job = (state: MailSyncJob['state'], processed = 0): MailSyncJob => ({ account_id: 'account', state, processed,
  phase: state === 'running' ? 'importing' : null, total: 100, started_at: null, updated_at: null, error: null });
let client: QueryClient;
const tick = (ms = 10) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const mount = () => renderHook(() => useMailSyncJobs(accounts), {
  wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  vi.clearAllMocks();
  setOfflineMode(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.mocked(api.get).mockResolvedValue({ data: { accounts: [job('idle')] } });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });

describe('mail job discovery and recovery', () => {
  it('discovers a background job after idle without user action or a refetch loop', async () => {
    const view = mount();
    await tick();
    expect(view.result.current.jobs.data?.[0].state).toBe('idle');
    expect(api.get).toHaveBeenCalledTimes(1);
    vi.mocked(api.get).mockResolvedValue({ data: { accounts: [job('running', 1)] } });
    await tick(30000);
    await tick();
    expect(view.result.current.jobs.data?.[0].state).toBe('running');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
  });

  it('keeps polling after already-running acceptance and a failed first status read', async () => {
    const view = mount();
    await tick();
    vi.mocked(api.post).mockResolvedValue({ data: { success: true, started: false, alreadyRunning: true, account_id: 'account', message: 'Already running' } });
    vi.mocked(api.get).mockResolvedValueOnce({ error: 'Temporarily unavailable' }).mockResolvedValue({ data: { accounts: [job('idle')] } });
    act(() => view.result.current.requestSync('account'));
    await tick();
    expect(view.result.current.jobs.isError).toBe(true);
    expect(view.result.current.jobs.data?.[0].state).toBe('queued');
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
    await tick(3000);
    await tick();
    expect(view.result.current.jobs.data?.[0].state).toBe('idle');
    expect(view.result.current.jobs.isError).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail sync finished' }));
  });

  it('refreshes partial imports at most every ten seconds, without invalidating job status or details', async () => {
    mount();
    await tick();
    const invalidation = vi.spyOn(client, 'invalidateQueries');
    const progress = async (processed: number) => {
      act(() => client.setQueryData(['mail-sync-jobs'], [job('running', processed)]));
      await tick();
    };
    await progress(1);
    expect(invalidation).toHaveBeenCalledExactlyOnceWith({ queryKey: mailQueryKeys.all });
    await progress(2);
    expect(invalidation).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-09-29T12:00:11Z'));
    await progress(3);
    expect(invalidation).toHaveBeenCalledTimes(2);
    expect(invalidation.mock.calls.every(([filter]) => filter?.queryKey === mailQueryKeys.all)).toBe(true);
  });
});
