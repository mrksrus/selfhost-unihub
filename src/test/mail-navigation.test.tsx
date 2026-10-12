import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import { useMailAccountSelection } from '@/hooks/use-mail-account-selection';

afterEach(cleanup);

describe('mail navigation', () => {
  it('virtual views never provide an account for sending or syncing', () => {
    const { result } = renderHook(useMailAccountSelection);
    act(() => result.current.selectAccount('account-b'));
    expect(result.current.accountId).toBe('account-b');
    for (const view of ['all', 'legacy', null]) {
      act(() => result.current.selectAccount(view));
      expect(result.current.accountId).toBeNull();
      expect(result.current.queryAccount).toBe(view);
    }
  });
});
