# Development

For installation of the published image, use the [installation guide](INSTALLATION.md).

## Runtime layout


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

## Local development

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

