# Calendar & ToDo Technical Documentation

## Overview

Calendar and ToDo still share one underlying event model, but the calendar subsystem now supports:

- Multiple calendar accounts per user (`local`, `google`, `microsoft`, `icloud`)
- Multiple calendars per account with per-calendar visibility/color/auto-ToDo settings
- Day/Week/Month rendering support in frontend
- Persistent completed items in calendar views (done items are marked, not removed)
- Provider sync/account APIs and RSVP endpoint

## Data Model

### Core event tables

- `calendar_events` (now includes `calendar_id`)
- `calendar_event_subtasks`
- `calendar_event_attendees`
- `calendar_event_external_refs`

### Account/calendar tables

- `calendar_accounts`
- `calendar_calendars`

### Backfill behavior

At startup, the backend ensures every user has at least one local account + default calendar and backfills legacy events with `calendar_id` when missing.

## Calendar-to-ToDo projection rule

ToDo visibility is projection-based (non-destructive):

- Event appears in ToDo execution flow only if:
  - Its calendar has `auto_todo_enabled = true`
  - Event is not cancelled
- Turning `auto_todo_enabled` off works retroactively via query semantics (existing events are hidden from ToDo view without deleting data).

## Date/Time handling

- Storage: UTC in MySQL `DATETIME`
- Input: local datetime from UI converted to UTC ISO before API calls
- Backend: normalizes incoming datetime via `toMysqlDatetime`
- Display: `date-fns` + optional user timezone
- All-day: represented with date-like semantics but stored as datetime

## API endpoints

All endpoints require auth cookie; write routes require `X-CSRF-Token`.

### Accounts

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/oauth/:provider/start` | Start OAuth redirect flow (`google`, `microsoft`) |
| GET | `/api/calendar/oauth/:provider/callback` | OAuth callback handler (stores tokens/account and triggers initial sync) |
| GET | `/api/calendar/accounts` | List calendar accounts |
| POST | `/api/calendar/accounts` | Create account (local/google/microsoft/icloud) |
| PUT | `/api/calendar/accounts/:id` | Update account metadata/tokens/config |
| DELETE | `/api/calendar/accounts/:id` | Delete account and account calendars/events |
| POST | `/api/calendar/accounts/:id/sync` | Trigger provider sync now |

### Calendars

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/calendars` | List calendars across accounts |
| POST | `/api/calendar/calendars` | Create calendar |
| PUT | `/api/calendar/calendars/:id` | Update name/color/visibility/auto-ToDo/read-only/primary |

### Events

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/events` | List events with filters (`include_todos`, `include_done`, `range_start`, `range_end`, `calendar_ids`, `respect_auto_todo`, `visible_only`) |
| POST | `/api/calendar/events` | Create event (supports `calendar_id`, `attendees`) |
| PUT | `/api/calendar/events/:id` | Update event fields |
| PUT | `/api/calendar/events/:id/todo-status` | Update todo status |
| PUT | `/api/calendar/events/:id/rsvp` | RSVP status update (`accepted`, `tentative`, `declined`, `needsAction`) |
| DELETE | `/api/calendar/events/:id` | Delete event (with provider delete propagation when mapped) |

### Subtasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/events/:id/subtasks` | List subtasks |
| POST | `/api/calendar/events/:id/subtasks` | Create subtask |
| PUT | `/api/calendar/events/:id/subtasks/:subtaskId` | Update subtask |
| DELETE | `/api/calendar/events/:id/subtasks/:subtaskId` | Delete subtask |
| POST | `/api/calendar/events/:id/subtasks/reorder` | Reorder subtasks |

## Sync behavior

### Google / Microsoft

- Supports account-level sync trigger
- OAuth connect flow in backend routes (`start`/`callback`) exchanges auth code for tokens
- Pulls calendars and events into local model
- Stores provider mappings in `calendar_event_external_refs`
- Pushes local create/update/delete for mapped provider calendars
- Carries attendee data into local attendee table

### iCloud / CalDAV (limited invitations)

- Supports sync from configured iCal feeds (`provider_config.ics_url` or configured feeds)
- Supports limited write path when CalDAV event base URL is configured
- Invitation handling remains limited by provider/protocol behavior

## Feature flags

- `CALENDAR_MULTI_ENABLED` (default enabled)
- `CALENDAR_SYNC_ENABLED` (default enabled)
- `CALENDAR_SYNC_PROVIDER_GOOGLE_ENABLED` (default enabled)
- `CALENDAR_SYNC_PROVIDER_MICROSOFT_ENABLED` (default enabled)
- `CALENDAR_SYNC_PROVIDER_ICLOUD_ENABLED` (default enabled)

## OAuth setup

Set these environment variables to use popup OAuth account connect for Google/Microsoft:

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `MICROSOFT_CALENDAR_CLIENT_ID`
- `MICROSOFT_CALENDAR_CLIENT_SECRET`
- `CALENDAR_OAUTH_REDIRECT_BASE_URL` (recommended when reverse-proxied)

OAuth redirect URIs must point to:

- `{base}/api/calendar/oauth/google/callback`
- `{base}/api/calendar/oauth/microsoft/callback`

## Security notes

- All calendar queries scoped by `user_id`
- Provider tokens are stored encrypted (`encrypted_access_token`, `encrypted_refresh_token`)
- Write APIs are CSRF-protected

## Known limitations

1. OAuth authorization flow UI is not bundled; account creation expects tokens/config supplied by client.
2. Recurrence expansion is still limited (field exists but no full recurrence engine in UI).
3. iCloud invitation semantics are constrained by CalDAV/server behavior.
