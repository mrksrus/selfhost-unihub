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

## Provider Model

| Provider | How it is created | Behavior |
| --- | --- | --- |
| `local` | Calendar account API or startup backfill | Fully local to UniHub |
| `caldav` | Mail account setup or edit page, or **Add account → CalDAV server** on the Calendar page | Two-way sync with the calendar server |
| `ics` | Subscription address in the mail account settings, or **Add account → Subscription** | Read-only; the feed is downloaded again on every sync |

Everything works with the login the user already has. UniHub needs no OAuth
app, API key or other registration on the UniHub server.

### Connecting a calendar

The **Calendar** section of a mail account's edit dialog turns the calendar of
that account on or off, shows the sync status, the last sync, the server that
was found and the synced calendars, and has **Sync now**. An address typed
there replaces the found server; an empty address with **Find automatically**
runs discovery again. Turning the calendar off removes the imported calendars,
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
neither the link nor the mark.

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
| `calendar_events` | `is_todo_only` | Standalone ToDo item |
| `calendar_events` | `todo_status` | `done`, `changed`, `time_moved`, `cancelled`, or null |
| `calendar_events` | `reminders` | JSON array of reminder offsets in minutes |
| `calendar_event_external_refs` | `remote_object_id`, `recurrence_id` | Links each local occurrence to its server object; `recurrence_id` is UTC `YYYYMMDDTHHMMSSZ` |

## Startup Backfill

On startup, `backfillCalendarOwnership` ensures every user has:

1. one local calendar account
2. one default local calendar
3. all legacy events assigned to that default calendar when `calendar_id` is null

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
| GET | `/api/calendar/calendars` | List calendars with account metadata |
| POST | `/api/calendar/calendars` | Create calendar under an account |
| PUT | `/api/calendar/calendars/:id` | Update name/color/visibility/auto-ToDo/primary |
| DELETE | `/api/calendar/calendars/:id` | Delete calendar and linked events |

The backend refuses to delete the last calendar in an account.

### Events

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/calendar/events` | List events |
| GET | `/api/calendar/events/:id` | Load one owned event/to-do, including subtasks and attendees |
| POST | `/api/calendar/events` | Create event or to-do |
| PUT | `/api/calendar/events/:id` | Update event fields and attendees; `scope` (`occurrence` or `series`) for recurring server events |
| PUT | `/api/calendar/events/:id/todo-status` | Update `todo_status`, optionally moving time |
| PUT | `/api/calendar/events/:id/rsvp` | Update RSVP state for an attendee |
| DELETE | `/api/calendar/events/:id` | Delete event; `?scope=occurrence\|series` for recurring server events |

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
`reminders`, `is_todo_only`, `calendar_id`, and `attendees`.

## Notifications and Offline Reading

Enabled devices receive Web Push for new events/to-dos and due reminders. The
server persists reminder schedules, checks due work every 30 seconds, and
rechecks visibility, cancellation and completion before delivery. Notification
links use `/calendar?event=<id>` or `/todo?event=<id>` and open the referenced
item after an owner-scoped detail request, even when it falls outside the
currently displayed calendar range. See [PWA notifications](PWA.md) for delivery
timing and platform limits.

Opt-in offline snapshots contain calendar accounts, calendars, events/to-dos,
attendees and subtasks. The offline view applies calendar visibility, date and
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
event.

## Sync

`api/src/services/calendar-sync.js` keeps the server copy of each calendar
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
  `calendar-multiget`, in batches of 50. Objects missing from the listing are
  removed. ICS feeds use `If-None-Match`.
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
  the series. Changing a series' time creates new occurrences.
- **Conflicts.** If the event changed on the server meanwhile (HTTP 412), the
  edit is refused with a message, nothing is overwritten, and the account syncs
  at once.
- **Moving.** A single event moves between calendars and accounts by creating
  it in the target before deleting it from the source. Recurring events cannot
  be moved.
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
seconds total and 16 MiB of response data. Blocked restored account settings
remain inactive with warnings.

## Security Notes

- All queries are scoped by `user_id`.
- Calendar/calendar account relationships are verified before writes.
- State-changing routes are CSRF-protected.
- CalDAV URLs must use HTTPS.
- CalDAV host policy blocks private/local addresses unless explicitly trusted.
- CalDAV credentials and ICS subscription addresses are encrypted with the
  shared `ENCRYPTION_KEY`; the API returns only the subscription's host.

## Backup and Restore (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Calendar/ToDo backups include calendar accounts, calendars, events, ToDos,
subtasks, attendees, external references, provider metadata, and supported
account credentials.

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
- Changing the time of a whole series creates new occurrences; their ToDo
  status and subtasks start empty.
- Events outside the window (365 days back, 730 days ahead) are not shown.
- Server calendars cannot be created, renamed or deleted from UniHub.
