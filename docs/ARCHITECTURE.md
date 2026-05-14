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

Nginx uses long `/api/` proxy timeouts because mail sync can take a long time for
large first imports.

## Backend Structure

| Path | Purpose |
| --- | --- |
| `api/server.js` | Starts the API |
| `api/src/app.js` | Initializes DB, starts HTTP server, schedules background jobs |
| `api/src/request-handler.js` | CORS, auth, CSRF, body parsing, route dispatch |
| `api/src/routes/` | Route handlers grouped by feature |
| `api/src/services/` | Database, mail, calendar, backup, recordings, 2FA logic |
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
8. Parse JSON request bodies.
9. Dispatch to the route handler.
10. Serialize JSON, raw downloads, stream downloads, redirects, or HTML responses.

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

Startup behavior:

1. Refuse missing or placeholder `JWT_SECRET`, `ENCRYPTION_KEY`, and DB password.
2. Create a MySQL pool with UTC datetime behavior.
3. Retry DB connection while MySQL starts.
4. Create or migrate tables in `ensureSchema`.
5. Create the first admin from bootstrap env vars when no users exist.
6. Backfill local calendar account/calendar ownership.

The schema migration style is intentionally idempotent: create tables if missing,
then attempt additive column/index migrations.

## Persistent Storage

| Path/table | Contents |
| --- | --- |
| MySQL | Application metadata and most user data |
| `/app/uploads/attachments` | Email attachments |
| `/app/uploads/mail-raw` | Raw imported email source |
| `/app/uploads/recordings` | Recording audio files and upload temp files |
| `/app/uploads/backups` | Generated ZIP export jobs |

The Docker Compose file mounts `/app/uploads` as `uploads_data`.

## Scheduled Jobs

`api/src/app.js` starts these intervals:

| Interval | Job |
| --- | --- |
| 10 minutes | Periodic mail sync for active accounts when no sync is running |
| 1 hour | Delete expired sessions |
| 1 hour | Delete expired recording upload temp files |
| 15 minutes | Database pool health logging |

At startup, pending data export jobs in `queued` or `running` state are resumed.

## Service Worker and PWA

The frontend uses `vite-plugin-pwa` with:

- app manifest and icons
- auto-update service worker registration
- network-only handling for mail email/attachment GETs
- short-lived network-first caching for other GET `/api/` calls
- custom notification/background-sync code from `public/sw-custom.js`

The custom service worker checks auth, triggers background mail sync when data is
stale, and checks upcoming calendar reminders/events.

## Security Boundaries

Important boundaries in the current code:

- all feature rows include `user_id` and routes scope queries by current user
- admin routes require `role = 'admin'`
- delete/deactivate/demote operations protect the last active admin
- mail and CalDAV host checks block private/local addresses unless trusted
- email HTML is rendered in a sandboxed iframe
- file download/stream routes validate paths stay under expected upload roots

## Operational Notes

- This is a single-container app design. Do not run multiple app containers
  against the same database without reviewing in-memory locks and rate limits.
- Mail sync and export jobs use in-process state and are not distributed.
- Use external backups for MySQL and the uploads volume.
- Place a TLS-terminating reverse proxy in front of the app for real use.
