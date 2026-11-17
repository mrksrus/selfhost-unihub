// Whose a calendar is and what the person may do with it, in the words the
// Calendar and ToDo screens share. The server decides; this only says it.
import type { CalendarCalendar } from '@/lib/calendar-api';
import type { CalendarPermission } from '@/lib/calendar-shares-api';

/** The five levels, lowest first, as the share dialog names them. */
export const LEVELS: Record<CalendarPermission, string> = {
  freebusy: 'Sees busy times', read: 'Can read', contribute: 'Can add subtasks', edit: 'Can edit', manage: 'Can manage',
};
const ORDER = Object.keys(LEVELS) as CalendarPermission[];

type Access = Pick<CalendarCalendar, 'permission' | 'owner_kind' | 'owner' | 'group' | 'archived' | 'user_id'>;

/** A calendar of another person, a group or the organisation. An answer from an older server marks none. */
export const isReached = (calendar: Access) => !!calendar.owner_kind && (calendar.owner_kind !== 'user' || !!calendar.owner);

/** Whose a reached calendar is: the person, the group, or the organisation. */
export function ownerName(calendar: Access): string | null {
  if (!isReached(calendar)) return null;
  if (calendar.owner_kind === 'group') return calendar.group?.name || 'A group';
  if (calendar.owner_kind === 'organisation') return 'Organisation';
  return calendar.owner?.full_name || calendar.owner?.email || null;
}

/** Whether the person's level reaches `level`; a calendar that names none is their own. */
export const atLeast = (calendar: Access | undefined, level: CalendarPermission) =>
  !calendar?.permission || ORDER.indexOf(calendar.permission) >= ORDER.indexOf(level);

/** Why the person cannot change events in this calendar; null when they can. */
export function readOnlyReason(calendar: Access): string | null {
  if (calendar.archived) return 'This calendar is archived. Nobody can change it.';
  if (calendar.permission === 'freebusy') return `You only see when ${ownerName(calendar) ?? 'this calendar'} is busy.`;
  if (calendar.permission === 'read') return 'You can read this calendar, not change it.';
  if (calendar.permission === 'contribute') return 'You can add subtasks here and change your own. The rest is read-only.';
  return null;
}

/** What the person may do, for the calendar's settings. */
export const levelSentence = (calendar: Access) =>
  readOnlyReason(calendar) ?? (calendar.permission === 'manage' ? 'You manage this calendar.' : 'You can edit this calendar.');

/** An event moves only between calendars of one owner (a person, or nobody for group and organisation calendars). */
export const sameOwner = (a: Access, b: Access) => (a.user_id ?? null) === (b.user_id ?? null);
