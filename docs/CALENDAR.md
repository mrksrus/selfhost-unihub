# Calendar & To-Do - Technical Documentation

## Overview

UniHub provides a calendar for scheduling events and a to-do system built on top of the same event model. Events can optionally carry a `todo_status` and nested subtasks, enabling both calendar scheduling and task management in one unified view.

## Database Schema

### `calendar_events` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `user_id` | UUID | FK to `users` |
| `title` | VARCHAR(255) | Required |
| `description` | TEXT | Nullable |
| `start_time` | DATETIME | Required (UTC) |
| `end_time` | DATETIME | Required (UTC) |
| `all_day` | BOOLEAN | Default false |
| `location` | VARCHAR(500) | Nullable |
| `color` | VARCHAR(20) | Default `#22c55e` |
| `recurrence` | VARCHAR(100) | Reserved for future use |
| `is_todo` | BOOLEAN | Default false |
| `todo_status` | VARCHAR(20) | `done`, `changed`, `time_moved`, `cancelled`, or null |
| `done_at` | DATETIME | Set when status becomes `done` |
| `created_at` | TIMESTAMP | Auto-set |
| `updated_at` | TIMESTAMP | Auto-updated |

Indexes: `idx_events_user`, `idx_events_date`.

### `calendar_event_subtasks` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `event_id` | UUID | FK to `calendar_events` (CASCADE delete) |
| `user_id` | UUID | FK to `users` (CASCADE delete) |
| `title` | VARCHAR(500) | Required |
| `is_done` | BOOLEAN | Default false |
| `position` | INT | Sort order |
| `created_at` | TIMESTAMP | Auto-set |

Indexes: `idx_subtasks_event`, `idx_subtasks_user`, `idx_subtasks_order`.

## Date/Time Handling

- **Storage**: all times in UTC as MySQL `DATETIME`.
- **Frontend input**: `<input type="datetime-local">` in local time, converted to ISO 8601 before sending.
- **Backend conversion**: parsed to `YYYY-MM-DD HH:MM:SS` UTC via helper functions (`toMysqlDatetime`, `parseDatetimeToMillis`).
- **Display**: frontend uses `date-fns` to format in the user's local timezone.
- **All-day events**: start and end times set to midnight UTC; displayed without a time component.

## API Endpoints

All endpoints require authentication via session cookie. State-changing requests require `X-CSRF-Token`.

### Events

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/calendar/events` | List events; supports `?includeTodos=true` to include to-do items |
| POST | `/api/calendar/events` | Create event or to-do |
| PUT | `/api/calendar/events/:id` | Update event fields |
| DELETE | `/api/calendar/events/:id` | Delete event |
| PUT | `/api/calendar/events/:id/todo-status` | Update to-do status (`done`, `changed`, `time_moved`, `cancelled`, null) |

### Subtasks

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/calendar/events/:id/subtasks` | List subtasks for an event |
| POST | `/api/calendar/events/:id/subtasks` | Create subtask (supports `position` for insertion order) |
| PUT | `/api/calendar/events/:id/subtasks/:subtaskId` | Update subtask title, done state, or position |
| DELETE | `/api/calendar/events/:id/subtasks/:subtaskId` | Delete subtask |
| POST | `/api/calendar/events/:id/subtasks/reorder` | Bulk reorder subtasks by position |

### Dashboard stats

`GET /api/stats` returns an `upcomingEvents` count (events with `start_time >= UTC_TIMESTAMP()` that are not done or cancelled).

## To-Do Status Flow

Events with `is_todo = true` can carry a `todo_status`:

| Status | Meaning | Side effects |
|--------|---------|-------------|
| `null` | Pending / open | `done_at` cleared |
| `done` | Completed | `done_at` set to `NOW()` |
| `changed` | Modified after scheduling | `done_at` cleared |
| `time_moved` | Rescheduled | Accepts new `start_time`/`end_time`; preserves event duration if only one end is provided |
| `cancelled` | Abandoned | `done_at` cleared |

When setting `time_moved`, the backend auto-computes the missing end (or start) based on the original event duration.

## Subtask Ordering

- Each subtask has a `position` integer.
- On create, if no position is given, the subtask is appended (max position + 1).
- If a specific position is given, existing subtasks at that position and below are shifted down.
- The reorder endpoint accepts an array of `{ id, position }` pairs and batch-updates all positions in a single query.

## Event Serialisation

The backend serialises event rows with:

- `start_time` and `end_time` as ISO 8601 strings.
- `done_at` as ISO 8601 or null.
- `is_todo`, `all_day` as booleans.
- `subtasks` array (populated when fetching a single event or when the list query requests it).

## Frontend

### Calendar page

- Month view showing events on their start date, color-coded.
- Navigation: previous/next month, today button.
- Click to create or edit; color picker and location input.
- All-day toggle.

### To-do page

- List of to-do events with subtask progress.
- Status controls: mark done, reschedule, cancel.
- Inline subtask management: add, toggle, reorder (drag), delete.

## Security

- All queries filter by `user_id` using parameterised SQL.
- Route parameters are extracted via dedicated helper functions (`getCalendarEventIdFromPath`, `getCalendarSubtaskIdFromPath`).
- CSRF protection on all write operations.

## Limitations

1. No recurrence support in the UI (database field exists).
2. No timezone selector (UTC storage, local display).
3. No week/day calendar views.
4. No event reminders or notifications.
5. No event sharing between users.
6. No calendar import/export (iCal).
