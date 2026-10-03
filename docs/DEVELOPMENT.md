# Development

For installation of the published image, use the [installation guide](INSTALLATION.md).

## Runtime layout


UniHub runs as two containers in the included Docker Compose setup:

| Container | Image | Purpose |
| --- | --- | --- |
| `unihub` | `ghcr.io/mrksrus/selfhost-unihub:latest` | React frontend served by Nginx plus Node.js API on port 4000 inside the container |
| `unihub-db` | `mariadb:11.8` | MariaDB database (10.11 or later required) |

Request flow:

```text
Browser -> Nginx :80 -> Node.js API :4000 -> MariaDB
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

The backend requires MariaDB configuration through either `DATABASE_URL` or
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


## Local MariaDB and sample data

`scripts/local-db.sh` runs an on-demand MariaDB 11.8 as your own user from the
official tarball: no system service, no sudo, nothing starts at boot. Install
the tarball once, checking the SHA-256 sum published on
[mariadb.org/download](https://mariadb.org/download/):

```bash
V=11.8.9; T=mariadb-$V-linux-systemd-x86_64.tar.gz
cd ~/Downloads
curl -LO https://downloads.mariadb.org/rest-api/mariadb/$V/$T
curl -s https://downloads.mariadb.org/rest-api/mariadb/$V/$T/checksum/   # shows sha256sum
sha256sum $T                                                            # must match it
mkdir -p ~/.local/opt && tar -xzf $T -C ~/.local/opt
ln -sfn ~/.local/opt/${T%.tar.gz} ~/.local/opt/mariadb-11.8
```

The script sends SQL through the API's `mysql2` driver, the same driver the app
uses, because the tarball's `mariadb` command-line client needs system libraries
some distributions do not ship. Data lives in `~/.local/share/unihub-mariadb` and
generated local passwords in `.private/local-db.env` (ignored by Git).

```bash
npm run db:start     # scripts/local-db.sh start (first run initializes the data dir)
npm run db:dev       # start, build and seed the unihub_dev database, print the API command
npm run test:db      # database integration suite like CI (stops the server again if it started it)
npm run db:stop      # scripts/local-db.sh stop
scripts/local-db.sh sql -e 'SHOW DATABASES'
scripts/local-db.sh dev --reset          # drop all unihub_dev tables and seed again
scripts/local-db.sh migrate-check d.sql  # run the startup upgrades on a dump, compare with a fresh install
scripts/local-db.sh schema-dump          # regenerate docker/mariadb/schema.sql
```

The app creates and upgrades its own schema at startup. `ensureLegacySchema` in
`api/src/services/database.js` is a frozen baseline; every schema change is a new
numbered migration in `ensureSchema`. `docker/mariadb/schema.sql` is
generated, never edited: `schema-dump` runs the startup schema code
(`api/scripts/dump-schema.cjs`) on an empty database and writes a sorted
`SHOW CREATE TABLE` dump. Commit the regenerated file with the migration;
`database-schema-file-mysql-integration.test.js` fails in CI when it is stale.
`migrate-check` warns and prints a diff when an upgraded old database ends up
different from a fresh install.

`db:dev` runs `api/scripts/seed-dev.cjs`, which refuses any database not ending
in `_dev`, builds the schema with the app's own startup code and inserts
deterministic synthetic data: contacts, calendars with events and todos,
four mail accounts (two Sync, one Download, one disconnected) with a few hundred
messages, and mail sync operations in queued, retry, needs-attention and
confirmed states. Re-running it without `--reset` changes nothing. The sample
mail servers use unresolvable `.test` hosts, so any sync attempt fails quickly
without leaving the machine; queued sample operations therefore move to a retry
state once the API runs. Sign in with `admin@example.com` or `alex@example.com`,
both with the password `local-dev-admin-password`.
