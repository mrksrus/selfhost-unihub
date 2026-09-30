# Development

For installation of the published image, use the [installation guide](INSTALLATION.md).

## Runtime layout


UniHub runs as two containers in the included Docker Compose setup:

| Container | Image | Purpose |
| --- | --- | --- |
| `unihub` | `ghcr.io/mrksrus/selfhost-unihub:latest` | React frontend served by Nginx plus Node.js API on port 4000 inside the container |
| `unihub-mysql` | `mysql:8.4` | MySQL database |

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


## Local MySQL and sample data

`scripts/local-mysql.sh` runs an on-demand MySQL 8.4 as your own user from the
official tarball: no system service, no sudo, nothing starts at boot. Install the
minimal glibc tarball once and verify its signature (Oracle's MySQL release key
`B7B3B788A8D3785C`):

```bash
V=8.4.11; T=mysql-$V-linux-glibc2.28-x86_64-minimal.tar.xz
cd ~/Downloads
curl -LO https://cdn.mysql.com/Downloads/MySQL-8.4/$T
curl -LO https://cdn.mysql.com/Downloads/MySQL-8.4/$T.asc
gpg --keyserver hkps://keyserver.ubuntu.com --recv-keys B7B3B788A8D3785C
gpg --verify $T.asc $T   # must report a good signature from MySQL Release Engineering
mkdir -p ~/.local/opt && tar -xJf $T -C ~/.local/opt
ln -sfn ~/.local/opt/${T%.tar.xz} ~/.local/opt/mysql-8.4
```

The script only talks to the server through the API's `mysql2` driver, because
the minimal tarball's `mysql` CLI needs `libncurses.so.6`, which some
distributions (e.g. Arch) do not ship. Data lives in `~/.local/share/unihub-mysql`
and generated local passwords in `.private/local-mysql.env` (ignored by Git).

```bash
npm run db:start     # scripts/local-mysql.sh start (first run initializes the data dir)
npm run db:dev       # start, build and seed the unihub_dev database, print the API command
npm run test:mysql   # MySQL integration suite like CI (stops the server again if it started it)
npm run db:stop      # scripts/local-mysql.sh stop
scripts/local-mysql.sh sql -e 'SHOW DATABASES'
scripts/local-mysql.sh dev --reset   # drop all unihub_dev tables and seed again
scripts/local-mysql.sh migrate-check # upgrade the 0.9.23.0 fixture (or a given dump), compare with a fresh install
scripts/local-mysql.sh schema-dump   # regenerate docker/mysql/init/01-schema.sql
```

The app creates and upgrades its own schema at startup. `ensureLegacySchema` in
`api/src/services/database.js` is a frozen baseline; every schema change is a new
numbered migration in `ensureSchema`. `docker/mysql/init/01-schema.sql` is
generated, never edited: `schema-dump` runs the startup schema code
(`api/scripts/dump-schema.cjs`) on an empty database and writes a sorted
`SHOW CREATE TABLE` dump. Commit the regenerated file with the migration;
`database-schema-file-mysql-integration.test.js` fails in CI when it is stale.
`migrate-check` warns and prints a diff when an upgraded old database ends up
different from a fresh install.

`db:dev` runs `api/scripts/seed-dev.cjs`, which refuses any database not ending
in `_dev`, builds the schema with the app's own startup code and inserts
deterministic synthetic data: contacts, calendars with events and todos, notes,
four mail accounts (two Sync, one Download, one disconnected) with a few hundred
messages, and mail sync operations in queued, retry, needs-attention and
confirmed states. Re-running it without `--reset` changes nothing. The sample
mail servers use unresolvable `.test` hosts, so any sync attempt fails quickly
without leaving the machine; queued sample operations therefore move to a retry
state once the API runs. Sign in with `admin@example.com` or `alex@example.com`,
both with the password `local-dev-admin-password`.
