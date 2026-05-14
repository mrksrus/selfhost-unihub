# UniHub - Self-Hosted Productivity Suite

> Disclaimer: UniHub is a learning/hobby project. It has not had a professional
> security review and should not be treated as production-ready software without
> your own review, testing, backups, and monitoring.

UniHub is a self-hosted web app for personal productivity data. It combines
mail, contacts, calendar, to-do items, recordings, settings, admin user
management, and a PWA shell in one installable browser app.

## Current Features

| Area | What exists now |
| --- | --- |
| Mail | IMAP sync, SMTP send, attachments, app-owned folders, sender routing rules, unread counts, bulk read/star/move/delete, background sync |
| Contacts | Search, favorites, import/export vCard 3.0, up to three emails and phone numbers per contact, duplicate preview/merge, bulk delete |
| Calendar and ToDo | Local calendar accounts, multiple calendars, visibility/color settings, attendees, RSVP state, reminders, subtasks, standalone to-dos |
| CalDAV import | Optional CalDAV discovery/import when adding a mail account; imports supported non-recurring events into calendar tables |
| Recordings | Browser recording/import, chunked upload, tags, search/filter, audio streaming/download |
| Backups/exports | JSON backup/import API plus async ZIP export jobs for selected sections |
| Admin | Bootstrap admin, signup mode control, account approval/deactivation, role changes, password resets, user deletion |
| Security baseline | HttpOnly cookie auth, CSRF tokens, 2FA, rate limiting, strict mail TLS by default, SSRF checks for mail/CalDAV hosts, sandboxed email HTML |
| PWA | Installable frontend, app manifest/icons, service worker caching, background notification checks |

## Architecture

UniHub runs as two containers in the included Docker Compose setup:

| Container | Image | Purpose |
| --- | --- | --- |
| `unihub` | `ghcr.io/mrksrus/selfhost-unihub:latest` | React frontend served by Nginx plus Node.js API on port 4000 inside the container |
| `unihub-mysql` | `mysql:8.0` | MySQL database |

Request flow:

```text
Browser -> Nginx :80 -> Node.js API :4000 -> MySQL
                                  -> IMAP/SMTP providers
                                  -> CalDAV providers during optional import
                                  -> /app/uploads volume
```

The API auto-creates and migrates tables on startup. Uploaded files and generated
exports are stored below `/app/uploads`, which is mounted as the `uploads_data`
Docker volume by default.

## Deployment

The repository includes [docker-compose.yml](docker-compose.yml). For a normal
self-hosted install, copy that file and [.env.example](.env.example) to your
host, fill in the required values, then start the stack:

```bash
docker compose up -d
```

Required `.env` values:

| Variable | Purpose |
| --- | --- |
| `UNIHUB_MYSQL_PASSWORD` | Password for the `unihub` MySQL user |
| `UNIHUB_MYSQL_ROOT_PASSWORD` | MySQL root password |
| `UNIHUB_JWT_SECRET` | Long random JWT signing secret |
| `UNIHUB_ENCRYPTION_KEY` | Long random key used to encrypt stored mail/calendar credentials and 2FA secrets |
| `UNIHUB_BOOTSTRAP_ADMIN_EMAIL` | First admin email, used only when the users table is empty |
| `UNIHUB_BOOTSTRAP_ADMIN_PASSWORD` | First admin password, minimum 12 characters |

Generate random secrets with:

```bash
openssl rand -base64 48
```

For localhost testing, open `http://localhost:3000` after startup and sign in
with the bootstrap admin. For access by hostname, IP address, or public domain,
put HTTPS in front of the app and use that HTTPS origin.

### Important Deployment Settings

The Compose file contains the runtime settings passed to the app container.
Review these before exposing UniHub outside your LAN:

| Setting | Default in compose | Notes |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Example localhost and placeholder domain | Replace with your real browser origin, such as `https://hub.example.com` |
| `TRUST_PROXY_HEADERS` | `true` | Use only behind a trusted reverse proxy that sets `X-Real-IP` / `X-Forwarded-For` |
| `TRUSTED_MAIL_HOSTS` | `mail.example.com` | Optional comma-separated host allowlist for private/local mail or CalDAV hosts |
| `MYSQL_STARTUP_MAX_WAIT_SECONDS` | `120` | How long the container waits for MySQL readiness |
| `CALENDAR_MULTI_ENABLED` | enabled unless set to `false` | Controls calendar account/calendar APIs |

Set up HTTPS at your reverse proxy. The app image serves plain HTTP internally.
When `NODE_ENV=production`, auth and CSRF cookies use the `Secure` flag, so the
browser must reach UniHub over HTTPS for sign-in to work reliably.

## Data and Backups

Persistent data is split across:

| Location | Contents |
| --- | --- |
| MySQL volume | Users, sessions, contacts, events, mail metadata, settings, job metadata |
| `/app/uploads/attachments` | Email attachments and inline images |
| `/app/uploads/mail-raw` | Raw `.eml` snapshots for imported messages |
| `/app/uploads/recordings` | Uploaded/imported audio files |
| `/app/uploads/backups` | Generated ZIP export jobs |

UniHub has manual export/import APIs, but it does not schedule database or volume
backups for you. Back up both Docker volumes.

## Local Development

Install frontend dependencies:

```bash
npm install
npm run dev
```

The Vite dev server listens on port `8080`. The frontend API base defaults to
`/api`; for separate local frontend/backend development, set `VITE_API_URL` to
the API origin and configure `ALLOWED_ORIGINS` on the backend accordingly.

Install backend dependencies separately:

```bash
cd api
npm install
npm start
```

The backend requires MySQL configuration through either `DATABASE_URL` or
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and
`MYSQL_PASSWORD`.

Useful checks:

```bash
npm run lint
npm run test
node --test api/tests/*.test.js
```

## Documentation

| Document | Covers |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Runtime layout, storage, request handling, scheduled jobs |
| [Auth, Admin, Settings](docs/AUTH_ADMIN_SETTINGS.md) | Sessions, CSRF, 2FA, signup modes, admin endpoints, preferences, search |
| [Mail Sync](docs/MAIL_SYNC.md) | IMAP/SMTP behavior, folders, routing rules, TLS/host trust checks |
| [Attachments](docs/ATTACHMENTS.md) | Attachment storage, inline images, downloads, compose limits |
| [Contacts](docs/CONTACTS.md) | Contact schema, vCard import/export, duplicate merge |
| [Calendar](docs/CALENDAR.md) | Calendar/to-do data model, local calendars, CalDAV import, endpoints |
| [Recordings](docs/RECORDINGS.md) | Audio upload protocol, tags, storage, limits |
| [Backup and Export](docs/BACKUP_EXPORT.md) | JSON backup/import and async ZIP export jobs |

## Known Limitations

- No built-in TLS termination; use a reverse proxy for HTTPS.
- Rate limiting is in-memory and resets on container restart.
- The app is designed for a single app container, not horizontal scaling.
- No scheduled backup system is included.
- Email verification is not implemented for user signup.
- Security/audit logging is minimal.
- Mail sync does not propagate provider-side deletes and does not sync drafts.
- CalDAV support is import-oriented and does not push calendar edits back to the provider.

## License

This project is provided as-is with no warranty. Use at your own risk.
