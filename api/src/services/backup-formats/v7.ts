// Data schema 7 (0.28.0): a user backup holds UniHub's own data by data class
// (F2): local events but not those of CalDAV and ICS calendars, Sync-mode mail
// only without a server copy, Download-mode mail by the person's choice or
// policy. Events, calendars and recordings carry their stable identity (uid),
// and synced tasks their UniHub state as calendar_overlay_restores rows. The
// manifest says what was left out. Nothing is converted here: older archives
// pass through the class filter of the import (backup-classes.ts), which
// leaves out their mirrored rows the same way.
import type { BackupPayload } from '../../types';
import { readV6 } from './v6';

function readV7<T extends BackupPayload>(backup: T): T {
  return readV6(backup);
}

export { readV7 };
