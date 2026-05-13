const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCalDavDiscoveryUrl,
  parseSimpleVevents,
} = require('../src/services/caldav');

test('normalizes CalDAV discovery URL from explicit URL or mail host', () => {
  assert.equal(
    normalizeCalDavDiscoveryUrl({ explicitUrl: 'https://dav.example.com/caldav', emailAddress: 'u@example.com' }),
    'https://dav.example.com/caldav'
  );
  assert.equal(
    normalizeCalDavDiscoveryUrl({ emailAddress: 'user@example.com', imapHost: 'imap.example.com' }),
    'https://example.com/.well-known/caldav'
  );
});

test('parseSimpleVevents imports simple events and skips recurring events', () => {
  const events = parseSimpleVevents([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Planning',
    'DESCRIPTION:Line one\\nLine two',
    'DTSTART:20260512T100000Z',
    'DTEND:20260512T110000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-2',
    'SUMMARY:Recurring',
    'RRULE:FREQ=WEEKLY',
    'DTSTART:20260513T100000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'event-1');
  assert.equal(events[0].title, 'Planning');
  assert.equal(events[0].description, 'Line one\nLine two');
  assert.equal(events[0].startIso, '2026-05-12T10:00:00.000Z');
});
