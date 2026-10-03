# 0.17.1: Calendar sync fixes

Fixes four calendar sync problems found in review after 0.17.0. A small
database upgrade runs at startup. See [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md)
and [Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0171-calendar-sync-fixes).

### Fixed

- **An unreadable event no longer deletes its local copy.** When a calendar
  server sends an event UniHub cannot parse, the last readable version stays,
  with its ToDo state and subtasks. The sync status says how many entries could
  not be read, and the next sync tries them again. Before, the event and its
  ToDo state were removed and the sync reported success.
- **Turning off a mail account's calendar respects the Calendar module.** The
  Calendar section's requests are refused while the Calendar module is off or a
  calendar restore runs, so they can no longer delete calendar data then.
- **Events from before 0.17 are not deleted or moved only locally.** Until the
  first sync has replaced them, deleting or moving one is refused with "This
  event is still being synced", as editing already was. Before, the event was
  removed in UniHub only and came back with the next sync.
- **A calendar account added on its own is not taken over by a mail account.**
  Only calendars that belonged to a mail account (from 0.16 or earlier, or
  linked before a backup) are linked by address when the mail account's
  settings are opened. Before, any calendar account with the same address was
  linked, so turning off or disconnecting the mail account also affected it.
  The startup upgrade marks the calendar accounts 0.17.0 linked, so a backup
  taken right after upgrading still links them again when restored.
