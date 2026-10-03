# 0.17.0: Calendar sync

Calendars now sync both ways with the login you already use for mail. UniHub
needs no OAuth app, API key or other setup on the server.
See [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md)
and [Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0170-calendar-sync).

### Added

- **Calendar settings on the mail account.** The edit dialog of a mail account
  has a Calendar section: turn it on or off, see the status, the last sync, the
  server that was found and the synced calendars, sync now, or enter a
  different address. Turning it off removes the imported calendars and events
  from UniHub; nothing changes on the server.
- **Finds the calendar server by itself.** From the email address and IMAP
  server, UniHub tries built-in providers (iCloud, Fastmail, Yahoo,
  mailbox.org, Posteo), DNS SRV records and `/.well-known/caldav`. This covers
  Stalwart, Nextcloud, Radicale, Baïkal, SOGo, mailcow and other CalDAV
  servers that publish it; otherwise enter the address once. New mail accounts
  try this by default.
- **Real sync.** Every account syncs every 15 minutes and on demand. Only
  changed events are downloaded. Recurring events, exceptions, time zones and
  event reminders are supported. New events from the server send a
  notification, and open pages update live.
- **Changes go back to the server.** Creating, editing, deleting and moving
  events in a CalDAV calendar writes them to the server. For repeating events
  you choose this event or all events. An event changed elsewhere in the
  meantime is never overwritten: UniHub refreshes it and asks you to try again.
- **Subscriptions.** Any ICS or webcal address can be added as a read-only
  calendar. This is how Gmail, Outlook and Exchange calendars appear: paste the
  calendar's secret (Google) or published (Outlook) ICS link.
- **Calendar page.** Add CalDAV accounts and subscriptions directly; each
  account shows its sync status, with sync now, pause and resume. Read-only
  calendars and events are marked as such.

### Changed

- Calendars imported by earlier versions start syncing; their first sync
  replaces the imported events, so their ToDo status starts empty.
- Synced calendars start with auto-ToDo off.

### Known limitations

- Google and Microsoft calendars are read-only; their two-way APIs need OAuth.
  Exchange Web Services is not supported.
- Attendees and RSVP are not synced.
- Changing the time of a whole repeating series resets the ToDo status and
  subtasks of its events.
- A color set on a single synced event is replaced by the calendar color.
