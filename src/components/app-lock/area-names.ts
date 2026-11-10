// Words the app lock screens share: what an area is called, how the relock
// times read, and how a requirement is told in one sentence.
import type { AppLockArea, AppLockRequirement, RelockAfter } from '@/hooks/use-app-lock';
import type { ModuleId, ModulePreference } from '@/lib/modules';

/** The module labels of the catalog (api/src/services/module-catalog.ts), until the modules have loaded. */
export const AREA_LABELS: Readonly<Record<Exclude<AppLockArea, 'app'>, string>> = {
  mail: 'Mail', contacts: 'Contacts', calendar: 'Calendar and ToDo', recordings: 'Recordings and Music',
};

/** The modules a lock can cover, in the catalog's order. */
export const LOCKABLE_MODULES: readonly ModuleId[] = ['mail', 'contacts', 'calendar', 'recordings'];

/** "Mail", "Calendar and ToDo", or "UniHub" for the whole app. */
export function areaLabel(area: AppLockArea, modules: readonly ModulePreference[] = []) {
  if (area === 'app') return 'UniHub';
  return modules.find(module => module.id === area)?.label || AREA_LABELS[area];
}

/** "Mail and Contacts"; with more, "Mail, Contacts, and Calendar and ToDo" keeps a two-part name whole. */
export function listNames(names: readonly string[]) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** "the whole app", "Mail and Contacts". */
export function describeScope(scope: readonly AppLockArea[], modules: readonly ModulePreference[] = []) {
  if (scope.includes('app')) return 'the whole app';
  return listNames(LOCKABLE_MODULES.filter(id => scope.includes(id)).map(id => areaLabel(id, modules)));
}

export const RELOCK_LABELS: Readonly<Record<RelockAfter, string>> = {
  '0': 'Every time UniHub opens',
  '60': 'After 1 minute in the background',
  '300': 'After 5 minutes in the background',
  '900': 'After 15 minutes in the background',
};

/** From the longest to the shortest time: the registry's strictness, so a floor allows everything at or after it. */
export const RELOCK_ORDER: readonly RelockAfter[] = ['900', '300', '60', '0'];

/** Whether `value` is at least as strict as `floor` (shorter in the background, or the same). */
export function relockAllowed(value: RelockAfter, floor: RelockAfter | null | undefined) {
  return !floor || RELOCK_ORDER.indexOf(value) >= RELOCK_ORDER.indexOf(floor);
}

/** The stricter of two relock times. */
export function shorterRelock(a: RelockAfter, b: RelockAfter | null | undefined): RelockAfter {
  if (!b) return a;
  return RELOCK_ORDER.indexOf(a) >= RELOCK_ORDER.indexOf(b) ? a : b;
}

/** "UniHub locks after 5 minutes in the background at most" / "UniHub locks every time it opens". */
export function describeMaxBackground(max: RelockAfter) {
  if (max === '0') return 'UniHub locks every time it opens';
  const minutes = Number(max) / 60;
  return `UniHub locks after ${minutes} minute${minutes === 1 ? '' : 's'} in the background at most`;
}

/** What the administrator requires, in one sentence: "Mail and Contacts; UniHub locks after 5 minutes in the background at most." */
export function describeRequirement(requirement: Pick<AppLockRequirement, 'required' | 'max_background'>, modules: readonly ModulePreference[] = []) {
  const parts: string[] = [];
  if (requirement.required.length) {
    const scope = describeScope(requirement.required, modules);
    parts.push(scope === 'the whole app' ? 'The whole app' : scope);
  }
  if (requirement.max_background) parts.push(describeMaxBackground(requirement.max_background));
  return parts.length ? `${parts.join('; ')}.` : '';
}

/** The scope a device saves to meet a requirement: what it has plus what is required; `app` stands alone. */
export function scopeMeeting(current: readonly AppLockArea[], required: readonly AppLockArea[]): AppLockArea[] {
  if (current.includes('app') || required.includes('app')) return ['app'];
  return LOCKABLE_MODULES.filter(area => current.includes(area) || required.includes(area));
}
