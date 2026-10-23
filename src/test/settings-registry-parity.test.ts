import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../../api/src/services/settings-registry';
import { DEFAULT_CALENDAR_SETTINGS, DEFAULT_MAIL_ACCOUNT_SETTINGS, DEFAULT_USER_SETTINGS } from '@/lib/settings-api';

// The page shows these until the account's settings load (and offline); a
// mismatch would show one value and then jump to another.
describe('settings registry parity', () => {
  it('the frontend defaults are the registry defaults, key for key', () => {
    const defaults = (scope: Record<string, { default: unknown }>) => Object.fromEntries(Object.entries(scope).map(([key, entry]) => [key, entry.default]));
    expect(DEFAULT_USER_SETTINGS).toEqual(defaults(SETTINGS.user));
    expect(DEFAULT_MAIL_ACCOUNT_SETTINGS).toEqual(defaults(SETTINGS.mail_account));
    expect(DEFAULT_CALENDAR_SETTINGS).toEqual(defaults(SETTINGS.calendar));
  });
});
