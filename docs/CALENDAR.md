# Calendar and ToDo Technical Documentation

## Overview

Calendar and ToDo share the `calendar_events` table. A dated event and a
standalone to-do are the same record with different flags and query semantics.

Current capabilities:

- multiple calendar accounts per user
- multiple calendars per account
- local calendar creation through the Calendar API
- two-way CalDAV sync, connected from a mail account's login or added directly
- read-only iCalendar (ICS) subscriptions
- automatic calendar server discovery from an email address
- recurring events, time zones, and notifications for new server events
- day/week/month calendar views in the frontend
- standalone to-dos, subtasks, reminders, attendees, RSVP state
- per-calendar visibility, color, primary flag, and auto-ToDo settings
- repeating events in UniHub's own calendars (0.32.0)
- sharing UniHub's own calendars and task lists with people and groups at
  five levels, group and organisation calendars, each shared calendar's own
  bin, a calendar's change of owner and its archive (0.32.0)

## Provider Model

| Provider | How it is created | Behavior |
| --- | --- | --- |
| `local` | Calendar account API, or as each user's default calendar | Fully local to UniHub |
| `caldav` | Mail account setup or edit page, or **Add account → CalDAV server** on the Calendar page | Two-way sync with the calendar server |
| `ics` | Subscription address in the mail account settings, or **Add account → Subscription** | Read-only; the feed is downloaded again on every sync |

Everything works with the login the user already has. UniHub needs no OAuth
app, API key or other registration on the UniHub server.

### Connecting a calendar

The **Calendar** section of a mail account's edit dialog turns the calendar of
that account on or off, shows the sync status, the last sync, the server that
was found and the synced calendars, and has **Sync now**. An address typed
there replaces the found server; an empty address with **Find automatically**
runs discovery again. While the calendar is off, **Connect calendar** (or
Enter in the address field) turns it on with the typed address, or finds the
server when the field is empty. These changes apply right away; saving the mail
account does not change the calendar. A failed attempt keeps its error message
below the section until the next attempt. Turning the calendar off removes the imported calendars,
their events and their local ToDo state from UniHub. Nothing is changed on the
server. The section and both requests need the Calendar module and are refused
while a calendar restore runs.

A calendar account belongs to a mail account through `mail_account_id`. Backups
do not keep that link, so opening the settings links an unlinked calendar
account with the same address, but only one that belonged to a mail account:
one marked `mailLinked` in its configuration, or a CalDAV account from 0.16 or
earlier (those could only be created together with a mail account). A calendar
account added on the Calendar page is never taken over by looking alone.
Turning the calendar on in the mail account's settings takes over an unlinked
account with the same server and login in place, keeping its events and their
ToDo state; this also relinks one restored from a 0.17.0 backup, which kept
neither the link nor the mark. One that another mail account has (two mail
accounts or aliases with the same calendar login) moves to this mail account
the same way, with its calendars, events, ToDo state and the synced-task
state waiting or set aside for them; the other mail account's calendar is
then off.

A linked CalDAV account has no password of its own: each sync and event
change reads the mail account's login at that moment. A new mail password or
login therefore applies right away, and a reconnect or login change starts a
sync of the linked calendar. While the mail account is disconnected (or paused
by a restore) the calendar waits: it is listed as paused with "The mail account
is disconnected", its sync is skipped, and an event change or move is refused
before anything is sent (a move before the target calendar is changed).
Disconnecting also stops any sync or event change of it that is running: reads
are aborted, a change already sent to the server is completed and kept.
Pausing the calendar yourself is separate and stays as you set it. Purging the
mail account deletes the calendar with its calendars and events in the same
transaction; it is refused while Calendar is turned off or being restored.

A calendar restored from a backup carries the `mailLinked` mark but no link
and no password. Opening the mail account's settings links it as described
above; if it is used first (by its sync), it finds the mail account with its
address itself. Without a mail account of that address it waits, listed as
paused with "This calendar belongs to a mail account it is not linked to";
adding the mail account in Mail resumes it. When that mail account already
has another calendar, the note says so: remove one of the two. A calendar
connected from mail before 0.17 and never linked finds its mail account the
same way, and so does one whose mail account was deleted: clearing all mail
accounts keeps the calendars and removes their links. Up to
0.18.1 a linked account kept a copy of the mail password; upgrading to 0.18.2
removes those copies (also from mail calendars not linked yet while a mail
account with their address exists) and turns calendars that were switched
off only by a mail disconnect back on. Only a calendar from before 0.17
whose mail account is gone keeps its password, as its own.

New mail accounts try the calendar by default (**Sync the calendar too**). The
mail account is created even when no calendar is found; the result says why.

Discovery, in order, stops at the first server that accepts the login:

1. an address typed by the user (a server root also tries
   `/.well-known/caldav` on it)
2. a known provider, matched by IMAP host or email domain
3. DNS `_caldavs._tcp` SRV and TXT records of the email domain (RFC 6764)
4. `https://<domain>/.well-known/caldav`, also for the IMAP host and the IMAP
   host without its first label

Then UniHub follows the principal to the calendar home and lists the
calendars. Basic and Digest authentication are supported.

| Server or provider | Result |
| --- | --- |
| Stalwart, Nextcloud, Radicale, Baïkal, SOGo, mailcow, Synology, other CalDAV servers | Found through SRV or `.well-known` when the domain publishes it; otherwise type the address once |
| iCloud | Built in; needs an app-specific password |
| Fastmail, Yahoo | Built in; need an app password |
| mailbox.org, Posteo | Built in |
| Gmail / Google Workspace | No CalDAV with a password. Paste the calendar's secret iCal address (Google Calendar → Settings → your calendar → Integrate calendar); read-only |
| Outlook.com, Microsoft 365, Exchange | No CalDAV. Publish the calendar in Outlook on the web (Settings → Calendar → Shared calendars) and paste the ICS link; read-only |

A self-hosted server must serve CalDAV over HTTPS with a certificate valid for
the name UniHub connects to. A host that only receives mail (the MX record) is
not enough: Stalwart, for example, serves CalDAV from its HTTP listener under
`/dav/` and `/.well-known/caldav`, so publish those paths under an HTTPS
hostname, then type `https://<that host>/` or let discovery find it through the
domain, the IMAP host or an SRV record. A server on a private address also
needs `TRUSTED_MAIL_HOSTS`.

The account shows how its server was found: typed, built-in provider, DNS, or
`.well-known`. Error messages never pass a raw server 401/403 to the browser;
a rejected login says to update the password.

## Data Model

Core tables:

- `calendar_accounts`
- `calendar_calendars`
- `calendar_events`
- `calendar_event_subtasks`
- `calendar_event_attendees`
- `calendar_event_external_refs`
- `calendar_remote_objects`
- `calendar_overlay_restores` (a synced task's own state waiting for its sync, see [Synced tasks keep their own state](#synced-tasks-keep-their-own-state))
- `calendar_series` (a repeating event of a UniHub calendar, see [Repeating events](#repeating-events-in-unihubs-calendars))
- `calendar_views`, `calendar_reminders` and `grants` of kind `calendar` (see [Shared calendars](#shared-group-and-organisation-calendars))

Important fields:

| Table | Field | Notes |
| --- | --- | --- |
| `calendar_accounts` | `provider` | `local`, `caldav` or `ics` |
| `calendar_accounts` | `encrypted_password` | CalDAV password, or the full ICS subscription address (it grants read access) |
| `calendar_accounts` | `mail_account_id` | Mail account whose settings own this calendar, if any |
| `calendar_accounts` | `provider_config` | Found server (`server.url`, `server.source`, `server.label`), credential scope, time zone |
| `calendar_accounts` | `sync_status`, `sync_error`, `last_synced_at`, `next_sync_at` | `pending`, `syncing`, `ok`, `error` or `paused`; schedule of the next sync |
| `calendar_calendars` | `read_only` | Set for subscriptions and server calendars without write access |
| `calendar_calendars` | `remote_ctag`, `remote_expanded_on` | Change marker of the server calendar; day the recurrences were last expanded |
| `calendar_remote_objects` | `href`, `etag`, `ics` | Server copy of each calendar object (one UID with its exceptions) |
| `calendar_calendars` | `is_visible` | Used by visible-only event queries |
| `calendar_calendars` | `auto_todo_enabled` | Controls projection into ToDo queries |
| `calendar_events` | `calendar_id` | Calendar ownership boundary |
| `calendar_events` | `uid` | The item's identity across moves, restores and installations: a synced event's iCal UID (shared by a series' occurrences), else its id or a new UUID. UIDs compare byte for byte |
| `calendar_events` | `is_todo_only` | Standalone ToDo item |
| `calendar_events` | `todo_status` | `done`, `changed`, `time_moved`, `cancelled`, or null |
| `calendar_events` | `reminders` | JSON array of reminder offsets in minutes |
| `calendar_events` | `source_email_id`, `source_email_json` | The email a task or event was made from (0.20.0): the id (no foreign key) and a snapshot of its header, see [Tasks from email](#tasks-from-email) |
| `calendar_event_external_refs` | `remote_object_id`, `recurrence_id` | Links each local occurrence to its server object; `recurrence_id` is UTC `YYYYMMDDTHHMMSSZ` |
| `calendar_calendars` | `user_id`, `account_id`, `group_id` | The owner: a person with their local account; both NULL for a calendar no person owns, a group calendar when `group_id` is set (deleting the group sets it NULL, which makes it an organisation calendar) |
| `calendar_calendars` | `archived_at`, `deleted_at`, `offer_to`, `offer_by` | Archived by an administrator; a deleted group or organisation calendar waiting for its purge; the one pending ownership offer |
| `calendar_events`, `calendar_event_subtasks`, `calendar_event_attendees` | `user_id` | The calendar owner's, whoever wrote the row; NULL in a calendar no person owns |
| `calendar_events` | `series_id`, `recurrence_id` | A date of a repeating UniHub event and its original time (the same key format as above); unique together |
| `calendar_event_subtasks` | `created_by` | Who added the subtask; a contributor changes only their own |
| `calendar_series` | `calendar_id`, `uid`, `ics` | The series as one iCalendar text: the rule, the creator's time zone, removed dates (`EXDATE`) and changed ones (`RECURRENCE-ID`). It has no owner column: it belongs to its calendar |
| `calendar_views` | `calendar_id`, `user_id`, `is_visible`, `color`, `notify_changes` | A person's own view of a calendar they reach; no row means on, the calendar's colour, no change notifications. For the owner only `notify_changes` counts |
| `calendar_reminders` | `user_id`, `event_id` or `series_id`, `reminders` | A person's own reminders on an event, or on every date of a series, of a calendar they do not own |
| `bin_items` | `calendar_id` | The calendar whose bin shows the item (no foreign key, so a deleted calendar does not take its bin with it) |

## Default Calendar

Every user has one local calendar account with one default local calendar
(`ensureDefaultLocalCalendarForUser`). The bootstrap admin gets them when the
database is created; other users when the calendar routes first need them.

## Date and Time Handling

- MariaDB `DATETIME` values are treated as UTC.
- The MariaDB pool uses `timezone: '+00:00'`.
- Incoming values are normalized with `toMysqlDatetime`.
- Datetime strings without an explicit timezone are interpreted as UTC.
- Serialized API responses convert `Date` instances to ISO strings.
- All-day events are stored as datetimes with `all_day = true`.

## Calendar-to-ToDo Projection

ToDo visibility is query-based and non-destructive.

An event appears in ToDo-oriented views when:

- `include_todos=true` is used where needed, and
- the event is either `is_todo_only=true` or otherwise selected by the frontend, and
- `respect_auto_todo=true` allows only calendars with `auto_todo_enabled=true`, and
- cancelled/done items are excluded when `include_done=false`.

Turning off `auto_todo_enabled` hides existing events from ToDo projections
without deleting the events.

**A repeating item in "Later".** ToDo's "Later" shows a repeating item once,
at its next date: the first open date per series (`series_key`) and calendar.
"Overdue" and "Today" keep every date, so a missed date stays until it is
ticked, and ticking a date brings the next one. This holds for UniHub's own
series and for synced ones; the view and list counts follow it, the ToDo
widget does the same ([Android](ANDROID.md#home-screen-widgets)), and the
calendar still shows every date.

## Repeating events in UniHub's calendars

From 0.32.0 an event or task in a UniHub calendar can repeat. Calendars synced
from a provider keep getting their repeating events from the provider
([Sync](#sync), [Writeback](#writeback)). The request and response shapes,
with every error code, are in `api/src/contracts/calendar-series.ts`.

- **Storage.** A series is one `calendar_series` row holding the iCalendar
  text, with one `calendar_events` row per date from 365 days back to 730
  days ahead (at most 1,100 dates), the same window and the same engine
  (`calendar-ical.ts`) as synced series. `services/calendar-series.ts`
  applies the series to its rows in place by recurrence key: a date found
  keeps its row and id, with its ToDo state, subtasks, attendees, order and
  reminders; a new date is inserted. Every reader (the calendar, ToDo,
  widgets, offline, search, reminders, free/busy) reads rows, so each date
  behaves like a single event there; search shows each date.
- **Daily extension.** Once a day per calendar with series, from the
  calendar sync pass, the dates that came into the window are added; nothing
  is changed or removed, and a date that falls out of the window keeps its
  row as history. A calendar whose owner's calendar restore runs waits; one
  whose owner has Calendar off waits a day.
- **Rules.** Daily; weekly on any weekdays; monthly on one day (months
  without that day are skipped, as RFC 5545 says) or on one ordinal weekday
  (first to fourth, or last); yearly. Interval 1 to 99; ending never, after 1
  to 999 dates, or on a date (the end of that day in the series' zone). The
  week starts on the person's `week_start`. Anything else is refused
  (`RRULE_UNSUPPORTED`); hourly rules, extra dates (`RDATE`) and "this and
  following" are not offered.
- **Time zone.** A series keeps its creator's time zone (`time_zone`, an IANA
  name; the person's own when left out), so 09:00 stays 09:00 across a
  daylight-saving change there, and people elsewhere see the same instants.
  An all-day series repeats dates in that zone.
- **One date or all.** `PUT` and `DELETE` of a date take `scope`
  (`occurrence`, the default, or `series`). One date is changed as an
  exception in the series and its row; a changed date keeps its own time when
  the series' time moves later. All dates changes the series and every date
  in the window, keeping ids and each date's state; a move of the series'
  time moves every date's key with it. Attendees are each date's own, also
  when all dates change. Switching all dates between all-day and timed, or
  changing the rule, treats the dates as new: a date that leaves the rule and
  holds something of its own (a ToDo state, subtasks or attendees) goes to
  the bin as a single event, one that holds nothing is removed. `repeat:
  null` keeps the edited date as a single event and puts the series in the
  bin; `repeat` on a single event makes it the first date of a series.
- **Deleting.** One date adds an `EXDATE` to the series and moves its row to
  the bin; restored, it comes back as a single event with what it held (the
  series keeps the gap). All dates go to the bin as one item with the series
  and every row, and come back as the series with the same ids. A calendar
  deleted to the bin takes its series with it.
- **Moving.** A series moves only whole, to a UniHub calendar of the same
  owner; one date never moves to another list (`409 SERIES_MOVE_REFUSED`).
- **Reminders.** The event's reminders are the series' `VALARM`s on every
  date (one date's in its exception). Anyone else's own reminders are for the
  whole series or for one date, which wins ([Reminders](#each-persons-reminders)).
- **Who.** `edit` creates, changes and deletes series and dates;
  `contribute` adds subtasks to one date; `read` sets its own reminders.
- **Old values.** A local event that held a `recurrence` value written by
  an API client before 0.32.0 stays a single event; that value was never
  expanded and still is not. The repeat mark and the "This event" or "All
  events" choice follow `series_id` for local events.
- **Backups.** Personal backups carry series from data schema 8; the
  readable `.ics` copy in the archive writes each series once, as it is
  stored ([Backup and Restore](#backup-and-restore-alpha)).

## Shared, group and organisation calendars

From 0.32.0 a calendar kept in UniHub can be shared with people and groups.
Calendars synced from a provider (CalDAV, subscriptions) are shared at the
provider, never through UniHub (`400 CALENDAR_NOT_SHAREABLE`; a grant on one
reaches nobody). A task list is a calendar, so the same holds for ToDo
lists. The request and response shapes, with every error code, are in
`api/src/contracts/calendar-shares.ts` and
`api/src/contracts/calendar-ownership.ts`.

**Three kinds of calendar.** A person's calendar belongs to them (`user_id`).
An organisation calendar belongs to nobody: an administrator makes it, for
example for holidays or a support rota. A group calendar is a calendar
nobody owns that names a group (`group_id`); deleting the group turns it
into an organisation calendar and keeps everything in it. Every row of a
calendar (events, subtasks, attendees, settings, bin items) carries its
owner's `user_id`, NULL without a person, whoever wrote it; that keeps a
person's backup, Delete data, deletion and a hand-over correct.

### Levels

A person's level on a calendar is one of five; each includes the ones
before. The access service (`services/access.ts`, kind `calendar`) answers it
from the grants to the person, to their groups and to Everyone, at the most
any of them gives.

| Level | Shown as | May |
| --- | --- | --- |
| `freebusy` | Sees busy times | Start, end and all-day of each event as "Busy"; no tasks, no titles |
| `read` | Can read | Everything; their own reminders and change notifications |
| `contribute` | Can add subtasks | Read, and add subtasks to events and tasks; the subtasks they added are theirs to change, tick and remove. Not: create, change the time, title or any other field, tick the item, touch another person's subtask, reorder, delete |
| `edit` | Can edit | Create, change, tick and delete events and tasks (one date or all), every subtask, the calendar's bin |
| `manage` | Can manage | Edit, and share within their reach, rename and set the default colour |

Without a grant:

- The owner of a person's calendar manages it. Deleting it is the owner's
  alone, and so is offering it, apart from a group manager's
  [hand-over](#change-of-owner-and-archive).
- A manager of a group manages that group's calendars.
- Administrators (`calendars.manage`: administrators and the owner of the
  installation) manage organisation and group calendars. A person's calendar
  shared with someone they see only by name and counts under Server ›
  Calendars, where they hand it over or archive it; its content only through
  a share of their own. A person's calendar nobody shares is out of their
  reach.
- An **archived** calendar caps every level, the owner's too, at `read`
  (`freebusy` stays `freebusy`).

Free/busy holds everywhere: the event list, an event by id, the offline
copy, widgets and notifications carry only the times and "Busy", tasks
without a date are left out, and search leaves such a calendar out. Each
date of a series is redacted like any event.

### Sharing

Anyone with `manage` gives a person, a group or Everyone a level, changes it
or removes it (`PUT /api/calendar/calendars/:id/shares`). Reach is as for
[shared address books](CONTACTS.md#who-may-do-what): an administrator
shares with anyone, a group or Everyone; anyone else only with the groups
they are in and the active people in those groups, never Everyone (`403
SHARE_OUT_OF_REACH`). Raising a share counts as sharing; lowering or
removing one is open to anyone who manages. The owner holds no share
(`SHARE_IS_OWNER`).

Access is asked on every request, and every write asks it again inside its
transaction after locking the calendar's row in share mode, so a share
removed while a write waits refuses the write. A write to another person's
calendar also waits for that person's calendar restore
(`409 RESTORE_IN_PROGRESS`), as their own writes do. A calendar the person
cannot see answers `404 CALENDAR_NOT_FOUND`, one they see but may not change
that way `403 CALENDAR_FORBIDDEN`. After a share, a group membership, a
group calendar created, renamed, deleted or restored, a hand-over, an
archive or a deactivation, the people concerned get the hint
`calendar.shares` and their pages refetch; a write sends `calendar.changed`
to everyone who reaches the calendar. A device's offline copy loses a
calendar no longer shared at its next refresh, a widget at its next refresh.

**Where shared calendars appear.** `GET /api/calendar/calendars` lists the
person's own calendars, then those others share with them (directly, through
a group or Everyone) and the group calendars of the groups they manage, each
with `permission`, `owner_kind`, `owner`, `group`, `archived`, the person's
`view` and a pending `offer`. A calendar offered to the person and not shared
with them is listed too, at `freebusy` with its offer and nothing else, until
they answer. Administrators find every other calendar under Server ›
Calendars only. The events of reached calendars the person has on are in
`GET /api/calendar/events`, ToDo, search, the offline copy and the widgets.

**The person's view.** Each person turns a calendar they reach on or off,
picks their own colour for it and switches "Notify me of others' changes"
(`PUT /api/calendar/calendars/:id/view`), on every device. For the owner the
on/off and colour stay the calendar's own settings; only the notification
switch is in the view. The order of tasks is each person's own.

**Moving events.** An event moves only between calendars of the same owner:
a person's own calendars (UniHub and synced alike, also when one of them is
shared), or calendars no person owns. Anything else is refused (`409
CALENDAR_MOVE_SHARED`). A new event or task goes into any calendar the person
may edit. RSVP and `POST /api/calendar/events/:id/move` stay for one's own
events.

### Group and organisation calendars

- **Creating.** An administrator makes an organisation calendar, or a group
  calendar for any group (Server › Calendars); a group's manager makes one for
  their group (the group's page, Calendars). A group may have several. A
  group calendar starts with a `contribute` share to the group, so every
  member sees it and adds subtasks; a manager raises or lowers that share and
  shares further like anyone who manages. An organisation calendar starts
  unshared: it reaches people once an administrator shares it, for example
  with Everyone.
- **Members.** Joining the group gives its level at once; leaving takes it
  away, and the person's own reminders there stop (nothing is deleted).
- **No approval.** Changes take effect at once.
- **Deleting.** A group's manager or an administrator deletes a group
  calendar, an administrator an organisation calendar
  (`DELETE /api/calendar/shared-calendars/:id`). It is hidden at once and
  deleted nothing for good; administrators restore it with its events and
  shares under Server › Calendars › Deleted. After the shared bins' time (as
  for [a book's bin](CONTACTS.md#deleting-a-book-and-each-books-bin): 30
  days, or longer while a bin minimum applies) the hourly purge deletes it
  with its events, bin and shares.

### A calendar's bin

An event or task deleted from a calendar goes to the bin with the calendar
named on it (`bin_items.calendar_id`). For a person's calendar it is also in
the owner's own bin, under the owner's retention. Everyone who may edit the
calendar lists it (`GET /api/bin?calendar=<id>`; `403` below edit), restores
items into that calendar under the same checks as a write, deletes them for
good and empties it (`POST /api/bin/empty` with `{ "calendar": "<id>" }`),
each under their own Calendar switch, restore lock and `bin.delete` rule. A
calendar nobody owns keeps its items as a book's bin does (above).

A restored event comes back with its row, subtasks, attendees and the
owner's ToDo order. What other people kept for themselves is not kept:
their own reminders on it and their place for it in their own task order
start afresh.

### Each person's reminders

The event's reminders (its column, a series' `VALARM`s) are the calendar
owner's. Anyone else with `read` or more sets their own through the event
route (`calendar_reminders`), for one event or for every date of a series.
One rule everywhere: a person's own row wins (one date's before its
series'); without one, the owner gets the event's reminders and nobody else
gets any. Someone creating an event in another person's calendar gets the
reminders they send as their own. Events of group and organisation
calendars have only personal reminders. The scheduler queues reminders per
person and checks the person's access again when one is queued and when it
is delivered, so a person whose access ended gets nothing; nothing is
deleted when access ends.

### Notifications of others' changes

The kind `calendar-change`, off until the person switches "Notify me of
others' changes" on for a calendar (their own calendars too). It tells them
that someone else created, changed, ticked, added a subtask to or deleted an
event or task there, never about their own changes: "<name> changed
<title>", or "A shared calendar changed" at the notification detail none.
There is at most one per event (or series) and person in ten minutes; a
change to all dates of a series is one. It expires after a day, and access
and the switch are checked again at delivery. See [PWA](PWA.md) for the
detail levels and the app lock.

### Change of owner and archive

A person's UniHub calendar can change its owner at any time. Calendars
nobody owns are handed over by administrators only; synced calendars have
no owner change.

- **Offer.** The owner offers the calendar to one active person within their
  reach who has the Calendar module
  (`POST /api/calendar/calendars/:id/hand-over` with `to`). There is one
  pending offer per calendar (`409 OFFER_PENDING`) and no expiry. The
  recipient accepts (`POST …/hand-over/accept`; reach, activity and the
  module are checked again) or declines; the offerer withdraws
  (`DELETE …/hand-over`). Deactivating either person, or archiving the
  calendar, ends the offer.
- **A group's manager.** A manager of a group that holds `read` or more on a
  person's calendar offers it, or with `now: true` hands it over at once, to
  an active member of that group, themselves included. Free/busy is not
  enough. Never an administrator's calendar, never to the organisation,
  never archive.
- **Administrators** (`calendars.manage`, with their password) hand over at
  once any calendar on Server › Calendars to an active person, to the
  organisation, or into its owner's bin
  (`POST /api/admin/calendars/:id/hand-over` with `to`: a person's id,
  `organisation` or `bin`), and archive or unarchive it
  (`PUT /api/admin/calendars/:id/archive`). An administrator's calendar is
  the installation owner's alone to act on (`403 ADMINS_OWNER_ONLY`).
- **What a hand-over does**, in one transaction under the calendar's row
  lock: the calendar goes to the new owner's local account (or to nobody),
  and its events, subtasks, attendees, bin items and settings follow (to the
  organisation the settings are deleted). The shares stay, the new owner's
  own share goes, and the old owner keeps `edit`, which the new owner may
  remove. The events' reminders become the new owner's; the old owner gets a
  copy as their own, and anyone's own reminders keep winning. A group
  calendar handed to a person or the organisation loses its group link; the
  group's share stays. It is refused while either person's calendar restore
  runs or a move of one of its events is pending.
- **Told and recorded.** The kind `calendar-ownership` tells the recipient of
  an offer, the old owner after an accept or a hand-over at once ("<calendar>
  now belongs to <name>"), and the owner after an archive; never the person
  who acted, "A calendar's owner changed" at the detail none. A hand-over at
  once and every administrator action leave an activity-log entry
  ([Auth and admin](AUTH_ADMIN_SETTINGS.md#activity-log)).
- **Archive.** Read-only for everyone, the owner included: no event,
  subtask, tick, share, offer, move into or out of it, RSVP, own-reminder
  change or delete. Removing the calendar account that holds it, and
  Settings › Delete data for Calendar, are refused (`403 CALENDAR_FORBIDDEN`)
  until an administrator unarchives it or hands it over. Reading and the
  person's own view go on; the owner of a person's calendar still changes
  its name and colour, nothing else (on/off stays the browser's own choice).
  Its series keep growing daily. Only
  administrators unarchive; the administrator's `bin` target still bins an
  archived calendar, and deleting the person removes it with their data.
- **When a person leaves**, an administrator decides for each of their
  shared calendars before Deactivate or Delete
  ([Auth and admin](AUTH_ADMIN_SETTINGS.md#deactivate-delete-and-devices)).

## API Endpoints

All endpoints require an authenticated session. Write endpoints require
`X-CSRF-Token`.

### Accounts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/calendar/accounts` | List accounts |
| POST | `/api/calendar/accounts` | Create a local account and default calendar |
| POST | `/api/calendar/accounts` | Create a `local` account with a default calendar, connect a `caldav` account (`username`, `password`, optional `url`), or add an `ics` subscription (`url`) |
| PUT | `/api/calendar/accounts/:id` | Update account email/display name; `is_active` pauses or resumes sync |
| POST | `/api/calendar/accounts/:id/sync` | Sync now |
| DELETE | `/api/calendar/accounts/:id` | Delete account, its calendars, and linked events (nothing is deleted on a server) |
| GET | `/api/mail/accounts/:id/calendar` | Calendar of a mail account: status, server, calendars, event count |
| PUT | `/api/mail/accounts/:id/calendar` | `enabled` turns it on or off; `caldav_url` sets the address (`''` finds it again, omitted keeps it) |

The backend refuses to delete the last local calendar account for a user.
Calendars of server accounts cannot be created, renamed or deleted in UniHub.

### Calendars

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/calendar/calendars` | List own calendars with account metadata, then the calendars the person reaches, each with its [access fields](#sharing) |
| POST | `/api/calendar/calendars` | Create calendar under an account |
| PUT | `/api/calendar/calendars/:id` | Update name/color/visibility/auto-ToDo/primary of an own calendar |
| DELETE | `/api/calendar/calendars/:id` | Move an own UniHub list and its events (and series) to the bin, as one group; its shares go. Refused while archived |

The backend refuses to delete the last calendar in an account.

### Sharing, group and organisation calendars, owner

These routes need the Calendar module, except the administrator's, and
declare no restore section: a write to another person's calendar checks that
person's restore lock itself.

| Method | Path | Purpose |
| --- | --- | --- |
| GET, PUT | `/api/calendar/calendars/:id/shares` | The shares; give, change or (`permission: null`) remove one (manage) |
| GET | `/api/calendar/calendars/:id/share-candidates?q=` | People and groups within the caller's reach, at most 20 each (manage) |
| PUT | `/api/calendar/calendars/:id/view` | The caller's own on/off, colour (`null`: the calendar's) and `notify_changes` (any level; for the owner only `notify_changes`) |
| POST | `/api/calendar/shared-calendars` | An organisation calendar (`calendars.manage`), or with `group_id` a group calendar (`calendars.manage` or a manager of that group) |
| PUT, DELETE | `/api/calendar/shared-calendars/:id` | Name and default colour (manage); delete a group or organisation calendar (a manager of its group, or `calendars.manage`) |
| POST, DELETE | `/api/calendar/calendars/:id/hand-over` | Offer (`to`; a group's manager also `now`); withdraw or decline |
| POST | `/api/calendar/calendars/:id/hand-over/accept` | The recipient accepts |
| GET | `/api/admin/calendars` | Server › Calendars: every calendar no person owns (deleted ones too) and every person's calendar shared with someone, by name and counts (`calendars.manage`) |
| POST | `/api/admin/calendars/:id/restore` | A deleted group or organisation calendar back with its events and shares (`calendars.manage`) |
| POST | `/api/admin/calendars/:id/hand-over` | At once to a person, `organisation` or `bin`, with the administrator's password (`calendars.manage`) |
| PUT | `/api/admin/calendars/:id/archive` | `archived: true \| false`, with the administrator's password (`calendars.manage`) |

### Events

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/calendar/events` | List events |
| GET | `/api/calendar/events/:id` | Load one event/to-do the person owns or reaches, including subtasks and attendees; a date of a UniHub series also answers `repeat` and `time_zone` |
| POST | `/api/calendar/events` | Create event or to-do; `repeat` (and `time_zone`) makes it the first date of a [series](#repeating-events-in-unihubs-calendars) |
| PUT | `/api/calendar/events/:id` | Update event fields and attendees; `scope` (`occurrence` or `series`) for recurring server events and UniHub series, `repeat` to add, change or (`null`) stop a UniHub series. Answers `{ event: null, replaced: true, scope: 'series' }` when a synced series' time change rebuilt the occurrences and the edited id is gone. `calendar_id: null` is refused (400) for an event linked to a server copy |
| PUT | `/api/calendar/events/:id/todo-status` | Update `todo_status`, optionally moving time |
| PUT | `/api/calendar/events/:id/rsvp` | Update RSVP state for an attendee |
| DELETE | `/api/calendar/events/:id` | Move the event or task to the bin (`bin_item_id` in the answer); a synced one is deleted at its server first. `?scope=occurrence\|series` for recurring server events and UniHub series |

Event query parameters:

| Parameter | Behavior |
| --- | --- |
| `include_todos` | Include standalone to-do events |
| `include_done` | Defaults to true; false hides `done` and `cancelled` |
| `range_start`, `range_end` | Date range overlap filter |
| `calendar_ids` | Comma-separated calendar IDs |
| `respect_auto_todo` | Filters out calendars where auto-ToDo is disabled |
| `visible_only` | Filters out hidden calendars |

Supported event payload fields include `title`, `description`, `start_time`,
`end_time`, `all_day`, `location`, `color`, `recurrence`, `reminder_minutes`,
`reminders`, `is_todo_only`, `calendar_id`, `attendees`, `repeat`,
`time_zone`, `scope` and, on create, `source_email_id`. The event routes serve
every calendar the person reaches, at the [level](#levels) each write needs;
on a calendar the person does not own, `reminders` are their own. Every
event carries `series_key` (a UniHub series' id, a synced object's UID, or
null) and every subtask `created_by` and `created_by_name`.

## Tasks from email

Since 0.20.0 a task or event can be made from an email (**Add task** in the
mail reader). `POST /api/calendar/events` with `source_email_id` checks that
the email belongs to the user and stores, next to the id, a snapshot of the
email's header in `source_email_json`: subject, sender, date, the file names
of up to eight regular attachments and the account address. Events are
returned with `source_email` (`{ email_id, subject, from_name, from_address,
received_at, attachments, account, available }`); `available` says whether
the email still exists, so the task keeps its context after the email is
removed by the user or by Sync policy. There is no foreign key: a
calendar-only restore does not depend on mail. The mail side shows the link
too: `GET /api/mail/emails/:id` returns `tasks` and the list returns
`task_count`.

Lists in the ToDo page are the user's local calendars; **New list** in the
dialog creates one. A task with a day appears in that calendar and is
reminded at its time (all-day tasks at 09:00); without a day it is
`is_todo_only`.

Backups export both fields. On restore the link is written as archived and,
once the mail section is restored, follows a restored email's new id; a
calendar-only restore keeps the id and the snapshot. The offline snapshot
includes both fields, and the app derives `source_email` from them.

## Notifications and Offline Reading

Enabled devices receive Web Push for new events/to-dos and due reminders. The
server persists reminder schedules, checks due work every 30 seconds, and
rechecks visibility, cancellation and completion before delivery. Notification
links use `/calendar?event=<id>` or `/todo?event=<id>` and open the referenced
item after an owner-scoped detail request, even when it falls outside the
currently displayed calendar range. See [PWA notifications](PWA.md) for delivery
timing and platform limits.

Since 0.24 each calendar can be switched off for notifications (calendar
setting `notify_enabled`, Settings → Notifications), and the person's reminder
detail level (`reminder_notification_detail`: full, or none for just "Event reminder"
without the title) applies to reminders and new items alike. Both are applied
on the server before delivery; the page's own reminders while it is open follow
them too. Two general settings shape the calendar: the first day of the week
(`week_start`: Monday, Sunday or Saturday) and the reminder a new event starts
with (`default_event_reminder`, none by default).

Opt-in offline snapshots contain calendar accounts, calendars, events/to-dos,
attendees and subtasks, and the calendars the person reaches with their view
and level (free/busy as "Busy" without tasks). The offline view applies calendar visibility, date and
to-do filters to the saved records and remains read-only. Dark mode preserves
existing calendar colors; defaults for newly created calendars use blue.

### Subtasks

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/calendar/events/:id/subtasks` | List subtasks |
| POST | `/api/calendar/events/:id/subtasks` | Create subtask |
| PUT | `/api/calendar/events/:id/subtasks/:subtaskId` | Update title/done/position |
| DELETE | `/api/calendar/events/:id/subtasks/:subtaskId` | Delete subtask |
| POST | `/api/calendar/events/:id/subtasks/reorder` | Replace full subtask order |

The reorder endpoint requires `subtask_ids` to include every subtask for that
event. Adding a subtask needs `contribute`; changing, ticking or removing one
needs `edit`, or `contribute` and the subtask being the caller's own;
reordering needs `edit`. A contributor's new subtask goes at the end.

## Sync

`api/src/services/calendar-sync.ts` keeps the server copy of each calendar
object in `calendar_remote_objects` and derives the local `calendar_events`
rows from it: one row per occurrence within 365 days back and 730 days ahead.

- **Schedule.** Every account stores `next_sync_at`. A timer checks every
  minute and syncs up to 20 due accounts. Each account syncs every 15 minutes,
  after an error after 30 minutes, and after a rejected login after 6 hours.
  Sync now, saving the settings and connecting run at once. One sync per
  account runs at a time, also across processes (database lock).
- **What is fetched.** The calendar list is read every time. A calendar whose
  change marker (ctag) did not change is skipped. Otherwise UniHub lists the
  objects in the window and downloads only new or changed ones (by ETag) with
  `calendar-multiget`, in batches of 50. ICS feeds use `If-None-Match`.
- **What is removed.** A listing can be incomplete, so a stored object it
  leaves out is requested again: one the server still has stays while it has
  occurrences in the window (it is applied again only when its ETag changed;
  the daily expansion refreshes it as any other), and loses its local rows
  once it moved out of the window, as before. An object is removed only when
  the server answers `404` or `410` for it; a calendar missing from the list
  only on `403`, `404` or `410`. Any other answer (a timeout, a server error,
  a rejected login) fails the sync and removes nothing. An ICS feed that
  suddenly has no events while some are saved is reported as an error
  (`ICS_FEED_EMPTY`) and the saved events stay; remove the subscription if its
  calendar was emptied on purpose.
- **Unreadable objects.** An object that cannot be parsed keeps its last
  readable copy, its ETag and its event rows with their ToDo state. The sync
  status shows how many entries could not be read, and the next sync downloads
  them again. A stored copy that cannot be read (0.17.0 stored copies before
  reading them) loses its ETag at the daily expansion, so it is downloaded
  again too. Rows imported before 0.17 are only replaced once every object of
  their calendar was read.
- **Recurrence and time zones.** `ical.js` expands `RRULE`, `RDATE`, `EXDATE`
  and overridden occurrences (`RECURRENCE-ID`), at most 1000 per series. Times
  are converted with the event's `VTIMEZONE` or IANA zone name. Floating times
  and all-day events use the account's time zone, which is the browser's time
  zone when the calendar was connected. Once a day every series is expanded
  again so the window moves forward.
- **Local state.** Occurrence rows are updated in place, so ToDo status and
  subtasks stay as long as the occurrence exists. Event colors follow the
  calendar color. New server calendars start with auto-ToDo off.
- **Notifications.** Up to 3 new future events per sync send a push
  notification, but not on the first sync of a calendar. `VALARM` reminders
  (up to 5) become UniHub reminders. A `calendar.changed` live event refreshes
  open pages.

## Writeback

Creating, editing, deleting and moving events in a writable CalDAV calendar
writes to the server first, with `If-Match` on the stored ETag. The local rows
are then rebuilt from the server's answer, so the server stays the authority.

- **Recurring events.** Edit and delete ask **This event** or **All events**.
  This event writes an overridden occurrence or an `EXDATE`; all events edits
  the series. Changing a series' time creates new occurrences: the edited row
  (and its attendees) is gone, nothing more is written for its id, and the
  response says `replaced: true` with `event: null`.
- **No calendar.** A synced event cannot be detached from its calendar
  (`calendar_id: null` is refused): without the calendar its later edits would
  stay local and be overwritten by the next sync. Move it or delete it instead.
- **Conflicts.** If the event changed on the server meanwhile (HTTP 412), the
  edit is refused with a message, nothing is overwritten, and the account syncs
  at once.
- **Moving.** A single event or task moves between calendars, accounts and
  UniHub lists by creating it in the target before deleting it from the
  source (`services/calendar-move.ts`, journalled in `calendar_event_moves`):
  the row, its done state, subtasks and hand place stay. A move a server has
  not confirmed shows as `move_pending` and finishes in the background, or can
  be cancelled; edits wait for it (`409 CALENDAR_MOVE_PENDING`). Recurring
  events cannot be moved.
- **Deleting.** A delete moves the item to the bin (D13, `services/bin-calendar.ts`).
  A synced one is deleted at its server first, as before (`If-Match`; a
  refusal or a conflict changes nothing); once the server confirmed, its rows
  leave UniHub and the bin keeps its server copy (ICS, UID, address), each
  occurrence's ToDo state, subtasks and source email, and its hand ranks.
  The delete holds the account's sync lock from the server's answer to the
  bin's commit, so a sync running meanwhile cannot remove the rows unbinned;
  it waits up to 20 seconds for a sync under way, then answers
  `409 CALENDAR_SYNC_BUSY`. Deleting **This event** of a repeating server
  event removes that date at the server for good and is not kept in the bin,
  so it is checked against `bin.delete` before the server is written. Items
  other apps delete at the server are not binned.
- **Restoring from the bin.** A UniHub item goes back into its list, or into
  the default list when that is gone. A synced one is created at its calendar
  again with the same UID, at its old address (`If-None-Match: *`), through
  the move journal (`calendar_event_moves.bin_item_id`): a lost answer waits
  (`pending`, the bin shows it as being restored) and its retry or the sync
  adopts the copy the server stored, never a second one; a server that holds
  the UID already is adopted at once. Another item at the address refuses it
  and it stays in the bin. A paused account refuses it (409); a calendar that
  is read-only now, or gone, takes it into the default list instead, with a
  note, unless the local copy would lose something: a repeating event with
  exceptions, extra or removed dates, or details on its dates stays in the bin
  (`BIN_RESTORE_NEEDS_CALENDAR`) until its calendar can take it back, or the
  person chooses another calendar for it. The rows the commit makes take
  their state back.
- **Restoring to another calendar.** Both restore routes take
  `calendar_id`, one of the person's own calendars (`BinRestoreRequest`):
  a writable server calendar creates a synced item there under its UID,
  through the same journal, and a UniHub list takes a UniHub item, or a
  synced one it can hold whole (else `BIN_RESTORE_NEEDS_CALENDAR`). A UniHub
  item goes to a UniHub list only (`BIN_RESTORE_NEEDS_LIST`); another
  person's calendar is not found (`BIN_RESTORE_CALENDAR_NOT_FOUND`), and a
  read-only one or a subscription is refused (`CALENDAR_READ_ONLY`). This
  is how a repeating item whose calendar went with its account comes back
  after the account is connected again. A restore whose server answer was
  lost keeps its calendar until that is settled: a retry without
  `calendar_id`, or with the same one, finishes it there (the stored copy is
  adopted), and any other destination, a list or another server calendar,
  is refused with `BIN_RESTORE_PENDING`, so the server's copy never shows
  beside a second one. The codes are `BinRestoreFailureCode`.
- **One change at a time.** Creating an item on a server, edits, time moves,
  deletions, moves, their cancel, a move's background run and a sync's
  adoption of a move's copy run one after another for one item (a lock per
  item, held from the first read to the local write). A change waits up to 25
  seconds for the one before it; past that, with two already waiting, or when
  the lock connections are in use, it answers `409 CALENDAR_EVENT_CHANGED` to
  try again. The locks have a connection pool of their own
  (`services/named-locks.ts`): `CALENDAR_EVENT_LOCKS` (10) for items and
  `CALENDAR_SYNC_LOCKS` (8) for account syncs, beside the main pool of 50; the
  comment there says how to size them. A request that waited checks the
  Calendar module and a running restore again, and every server write and
  local write of a change checks for a calendar restore begun since; a sync
  leaves a copy it may not adopt yet for its next run. A restore that writes
  over a task ends a move of it still creating its new copy; a move already
  removing the old copy goes on. Separately, a restore that points a move's
  calendar or its account elsewhere (another server, collection or login)
  ends that move, whatever its state, without deleting anything
  (docs/DATA_RECOVERY.md). A lock whose database session ended (a
  killed or broken connection) is lost: every server write and the local
  write of the change holding it check it first, so that change writes
  nothing more and answers 409, and the change that took the lock since
  stands. Known limit: an account sync's lock is not checked that way. A
  sync whose lock session ended can run beside the next one and write what it
  read before, for example an old copy a move removed or an older calendar
  tag; the next sync repairs both.
- **A move copies the version it deletes.** Every sync and edit that applies
  a server copy to its row notes the copy's version (ETag) on the link. A move
  whose row was applied from another version than the one it would delete is
  refused with `409 CALDAV_CONFLICT`, and the row is refreshed from the server
  first.
- **Read-only.** ICS subscriptions and calendars marked read-only reject
  changes with `403 CALENDAR_READ_ONLY`; the event dialog shows them read-only.
- **Not yet synced.** Events imported before 0.17 have no server copy until the
  first sync replaces them. Editing, deleting or moving one is refused with
  `409 CALENDAR_SYNC_PENDING` instead of changing only the local copy.
- **Not written.** Attendees and RSVP stay local. Standalone ToDos without a
  date cannot be saved to a server calendar.

## Network Policy

Every CalDAV and ICS connection uses a DNS-checked address with the original
TLS hostname and requires HTTPS (`webcal://` is read as `https://`). Private
and local addresses are blocked unless the host is listed in
`TRUSTED_MAIL_HOSTS`. The password is sent only to the origin where the login
was confirmed, or to a built-in provider's own hosts (for example iCloud's
`pNN-caldav.icloud.com`). Redirects to another origin are followed without
credentials only during discovery. Requests allow at most five redirects, 20
seconds total and 16 MiB of response data. A subscription feed is parsed in
one piece on the API's event loop, so it may be at most 8 MiB and hold at most
10,000 entries (UIDs); a larger feed is refused as a whole (`ICS_TOO_LARGE`)
when it is added, and at a later sync its last synced entries are kept and the
account shows the error. Blocked restored account settings remain inactive
with warnings.

## Security Notes

- Queries of a person's own calendars are scoped by `user_id`; every other
  calendar is reached only through the access service, asked again inside
  each write's transaction.
- Administrators see a person's calendar only by name and counts, unless it
  is shared with them.
- Calendar/calendar account relationships are verified before writes.
- State-changing routes are CSRF-protected.
- CalDAV URLs must use HTTPS.
- CalDAV host policy blocks private/local addresses unless explicitly trusted.
- CalDAV credentials and ICS subscription addresses are encrypted with the
  shared `ENCRYPTION_KEY`; the API returns only the subscription's host.

## Synced tasks keep their own state

What UniHub adds to a synced item (ToDo state, done time, source email,
subtasks; F2 `local` overlay) is not at the server, so a restore, which
re-syncs mirror data, would lose it with the rows. `services/calendar-overlays.ts`
keeps it in `calendar_overlay_restores` until the item exists again: the
sync that creates the item's row takes it in the same transaction, by
calendar, exact UID (byte for byte, spaces included) and recurrence id. For
archives without UIDs it goes by title and start, only to the one row of its
calendar that matches once every object was read, and only to a row without
state of its own; two candidates leave it waiting (those expire after 30
days). Applied once: a later change in UniHub
stands. An overlay goes with its calendar, is never written for another
person's calendar, and nothing is applied while Calendar is off or being
restored (no sync runs). An item whose rows exist already gets its overlay
at once (`applyOverlaysToLiveRows`). A move keeps the item's UID: a UniHub
task sent to a server calendar carries its own UID unless that calendar
holds it already (then a new one, recorded on the row), and a server task
taken into a list keeps the server's.

## Backup and Restore (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Calendar/ToDo backups include calendar accounts, calendars, events, ToDos,
subtasks, attendees, external references, provider metadata, and supported
account credentials. From data schema 8 (0.32.0) they also carry UniHub
series with their dates' keys; a restore maps series ids as it maps event
ids. A person's calendar stays in their own backup, shared or not, but
arrives unshared and not archived: shares, views, other people's reminders
and offers stay with the installation. Group and organisation calendars, with
everything in them, are only in the instance backup
([Data recovery](DATA_RECOVERY.md#backup-versions-and-restore-behavior)).

Same-name local calendars, including the default `Local` calendar, merge by
default. Restore can instead create restored copies. Events and child rows are
matched/remapped so subtasks, attendees, and external references continue to
point to the correct restored event.

Encrypted backups carry CalDAV passwords and stored access/refresh tokens in a
portable protected credential bundle. The destination server re-encrypts them
with its own `ENCRYPTION_KEY`.

Calendar writes are temporarily read-only only while a restore containing the
calendar section is queued/running.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Limitations

- Google and Microsoft calendars (including Exchange and Microsoft 365) are
  read-only subscriptions; their two-way APIs need OAuth app registration,
  which UniHub does not use.
- Exchange Web Services (EWS) is not supported.
- Attendees, invitations and RSVP state are not synced; no invite email is sent.
- A local color change on a synced event is replaced by the calendar color at
  the next sync.
- Changing the time of a whole synced series creates new occurrences; their
  ToDo status and subtasks start empty. A UniHub series keeps them.
- Events outside the window (365 days back, 730 days ahead) are not shown.
- UniHub series offer no hourly rules, extra dates or "this and following";
  a deleted date restored from the bin comes back as a single event, not into
  its series.
- An existing event does not move between calendars of different owners.
- Ownership offers do not expire; whoever made one withdraws it.
- Server calendars cannot be created, renamed or deleted from UniHub.
