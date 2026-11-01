import type { FixtureValue } from './test-types.cts';

// An in-memory calendar server in place of the installed CalDAV peer, for the
// calendar overlay and bin tests: two calendars of one account, If-Match and
// If-None-Match kept, and faults that refuse a write or lose its answer
// (stored or not). Patches the given caldav service module.
const BASE = 'https://dav.example.test';
const HOME = '/dav/calendars/person/';
const WORK = `${HOME}work/`;
const SHARED = `${HOME}shared/`;

function icsDate(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function eventIcs(uid: string, title: string, startMs: number, extra: string[] = []) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
    `DTSTART:${icsDate(startMs)}`, `DTEND:${icsDate(startMs + 3600000)}`, `SUMMARY:${title}`, ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
const davError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);

function installCalDavFake(caldav: FixtureValue, { readOnlyShared = true } = {}) {
  const remote = { version: 1, objects: new Map<string, { etag: string; ics: string }>(), writes: [] as string[][] };
  const faults: { put?: (path: string) => 'store-then-lose' | 'lose' | 'refuse' | void; remove?: (path: string) => 'fail' | void } = {};
  let etags = 0;
  const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname);
  const store = (objectPath: string, ics: string) => { remote.objects.set(objectPath, { etag: `"e${++etags}"`, ics }); remote.version += 1; };
  const copiesOf = (title: string) => [...remote.objects].filter(([, object]) => object.ics.includes(`SUMMARY:${title}\r\n`)).map(([objectPath]) => objectPath);
  caldav.listCalendars = async () => [
    { href: WORK, url: `${BASE}${WORK}`, displayName: 'Work', ctag: String(remote.version), readOnly: false },
    { href: SHARED, url: `${BASE}${SHARED}`, displayName: 'Shared', ctag: String(remote.version), readOnly: readOnlyShared },
  ];
  caldav.listCalendarObjects = async ({ calendarUrl }: FixtureValue) => [...remote.objects].filter(([objectPath]) => objectPath.startsWith(pathOf(calendarUrl)))
    .map(([href, object]) => ({ href, url: `${BASE}${href}`, etag: object.etag }));
  caldav.fetchCalendarObjects = async ({ objects }: FixtureValue) => objects.filter((item: FixtureValue) => remote.objects.has(item.href))
    .map((item: FixtureValue) => ({ href: item.href, etag: remote.objects.get(item.href)!.etag, ics: remote.objects.get(item.href)!.ics }));
  caldav.resourceGone = async ({ url, kind }: FixtureValue) => kind === 'calendar' ? ![WORK, SHARED].includes(pathOf(url)) : !remote.objects.has(pathOf(url));
  caldav.getCalendarObject = async ({ url }: FixtureValue) => {
    const object = remote.objects.get(pathOf(url));
    return object ? { ...object } : null;
  };
  caldav.putCalendarObject = async ({ url, ics, etag }: FixtureValue) => {
    const objectPath = pathOf(url);
    remote.writes.push(['put', objectPath, etag ? `If-Match ${etag}` : 'If-None-Match *']);
    const fault = faults.put?.(objectPath);
    if (fault === 'lose') throw davError('socket hang up', {});
    if (fault === 'refuse') throw davError('CalDAV request failed (403)', { status: 403 });
    const current = remote.objects.get(objectPath);
    if (etag ? current?.etag !== etag : current) throw davError('The event was changed on the calendar server in the meantime.', { status: 409, code: 'CALDAV_CONFLICT' });
    store(objectPath, ics);
    if (fault === 'store-then-lose') throw davError('The operation was aborted due to timeout', { name: 'TimeoutError' });
    return { etag: remote.objects.get(objectPath)!.etag };
  };
  caldav.deleteCalendarObject = async ({ url, etag }: FixtureValue) => {
    const objectPath = pathOf(url);
    remote.writes.push(['delete', objectPath, etag ? `If-Match ${etag}` : '']);
    if (faults.remove?.(objectPath) === 'fail') throw davError('read ECONNRESET', {});
    const current = remote.objects.get(objectPath);
    if (!current) return;
    if (etag && current.etag !== etag) throw davError('The event was changed on the calendar server in the meantime.', { status: 409, code: 'CALDAV_CONFLICT' });
    remote.objects.delete(objectPath);
    remote.version += 1;
  };
  return { remote, faults, store, copiesOf, BASE, HOME, WORK, SHARED };
}

/** A CalDAV account of the person, as the calendar tests store one. */
async function insertCalDavAccount(pool: FixtureValue, encrypt: (text: string) => string, userId: string, id: string) {
  await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, username, encrypted_password, base_url, provider_config, is_active)
    VALUES (?, ?, 'caldav', 'person@dav.example.test', 'Work server', 'person', ?, ?, ?, TRUE)`,
  [id, userId, encrypt('synthetic-dav-password'), `${BASE}${HOME}`, JSON.stringify({ server: { url: BASE, source: 'discovered', label: 'dav.example.test' }, principalHref: '/dav/principals/person/' })]);
}

export type CalDavFake = ReturnType<typeof installCalDavFake>;
module.exports = { installCalDavFake, insertCalDavAccount, eventIcs, BASE, HOME, WORK, SHARED };
