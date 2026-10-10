import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  zonedWallTimeToUtc,
  resolveUserTimeZone,
  expandCalendarObject,
  splitIcsFeed,
  createEventIcs,
  updateEventIcs,
  removeOccurrenceIcs,
  objectUid,
} = require('../dist/src/services/calendar-ical') as typeof import('../src/services/calendar-ical');

const BERLIN_TZ = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

function calendar(...lines: FixtureValue[]) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

const window = { windowStartMs: Date.UTC(2026, 0, 1), windowEndMs: Date.UTC(2027, 0, 1), userTimeZone: 'Europe/Berlin' };

test('time zone helpers convert wall time across DST', () => {
  assert.equal(zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9 }, 'Europe/Berlin'), Date.UTC(2026, 0, 15, 8));
  assert.equal(zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9 }, 'Europe/Berlin'), Date.UTC(2026, 6, 15, 7));
  assert.equal(resolveUserTimeZone('Not/AZone'), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  assert.equal(resolveUserTimeZone('America/New_York'), 'America/New_York');
});

test('single events keep their zone, description, location and alarms', () => {
  const result = expandCalendarObject(calendar(...BERLIN_TZ,
    'BEGIN:VEVENT', 'UID:one@example.test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Planning', 'DESCRIPTION:Line one\\nLine two', 'LOCATION:Room 1',
    'DTSTART;TZID=Europe/Berlin:20260715T090000', 'DTEND;TZID=Europe/Berlin:20260715T100000',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT60M', 'END:VALARM',
    'END:VEVENT'), window);
  assert.equal(result.uid, 'one@example.test');
  assert.equal(result.recurring, false);
  assert.equal(result.occurrences.length, 1);
  const [event] = result.occurrences;
  assert.equal(event.startMs, Date.UTC(2026, 6, 15, 7));
  assert.equal(event.endMs, Date.UTC(2026, 6, 15, 8));
  assert.equal(event.description, 'Line one\nLine two');
  assert.equal(event.location, 'Room 1');
  assert.deepEqual(event.reminders, [0, 15]);
  assert.equal(event.recurrenceId, '');
});

test('all-day events span local midnights in the user zone', () => {
  const [event] = expandCalendarObject(calendar('BEGIN:VEVENT', 'UID:day', 'DTSTART;VALUE=DATE:20260310', 'SUMMARY:Holiday', 'END:VEVENT'), window).occurrences;
  assert.equal(event.allDay, true);
  assert.equal(event.startMs, Date.UTC(2026, 2, 9, 23));
  assert.equal(event.endMs, Date.UTC(2026, 2, 10, 23));
});

const SERIES = calendar(...BERLIN_TZ,
  'BEGIN:VEVENT', 'UID:series', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Berlin:20260302T090000', 'DTEND;TZID=Europe/Berlin:20260302T091500',
  'RRULE:FREQ=WEEKLY;COUNT=6', 'EXDATE;TZID=Europe/Berlin:20260309T090000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID;TZID=Europe/Berlin:20260316T090000', 'SUMMARY:Standup (moved)',
  'DTSTART;TZID=Europe/Berlin:20260316T110000', 'DTEND;TZID=Europe/Berlin:20260316T111500', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID;TZID=Europe/Berlin:20260323T090000', 'STATUS:CANCELLED',
  'DTSTART;TZID=Europe/Berlin:20260323T090000', 'DTEND;TZID=Europe/Berlin:20260323T091500', 'END:VEVENT');

test('recurring series expand with EXDATE, overrides, cancellations and DST', () => {
  const result = expandCalendarObject(SERIES, window);
  assert.equal(result.recurring, true);
  assert.equal(result.rrule, 'FREQ=WEEKLY;COUNT=6');
  const byId = Object.fromEntries(result.occurrences.map((item) => [item.recurrenceId, item]));
  assert.deepEqual(Object.keys(byId), ['20260302T080000Z', '20260316T080000Z', '20260330T070000Z', '20260406T070000Z']);
  assert.equal(byId['20260316T080000Z'].title, 'Standup (moved)');
  assert.equal(byId['20260316T080000Z'].startMs, Date.UTC(2026, 2, 16, 10));
  // After the switch to summer time 09:00 local is 07:00 UTC.
  assert.equal(byId['20260330T070000Z'].startMs, Date.UTC(2026, 2, 30, 7));
});

test('occurrence edits add an override and occurrence deletes add an EXDATE', () => {
  const edited = updateEventIcs(SERIES, { title: 'Only this one' }, { recurrenceId: '20260406T070000Z', scope: 'occurrence', userTimeZone: 'Europe/Berlin' });
  const afterEdit = expandCalendarObject(edited, window).occurrences;
  assert.equal(afterEdit.find((item) => item.recurrenceId === '20260406T070000Z')!.title, 'Only this one');
  assert.equal(afterEdit.find((item) => item.recurrenceId === '20260302T080000Z')!.title, 'Standup');

  const removed = removeOccurrenceIcs(edited, '20260406T070000Z', { userTimeZone: 'Europe/Berlin' });
  const ids = expandCalendarObject(removed, window).occurrences.map((item) => item.recurrenceId);
  assert.deepEqual(ids, ['20260302T080000Z', '20260316T080000Z', '20260330T070000Z']);
});

test('moving one occurrence of a series moves the series and its overrides', () => {
  const previousStartMs = Date.UTC(2026, 2, 30, 7);
  const moved = updateEventIcs(SERIES, { startMs: previousStartMs + 3600000, endMs: previousStartMs + 3600000 + 900000, allDay: false },
    { recurrenceId: '20260330T070000Z', scope: 'series', previousStartMs, userTimeZone: 'Europe/Berlin' });
  assert.match(moved, /DTSTART;TZID=Europe\/Berlin:20260302T100000/);
  const occurrences = expandCalendarObject(moved, window).occurrences;
  assert.equal(occurrences[0].startMs, Date.UTC(2026, 2, 2, 9));
  // Overrides follow the series by their original time and keep their own time.
  assert.equal(occurrences.length, 4);
  const override = occurrences.find((item) => item.title === 'Standup (moved)');
  assert.equal(override!.recurrenceId, '20260316T090000Z');
  assert.equal(override!.startMs, Date.UTC(2026, 2, 16, 10));
});

test('created events round-trip through expansion', () => {
  const startMs = Date.UTC(2026, 4, 12, 10);
  const { uid, ics } = createEventIcs({ title: 'Review', description: 'Notes', location: null, startMs, endMs: startMs + 3600000, allDay: false, reminders: [10] },
    { userTimeZone: 'Europe/Berlin' });
  assert.equal(objectUid(ics), uid);
  const [event] = expandCalendarObject(ics, window).occurrences;
  assert.equal(event.title, 'Review');
  assert.equal(event.startMs, startMs);
  assert.deepEqual(event.reminders, [10]);

  const allDay = createEventIcs({ title: 'Trip', startMs: Date.UTC(2026, 5, 1, 22), endMs: Date.UTC(2026, 5, 3, 22), allDay: true }, { userTimeZone: 'Europe/Berlin' }).ics;
  assert.match(allDay, /DTSTART;VALUE=DATE:20260602/);
  assert.match(allDay, /DTEND;VALUE=DATE:20260604/);
});

test('subscription feeds are split per UID with their time zones', () => {
  const feed = splitIcsFeed(calendar('X-WR-CALNAME:Team', ...BERLIN_TZ,
    'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260101T100000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART;TZID=Europe/Berlin:20260101T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'RECURRENCE-ID:20260108T090000Z', 'DTSTART:20260108T120000Z', 'END:VEVENT'));
  assert.equal(feed.name, 'Team');
  assert.deepEqual(feed.objects.map((item) => item.uid), ['a', 'b']);
  assert.match(feed.objects[1].ics, /BEGIN:VTIMEZONE/);
  assert.equal((feed.objects[1].ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal(splitIcsFeed(feed.objects[0].ics).objects[0].etag, feed.objects[0].etag, 'Unchanged events keep their ETag');
});
