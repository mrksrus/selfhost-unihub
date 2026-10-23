import type { ResolvedSetting } from '@/lib/settings-api';

// How a policy shows in Settings (F1): a locked setting is greyed out with
// its reason, never hidden; a floor greys out the less private choices with
// the same reason. The server enforces both; the page only reflects them.
export const ADMIN_REASON = 'Set by your administrator';

/**
 * Whether a choice is allowed under the setting's floor. `order` lists the
 * values from the most to the least detail (the registry's strictness); the
 * floor is the least strict value still allowed.
 */
export function allowedByFloor<T extends string>(setting: Pick<ResolvedSetting<T>, 'floor'>, order: readonly T[], value: T) {
  if (setting.floor === undefined) return true;
  return order.indexOf(value) >= order.indexOf(setting.floor);
}

/** The reason line of a row: the lock, or a floor that greys out some choices. */
export function policyReason<T>(setting: Pick<ResolvedSetting<T>, 'locked' | 'floor'>) {
  return setting.locked || setting.floor !== undefined ? ADMIN_REASON : undefined;
}
