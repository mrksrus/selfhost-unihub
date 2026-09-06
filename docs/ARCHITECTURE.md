# Architecture Technical Documentation

## Runtime Topology

The standard deployment uses two Docker containers:

| Container | Role |
| --- | --- |
| `unihub` | Nginx static frontend plus Node.js API |
| `unihub-mysql` | MySQL 8.0 database |

Inside the app container:

```text
Nginx :80
  /assets, /icons, SPA fallback -> /usr/share/nginx/html
  /api/*, /health              -> Node.js API :4000

Node.js API
  api/server.js -> api/src/app.js -> api/src/request-handler.js -> api/src/routes/*
```

Nginx uses long `/api/` proxy timeouts because mail sync and large backup uploads
can take time. Backup validation and restore themselves run as durable
background jobs and do not depend on the proxy connection after job creation.

## Backend Structure

| Path | Purpose |
| --- | --- |
| `api/server.js` | Starts the API |
| `api/src/app.js` | Initializes DB, starts HTTP server, schedules background jobs |
| `api/src/request-handler.js` | CORS, auth, CSRF, body parsing, route dispatch |
| `api/src/routes/` | Route handlers grouped by feature |
| `api/src/services/` | Database, mail, calendar, backup creation/encryption/restore workers, recordings, 2FA logic |
| `api/src/services/mail-attachments.js` | Attachment validation, staging and inline references |
| `api/src/services/mail-drafts.js` | Atomic draft replacements |
| `api/src/services/mail-import.js` | Complete-message transactions and durable queue insertion |
| `api/src/services/mail-sync-state.js` | Per-folder UID progress and resets |
| `api/src/services/offline.js` | Owner-scoped, size-bounded offline snapshots |
| `api/src/services/notifications.js` | Durable notification events, delivery state and reminder worker |
| `api/src/security/encryption.js` | AES-256-GCM helpers |
| `api/tests/` | Backend `node:test` coverage |

The API is a vanilla Node.js HTTP server. There is no Express router; routes are
mapped by exact keys such as `GET /api/contacts`, with parameterized paths
normalized in `request-handler.js`.

## Frontend Structure

| Path | Purpose |
| --- | --- |
| `src/App.tsx` | Main router |
| `src/pages/` | Page-level views |
| `src/components/` | Layout, UI, game, mail, and PWA components |
| `src/contexts/AuthContext.tsx` | Auth state and CSRF token wiring |
| `src/lib/api.ts` | Cookie-based API client |
| `src/lib/calendar-api.ts` | Calendar-specific API helpers |
| `src/test/` | Vitest frontend tests |

Main routes:

- `/dashboard`
- `/contacts`
- `/calendar`
- `/todo`
- `/mail`
- `/recordings`
- `/games`
- `/more`
- `/settings`
- `/admin/users`
- `/admin/settings`

## Request Handling

Every request passes through `handleRequest`:

1. Build a route key from method and path.
2. Normalize known parameterized routes.
3. Apply CORS using `ALLOWED_ORIGINS`; if unset, only same-host origins are accepted.
4. Handle `OPTIONS` preflight.
5. Verify auth from the session cookie or bearer token.
6. Validate CSRF for authenticated state-changing requests.
7. Enforce endpoint-specific body size limits.
8. Decode chunked JSON with a UTF-8 decoder, rejecting malformed JSON with HTTP 400, or stream backup uploads directly to persisted storage.
9. Dispatch to the route handler.
10. Serialize JSON, raw downloads, stream downloads, redirects, or HTML responses.

JSON API responses use `Cache-Control: no-store`. Authenticated mail attachments,
recordings and backup archives reuse the file-stream response contract, including
byte ranges. Client disconnects destroy the corresponding stream.

## Authentication and CSRF

Sessions use:

- `auth-token` HttpOnly cookie containing a JWT
- database-backed `sessions` row for every active token
- `csrf-token` HttpOnly cookie and `X-CSRF-Token` header comparison for writes
- 21-day session expiration

`/api/auth/me` refreshes the CSRF token for regular frontend auth checks.

When `NODE_ENV=production`, auth cookies are marked `Secure`. In production,
serve UniHub through HTTPS.

## Database Initialization

`initDatabase` accepts either:

- `DATABASE_URL`, or
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`

Before launching the API, `docker/start.sh` runs an authenticated `SELECT 1`
through mysql2 using that same configuration. It retries for up to 300 seconds
by default and continues immediately when the database is ready.
`MYSQL_STARTUP_MAX_WAIT_SECONDS` and `MYSQL_STARTUP_CHECK_INTERVAL_SECONDS`
override the budget and retry interval. Application image and Compose health
checks allow 360 seconds for startup, including slow database recovery.

Startup behavior:

1. Refuse missing or placeholder `JWT_SECRET`, `ENCRYPTION_KEY`, and DB password.
2. Create a MySQL pool with UTC datetime behavior.
3. Retry DB connection while MySQL starts.
4. Create or migrate tables in `ensureSchema`.
5. Create the first admin from bootstrap env vars when no users exist.
6. Backfill local calendar account/calendar ownership.

Additive mail migrations create `emails.import_complete` and `mail_sync_state`.
Old imported messages are revalidated once; subsequent progress is recorded per
account and exact provider folder, with UIDVALIDITY resets and failed-UID retries.
No container configuration change is needed for these application migrations.

The schema migration style is intentionally idempotent: create tables if missing,
then attempt additive column/index migrations.

## Persistent Storage

| Path/table | Contents |
| --- | --- |
| MySQL | Application metadata and most user data |
| `/app/uploads/attachments` | Email attachments |
| `/app/uploads/mail-raw` | Raw imported email source |
| `/app/uploads/recordings` | Recording audio files and upload temp files |
| `/app/uploads/backups/<userId>` | Generated `.zip` or encrypted `.unihub-backup` archives |
| `/app/uploads/backups/restores/<userId>` | Retained restore uploads |
| `/app/uploads/backups/restores/work/<jobId>` | Temporary decrypted ZIP used by an active encrypted restore job |

The Docker Compose file mounts `/app/uploads` as `uploads_data`.

## Scheduled Jobs

`api/src/app.js` starts these intervals:

| Interval | Job |
| --- | --- |
| 30 seconds | Reconcile due reminders and process durable notification deliveries |
| 10 minutes | Periodic mail sync for active accounts when no sync is running |
| 1 minute | Process eligible mail-server deletion queue rows |
| 1 hour | Delete expired sessions |
| 1 hour | Delete expired recording upload temp files |
| 1 hour | Expire retained restore uploads older than seven days |
| 15 minutes | Database pool health logging |

At startup:

- queued/interrupted backup creation jobs are resumed
- interrupted validation jobs return to validation
- interrupted restore jobs return to the restore queue
- incomplete job work directories are removed
- completed uploaded restores finish archive/key cleanup if the process stopped
  after the database commit

Backup creation and restore processing are serialized by in-process workers.
Restore status and options are durable in MySQL, so browser closure and proxy
timeouts do not terminate work.

## Mail Persistence

Default folders are inserted in one batch without overwriting user display names
or positions. A sync/backfill routing context loads rule precedence and target
folder membership once for that operation.

An imported message stages its raw source and attachments before opening a short
metadata transaction. The transaction marks the message complete and inserts
attachment, server-deletion and eligible notification rows together. Failures
retain the folder checkpoint for retry. Existing local read/star/folder changes
survive content repair. Draft replacements follow the same stage/commit/cleanup
ordering. See [Mail Sync](MAIL_SYNC.md) for upgrade and recovery behavior.

## Offline Snapshot Endpoint

`GET /api/offline/snapshot` requires a current authenticated session. One
repeatable-read transaction collects all of that user's contacts, calendar
entries/todos, subtasks, attendees, calendar/account display data, and the latest
100 non-draft email bodies. Deleted rows disappear on the next complete snapshot.

Explicit column projections exclude credentials, provider configuration, sync
tokens, raw-message paths and attachment storage paths. Attachment metadata marks
files unavailable offline. SQL size preflights reject oversized selected sections
before transferring their contents to Node; the final serialized snapshot must
fit 32 MiB. The operation returns a complete snapshot or an error and never writes
a partial server-side snapshot. The client is responsible for atomically
replacing its previous device copy.

The ordinary contacts API returns stable pages with `offset` and `has_more`, using
an ID tie-breaker after favorite/name ordering. The offline snapshot bypasses
that page limit so users with more than 2,000 contacts receive their entire list.

## Backup Architecture

The canonical backup data remains an uncompressed, stored-entry ZIP built by
`api/src/services/export-jobs.js` from data assembled in
`api/src/services/backup.js`.

Encrypted backups add a streaming container implemented by
`api/src/services/backup-container.js`:

- random per-backup data key
- 4 MiB AES-256-GCM chunks
- password-wrapped data key embedded in the file
- server-wrapped data key stored in `backup_archive_keys`
- portable mail/calendar credential bundle encrypted with the backup data key

Durable state is split across:

| Table | Purpose |
| --- | --- |
| `data_export_jobs` | Backup creation, progress, cancellation, archive metadata |
| `backup_restore_jobs` | Upload, validation, restore, progress, options, results, retention |
| `backup_archive_keys` | Server automatic-unlock key and temporary one-time password ciphertext |

Restore writes files into job-specific directories and restores database rows
inside one transaction. The job is marked completed in that same transaction.
Cancellation before commit rolls back rows and removes files created by the job.

An active restore makes only its selected sections read-only for that user.
Mail restore additionally pauses new mail sync/server-deletion work and waits for
already-running mail operations to finish.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Service Worker and PWA

The frontend uses vite-plugin-pwa for an installable shell and a prompted update flow. Routes and games load lazily; Workbox still precaches the offline-capable chunks, so startup savings do not imply smaller total installation downloads.

All private API requests use NetworkOnly. The custom worker removes obsolete API caches on activation and owns Web Push display, persistent per-user deduplication and safe click navigation. The API persists encrypted VAPID identity, session-bound subscriptions, a transactional notification outbox and indexed reminder schedules in MySQL. One job loop processes notifications every 30 seconds.

Opt-in offline reading uses a separate versioned IndexedDB snapshot with explicit account/epoch ownership. It contains the latest 100 full emails, all contacts and events, bounded to 32 MiB; it is not an authentication-response cache. Account changes and explicit clearing invalidate pending saves across tabs. See [PWA](PWA.md) and [Offline reading](OFFLINE.md).

## Security Boundaries

Important boundaries in the current code:

- all feature rows include `user_id` and routes scope queries by current user
- admin routes require `role = 'admin'`
- delete/deactivate/demote operations protect the last active admin
- mail and CalDAV host checks block private/local addresses unless trusted
- email HTML is rendered in a sandboxed iframe
- file download/stream routes validate paths stay under expected upload roots
- backup uploads are streamed to owner-only files instead of buffered in memory
- encrypted backups authenticate their header, password-wrapped key, and every
  data chunk
- recovery passwords are never stored as plaintext and can be revealed only once
- `JWT_SECRET` is not used for backup encryption

## Operational Notes

- This is a single-container app design. Do not run multiple app containers
  against the same database without reviewing in-memory locks and rate limits.
- Mail and backup workers use in-process execution locks and are not designed
  for multiple app containers. Backup/restore job state itself is durable.
- Use external backups for MySQL and the uploads volume.
- Download important application backups off-server. A generated backup retained
  in the uploads volume is not protection against loss of that volume.
- Place a TLS-terminating reverse proxy in front of the app for real use.
