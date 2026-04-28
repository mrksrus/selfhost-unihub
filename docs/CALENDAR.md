# Calendar & ToDo Technical Documentation

## Overview

Calendar and ToDo still share one underlying event model, but the calendar subsystem now supports:

- Multiple local calendar accounts per user
- Multiple calendars per account with per-calendar visibility/color/auto-ToDo settings
- Day/Week/Month rendering support in frontend
- Persistent completed items in calendar views (done items are marked, not removed)
- Local account/calendar APIs, attendee storage, subtasks, and RSVP state

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
| GET | `/api/calendar/accounts` | List calendar accounts |
| POST | `/api/calendar/accounts` | Create local account |
| PUT | `/api/calendar/accounts/:id` | Update account metadata |
| DELETE | `/api/calendar/accounts/:id` | Delete account and account calendars/events |

### Calendars

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/calendars` | List calendars across accounts |
| POST | `/api/calendar/calendars` | Create calendar |
| PUT | `/api/calendar/calendars/:id` | Update name/color/visibility/auto-ToDo/primary |

### Events

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/events` | List events with filters (`include_todos`, `include_done`, `range_start`, `range_end`, `calendar_ids`, `respect_auto_todo`, `visible_only`) |
| POST | `/api/calendar/events` | Create event (supports `calendar_id`, `attendees`) |
| PUT | `/api/calendar/events/:id` | Update event fields |
| PUT | `/api/calendar/events/:id/todo-status` | Update todo status |
| PUT | `/api/calendar/events/:id/rsvp` | RSVP status update (`accepted`, `tentative`, `declined`, `needsAction`) |
| DELETE | `/api/calendar/events/:id` | Delete event |

### Subtasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendar/events/:id/subtasks` | List subtasks |
| POST | `/api/calendar/events/:id/subtasks` | Create subtask |
| PUT | `/api/calendar/events/:id/subtasks/:subtaskId` | Update subtask |
| DELETE | `/api/calendar/events/:id/subtasks/:subtaskId` | Delete subtask |
| POST | `/api/calendar/events/:id/subtasks/reorder` | Reorder subtasks |

## Calendar behavior

Calendar data is local to UniHub. The backend ensures each user has a default local account and default local calendar, and event create/update/delete operations only affect UniHub data.

## Feature flags

- `CALENDAR_MULTI_ENABLED` (default enabled)

## Security notes

- All calendar queries scoped by `user_id`
- Write APIs are CSRF-protected

## Known limitations

1. External calendar sync/import is not implemented.
2. Recurrence expansion is still limited (field exists but no full recurrence engine in UI).
