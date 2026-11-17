import { ok, type ApiCall } from '../support/api.ts';

// What the shared-calendar and shared-list tests prepare through the API: a
// person's own UniHub calendar, its shares, and the removal of what a run
// (also an interrupted one) left behind. The calendars are named "e2e …".

export interface SharedCalendar { id: string; name: string; permission?: string; user_id?: string | null }
export type SharePrincipal = { kind: 'group' | 'user'; id: string } | { kind: 'everyone' };

export const calendarsOf = async (api: ApiCall) => ok(await api<{ calendars: SharedCalendar[] }>('GET', '/api/calendar/calendars'), 'calendars').calendars;

/** A new calendar in the person's own UniHub account. */
export async function makeCalendar(api: ApiCall, name: string): Promise<SharedCalendar> {
  const { accounts } = ok(await api<{ accounts: { id: string; provider: string }[] }>('GET', '/api/calendar/accounts'), 'calendar accounts');
  const local = accounts.find((account) => account.provider === 'local');
  if (!local) throw new Error('the person has no UniHub calendar account');
  ok(await api('POST', '/api/calendar/calendars', { account_id: local.id, name }), `create ${name}`);
  const made = (await calendarsOf(api)).find((calendar) => calendar.name === name);
  if (!made) throw new Error(`${name} is not listed`);
  return made;
}

export async function share(api: ApiCall, calendarId: string, principal: SharePrincipal, permission: string | null) {
  ok(await api('PUT', `/api/calendar/calendars/${calendarId}/shares`, { principal, permission }), `share at ${permission}`);
}

/** Deletes the person's own "e2e …" calendars; their shares go with them. */
export async function removeCalendars(api: ApiCall) {
  for (const calendar of (await calendarsOf(api)).filter((entry) => entry.name.startsWith('e2e ') && entry.permission === 'manage')) {
    await api('DELETE', `/api/calendar/calendars/${calendar.id}`);
  }
}
