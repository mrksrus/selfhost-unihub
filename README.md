# UniHub - Self-Hosted Productivity Suite

> **Disclaimer:** This project was entirely AI-generated and built by someone with zero coding experience. It is a learning/hobby project and **must not be used in production without thorough security review and testing**. There will be bugs, incomplete features, and rough edges throughout the codebase. Use at your own risk.

## What is UniHub?

UniHub is a self-hosted, all-in-one productivity hub that combines contacts management, calendar scheduling, to-do lists, and email account management into a single web application. Deploy it on your own infrastructure via a Docker Compose YAML file -- paste the YAML, set your passwords, and it runs.

You sign in inside the web app, import contacts, set calendar events, manage to-do items, and sign into your mail accounts. Everything is stored on your server. Then on your phone or PC you sign in with your UniHub account and have access to all of it. The app can be installed as a PWA for a native-like experience.

Since one UniHub account potentially accesses multiple email accounts, **set a strong password**.

## Architecture

UniHub runs as **two containers**:

| Container | Image | Purpose |
|-----------|-------|---------|
| `unihub` | `ghcr.io/mrksrus/selfhost-unihub:latest` | Frontend (Nginx) + Backend API (Node.js) |
| `unihub-mysql` | `mysql:8.0` | Database |

The application container bundles the React frontend (served by Nginx) and the Node.js API into a single image. Nginx reverse-proxies `/api/*` requests to the Node.js backend running inside the same container. The database schema is created automatically on first startup.

### Request flow

```
Browser --> Nginx (port 80) --> Node.js API (port 4000) --> MySQL
                                      |
                                      +--> IMAP/SMTP (external mail servers)
```

### Authentication

- Sessions are managed via **HttpOnly, SameSite=Strict** cookies (not localStorage).
- A JWT is signed with `JWT_SECRET` and stored in a server-set cookie alongside a CSRF token cookie.
- Every state-changing request (POST/PUT/DELETE) must include the `X-CSRF-Token` header matching the CSRF cookie.
- Session validity is verified against the database on every request, including an active-user check -- deactivated users are immediately locked out.
- Sessions expire after 21 days; expired sessions are cleaned up automatically every hour.

### Email HTML rendering

Untrusted email HTML is rendered inside a **sandboxed iframe** (`sandbox=""`) with no script execution privileges. This isolates email content from the app origin. Plain-text fallback is used when HTML is not available.

### Mail transport security

- All IMAP and SMTP connections use **strict TLS certificate verification** by default (`rejectUnauthorized: true`).
- When adding a mail account with an unknown/custom host, a **preflight check** runs that classifies the host (known provider vs unknown) and resolves DNS to detect private/local addresses.
- Unknown hosts trigger a confirmation dialog showing certificate details (subject, issuer, fingerprint) so you can verify before trusting.
- Private/local IP hosts are blocked unless explicitly allowlisted via `TRUSTED_MAIL_HOSTS`.

## Features

- **Contacts** -- create, edit, search, favorite, bulk delete, vCard import/export
- **Calendar** -- multi-account/multi-calendar support, day/week/month views, per-calendar visibility + color + auto-ToDo settings
- **To-Do** -- task management with subtasks, reordering, status tracking
- **Mail** -- full IMAP/SMTP email with sync, compose, reply, forward, attachments, bulk operations
- **Admin Panel** -- user management, signup mode control (open/approval/disabled), password resets
- **PWA Support** -- installable as a native-like app on mobile and desktop
- **Security** -- HttpOnly cookie auth, CSRF protection, rate limiting, strict TLS for mail, sandboxed email rendering

## Deployment (TrueNAS Scale / Portainer / any Docker host)

Deploy by pasting a YAML file into your container platform. No cloning or building required.

### Step 1 -- Copy the YAML

```yaml
networks:
  unihub-network:
    driver: bridge

services:
  unihub:
    image: ghcr.io/mrksrus/selfhost-unihub:latest
    pull_policy: always
    container_name: unihub
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    ports:
      - "3000:80"
    environment:
      NODE_ENV: production
      MYSQL_DATABASE: unihub
      MYSQL_USER: unihub
      MYSQL_PASSWORD: CHANGE_ME_db_password
      MYSQL_HOST: unihub-mysql
      MYSQL_PORT: "3306"
      MYSQL_STARTUP_MAX_WAIT_SECONDS: "120"
      MYSQL_STARTUP_CHECK_INTERVAL_SECONDS: "5"
      UNIHUB_API_START_DELAY_SECONDS: "2"
      JWT_SECRET: ""                                  # REQUIRED -- openssl rand -base64 48
      ENCRYPTION_KEY: CHANGE_ME_encryption_key        # REQUIRED
      BOOTSTRAP_ADMIN_EMAIL: admin@example.com        # REQUIRED on first start
      BOOTSTRAP_ADMIN_PASSWORD: CHANGE_ME_admin_pw    # REQUIRED on first start (min 12 chars)
      ALLOWED_ORIGINS: http://localhost:3000           # Your frontend origin
      TRUST_PROXY_HEADERS: "true"                     # Set true when behind reverse proxy
      TRUSTED_MAIL_HOSTS: ""                          # Optional: mail.example.com
    depends_on:
      - unihub-mysql
    networks:
      - unihub-network
    volumes:
      - uploads_data:/app/uploads

  unihub-mysql:
    image: mysql:8.0
    container_name: unihub-mysql
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    environment:
      MYSQL_DATABASE: unihub
      MYSQL_USER: unihub
      MYSQL_PASSWORD: CHANGE_ME_db_password
      MYSQL_ROOT_PASSWORD: CHANGE_ME_root_password
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
      - --max-connections=100
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "MYSQL_PWD=$$MYSQL_ROOT_PASSWORD mysqladmin ping -h localhost -u root"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 120s
    networks:
      - unihub-network

volumes:
  mysql_data:
    driver: local
  uploads_data:
    driver: local
```

### Step 2 -- Set your passwords

Replace every `CHANGE_ME_*` value and fill in required secrets:

| Value | What to put there |
|-------|-------------------|
| `MYSQL_PASSWORD` | A strong password (must match in both services) |
| `MYSQL_ROOT_PASSWORD` | A different strong password for the MySQL root user |
| `JWT_SECRET` | A long random string -- generate with `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | Another random string -- used to encrypt stored mail credentials |
| `BOOTSTRAP_ADMIN_EMAIL` | Email for the first admin account (used only when DB has no users) |
| `BOOTSTRAP_ADMIN_PASSWORD` | Bootstrap admin password (minimum 12 characters) |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed for API calls (e.g. `https://hub.example.com`) |
| `TRUST_PROXY_HEADERS` | Set to `true` when running behind a reverse proxy (Nginx, Caddy, Traefik) |
| `TRUSTED_MAIL_HOSTS` | Optional comma-separated custom mail host domains/IPs to trust (e.g. `mail.example.com`) |

**Note on auto-updates:** `pull_policy: always` pulls the latest image on every container start. Restart to update; data persists in volumes.

### Step 3 -- Start it

On first launch:

1. MySQL creates the `unihub` database and user automatically
2. The API waits for MySQL readiness (up to `MYSQL_STARTUP_MAX_WAIT_SECONDS`, default 120 seconds)
3. The API creates all database tables automatically
4. If no users exist, the API creates the first admin from `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`

The server will **refuse to start** if `JWT_SECRET`, `ENCRYPTION_KEY`, or the bootstrap admin env vars (when no users exist) are missing.

### Step 4 -- Log in

Open `http://<your-host>:3000` and sign in with your bootstrap admin credentials.

### Verifying environment variables

The values under `environment:` in `docker-compose.yml` are passed into each container. To confirm they are set (e.g. if you see "Access denied" or missing config):

- **Unihub** (DB-related and startup vars; omit `-e` to print all env):
  ```bash
  docker compose run --rm unihub env | grep -E '^MYSQL_|^UNIHUB_'
  ```
- **MySQL** (vars used to create database and user):
  ```bash
  docker compose run --rm unihub-mysql env | grep -E '^MYSQL_'
  ```

Ensure `MYSQL_PASSWORD` is identical in both services; the MySQL container creates the user with that password, and the unihub container must use the same one to connect.

## Environment Variables Reference

### Required (server exits if missing)

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Signs JWT auth tokens |
| `ENCRYPTION_KEY` | AES-256-GCM key for stored mail passwords |
| `BOOTSTRAP_ADMIN_EMAIL` | First admin email (only used when users table is empty) |
| `BOOTSTRAP_ADMIN_PASSWORD` | First admin password (min 12 characters, only used when users table is empty) |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` | Database connection |

### Optional

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | API listen port inside the container |
| `NODE_ENV` | -- | Set to `production` to enable Secure cookie flag |
| `ALLOWED_ORIGINS` | same-host | Comma-separated CORS origin allowlist |
| `TRUST_PROXY_HEADERS` | `false` | Trust `X-Real-IP` / `X-Forwarded-For` for rate limiting |
| `TRUSTED_MAIL_HOSTS` | -- | Comma-separated custom mail hosts to trust without confirmation |
| `CALENDAR_MULTI_ENABLED` | `true` | Enable multi-account and multi-calendar features |
| `CALENDAR_SYNC_ENABLED` | `true` | Enable external calendar sync/account APIs |
| `CALENDAR_SYNC_PROVIDER_GOOGLE_ENABLED` | `true` | Enable Google calendar sync provider |
| `CALENDAR_SYNC_PROVIDER_MICROSOFT_ENABLED` | `true` | Enable Microsoft calendar sync provider |
| `CALENDAR_SYNC_PROVIDER_ICLOUD_ENABLED` | `true` | Enable iCloud/CalDAV calendar sync provider |
| `GOOGLE_CALENDAR_CLIENT_ID` | -- | Google OAuth client ID for calendar connect flow |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | -- | Google OAuth client secret |
| `MICROSOFT_CALENDAR_CLIENT_ID` | -- | Microsoft OAuth app client ID |
| `MICROSOFT_CALENDAR_CLIENT_SECRET` | -- | Microsoft OAuth app client secret |
| `CALENDAR_OAUTH_REDIRECT_BASE_URL` | first allowed origin | Public base URL used for OAuth callback redirect URI construction |
| `MYSQL_STARTUP_MAX_WAIT_SECONDS` | `120` | Max seconds `start.sh` waits for MySQL before continuing |
| `MYSQL_STARTUP_CHECK_INTERVAL_SECONDS` | `5` | Seconds between MySQL readiness checks in `start.sh` |
| `UNIHUB_API_START_DELAY_SECONDS` | `2` | Delay after API start before Nginx startup check |

## Mail Sync Details

- **Supported providers**: Gmail, Apple/iCloud, Yahoo, Outlook, and any standard IMAP/SMTP provider (including self-hosted)
- **Sync behavior**: automatic every 10 minutes; manual sync via UI; fetches last 500 emails per account
- **Compose**: new messages, reply, forward with attachment support (up to 20 attachments, 25 MB total)
- **Security**: mail passwords encrypted with AES-256-GCM; strict TLS verification; unknown-host preflight with certificate inspection; SSRF protection (private IP blocking)
- **Limitations**: syncs last 500 emails only; one-by-one fetching may be slow for large mailboxes; INBOX only (no sent folder sync yet)

## Calendar Sync Details

- **Providers**: Local, Google Calendar, Microsoft 365, iCloud/CalDAV
- **Capabilities**:
  - Multiple calendars per account with per-calendar visibility and auto-ToDo toggle
  - Manual and periodic provider sync
  - Local event create/update/delete propagation to provider for mapped external events
  - RSVP API endpoint for attendee status updates
- **OAuth connect UI**: Google and Microsoft can be connected from Calendar settings via popup OAuth flow (`/api/calendar/oauth/:provider/start` + callback)
- **iCloud note**: invitation behavior is limited by CalDAV/provider constraints

## Known Limitations

- **No HTTPS by default** -- place a TLS-terminating reverse proxy in front for production
- **In-memory rate limiting** -- state lost on container restart
- **Single-server only** -- no clustering or horizontal scaling
- **No automated backups** -- back up your MySQL data volume manually
- **No email verification** -- user email addresses are not verified on signup
- **No audit logging** -- user actions are not logged for security auditing
- **INBOX-only sync** -- sent/archive/draft folder sync not yet implemented

## Tech Stack

**Frontend:** React 18, TypeScript, Vite 7, Tailwind CSS, shadcn/ui, TanStack React Query, Framer Motion, PWA

**Backend:** Node.js (vanilla HTTP server), MySQL 8.0

**Infrastructure:** Docker, Docker Compose, Nginx

## Building from Source

```bash
git clone https://github.com/mrksrus/selfhost-unihub.git
cd selfhost-unihub
docker compose up -d --build
```

For local frontend development:

```bash
npm install
npm run dev
```

The Vite dev server proxies API requests to `localhost:4000`.

## Project Structure

```
api/
  server.js               Backend API server (Node.js)
  calendar-route-utils.js Route parsing helpers
  package.json            Backend dependencies
  tests/                  Backend tests (node:test)
src/                      Frontend React application
  components/mail/        SafeEmailContent (sandboxed iframe renderer)
  contexts/               AuthContext (cookie-based session)
  lib/api.ts              API client (cookie credentials, CSRF)
  pages/                  Page components
  test/                   Frontend tests (vitest)
docker/
  nginx/                  Nginx configuration
  mysql/                  Reference SQL schema
  start.sh                Container startup script
docs/
  MAIL_SYNC.md            Email sync technical details
  ATTACHMENTS.md          Attachment handling documentation
  CONTACTS.md             Contacts and vCard import/export
  CALENDAR.md             Calendar events and date handling
docker-compose.yml        Paste-and-deploy YAML
Dockerfile                Combined image (Nginx + Node.js API)
package.json              Frontend dependencies
```

## Technical Documentation

- **[Mail Sync](docs/MAIL_SYNC.md)** -- IMAP sync process, TLS verification, host trust preflight, encryption
- **[Attachments](docs/ATTACHMENTS.md)** -- Attachment storage, inline images, sandboxed rendering, download security
- **[Contacts](docs/CONTACTS.md)** -- Contact management, vCard import/export, API endpoints
- **[Calendar](docs/CALENDAR.md)** -- Calendar events, to-do/subtask system, date handling, API endpoints

## License

This project is provided as-is with no warranty. Use at your own risk.
