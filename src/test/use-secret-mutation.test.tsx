import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { SessionScopeContext, type SessionScope } from '@/lib/session-scope';

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }), clearToasts: vi.fn() }));

// An administrator's request with their password, answered after its page
// was left: in the same session its callbacks still get the person it was
// for (a success refreshes what it changed); after the session ended they do
// not run. The password is never in TanStack's cache.
describe('useSecretMutation after its page was left', () => {
  function pending(scope: SessionScope) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let answer!: () => void;
    const response = new Promise<void>(done => { answer = done; });
    const refreshed = vi.fn(), failed = vi.fn(), settled = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionScopeContext.Provider value={scope}><QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider></SessionScopeContext.Provider>
    );
    const hook = renderHook(() => useSecretMutation<void, Error, { userId: string; password: string }>({
      mutationFn: () => response,
      onSuccess: (_data, { userId }) => { refreshed(userId); },
      onError: failed,
      onSettled: (_data, _error, { userId }) => { settled(userId); },
    }), { wrapper });
    const cached = () => JSON.stringify(client.getMutationCache().getAll().map(mutation => [mutation.state.variables ?? null, mutation.state.context ?? null]));
    return { client, hook, answer: () => answer(), refreshed, failed, settled, cached };
  }

  it('still refreshes what a success changed, in the same session', async () => {
    const scope = { ended: false };
    const { client, hook, answer, refreshed, failed, settled, cached } = pending(scope);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.mutateAsync({ userId: 'person-alex', password: 'admin-pw' }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(client.getMutationCache().getAll()[0].state.status).toBe('pending');
    expect(cached()).not.toContain('admin-pw');
    hook.unmount();
    let outcome: unknown;
    await act(async () => { answer(); outcome = await operation.then(() => 'success', error => error); });
    expect(outcome).toBe('success');
    expect(refreshed).toHaveBeenCalledWith('person-alex');
    expect(settled).toHaveBeenCalledWith('person-alex');
    expect(failed).not.toHaveBeenCalled();
    expect(cached()).not.toContain('admin-pw');
  });

  it('runs none of its callbacks once the session ended', async () => {
    const scope = { ended: false };
    const { hook, answer, refreshed, failed, settled, cached } = pending(scope);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.mutateAsync({ userId: 'person-alex', password: 'admin-pw' }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    hook.unmount();
    scope.ended = true;
    let outcome: unknown;
    await act(async () => { answer(); outcome = await operation.then(() => 'success', error => error); });
    expect(outcome).toBe('success');
    expect([refreshed.mock.calls.length, failed.mock.calls.length, settled.mock.calls.length]).toEqual([0, 0, 0]);
    expect(cached()).not.toContain('admin-pw');
  });
});
