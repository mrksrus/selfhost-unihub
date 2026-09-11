# UniHub - Self-Hosted Productivity Suite

UniHub brings mail, contacts, calendars, to-do items, and recordings together in
one self-hosted, installable web app. It includes account administration,
encrypted backups, Web Push notifications, and optional offline reading.

UniHub's application code is AI-written and is maintained using OpenAI models,
primarily **GPT 6 Astra**. Development includes AI-assisted security reviews,
regression tests, and release checks. UniHub is independently maintained; it is
not affiliated with or endorsed by OpenAI.

## Current Features

| Area | What exists now |
| --- | --- |
| Mail | IMAP sync with per-folder progress, SMTP send, local drafts, attachments, app-owned folders, sender routing rules, unread counts, and bulk read/star/move/delete |
| Appearance | Black dark mode, white text and blue accents by default, with Light/System preferences |
| Offline reading | Opt-in latest 100 full non-draft emails, all contacts and calendar/to-do entries; read-only device snapshots with a 32 MiB limit and explicit clearing |
| Contacts | Search, favorites, import/export vCard 3.0, up to three emails and phone numbers per contact, duplicate preview/merge, bulk delete |
| Calendar and ToDo | Local calendar accounts, multiple calendars, visibility/color settings, attendees, RSVP state, reminders, subtasks, standalone to-dos |
| CalDAV import | Optional CalDAV discovery/import when adding a mail account; imports supported non-recurring events into calendar tables |
| Recordings | Browser recording/import, chunked upload, tags, search/filter, audio streaming/download |
| Games | Nine local browser games, loaded when opened; Block Stack can save personal bests to the server |
| Backups | Encrypted-by-default full/section backups, one-time recovery passwords, portable account credentials, background validation/restore, cancellation, and server-retained restore points |
| Admin | Bootstrap admin, signup mode control, account approval/deactivation, role changes, password resets, user deletion |
| Security baseline | HttpOnly cookie auth, CSRF tokens, 2FA, rate limiting, strict mail TLS by default, SSRF checks for mail/CalDAV hosts, sandboxed email HTML |
| PWA | Installable frontend, Web Push mail/event notifications and reminders, optional offline reading, and updates that refresh each tab only after confirmation |

Release checks cover frontend types, lint and tests; API regression and MySQL
integration tests; and a built-container smoke test for startup, authentication,
storage, and recording downloads/conversion. See [Security](SECURITY.md) for the
security review process and vulnerability reporting.

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
                                  -> Browser push services
                                  -> /app/uploads volume
```

The API auto-creates and migrates tables on startup. Uploaded files, generated
backups, and retained restore uploads are stored below `/app/uploads`, which is mounted as the `uploads_data`
Docker volume by default.

## Deployment

The repository includes [docker-compose.yml](docker-compose.yml),
[.env.example](.env.example), and the mounted
[MySQL configuration](docker/mysql/conf/custom.cnf). Keep those paths together.
Cloning the repository provides the complete deployment layout:

```bash
git clone https://github.com/mrksrus/selfhost-unihub.git
cd selfhost-unihub
cp .env.example .env
```

Fill in `.env` and review the runtime settings below before starting the stack:

```bash
docker compose up -d
```

Deployment `.env` values (all required except the separate backup key):

| Variable | Purpose |
| --- | --- |
| `UNIHUB_MYSQL_PASSWORD` | Password for the `unihub` MySQL user |
| `UNIHUB_MYSQL_ROOT_PASSWORD` | MySQL root password |
| `UNIHUB_JWT_SECRET` | Long random JWT signing secret |
| `UNIHUB_ENCRYPTION_KEY` | Long random key used to encrypt stored mail/calendar credentials, 2FA secrets, and the Web Push private key |
| `UNIHUB_BACKUP_MASTER_KEY` | Optional separate key for automatic server-side backup unlocking; defaults to `UNIHUB_ENCRYPTION_KEY` |
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
| `TRUST_PROXY_HEADERS` | `true` | Read `X-Forwarded-For` only through explicitly trusted proxy addresses |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/32,::1/128` | Bundled proxy only; set `UNIHUB_TRUSTED_PROXY_CIDRS` in Compose `.env` to include your actual HTTPS proxy address/CIDR |
| `TRUSTED_MAIL_HOSTS` | `mail.example.com` | Optional comma-separated host allowlist for private/local mail or CalDAV hosts |
| `MYSQL_STARTUP_MAX_WAIT_SECONDS` | `300` | Wait up to five minutes for MySQL; continue immediately after an authenticated readiness check succeeds |
| `CALENDAR_MULTI_ENABLED` | enabled unless set to `false` | Controls calendar account/calendar APIs |

For an additional HTTPS proxy, see the [trusted-proxy configuration](docs/AUTH_ADMIN_SETTINGS.md#trusted-proxies).
Only include proxy addresses you control, and restrict direct access to the app's
published port when the proxy is meant to be the public entry point. Successful
sign-in never clears another account's attempt budget.

The application image and Compose health checks allow 360 seconds for startup.
Keep that grace period longer than the readiness budget if you increase the wait
setting. Existing deployments with an explicit `120` must set it to `300` in
Compose; pulling a new image cannot override that environment setting.

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
| `/app/uploads/backups` | Generated backups and retained restore uploads |

**Since 0.10.4, in-app backup creation, import and restore are temporarily disabled.**
Existing completed backups can still be downloaded. UniHub does not schedule infrastructure
backups for you. Back up both Docker volumes. Server-retained backups are
convenient restore points, not protection from loss of the server or uploads volume.

Encrypted backups use `.unihub-backup`, are portable to another UniHub server
with their one-time recovery password, and can carry mail/calendar credentials
without depending on the destination server's original encryption key. See the
[Backup and Restore Guide](docs/BACKUP_RESTORE.md) before relying on backups for
recovery.

## Local Development

Use Node.js 24 LTS, the container and CI runtime. Package manifests require Node 24 or newer.

Install frontend dependencies:

```bash
npm ci
npm run dev
```

The Vite dev server listens on port `8080`. The frontend API base defaults to
`/api`; for separate local frontend/backend development, set `VITE_API_URL` to
the complete API base, such as `http://localhost:4000/api`, and configure
`ALLOWED_ORIGINS` for the frontend origin on the backend.

Install backend dependencies separately:

```bash
npm --prefix api ci
npm --prefix api start
```

The backend requires MySQL configuration through either `DATABASE_URL` or
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and
`MYSQL_PASSWORD`. Supply `JWT_SECRET`, `ENCRYPTION_KEY`, and the bootstrap admin
credentials in the backend process environment as well. The Compose `.env`
variable names are mapped by Compose; the standalone API reads its runtime
names directly. Local HTTP development uses non-production cookie settings.

Useful checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm --prefix api test
```

## Documentation

See the [upgrade guide](docs/UPGRADING.md) before replacing an existing deployment,
the [0.10.5 release notes](docs/RELEASE_0.10.5.md) for automatic reconciliation of old folders and Legacy recovery,
the [0.10.4 release notes](docs/RELEASE_0.10.4.md) for account folders and temporary backup suspension,
the [0.10.3 release notes](docs/RELEASE_0.10.3.md) for backup reliability and format
compatibility, the [0.10.2 release notes](docs/RELEASE_0.10.2.md) for security corrections and
recording efficiency, the [0.10.1 release notes](docs/RELEASE_0.10.1.md) for
licensing, and the [0.10.0 release notes](docs/RELEASE_0.10.0.md) for the feature release.

| Document | Covers |
| --- | --- |
| [Offline reading and appearance](docs/OFFLINE.md) | Device snapshots, limits, dark reading, and update prompts |
| [Architecture](docs/ARCHITECTURE.md) | Runtime layout, storage, request handling, scheduled jobs |
| [Auth, Admin, Settings](docs/AUTH_ADMIN_SETTINGS.md) | Sessions, CSRF, 2FA, signup modes, admin endpoints, preferences, search |
| [Mail Sync](docs/MAIL_SYNC.md) | IMAP/SMTP behavior, folders, routing rules, TLS/host trust checks |
| [Attachments](docs/ATTACHMENTS.md) | Attachment storage, inline images, downloads, compose limits |
| [Contacts](docs/CONTACTS.md) | Contact schema, vCard import/export, duplicate merge |
| [Calendar](docs/CALENDAR.md) | Calendar/to-do data model, local calendars, CalDAV import, endpoints |
| [Recordings](docs/RECORDINGS.md) | Audio upload protocol, tags, storage, limits |
| [Backup and Restore Guide](docs/BACKUP_RESTORE.md) | Backup contents, encryption, recovery passwords, merge rules, background jobs, retention, API, and troubleshooting |
| [PWA Guide](docs/PWA.md) | Installation, Web Push, device permissions, delivery limits, and notification persistence |
| [Security](SECURITY.md) | Security review process, deployment boundaries, and vulnerability reporting |
| [Licensing](LICENSING.md) | Noncommercial use, commercial agreements, and version applicability |

## Known Limitations

- No built-in TLS termination; use a reverse proxy for HTTPS.
- Rate limiting is in-memory and resets on container restart.
- The app is designed for a single app container, not horizontal scaling.
- No scheduled backup system is included.
- The current backup payload uses ZIP32 internally; ZIP64 archives are not supported.
- Email verification is not implemented for user signup.
- Security/audit logging is minimal.
- Provider-side deletes and local folder moves are not synchronized in both directions. Local draft edits are not sent back to provider draft folders.
- CalDAV support is import-oriented and does not push calendar edits back to the provider.
- Closed-app notifications depend on browser/OS permission and connectivity; a closed PWA cannot schedule alarms while completely offline.

## License

Starting with **v0.10.1**, UniHub is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE), free for noncommercial use.
Commercial use requires a separate paid written agreement; contact
[smrus@rus.family](mailto:smrus@rus.family).

Previous releases retain their existing terms. See [Licensing](LICENSING.md) for
the version boundary and commercial licensing details.
