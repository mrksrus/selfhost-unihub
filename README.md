# UniHub - Self-Hosted Productivity Suite

> **Disclaimer:** This project was entirely AI-generated and built by someone with zero coding experience. It is a learning/hobby project and **must not be used in production without thorough security review and testing**. There will be bugs, security vulnerabilities, incomplete features, and rough edges throughout the codebase. Use at your own risk.

## What is UniHub?

UniHub is a self-hosted, all-in-one productivity hub that combines contacts management, calendar scheduling, and email account management into a single web application. It is designed to be deployed on your own infrastructure via a Docker Compose YAML file — paste the YAML, set your passwords, and it runs.

Basically: You sign in inside the webpage, import contacts, set calendar events and sign into your mail accounts. Those get stored on the server. 
Then on your phone or PC you sign in with your UniHub Account and have access to all of those. 
Intention then is it be able to install the app as a PWA and implement more features like local Notifications, etc. 
So indead of having to setup your phone or PC very time for your Accounts, you can just set them up once, and access via one login. 
Security vulnerabilty given one Account accesses potentially multiple ones... should be clear. Set a fricking good password!

## Mail Sync Details

UniHub supports email account management with full IMAP/SMTP sync functionality:

- **Supported Providers**: Gmail, Apple/iCloud, Yahoo, and any standard IMAP/SMTP provider
- **Sync Behavior**: 
  - Automatically syncs every 10 minutes in the background
  - Manual sync available via UI button
  - Fetches last 500 emails per account (most recent first)
  - One-by-one email fetching for reliability and real-time progress
- **Email Features**:
  - Read emails with HTML/plain text rendering
  - Reply and forward functionality
  - Mark as read/unread
  - Star/unstar emails
  - Responsive compose UI (popup on mobile, inline on desktop)
- **Security**: 
  - Email passwords encrypted with AES-256-GCM
  - CSRF protection implemented
  - Requires App Passwords for Gmail/Yahoo/iCloud (2FA accounts)
- **Limitations**:
  - Syncs last 500 emails only (older emails not automatically synced)
  - One-by-one fetching may be slow for accounts with many emails
  - Exchange/Office365 may work but EWS or Microsoft Graph API preferred

## Architecture

UniHub runs as **two containers**:

| Container | Image | Purpose |
|-----------|-------|---------|
| `unihub` | `ghcr.io/mrksrus/unify-self-host:latest` | Frontend (Nginx) + Backend API (Node.js) |
| `unihub-mysql` | `mysql:8.0` | Database |

The application container bundles the React frontend (served by Nginx) and the Node.js API into a single image. Nginx reverse-proxies `/api/*` requests to the API running inside the same container. The database schema and default admin user are created automatically on first startup — no init scripts or file mounts are needed.

## Deployment (TrueNAS Scale / Portainer / any Docker host)

This project is intended to be deployed by pasting a YAML file into your container platform. No cloning, no building, no extra files required.

### Step 1 — Copy the YAML

TrueNAS (and some UIs) do not support YAML anchors or `build:`. Use the fully expanded YAML below (no anchors), which is known to work with TrueNAS:

```yaml
networks:
  unihub-network:
    driver: bridge

services:
  unihub:
    image: ghcr.io/mrksrus/unify-self-host:latest
    pull_policy: always  # Always pull latest image on container start (for auto-updates)
    container_name: unihub
    restart: unless-stopped
    ports:
      - "3000:80"
    environment:
      NODE_ENV: production
      MYSQL_DATABASE: unihub
      MYSQL_USER: unihub
      MYSQL_PASSWORD: CHANGE_ME_db_password
      MYSQL_HOST: unihub-mysql
      MYSQL_PORT: "3306"
      JWT_SECRET: ""                               # ← REQUIRED – generate with: openssl rand -base64 48
      ENCRYPTION_KEY: CHANGE_ME_encryption_key
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

### Step 2 — Set your passwords

Replace every `CHANGE_ME_*` value and fill in `JWT_SECRET`:

**Note on Auto-Updates:** The `pull_policy: always` setting ensures the latest image is pulled every time the container starts. This means you can simply restart the app in TrueNAS Scale to get updates without deleting/recreating the app. Your data (database, settings, mail accounts) persists in volumes, so you won't lose anything on restart.

| Value | What to put there |
|-------|-------------------|
| `MYSQL_PASSWORD` | A strong password (must match in both services) |
| `MYSQL_ROOT_PASSWORD` | A different strong password for the MySQL root user |
| `JWT_SECRET` | A long random string — generate with `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | Another random string — used to encrypt stored mail credentials |

### Step 3 — Start it

Deploy / start the stack. On first launch:

1. MySQL creates the `unihub` database and user automatically
2. The API waits for MySQL to be ready (retries up to 45 seconds)
3. The API creates all database tables automatically
4. A default admin user is seeded: `admin@unihub.local` / `admin123`

### Step 4 — Log in

Open `http://<your-host>:3000` and sign in with the default admin credentials. **Change the admin password immediately** under Settings -> Security -> Change Password.

## Tech Stack

**Frontend:** React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, TanStack React Query, Framer Motion, PWA

**Backend:** Node.js (vanilla HTTP server), MySQL 8.0

**Infrastructure:** Docker + Docker Compose, Nginx

## Features

- **Contacts** — create, edit, search, and favorite contacts
- **Calendar** — schedule events with color coding and location support
- **Mail** — full email account management with IMAP/SMTP sync, email reading, reply/forward functionality
- **Admin Panel** — user management for administrators
- **PWA Support** — installable as a native-like app on mobile and desktop
- **Authentication** — JWT-based auth with session management, CSRF protection, and rate limiting

## Known Limitations & Security Warnings

> **This is an AI-generated project. Read the following carefully before deploying.**

- **No HTTPS by default** — Nginx serves over plain HTTP; place a TLS-terminating reverse proxy (Caddy, Traefik, etc.) in front for production use
- **Mail sync limitations** — syncs last 500 emails per account; one-by-one fetching may be slow for large mailboxes; automatic sync runs every 10 minutes
- **Basic input validation** — common cases are handled but edge cases may slip through
- **No email verification** — user email addresses are not verified on signup
- **In-memory rate limiting** — rate-limit state is lost when the container restarts
- **Single-server only** — no clustering or horizontal scaling support
- **No automated backups** — you must back up your MySQL data volume manually
- **Limited error handling** — some error scenarios may return generic 500 errors
- **No audit logging** — user actions are not logged for security auditing
- **Default admin password** — ships with a well-known default; change it immediately

## Building from Source (Development)

If you want to build the image yourself instead of pulling from GHCR:

```bash
git clone https://github.com/mrksrus/unify-self-host.git
cd unify-self-host

# Build and start (the docker-compose.yml includes a build: directive for this)
docker compose up -d --build
```

To work on the frontend locally:

```bash
npm install
npm run dev
```

The Vite dev server proxies API requests to `localhost:4000`.

## Project Structure

```
├── api/
│   ├── server.js          # Backend API server (Node.js)
│   └── package.json       # Backend dependencies
├── src/                   # Frontend React application
├── docker/
│   ├── nginx/             # Nginx configuration
│   ├── mysql/             # Reference SQL schema (not required at runtime)
│   └── start.sh           # Container startup script
├── docs/                   # Technical documentation
│   ├── MAIL_SYNC.md       # Email sync implementation details
│   ├── ATTACHMENTS.md     # Attachment handling documentation
│   ├── CONTACTS.md        # Contacts and vCard import/export
│   └── CALENDAR.md        # Calendar events and date handling
├── docker-compose.yml     # Docker Compose YAML (paste-and-deploy ready)
├── Dockerfile             # Combined image (Nginx + Node.js API)
└── package.json           # Frontend dependencies
```

## Technical Documentation

For detailed explanations of how different features work, see the documentation in the `docs/` folder:

- **[Mail Sync](docs/MAIL_SYNC.md)** - How email synchronization works, IMAP protocol usage, one-by-one fetching strategy, and sync process details
- **[Attachments](docs/ATTACHMENTS.md)** - Email attachment handling, inline images, storage architecture, and download endpoints
- **[Contacts](docs/CONTACTS.md)** - Contact management, vCard import/export, parsing logic, and compatibility notes
- **[Calendar](docs/CALENDAR.md)** - Calendar events, date/time handling, UTC storage, and event management

These documents are learning resources explaining the implementation details, design decisions, and how the system works internally.

## License

This project is provided as-is with no warranty. Use at your own risk.
