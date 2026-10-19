# Architecture Technical Documentation


## Runtime Topology

The standard deployment uses two Docker containers:

| Container | Role |
| --- | --- |
| `unihub` | Nginx static frontend plus Node.js API |
| `unihub-db` | MariaDB 11.8 LTS database (`mariadb:11.8`) |

Inside the app container:

```text
Nginx :80
  /assets, /icons, SPA fallback -> /usr/share/nginx/html
  /api/events (unbuffered SSE)  -> Node.js API :4000
  /api/*, /health              -> Node.js API :4000

Node.js API
  api/server.ts -> api/src/app.ts -> api/src/request-handler.ts -> api/src/routes/*
```

The entrypoint waits up to 300 seconds for an authenticated MariaDB connection,
continuing immediately when it succeeds. It then starts a small Node.js service
supervisor as the container's main process. The supervisor starts the API and
nginx, forwards shutdown signals, and exits with failure if either service stops.
The existing Docker restart policy can then recover the whole app. The default
360-second health startup grace remains unchanged.

Nginx uses long `/api/` proxy timeouts because mail sync and large backup uploads
can take time. Backup validation and restore themselves run as durable
background jobs and do not depend on the proxy connection after job creation.

Nginx sends the security headers from `docker/nginx/security-headers.conf`
(`X-Frame-Options`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 0`,
`Referrer-Policy`, `Content-Security-Policy`, `Permissions-Policy`) with every
response. nginx inherits `add_header` all or nothing, so the file is included at
the `http` level and again inside each location that sets its own `add_header`
(`/assets/`, `/sw.js`, the manifest, `/icons/`); the SSE locations set none and
inherit it. The policy allows scripts from this origin only, which is why the
pre-paint theme script is the file `public/theme-init.js` rather than inline
markup. `img-src` also admits `http:` and `https:` because the mail reader's
`srcdoc` frame inherits the page policy on top of its own per-message policy
(`src/lib/email-privacy.ts`), and that inner policy alone decides whether remote
images load; the page never renders sender HTML outside that frame. The
service worker and the pdf.js worker run under the policy of their own script
response, so `/sw.js` and `/assets/` must carry it. `scripts/container-smoke.sh`
asserts the headers on `/`, `/sw.js`, `/theme-init.js`, an asset, the manifest
and an icon, and that the page loads no inline script.

## Backend Structure

| Path | Purpose |
| --- | --- |
| `api/server.ts` | Starts the API |
| `api/src/service-supervisor.ts` | Supervises API/nginx and essential-service failure |
| `api/src/app.ts` | Initializes DB, resumes backup workers, starts HTTP server and the background work |
| `api/src/services/background-work.ts`, `timers.ts` | The periodic jobs of the API process behind one start/stop (see Scheduled Jobs) |
| `api/src/services/realtime.ts` | Front for the live channels (browser event stream, Android notification stream); the mail and calendar event producers |
| `api/src/request-handler.ts` | CORS, auth, CSRF, module/restore gates, body parsing, route dispatch; every gate reads the matched route's spec |
| `api/src/http/route.ts` | `RouteSpec`, `defineRoutes`, `mergeRouteTables` and the route-table invariants (see Request Handling) |
| `api/src/routes/` | Route handlers grouped by feature; `routes/mail.ts` combines `mail-folders`, `mail-accounts`, `mail-drafts` (and send), `mail-messages`, `mail-operations` and `mail-sync`. Every mail route answers a caught error through `routeError` in `mail-route-helpers.ts`: a status-bearing error passes its message, anything else gets the route's fallback with 500. Account fields are parsed by `services/mail-account-input.ts` before anything is tested or stored |
| `api/src/services/` | Database, mail, calendar, backup creation/encryption/restore workers, recordings, 2FA logic |
| `api/src/routes/settings.ts` | User settings: there is no settings service yet. The account preferences (keys, defaults, allowed values in `USER_SETTING_DEFAULTS` and `USER_SETTING_ALLOWED_VALUES`, stored in `user_settings`), system settings and the `clear-*` data deletion live here; a new preference starts with those two tables and the table in [Auth](AUTH_ADMIN_SETTINGS.md) |
| `api/src/services/mail.ts` | Facade re-exporting `mail-host-policy` (host checks, IMAP config), `mail-folders` (folders, sender rules), `mail-durable-jobs` (job executor, scheduler), `mail-sync-control` (sync admission, cancel/stop), `mail-server-delete` and `mail-send` |
| `api/src/services/backup.ts` | Facade re-exporting `backup-common`, `backup-export`, `backup-validate`, `backup-restore-mapping`, `backup-zip-reader` and `backup-import` |
| `api/src/services/mail-attachments.ts` | Attachment validation, staging and inline references |
| `api/src/services/mail-drafts.ts` | Atomic draft replacements |
| `api/src/services/mail-import.ts` | Complete-message transactions and durable queue insertion |
| `api/src/services/mail-idle.ts` | IMAP IDLE supervisor: one read-only INBOX session per eligible account; changes become ordinary durable jobs |
| `api/src/services/offline.ts` | Owner-scoped, size-bounded offline snapshots |
| `api/src/services/caldav.ts`, `calendar-sync.ts`, `calendar-ical.ts`, `calendar-accounts.ts` | CalDAV discovery and requests, the sync engine and writeback, iCalendar parsing and recurrence expansion, calendars of mail accounts |
| `api/src/services/notifications.ts`, `notification-transports.ts`, `android-push.ts` | Durable notification events, delivery state and reminder worker; delivery transports keyed by the subscription's transport (`webpush`, which owns the VAPID identity, and `android`, the app's own connection) |
| `api/src/services/access-policy.ts` | `canRunModule` (module enabled, background allowed, no restore of its section) and the per-user blocked-module map used by workers |
| `api/src/services/module-lifecycle.ts` | `applyModuleChange`: what a saved module choice means for running work (the mail hook stops, cancels or resumes accounts and the IDLE session) and for open event streams |
| `api/src/security/encryption.ts` | AES-256-GCM helpers |
| `api/src/security/client-ip.ts`, `login-limits.ts` | Explicit proxy trust and separate IP/account attempt budgets |
| `api/src/security/outbound-network.ts`, `caldav-transport.ts` | Checked-address connections and same-origin CalDAV credentials |
| `api/tests/` | Backend `node:test` coverage |

Authored API source compiles to `api/dist/` for local use. The Docker builder
copies that tree into `/app/api/`, retaining the supervisor, readiness and
server entrypoint paths. Browser workers compile from `workers/` into classic
scripts at their existing URLs. See [development](DEVELOPMENT.md) for commands.

The API is a vanilla Node.js HTTP server. There is no Express router; routes are
mapped by keys such as `GET /api/contacts` or `PUT /api/contacts/:id/favorite`.
`http/route-matcher.ts` compiles every key of the route table once at startup:
an exact key wins, then the parameterized keys of the same method are tried by
whole path segment, the one with the most literal segments first (ties go to
the pattern whose literal comes first), so a new parameterized route needs no
change in `request-handler.ts`. A `:param` is one non-empty, percent-decoded
segment, available to the handler as `req.params`; malformed encoding is a 400.
Paths with an empty or trailing segment match nothing.

### Layering

`npm run lint` enforces the direction of imports:

- `api/src/security/` and `api/src/http/` are leaf layers: they import neither
  services nor routes.
- Routes reach the database through services, not `db` from `state.ts`, and
  read path parameters from `req.params` rather than splitting `req.url`.
- Frontend views and hooks call the API through a feature module in `src/lib/`
  (`calendar-api.ts`, `mail-api.ts`, ...); only `src/lib/`, `AuthContext.tsx`
  and `utils/service-worker.ts` use the raw client in `src/lib/api.ts`.
- There is no static import cycle in the API or the frontend
  (`scripts/import-graph.mts`). A cycle is broken on purpose with a lazy
  `require()`; the check lists the lazy edges from routes into the mail engine.

Files that predate a rule are listed in `eslint.boundaries.js`. The lists only
shrink: the check fails when a listed file no longer needs its entry or a list
grows past its ceiling.

## Frontend Structure

| Path | Purpose |
| --- | --- |
| `src/App.tsx` | Main router |
| `src/pages/` | One file per page; it composes the page's panel, header and body |
| `src/components/layout/` | App shell: `NavRail` (desktop), `BottomNav` (phones), `PageShell` with `PageHeader`, `PageBody` and the context-panel parts, and the attention list |
| `src/components/<feature>/` | Feature views (mail, calendar, todo, contacts, recordings, settings) |
| `src/contexts/AuthContext.tsx` | Session validation, cross-tab account changes, CSRF, and offline viewing identity |
| `src/components/SessionQueryProvider.tsx` | Private query cache lifetime tied to the signed-in account |
| `src/lib/api.ts` | Cookie-based API client, request cancellation, and network-failure-only offline reads |
| `src/lib/<feature>-api.ts` | A feature's types, query keys, requests and `invalidate…` helper (mail, calendar, contacts, recordings, settings, mail rules) |
| `src/hooks/use-<feature>-actions.ts` | A feature's changes as mutations with their feedback (tasks, events, contacts) |
| `src/hooks/use-mail-reader.ts` | Cancelled/stale reader requests and online read-state updates |
| `src/hooks/use-attention.ts` | Things that need the user (mail changes to review, failed syncs, app update) for the attention list |
| `src/hooks/use-audio-capture.ts` | Microphone recording as WAV, written to the device while recording |
| `src/lib/platform.ts` | Device boundary: saving files, downloads, clipboard and connectivity |
| `src/lib/app-events.ts` | Typed in-app events between parts of the app that do not share React state |
| `src/components/settings/BackupSettings.tsx` | Lazy backup and restore section and active-job polling |
| `src/lib/offline.ts` | Device snapshot storage, account/epoch isolation, and read-only response resolution |
| `src/lib/pwa-update.ts`, `src/hooks/use-app-update.ts` | Service-worker activation with separate refresh consent for each tab; the waiting update is an attention item |
| `src/test/` | Vitest frontend tests |

Main routes:

- `/dashboard` (Today: agenda, tasks and unread mail)
- `/contacts`
- `/calendar`
- `/todo`
- `/mail`
- `/recordings`
- `/more`
- `/music`
- `/settings` (sections chosen with `?section=`)
- `/admin/users`
- `/admin/settings`

Pages use one layout. On wide windows a page has an optional context panel
(folders, lists, sections) next to its content, which can be folded away from
its header (remembered in the browser per page); on narrow windows, or while
folded, the panel opens as a sheet from the scope button in the page header,
and on phones the header is the top bar. A page's view, filters and open item live in the address
(`?view=`, `?section=`, `?contact=`), so links from Today, notifications and
the command palette open the same state. Links ending in `?action=new` open
the page's form for a new item.

Routes load in separate chunks. Account
changes unmount the previous private query cache and cancel its requests before
rendering the next account. Mail search is debounced, and a reader request that
finishes after selection changes cannot replace the selected message. The backup
and restore section polls only active backup/restore jobs while it is shown;
terminal jobs and password-waiting jobs do not keep a polling loop running.

## Request Handling

Every route is declared with a spec (`api/src/http/route.ts`): the key
(`METHOD /path`, with `:param` segments) and the policy the boundary applies.
`request-handler.ts` reads only the spec; no other table decides a request's
treatment.

| Field | Meaning |
| --- | --- |
| `auth` | `'public'`, `'user'` or `'admin'`. The handler of a `'user'` or `'admin'` route receives a signed-in user id; the boundary has already answered 401 (no session) or 403 (`'admin'` without the admin role). |
| `module` | A module id gates the route behind that module's switch (403 `MODULE_DISABLED`); `null` is a core route. Required under `/api/<module>/`; a route elsewhere that touches a module (`POST /api/settings/clear-mail-accounts`) declares it too. |
| `restoreSection` | The recovery section whose running restore makes the route read-only (409 `RESTORE_IN_PROGRESS`); `'*'` refuses during any restore. Required on `POST`/`PUT`/`DELETE` outside `/api/backup/` and `/api/auth/`; an explicit `null` states that the route writes nothing a restore replaces. Every section with tables must have at least one write route. |
| `body` | `limit` in bytes (default 16 KiB, `DEFAULT_BODY_LIMIT`) and `kind`: `'json'` (default), `'backup-upload'` (spooled to a file when the content type is an archive) or `'none'` (not read). |
| `csrf` | `'token'` (default: cookie/header pair), `'background-header'` (the service worker's `X-Background-Sync: 1` also passes) or `'none'` (sign-in and sign-up, which issue the token). The bearer-without-cookie rule is global. |
| `response` | `'json'` (default) or `'stream'`: the handler writes and owns the response and returns nothing; a refusal before that is an ordinary JSON error. `GET /api/events` and `GET /api/notifications/android/stream`. |

`routes/index.ts` merges the files with `mergeRouteTables()` (a duplicate key
throws) and runs `assertRouteTable()` at startup and in `routes-policy.test.cts`:
every `/api/admin/` key is `'admin'`, every module key names its module, every
mutating key states its restore section, every section has a write route, and
every key resolves through the matcher. `routes-policy.test.cts` also walks the
production table through the real boundary: 401 for every non-public route
without a session, 403 for every admin route as a plain user.

Route files not yet declared with specs (`calendar`, `mail-*`, `contacts`,
`recordings`, `backup`) export plain handlers that `routes/legacy-spec.ts`
wraps with the derived policy (public keys, body limits, `getModuleForPath`,
a restore-section prefix table, the background-header keys);
`route-spec.test.cts` pins that derivation. To add a route, declare it in its
feature file with `defineRoutes()`; the invariants refuse a missing module,
restore section or admin level at startup.

Every request passes through `handleRequest`, in this order:

1. Resolve the method and path to a route key and `req.params` through the
   compiled route matcher (404 when nothing matches).
2. Apply CORS using `ALLOWED_ORIGINS`; if unset, only same-host origins are
   accepted. Handle `OPTIONS` preflight.
3. Verify auth from the session cookie or bearer token; the accepted credential
   is recorded on the request. 401 unless the spec is `'public'`.
4. Validate CSRF for authenticated state-changing requests according to
   `spec.csrf` (see [Auth](AUTH_ADMIN_SETTINGS.md#csrf-protection)).
5. Refuse a non-admin on an `'admin'` route (403).
6. Module gate (`spec.module`, 403), then the backup kill switch
   (`DISABLED_BACKUP_ROUTES`, 503), then the restore gate (`spec.restoreSection`,
   409). A disabled module therefore answers before a body is looked at.
7. Enforce `spec.body.limit` (413) and parse: chunked JSON with a UTF-8
   decoder (malformed JSON is 400), a backup upload spooled to a file, or no
   body for `kind: 'none'`.
8. Dispatch to the handler.
9. Serialize JSON, raw downloads, stream downloads, redirects or HTML; a
   `'stream'` route that has written its head is left alone.

JSON API responses use `Cache-Control: no-store`. Authenticated mail attachments,
recordings and backup archives reuse the file-stream response contract, including
byte ranges. Client disconnects destroy the corresponding stream.
Request URL parsing is inside the outer error boundary. Malformed Host headers
or request targets return HTTP 400 without terminating the API.

### Error contract

An error response is `{ error, code?, status }`: `error` is the text a client
may show, `code` (when present) is the stable value a client branches on, and
`status` repeats the HTTP status. `api/src/http/errors.ts` defines `ApiError`
(`status`, `code`, optional `details`) with the constructors `badRequest`,
`unauthorized`, `forbidden`, `notFound` and `conflict`, and `clientError(error,
fallback)`, the one mapping rule: an error carrying a 4xx status (an `ApiError`
or a plain `Error` with a `status`) answers with that status, its message and
its code; anything else answers 500 with the fallback text. The boundary applies
the rule to every error a route lets through (fallback `Internal Server Error`,
logged with the method and route key but never the request body), and route
catch blocks apply it with their own fallback (`Failed to update event`), so a
database driver's or file system's message never reaches the browser.

## Live Status Events

`GET /api/events` is a Server-Sent Events stream (`text/event-stream`) that
replaces most status polling in the browser. It passes the normal request
boundary: the session must be valid (401 otherwise), a foreign `Origin` is
refused (403), and as a GET it needs no CSRF token. The stream belongs to one
user and one session.

- **Bus.** `api/src/services/server-events.ts` holds an in-process bus; the
  Android notification stream (`android-push.ts`) is a second bus of the same
  kind. Producers publish and session changes close streams through
  `api/src/services/realtime.ts`, which fronts both: signing out, a password or
  two-factor change and deactivation end the user's streams on both channels.
  UniHub runs exactly one API process, so every event published by the mail
  workers reaches every stream. A second API replica would not share events (or the
  existing in-process mail and backup locks); see Operational Notes.
- **Owner scoping.** Events are published for a user id taken from the row that
  changed (`mail_engine_jobs.user_id`, `mail_writebacks.user_id`) and are written
  only to that user's streams. Events of a disabled module are withheld per
  stream; the module set is read at connect, on `PUT /api/modules` and at every
  heartbeat.
- **Content.** Events carry ids, states and counters only: never message
  content, subjects, addresses, folder names or provider error text. The
  browser refetches the real data through the ordinary owner-scoped routes.
- **Event types.** `ready` (`{v}`), `mail.job` (`{accountId, jobId, kind, state,
  phase, processed, total}`; states `queued`, `running`, `idle`, `error`,
  `cancelled`, `paused`), `mail.operation` (`{accountId, operationIds, state}`;
  writeback states such as `accepted`, `queued`, `confirmed`, `needs_attention`,
  or `null` for a coalesced mix), `mail.changed` (`{accountId, reason}`; reasons
  `import`, `flags`, `folders`, `content` (fetched bodies, and Sync policy
  removals/merges by the local `prune` job), `operation`, `local`) and `end`
  (`{reason}`: `signed_out`, `session_ended` or `shutdown`). `accountId` may be
  `null` when a change spans accounts.
- **Rate.** Each event type is throttled to one per second per account; the last
  event of a burst is always delivered when the interval ends.
- **Lifetime.** The stream starts with a `retry:` hint and a `ready` event and
  sends a `: ping` comment every 25 seconds. Each heartbeat re-checks the session
  with the same lookup as `verifyToken`, so a revoked, expired or deactivated
  session ends at the latest one heartbeat later. Sign-out, password changes,
  2FA disable (other sessions), and admin password reset, deactivation or
  deletion end the affected streams at once. A stream is closed when the client
  disconnects or stops reading (more than 256 KiB buffered).
- **Limits.** At most 5 streams per user and 200 in total; further requests get
  429 or 503 with `Retry-After: 60`.
- **Shutdown.** On SIGTERM/SIGINT (the supervisor's stop path, including the
  IPC disconnect of the unprivileged API) the API sends `end` with reason
  `shutdown`, closes every stream and stops accepting connections, then lets the
  signal end the process.
- **Proxy.** Nginx proxies `location = /api/events` (and the Android app's
  `/api/notifications/android/stream`) with `proxy_buffering off`, no gzip and a
  one-hour read timeout. The API sends `X-Accel-Buffering: no`, and Nginx passes
  it on (`proxy_pass_header`; it drops `X-Accel-*` headers otherwise) so that an
  Nginx-based reverse proxy in front, such as Nginx Proxy Manager, does not
  buffer the stream either. Without it, such a proxy held back an HTTP/1.1
  stream over TLS (the Android app's connection) until its buffer filled.
  The service worker has no route for `/api/events`, so the browser reads the
  stream from the network directly and nothing is cached.

In the browser, `ServerEventsProvider` (inside `SessionQueryProvider`, so it ends
with the session) opens the stream for an authenticated online session only,
never for an offline profile. It turns events into coalesced TanStack Query
invalidations and defers them while the tab is hidden. See
[Mail sync](MAIL_SYNC.md#status-updates) for the polling fallback.

## Authentication and CSRF

Sessions use:

- `auth-token` HttpOnly cookie containing a JWT
- database-backed `sessions` row for every active token
- `csrf-token` HttpOnly cookie and `X-CSRF-Token` header comparison for writes
- Sliding 21-day sessions (renewed on use, at most daily)

`/api/auth/me` returns the browser's existing CSRF token and issues one only
when it is missing or malformed, so another tab's token stays valid
([Auth](AUTH_ADMIN_SETTINGS.md#csrf-protection)).

Auth and CSRF cookies are marked `Secure` when `NODE_ENV=production`
(`COOKIE_SECURE` in `api/src/config.ts`, the only place that reads it). The
image sets `NODE_ENV=production`, so a deployment gets secure cookies however
the container is started; serve UniHub through HTTPS. Local HTTP development
runs the API without it.

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
2. Create a MariaDB pool with UTC datetime behavior.
3. Retry DB connection while MariaDB starts.
3a. Refuse any server that is not MariaDB 10.11 or later (`database-version.ts`),
    before any schema change. UniHub 0.16.0 and later do not run on MySQL.
4. Apply missing ordered upgrades through `schema_migrations`, verifying each before recording completion.
   An empty database is first set up from the 0.16.0 baseline, which also
   creates the first admin from the bootstrap env vars and its default local
   calendar.
5. Check the declared field inventory against the actual schema, then generate
   the Web Push identity if `notification_config` is still empty.

A refusal in steps 1 to 3a is thrown from `initDatabase`; `api/server.ts`
logs it and exits 1, so the container restarts instead of serving nothing.
`database.ts` exports the migration list as `MIGRATIONS` and
`LATEST_MIGRATION_ID`; `api/tests/database-migration-list.test.cts` checks ids,
names, inventory `introducedIn` bounds and the schema file's header without a
database.

The numbered upgrades in `database.ts` are the only schema path: since 0.19.2
step 15 also owns the notification tables and the mail list indexes, which
earlier releases created outside the upgrade history (at every start and
after listen). No container configuration change is needed for these
application migrations.

A new database is created from the 0.16.0 baseline, which stands for upgrade steps 1 to 11. Later upgrades have ordered IDs and completion records; completed repairs do not repeat. Required migration errors stop startup. A declared field inventory is checked against the actual schema. See [Recovery contracts](DATA_RECOVERY.md).

## Persistent Storage

| Path/table | Contents |
| --- | --- |
| MariaDB | Application metadata and most user data |
| `/app/uploads/attachments` | Email attachments |
| `/app/uploads/mail-raw` | Raw imported email source |
| `/app/uploads/recordings` | Recording audio files and upload temp files |
| `/app/uploads/backups/<userId>` | Generated `.zip` or encrypted `.unihub-backup` archives |
| `/app/uploads/backups/restores/<userId>` | Retained restore uploads |
| `/app/uploads/backups/restores/work/<jobId>` | Temporary decrypted ZIP used by an active encrypted restore job |

The Docker Compose file mounts `/app/uploads` as `uploads_data`. The two mail
roots are defined once in `api/src/services/mail-storage.ts`, which also owns
the "path is inside this root or owner directory" checks; the environment
variables `MAIL_ATTACHMENT_UPLOAD_ROOT` and `MAIL_RAW_STORAGE_ROOT` override
them, mainly for tests.

Multi-statement database writes run through `withTransaction` in
`api/src/services/transactions.ts` (also exported from `services/database.ts`
and `mail-engine/repository.ts`): one pooled connection between BEGIN and
COMMIT, rollback and release on a throw, and a bounded retry when InnoDB picks
the transaction as a deadlock victim. The callback receives an `SqlExecutor`
and its return value is the result, so a service can run on a passed-in
connection or open its own. Callbacks only touch the database; provider
commands and file writes stay outside.

## Scheduled Jobs

`api/src/services/background-work.ts` holds the periodic work of the API
process. `app.ts` starts it once after the server listens and stops it on
shutdown, before the event streams close. Each timer skips a tick while its
previous run is still going (`services/timers.ts`). These nine run:

| Interval | Job |
| --- | --- |
| 1 second | Re-enqueue due mail writebacks (per-operation backoff) and nudge the durable mail scheduler |
| 30 seconds | Reconcile due reminders and process durable notification deliveries |
| 30 seconds | Mail INBOX follow-up per active account (every 5 minutes while its IMAP IDLE session is healthy); folder discovery at most every 5 minutes |
| 1 minute | Calendar accounts whose `next_sync_at` is due |
| 1 minute | Process eligible mail-server deletion queue rows |
| 1 minute | Database pool counts, logged every 15 minutes and every minute while busy |
| 1 hour | Delete expired sessions |
| 1 hour | Delete finished mail engine jobs older than 7 days |
| 1 hour | Delete expired recording upload temp files |

It also starts the mail IDLE supervisor (`mail-idle.ts`) after the first mail
pass; the supervisor runs its own 60-second eligibility pass that opens and
closes one read-only INBOX IDLE session per eligible account. Restore-upload
expiry remains paused; completed restores still clean their upload.

At startup:

- queued/interrupted backup creation jobs are resumed
- interrupted validation jobs return to validation
- interrupted restore jobs return to the restore queue
- incomplete job work directories are removed
- completed uploaded restores finish archive/key cleanup if the process stopped
  after the database commit

Backup creation and restore processing are serialized by in-process workers.
Restore status and options are durable in MariaDB, so browser closure and proxy
timeouts do not terminate work.

## Mail Persistence

Default folders are inserted in one batch without overwriting user display names
or positions. A sync/backfill routing context loads rule precedence and target
folder membership once for that operation.

An imported message stages its raw source and attachments before opening a short
metadata transaction. The transaction marks the message complete, inserts the
attachment and server-deletion rows and releases the "New Email" notification
that the discovery scan held for a new arrival, all together. Failures
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

## Backup Architecture (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

The canonical backup data remains an uncompressed, stored-entry ZIP built by
`api/src/services/export-jobs.ts` from data assembled in
`api/src/services/backup-export.ts` (through the `backup.ts` facade).

Encrypted backups add a streaming container implemented by
`api/src/services/backup-container.ts`:

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

The frontend uses vite-plugin-pwa for an installable shell and a prompted update
flow: a waiting update appears in the attention list (rail and More) with a
Reload action, not as a separate banner. The client overrides the plugin's automatic reload callback: worker
activation is shared, but each tab must explicitly request its own refresh.
Native worker activation/controller events complete the requesting tab's update,
with a bounded timeout and retry if activation fails. Routes load
lazily; Workbox still precaches the offline-capable chunks, so startup savings do
not imply smaller total installation downloads.

The service worker does not handle API requests at all: no route matches `/api/`, so the browser sends them straight to the network and an open request cannot delay a worker update (see `vite.config.ts`).
The custom worker removes obsolete API caches on activation and owns Web Push
display, persistent per-user deduplication and same-origin click navigation.
Mail, calendar and to-do notification links open the referenced item after
owner-scoped loading. The API persists encrypted VAPID identity, session-bound
subscriptions, a transactional notification outbox and indexed reminder
schedules in MariaDB. One job loop processes notifications every 30 seconds:
`notifications.ts` selects due deliveries, revalidates their source and records
outcomes; the transport map in `notification-transports.ts` does the sending
and classifies failures. `webpush` sends to a browser's push service. `android`
(`android-push.ts`, upgrade step 17) makes UniHub the Android app's own push
server: the phone registers RFC 8291 keys as a push subscription with
`transport = 'android'`, holds a Server-Sent Events stream to the API (its own
bus, 45-second heartbeat, session and device checked at every heartbeat), and
acknowledges each encrypted notification; the delivery stays pending until
then and is sent again after two minutes, or as soon as an offline phone
connects. See [Android](ANDROID.md#notifications).

Opt-in offline reading uses a separate versioned IndexedDB snapshot with explicit account/epoch ownership. It contains the latest 100 full emails, all contacts and events, bounded to 32 MiB; it is not an authentication-response cache. Account changes and explicit clearing invalidate pending saves across tabs. See [PWA](PWA.md) and [Offline reading](OFFLINE.md).

## Security Boundaries

Important boundaries in the current code:

- every feature row is owned by one user: it has a `user_id`, or every path to
  it goes through a parent row that has one (`mail_folder_remote_boxes`,
  `mail_folder_rule_overrides`; `ownership: 'owned_parents'` in
  `backup-catalog.ts`). Routes and services scope queries by the current user
  on the row or on that parent
- admin routes require `role = 'admin'`
- delete/deactivate/demote operations protect the last active admin
- mail and CalDAV connections use DNS-checked IPs, block private/special addresses
  unless administrator-allowlisted, and preserve TLS hostname verification
- CalDAV credentials remain on the configured HTTPS origin through discovery
  and redirects
- restore writes are owner-scoped, new IDs are generated and parent links checked
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
- Live status events (`/api/events`) use an in-process bus: one API process
  serves every stream. Behind several API processes, browsers would miss events
  and fall back to slow polling.
- Use external backups for MariaDB and the uploads volume.
- Download important application backups off-server. A generated backup retained
  in the uploads volume is not protection against loss of that volume.
- Place a TLS-terminating reverse proxy in front of the app for real use.

## Mail modes and display privacy

`mail-account-mode.ts` validates switches and provider identity. The per-account
queue in `mail-account-lock.ts` serializes settings with sync/deletion workers.
The durable engine in `mail-engine/` scans each mapped provider mailbox in bounded
UID windows, reconciles verified current locations and retains absent copies. Original provider identity remains
separate from current bindings and local filing. Its job kinds (`mail-engine/job-kinds.ts`)
and operation states (`mail-engine/operation-states.ts`) are declared once; the
SQL `IN (...)` lists, the "due" predicate and the retry/cancel predicates are
built from those arrays. This assumes the standard single
API process; multiple API replicas require distributed worker coordination.

Migration 3 and the recovery catalog declare mode/current-location fields. Restore
resets operational progress, disables deletion and rejects conflicting mailbox
identities. Offline snapshots include mode and the retained-copy marker, excluding
provider UIDs and credentials. See [mail modes](MAIL_MODES.md).

`email-privacy.ts` builds a display-only sanitized document from inert HTML.
`SafeEmailContent` owns transient consent and a restricted iframe. A stored
draft's HTML passes through the same sanitizer (`sanitizeComposeHtml`) before
it enters the compose editor, the one place where server-supplied HTML becomes
live DOM in the application origin; SVG attachments are drawn from `data:` URLs
so that no sender content is reachable through a same-origin `blob:` URL. A synthetic
Chromium request check is available through
`node scripts/email-privacy-browser-check.mts` when Chromium is installed. It
intercepts image responses and uses no provider account.


## Built-in module boundaries

`module-catalog.ts` lists built-in modules and their corresponding recovery sections.
`module-settings.ts` owns per-user visibility/access/background preferences. The
request handler checks module access before reading a body or serving an attachment;
search, statistics, offline reads and provider workers apply their own relevant
checks. Settings/auth/recovery remain core functions. This is an internal catalog,
not a dynamic plugin or microservice system.

Each user's module order is a separate `module_order` setting. The API returns
modules in that order, and the navigation rail, mobile bar and More page follow it. See
[Modules](MODULES.md).
