import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePersistedFlag } from '@/hooks/use-persisted-flag';

describe('usePersistedFlag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('keeps a collapsed sidebar collapsed after a reload', () => {
    const first = renderHook(() => usePersistedFlag('app_sidebar_collapsed'));
    expect(first.result.current[0]).toBe(false);
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    const reloaded = renderHook(() => usePersistedFlag('app_sidebar_collapsed'));
    expect(reloaded.result.current[0]).toBe(true);
    act(() => reloaded.result.current[1](false));
    expect(localStorage.getItem('app_sidebar_collapsed')).toBe('false');
  });

  it('falls back to the default when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => usePersistedFlag('mail_sidebar_collapsed'));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
