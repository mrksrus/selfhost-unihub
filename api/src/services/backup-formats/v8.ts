// Data schema 8: the Calendar section carries repeating local events, each
// a calendar_series row (the iCalendar text: rule, time zone, changed and
// removed dates) with its dates as calendar_events rows (series_id,
// recurrence_id); a bin item names the calendar whose bin shows it
// (calendar_id). Archives up to schema 7 have none: nothing is converted,
// the schema number makes an older release refuse this archive as newer
// instead of restoring a series' dates as single events without a word.
import type { BackupPayload } from '../../types';
import { readV7 } from './v7';

function readV8<T extends BackupPayload>(backup: T): T {
  return readV7(backup);
}

export { readV8 };
