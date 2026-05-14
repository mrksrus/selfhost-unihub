# Calendar and ToDo Technical Documentation

## Overview

Calendar and ToDo share the `calendar_events` table. A dated event and a
standalone to-do are the same record with different flags and query semantics.

Current capabilities:

- multiple calendar accounts per user
- multiple calendars per account
- local calendar creation through the Calendar API
- optional CalDAV discovery/import when adding a mail account
- day/week/month calendar views in the frontend
- standalone to-dos, subtasks, reminders, attendees, RSVP state
- per-calendar visibility, color, primary flag, and auto-ToDo settings

## Provider Model

| Provider | How it is created | Behavior |
| --- | --- | --- |
| `local` | Calendar account API or startup backfill | Fully local to UniHub |
| `caldav` | Optional `try_calendar_sync` flow while creating a mail account | Discovers calendars and imports supported events |

The normal calendar account API only creates local accounts. CalDAV support is
currently import-oriented. It does not provide ongoing periodic CalDAV sync,
provider delete propagation, invite sending, or writeback of UniHub edits.

## Data Model

Core tables:

- `calendar_accounts`
- `calendar_calendars`
- `calendar_events`
- `calendar_event_subtasks`
- `calendar_event_attendees`
- `calendar_event_external_refs`

Important fields:

| Table | Field | Notes |
| --- | --- | --- |
| `calendar_accounts` | `provider` | `local` or `caldav` |
| `calendar_accounts` | `encrypted_password` | Used by CalDAV imports created from mail-account setup |
| `calendar_accounts` | `sync_status`, `sync_error`, `last_synced_at` | CalDAV import status metadata |
| `calendar_calendars` | `is_visible` | Used by visible-only event queries |
| `calendar_calendars` | `auto_todo_enabled` | Controls projection into ToDo queries |
| `calendar_events` | `calendar_id` | Calendar ownership boundary |
| `calendar_events` | `is_todo_only` | Standalone ToDo item |
| `calendar_events` | `todo_status` | `done`, `changed`, `time_moved`, `cancelled`, or null |
| `calendar_events` | `reminders` | JSON array of reminder offsets in minutes |
| `calendar_event_external_refs` | `provider`, `external_event_id`, `external_etag` | CalDAV/import reference tracking |

## Startup Backfill

On startup, `backfillCalendarOwnership` ensures every user has:

1. one local calendar account
2. one default local calendar
3. all legacy events assigned to that default calendar when `calendar_id` is null

## Date and Time Handling

- MySQL `DATETIME` values are treated as UTC.
- The MySQL pool uses `timezone: '+00:00'`.
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
| PUT | `/api/calendar/accounts/:id` | Update account email/display name/active state |
| DELETE | `/api/calendar/accounts/:id` | Delete account, its calendars, and linked events |

The backend refuses to delete the last local calendar account for a user.

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
| POST | `/api/calendar/events` | Create event or to-do |
| PUT | `/api/calendar/events/:id` | Update event fields and attendees |
| PUT | `/api/calendar/events/:id/todo-status` | Update `todo_status`, optionally moving time |
| PUT | `/api/calendar/events/:id/rsvp` | Update RSVP state for an attendee |
| DELETE | `/api/calendar/events/:id` | Delete event |

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

## CalDAV Import Details

When `POST /api/mail/accounts` includes `try_calendar_sync: true`, the mail route
calls the CalDAV service after successful IMAP credential validation.

Flow:

1. Build a discovery URL from `caldav_url`, or from the mail/email domain.
2. Require HTTPS.
3. Reuse host assessment logic to block private/local addresses unless the host
   is allowlisted through `TRUSTED_MAIL_HOSTS`.
4. Use Basic auth with the mail username/password.
5. Discover calendar home and calendars with DAV `PROPFIND`.
6. Fetch events using a CalDAV `REPORT` over a window of 365 days past and 730
   days future.
7. Parse simple non-recurring `VEVENT` items.
8. Upsert events and external refs into UniHub.

Recurring events and recurrence exceptions are skipped by the simple parser.

## Security Notes

- All queries are scoped by `user_id`.
- Calendar/calendar account relationships are verified before writes.
- State-changing routes are CSRF-protected.
- CalDAV URLs must use HTTPS.
- CalDAV host policy blocks private/local addresses unless explicitly trusted.
- CalDAV credentials are encrypted with the shared `ENCRYPTION_KEY`.

## Limitations

- Calendar API account creation is local-only.
- CalDAV is not a continuous sync engine.
- CalDAV import skips recurring events and recurrence exceptions.
- UniHub calendar edits are not pushed back to CalDAV providers.
- RSVP state is stored locally; no invite email or provider update is sent.
