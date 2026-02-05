# UniHub - Self-Hosted Productivity Suite

> **Disclaimer:** This project was entirely AI-generated and built by someone with zero coding experience. It is a learning/hobby project and **must not be used in production without thorough security review and testing**. There will be bugs, security vulnerabilities, incomplete features, and rough edges throughout the codebase. Use at your own risk.

## What is UniHub?

UniHub is a self-hosted, all-in-one productivity hub that combines contacts management, calendar scheduling, and email account management into a single web application. It is designed to be deployed on your own infrastructure via a Docker Compose YAML file — paste the YAML, set your passwords, and it runs.

Basically: You sign in inside the webpage, import contacts, set calendar events and sign into your mail accounts. Those get stored on the server. 
Then on your phone or PC you sign in with your UniHub Account and have access to all of those. 
Intention then is it be able to install the app as a PWA and implement more features like local Notifications, etc. 
So indead of having to setup your phone or PC very time for your Accounts, you can just set them up once, and access via one login. 
Security vulnerabilty given one Account accesses potentially multiple ones... should be clear. Set a fricking good password!

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

Copy the contents of [`docker-compose.yml`](docker-compose.yml) (or the version below with `build:` removed) into your platform's custom app / stack editor:

```yaml
x-db-credentials: &db_credentials
  MYSQL_DATABASE: unihub
  MYSQL_USER: unihub
  MYSQL_PASSWORD: CHANGE_ME_db_password            # ← set a strong password

services:
  unihub:
    image: ghcr.io/mrksrus/unify-self-host:latest
    container_name: unihub
    restart: unless-stopped
    ports:
      - "3000:80"
    environment:
      NODE_ENV: production
      <<: *db_credentials
      MYSQL_HOST: unihub-mysql
      MYSQL_PORT: "3306"
      JWT_SECRET: ""                               # ← REQUIRED – generate with: openssl rand -base64 48
      ENCRYPTION_KEY: CHANGE_ME_encryption_key     # ← set a random string
    depends_on:
      unihub-mysql:
        condition: service_healthy
    networks:
      - unihub-network
    volumes:
      - uploads_data:/app/uploads

  unihub-mysql:
    image: mysql:8.0
    container_name: unihub-mysql
    restart: unless-stopped
    environment:
      <<: *db_credentials
      MYSQL_ROOT_PASSWORD: CHANGE_ME_root_password # ← set a strong password
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
      - --max-connections=100
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p$${MYSQL_ROOT_PASSWORD}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - unihub-network

networks:
  unihub-network:
    driver: bridge

volumes:
  mysql_data:
    driver: local
  uploads_data:
    driver: local
```

### Step 2 — Set your passwords

Replace every `CHANGE_ME_*` value and fill in `JWT_SECRET`:

| Value | What to put there |
|-------|-------------------|
| `MYSQL_PASSWORD` | A strong password (set once, shared by both containers via the YAML anchor) |
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
- **Mail** — email account management (IMAP/SMTP sync is not yet implemented)
- **Admin Panel** — user management for administrators
- **PWA Support** — installable as a native-like app on mobile and desktop
- **Authentication** — JWT-based auth with session management and rate limiting

## Known Limitations & Security Warnings

> **This is an AI-generated project. Read the following carefully before deploying.**

- **No HTTPS by default** — Nginx serves over plain HTTP; place a TLS-terminating reverse proxy (Caddy, Traefik, etc.) in front for production use
- **Mail sync is not functional** — email accounts can be added but IMAP/SMTP sync is not implemented yet
- **Basic input validation** — common cases are handled but edge cases may slip through
- **No CSRF protection** — the API relies solely on JWT Bearer tokens
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
├── docker-compose.yml     # Docker Compose YAML (paste-and-deploy ready)
├── Dockerfile             # Combined image (Nginx + Node.js API)
└── package.json           # Frontend dependencies
```
cally
## License

This project is provided as-is with no warranty. Use at your own risk.
