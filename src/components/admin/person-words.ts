import type { Person, Role } from '@/lib/admin-api';

// The words of Server › People, one place for the list, the person page and
// their dialogs. The stored role 'user' reads "Member".

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Administrator', user: 'Member' };

export const personName = (person: Pick<Person, 'full_name' | 'email'>) => person.full_name || person.email;
/** Names the person in a dialog, with the address so that two people of one name stay apart. */
export const personTarget = (person: Pick<Person, 'full_name' | 'email'>) => person.full_name ? `${person.full_name} (${person.email})` : person.email;

/**
 * A name that opens its page from inside a row. On touch screens the line of
 * text alone is too low to hit (P-11): the link grows above and below it
 * without moving anything.
 */
export const ROW_LINK = 'rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:inline-block touch:max-w-full touch:py-3 touch:-my-3';

export const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
export const formatDayTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/**
 * How the person signs in, in a few words, and whether it needs the
 * administrator's attention (shown in the warning colour): an account nobody
 * can use yet, or one the two-factor rule will soon stop.
 */
export function signInState(person: Person): { text: string; attention: boolean } {
  if (person.status === 'inactive') return { text: 'Inactive', attention: true };
  if (person.status === 'invited') return { text: 'Invited', attention: false };
  if (person.status === 'not_set_up') return { text: 'Not set up', attention: true };
  if (person.two_factor_enabled) return { text: '2FA on', attention: false };
  if (person.two_factor_grace_ends_at) return { text: `2FA due by ${formatDay(person.two_factor_grace_ends_at)}`, attention: true };
  return { text: '2FA off', attention: false };
}
