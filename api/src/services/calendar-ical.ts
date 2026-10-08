// iCalendar (RFC 5545) reading and writing for synced calendars. Everything
// here is synchronous: ical.js keeps a process-wide timezone registry, and a
// calendar's own VTIMEZONE definitions are registered and removed again
// without yielding, so concurrent syncs never see each other's zones.
import crypto from 'crypto';

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time> & { timezone?: string };
interface WallTime { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }
interface Fields {
  title?: unknown;
  description?: unknown;
  location?: unknown;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  reminders?: unknown;
}
interface TimeOptions { allDayValue?: Time; template?: Time | null; userTimeZone?: string }
interface ApplyOptions { template?: { start: Time | null; end: Time | null }; userTimeZone: string }
interface Occurrence extends ReturnType<typeof occurrenceFromComponent> { recurrenceId: string }
const ICAL: typeof import('ical.js').default = require('ical.js');

const MAX_OCCURRENCES_PER_SERIES = 1000;
const MAX_RECURRENCE_STEPS = 20000;
const MAX_REMINDERS = 5;
const PRODID = '-//UniHub//Calendar//EN';

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(timeZone)!;
}

function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try { zoneFormatter(timeZone); return true; } catch { return false; }
}

function utcToZonedFields(ms: number, timeZone: string) {
  const parts = Object.fromEntries(zoneFormatter(timeZone).formatToParts(new Date(ms))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function zoneOffsetMs(ms: number, timeZone: string) {
  const f = utcToZonedFields(ms, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in an IANA zone to UTC. A time skipped by a DST change moves
// forward by the gap, as most calendar clients do.
function zonedWallTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }: WallTime, timeZone: string) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wall - zoneOffsetMs(wall, timeZone);
  const corrected = wall - zoneOffsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  return guess;
}

function resolveUserTimeZone(value: unknown): string {
  if (isValidTimeZone(value)) return value;
  const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(server) ? server : 'UTC';
}

function withCalendarTimezones<T>(root: Component, fn: () => T): T {
  const registered = [];
  try {
    for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
      const tzid = vtimezone.getFirstPropertyValue('tzid') as string | null;
      if (!tzid || tzid === 'UTC' || ICAL.TimezoneService.has(tzid)) continue;
      ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone));
      registered.push(tzid);
    }
    return fn();
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}

// Component.toJSON() returns the live jCal array; copies must be deep.
function cloneComponent(component: Component) {
  return new ICAL.Component(JSON.parse(JSON.stringify(component.toJSON())));
}

function parseIcs(ics: unknown) {
  const text = String(ics || '');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not an iCalendar object');
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== 'vcalendar') throw new Error('Not an iCalendar object');
  return root;
}

// Times with a known zone convert directly. A TZID without a VTIMEZONE is used
// when it is an IANA name; otherwise floating times use the user's zone.
function icalTimeToMillis(time: Time, userTimeZone: string) {
  if (time.isDate) return zonedWallTimeToUtc({ year: time.year, month: time.month, day: time.day }, userTimeZone);
  const tzid = time.zone?.tzid;
  if (tzid && tzid !== 'floating') return time.toUnixTime() * 1000;
  const named = isValidTimeZone(time.timezone) ? time.timezone : userTimeZone;
  return zonedWallTimeToUtc(time, named);
}

function recurrenceKey(time: Time | null, userTimeZone: string) {
  if (!time) return '';
  if (time.isDate) return `${String(time.year).padStart(4, '0')}${String(time.month).padStart(2, '0')}${String(time.day).padStart(2, '0')}`;
  return new Date(icalTimeToMillis(time, userTimeZone)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function text(component: Component, name: string) {
  const value = component.getFirstPropertyValue(name);
  return value == null ? '' : String(value).trim();
}

function alarmMinutes(vevent: Component, startMs: number, endMs: number) {
  const minutes = [];
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const action = text(alarm, 'action').toUpperCase();
    if (action && !['DISPLAY', 'AUDIO', 'EMAIL'].includes(action)) continue;
    const triggerProp = alarm.getFirstProperty('trigger');
    const trigger = triggerProp?.getFirstValue();
    if (!trigger) continue;
    let before: number | undefined;
    if (trigger instanceof ICAL.Duration) {
      const seconds = trigger.toSeconds();
      const related = String(triggerProp!.getParameter('related') || 'START').toUpperCase();
      before = related === 'END' ? -(seconds + (endMs - startMs) / 1000) / 60 : -seconds / 60;
    } else if (trigger instanceof ICAL.Time) {
      before = (startMs - trigger.toUnixTime() * 1000) / 60000;
    }
    if (Number.isFinite(before) && before! >= 0 && before! <= 525600) minutes.push(Math.round(before!));
  }
  return [...new Set(minutes)].sort((a, b) => a - b).slice(0, MAX_REMINDERS);
}

function occurrenceFromComponent(vevent: Component, startTime: Time, endTime: Time | null, userTimeZone: string) {
  const allDay = !!startTime.isDate;
  const startMs = icalTimeToMillis(startTime, userTimeZone);
  let endMs = endTime ? icalTimeToMillis(endTime, userTimeZone) : startMs;
  if (allDay && endMs <= startMs) endMs = zonedWallTimeToUtc(
    { year: startTime.year, month: startTime.month, day: startTime.day + 1 }, userTimeZone);
  if (endMs < startMs) endMs = startMs;
  return {
    title: text(vevent, 'summary').slice(0, 255) || 'Untitled event',
    description: text(vevent, 'description') || null,
    location: text(vevent, 'location').slice(0, 500) || null,
    allDay,
    startMs,
    endMs,
    reminders: alarmMinutes(vevent, startMs, endMs),
    cancelled: text(vevent, 'status').toUpperCase() === 'CANCELLED',
  };
}

function eventEnd(vevent: Component, start: Time): Time {
  const end = (vevent.getFirstPropertyValue('dtend') as Time);
  if (end) return end;
  const duration = vevent.getFirstPropertyValue('duration') as InstanceType<typeof ICAL.Duration> | null;
  if (duration) { const copy = start.clone(); copy.addDuration(duration); return copy; }
  if (start.isDate) { const copy = start.clone(); copy.adjust(1, 0, 0, 0); return copy; }
  return start;
}

// One CalDAV object holds one UID: a master VEVENT and optional exceptions
// (RECURRENCE-ID). Returns every occurrence in the window, keyed by its
// original recurrence time so a moved occurrence keeps its identity.
function expandCalendarObject(ics: unknown, { windowStartMs, windowEndMs, userTimeZone }: { windowStartMs: number; windowEndMs: number; userTimeZone: string }) {
  const root = parseIcs(ics);
  return withCalendarTimezones(root, () => {
    const vevents = root.getAllSubcomponents('vevent');
    if (!vevents.length) return { uid: null, recurring: false, rrule: null, occurrences: [] };
    const master = vevents.find(item => !item.hasProperty('recurrence-id')) || null;
    const exceptions = vevents.filter(item => item !== master && item.hasProperty('recurrence-id'));
    const uid = text(master || vevents[0], 'uid') || null;
    const occurrences: Occurrence[] = [];
    const add = (vevent: Component, start: Time, end: Time | null, key: string) => {
      const occurrence = occurrenceFromComponent(vevent, start, end, userTimeZone);
      if (occurrence.cancelled) return;
      occurrences.push({ ...occurrence, recurrenceId: key });
    };

    const recurring = !!master && (master.hasProperty('rrule') || master.hasProperty('rdate'));
    if (master && master.hasProperty('dtstart') && !recurring) {
      const start = (master.getFirstPropertyValue('dtstart') as Time);
      add(master, start, eventEnd(master, start), '');
    } else if (recurring && master.hasProperty('dtstart')) {
      const event = new ICAL.Event(master, { exceptions });
      const iterator = event.iterator();
      let next;
      let steps = 0;
      while ((next = iterator.next()) && steps++ < MAX_RECURRENCE_STEPS && occurrences.length < MAX_OCCURRENCES_PER_SERIES) {
        const details = event.getOccurrenceDetails(next);
        const startMs = icalTimeToMillis(details.startDate, userTimeZone);
        if (startMs > windowEndMs && icalTimeToMillis(next, userTimeZone) > windowEndMs) break;
        const endMs = icalTimeToMillis(details.endDate, userTimeZone);
        if (endMs < windowStartMs || startMs > windowEndMs) continue;
        add(details.item.component, details.startDate, details.endDate, recurrenceKey(details.recurrenceId, userTimeZone));
      }
    }
    // Exceptions without a master (an invitation to one occurrence) are
    // ordinary events with their own identity.
    if (!master) {
      for (const vevent of exceptions) {
        const start = (vevent.getFirstPropertyValue('dtstart') as Time);
        if (start) add(vevent, start, eventEnd(vevent, start), recurrenceKey((vevent.getFirstPropertyValue('recurrence-id') as Time), userTimeZone));
      }
    }
    const rrule = recurring && master.hasProperty('rrule') ? master.getFirstProperty('rrule')!.toICALString().replace(/^RRULE:/i, '') : null;
    return { uid, recurring, rrule, occurrences };
  });
}

// An ICS feed (subscription) holds many UIDs. Split it into one object per
// UID with the feed's VTIMEZONEs, so feeds and CalDAV share the same pipeline.
function splitIcsFeed(ics: unknown) {
  const root = parseIcs(ics);
  const timezones = root.getAllSubcomponents('vtimezone');
  const byUid = new Map<string, Component[]>();
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const uid = text(vevent, 'uid') || `generated-${crypto.createHash('sha256').update(vevent.toString()).digest('hex').slice(0, 32)}`;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(vevent);
  }
  const name = text(root, 'x-wr-calname') || null;
  const objects = [...byUid].map(([uid, vevents]) => {
    const calendar = new ICAL.Component('vcalendar');
    calendar.addPropertyWithValue('version', '2.0');
    calendar.addPropertyWithValue('prodid', PRODID);
    for (const tz of timezones) calendar.addSubcomponent(cloneComponent(tz));
    for (const vevent of vevents) calendar.addSubcomponent(cloneComponent(vevent));
    const body = calendar.toString();
    return { uid, ics: body, etag: crypto.createHash('sha256').update(body).digest('hex').slice(0, 40) };
  });
  return { name, objects };
}

function utcTime(ms: number) {
  return ICAL.Time.fromJSDate(new Date(ms), true);
}

function dateInZone(ms: number, timeZone: string, addDays = 0) {
  const f = utcToZonedFields(ms, timeZone);
  const date = new Date(Date.UTC(f.year, f.month - 1, f.day + addDays));
  return ICAL.Time.fromData({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), isDate: true });
}

// All-day events are stored from local midnight to the next local midnight.
// The end date is exclusive in iCalendar; an end at a non-midnight time on a
// later day (a hand-entered range) still covers that last day.
function allDayRange(startMs: number, endMs: number, timeZone: string) {
  const start = dateInZone(startMs, timeZone);
  const endFields = utcToZonedFields(endMs, timeZone);
  const endMidnight = endFields.hour === 0 && endFields.minute === 0 && endFields.second === 0;
  let end = dateInZone(endMs, timeZone, endMidnight ? 0 : 1);
  if (end.compare(start) <= 0) end = dateInZone(startMs, timeZone, 1);
  return { start, end };
}

// Write a time in the zone the server copy used, so a recurring series keeps
// following its own DST rules; otherwise write UTC.
function setTimeProperty(vevent: Component, name: string, ms: number, { allDayValue, template, userTimeZone }: TimeOptions) {
  vevent.removeAllProperties(name);
  if (allDayValue) {
    vevent.addPropertyWithValue(name, allDayValue);
    return;
  }
  const tzid = template && !template.isDate ? (template.zone?.tzid !== 'floating' ? template.zone?.tzid : (template as Time & { timezone?: string }).timezone) : null;
  const property = new ICAL.Property(name, vevent);
  if (tzid && tzid !== 'UTC' && ICAL.TimezoneService.has(tzid)) {
    property.setValue(utcTime(ms).convertToZone(ICAL.TimezoneService.get(tzid)));
    property.setParameter('tzid', tzid);
  } else if (tzid && tzid !== 'UTC' && isValidTimeZone(tzid)) {
    const f = utcToZonedFields(ms, tzid);
    property.setValue(ICAL.Time.fromData({ ...f, isDate: false }));
    property.setParameter('tzid', tzid);
  } else {
    property.setValue(utcTime(ms));
  }
  vevent.addProperty(property);
  void userTimeZone;
}

function setText(vevent: Component, name: string, value: unknown) {
  vevent.removeAllProperties(name);
  if (value != null && String(value).trim() !== '') vevent.addPropertyWithValue(name, String(value));
}

function setAlarms(vevent: Component, reminders: unknown) {
  for (const alarm of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(alarm);
  const values = [...new Set((Array.isArray(reminders) ? reminders : []).map(Number)
    .filter(value => Number.isSafeInteger(value) && value >= 0 && value <= 525600))].slice(0, MAX_REMINDERS);
  for (const minutes of values) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY');
    alarm.addPropertyWithValue('description', 'Reminder');
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60));
    vevent.addSubcomponent(alarm);
  }
}

function touch(vevent: Component) {
  const now = utcTime(Date.now());
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  const sequence = Number(vevent.getFirstPropertyValue('sequence')) || 0;
  vevent.updatePropertyWithValue('sequence', sequence + 1);
}

function applyFields(vevent: Component, fields: Fields, { template, userTimeZone }: ApplyOptions) {
  if (fields.title !== undefined) setText(vevent, 'summary', fields.title);
  if (fields.description !== undefined) setText(vevent, 'description', fields.description);
  if (fields.location !== undefined) setText(vevent, 'location', fields.location);
  if (fields.startMs !== undefined && fields.endMs !== undefined) {
    vevent.removeAllProperties('duration');
    if (fields.allDay) {
      const range = allDayRange(fields.startMs, fields.endMs, userTimeZone);
      setTimeProperty(vevent, 'dtstart', fields.startMs, { allDayValue: range.start });
      setTimeProperty(vevent, 'dtend', fields.endMs, { allDayValue: range.end });
    } else {
      setTimeProperty(vevent, 'dtstart', fields.startMs, { template: template?.start, userTimeZone });
      setTimeProperty(vevent, 'dtend', fields.endMs, { template: template?.end || template?.start, userTimeZone });
    }
  }
  if (fields.reminders !== undefined) setAlarms(vevent, fields.reminders);
  touch(vevent);
}

function createEventIcs(fields: Fields, { uid = crypto.randomUUID(), userTimeZone }: { uid?: string; userTimeZone: string }) {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);
  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('created', utcTime(Date.now()));
  calendar.addSubcomponent(vevent);
  applyFields(vevent, fields, { userTimeZone });
  vevent.updatePropertyWithValue('sequence', 0);
  return { uid, ics: calendar.toString() };
}

function findMaster(root: Component) {
  return root.getAllSubcomponents('vevent').find(item => !item.hasProperty('recurrence-id')) || null;
}

function findException(root: Component, recurrenceId: string, userTimeZone: string) {
  return root.getAllSubcomponents('vevent').find(item => item.hasProperty('recurrence-id')
    && recurrenceKey((item.getFirstPropertyValue('recurrence-id') as Time), userTimeZone) === recurrenceId) || null;
}

// The original recurrence time in the form of the master's DTSTART (same
// value type and zone), as RECURRENCE-ID and EXDATE require.
function recurrenceTimeLike(master: Component, recurrenceId: string, userTimeZone: string): Time | { value: Time; tzid: string | null } {
  const start = (master.getFirstPropertyValue('dtstart') as Time);
  if (/^\d{8}$/.test(recurrenceId)) {
    return ICAL.Time.fromData({ year: Number(recurrenceId.slice(0, 4)), month: Number(recurrenceId.slice(4, 6)), day: Number(recurrenceId.slice(6, 8)), isDate: true });
  }
  const ms = Date.parse(recurrenceId.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (!Number.isFinite(ms)) throw Object.assign(new Error('Invalid occurrence'), { status: 400 });
  const scratch = new ICAL.Component('vevent');
  setTimeProperty(scratch, 'x-time', ms, { template: start, userTimeZone });
  const property = scratch.getFirstProperty('x-time');
  return { value: property!.getFirstValue() as Time, tzid: property!.getParameter('tzid') as string | null };
}

function addTimeProperty(vevent: Component, name: string, time: Time | { value: Time; tzid: string | null }) {
  const property = new ICAL.Property(name, vevent);
  if ('value' in time && time.value) {
    property.setValue(time.value);
    if (time.tzid) property.setParameter('tzid', time.tzid);
  } else {
    property.setValue(time);
  }
  vevent.addProperty(property);
}

// Excluded and modified occurrences are identified by their original time, so
// they move with the series; otherwise they would no longer match anything.
function shiftSeriesExceptions(root: Component, master: Component, deltaMs: number, userTimeZone: string) {
  const shift = (component: Component, name: string) => {
    for (const property of component.getAllProperties(name)) {
      const values = property.getValues().map((time: Time) => {
        if (time.isDate) {
          const copy = time.clone();
          copy.adjust(Math.round(deltaMs / 86400000), 0, 0, 0);
          return copy;
        }
        const scratch = new ICAL.Component('vevent');
        setTimeProperty(scratch, 'x-time', icalTimeToMillis(time, userTimeZone) + deltaMs, { template: time, userTimeZone });
        return (scratch.getFirstPropertyValue('x-time') as Time);
      });
      if (property.isMultiValue) property.setValues(values);
      else property.setValue(values[0]);
    }
  };
  shift(master, 'exdate');
  for (const vevent of root.getAllSubcomponents('vevent')) {
    if (vevent !== master && vevent.hasProperty('recurrence-id')) shift(vevent, 'recurrence-id');
  }
}

// Edit an existing server copy in place so properties UniHub does not show
// (attendees, organizer, categories, X- properties) are preserved.
//   scope 'series': change the master; a time change shifts the series start
//     by the same amount the edited occurrence moved.
//   scope 'occurrence': create or update the exception for one occurrence.
function updateEventIcs(ics: unknown, fields: Fields, { recurrenceId = '', scope = 'series', previousStartMs, userTimeZone }: { recurrenceId?: string; scope?: string; previousStartMs?: number | null; userTimeZone: string }) {
  const root = parseIcs(ics);
  return withCalendarTimezones(root, () => {
    const master = findMaster(root);
    const recurring = !!master && (master.hasProperty('rrule') || master.hasProperty('rdate'));
    if (recurring && recurrenceId && scope === 'occurrence') {
      let exception = findException(root, recurrenceId, userTimeZone);
      if (!exception) {
        exception = cloneComponent(master);
        for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) exception.removeAllProperties(name);
        exception.removeAllProperties('recurrence-id');
        addTimeProperty(exception, 'recurrence-id', recurrenceTimeLike(master, recurrenceId, userTimeZone));
        root.addSubcomponent(exception);
      }
      const start = (exception.getFirstPropertyValue('dtstart') as Time);
      applyFields(exception, fields, { template: { start, end: (exception.getFirstPropertyValue('dtend') as Time) }, userTimeZone });
      return root.toString();
    }
    const target = master || (recurrenceId ? findException(root, recurrenceId, userTimeZone) : null) || root.getFirstSubcomponent('vevent');
    if (!target) throw Object.assign(new Error('The server copy has no event'), { status: 409 });
    const start = (target.getFirstPropertyValue('dtstart') as Time);
    const end = eventEnd(target, start);
    let next = fields;
    if (recurring && fields.startMs !== undefined && Number.isFinite(previousStartMs)) {
      // Moving one occurrence of a series by N minutes moves the whole series.
      const delta = fields.startMs - previousStartMs!;
      const length = fields.endMs! - fields.startMs;
      const masterStart = icalTimeToMillis(start, userTimeZone) + delta;
      next = { ...fields, startMs: masterStart, endMs: masterStart + length };
      if (delta && !!fields.allDay === !!start.isDate) shiftSeriesExceptions(root, master, delta, userTimeZone);
    }
    applyFields(target, next, { template: { start, end }, userTimeZone });
    return root.toString();
  });
}

// Remove one occurrence: drop its exception and add an EXDATE to the master.
// Returns null when nothing is left, so the caller deletes the whole object.
function removeOccurrenceIcs(ics: unknown, recurrenceId: string, { userTimeZone }: { userTimeZone: string }) {
  const root = parseIcs(ics);
  return withCalendarTimezones(root, () => {
    const exception = findException(root, recurrenceId, userTimeZone);
    if (exception) root.removeSubcomponent(exception);
    const master = findMaster(root);
    if (!master) return root.getAllSubcomponents('vevent').length ? root.toString() : null;
    addTimeProperty(master, 'exdate', recurrenceTimeLike(master, recurrenceId, userTimeZone));
    touch(master);
    return root.toString();
  });
}

function objectUid(ics: unknown) {
  try {
    const root = parseIcs(ics);
    const vevent = root.getFirstSubcomponent('vevent');
    return vevent ? text(vevent, 'uid') || null : null;
  } catch {
    return null;
  }
}

export {
  isValidTimeZone,
  resolveUserTimeZone,
  zonedWallTimeToUtc,
  utcToZonedFields,
  expandCalendarObject,
  splitIcsFeed,
  createEventIcs,
  updateEventIcs,
  removeOccurrenceIcs,
  objectUid,
  MAX_OCCURRENCES_PER_SERIES,
};
