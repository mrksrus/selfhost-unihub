import { NO_APP_LOCK, type AppLockArea, type AppLockValue } from '@/hooks/use-app-lock';

/**
 * An app lock state for screen tests, without the provider's storage and
 * network: `locked` follows `status` and `scope` as the provider's does,
 * unless the test gives its own. Render it with
 * `<AppLockContext.Provider value={fakeAppLock({ ... })}>`.
 */
export function fakeAppLock(overrides: Partial<AppLockValue> = {}): AppLockValue {
  const status = overrides.status ?? NO_APP_LOCK.status;
  const scope = overrides.scope ?? NO_APP_LOCK.scope;
  const locked = (area: AppLockArea) => status === 'checking'
    || ((status === 'locked' || status === 'setup') && (scope.includes('app') || (area !== 'app' && scope.includes(area))));
  return { ...NO_APP_LOCK, locked, ...overrides };
}
