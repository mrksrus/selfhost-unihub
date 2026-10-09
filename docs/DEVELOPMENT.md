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
                                  -> CalDAV servers and ICS feeds (calendar sync)
                                  -> Browser push services
                                  -> /app/uploads volume
```

The API auto-creates and migrates tables on startup. Uploaded files, generated
backups, and retained restore uploads are stored below `/app/uploads`, which is mounted as the `uploads_data`
Docker volume by default.

## Local development

Use Node.js 26, the container and CI runtime. Package manifests require Node 26 or newer.

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

The API source is TypeScript. `npm --prefix api start` compiles first, then starts
`api/dist/server.js`. `npm --prefix api run build` creates the CommonJS runtime
and `npm --prefix api run typecheck` checks source without emitting code.

The notification service worker and audio worklet are authored in `workers/`.
`npm run build:workers` emits classic scripts into ignored `.worker-dist/`.
Vite serves those files during development and includes them in production
under the existing `/sw-custom.js` and `/audio-recorder-worklet.js` URLs.
Rebuild workers after editing their source during a running development session.

API tests import `api/dist/` and worker tests read `.worker-dist/`, so run
`npm --prefix api run build` before a direct `node --test` invocation. Npm API
test commands and `scripts/local-db.sh` build automatically. API-only Docker
build stages compile the API; the frontend stage compiles browser workers.

API modules use ES module syntax and compile to CommonJS. A few conventions
keep the compiled modules testable:

- Tests replace functions with `t.mock.method(module, name)`. A call through a
  named import (`import { fn } from './x'`) looks `fn` up on the module at
  call time, so such a mock reaches it. A facade such as `services/mail.ts`
  exports plain values (`export const fn = impl.fn`), not re-exports, because
  `export { fn } from` compiles to a read-only getter that cannot be mocked.
- A module that must load on first use, to break an import cycle or because
  tests swap it in `require.cache`, is required in place and typed:
  `(require('./x') as typeof import('./x')).fn()`. Keep these where they are.
- Route modules export one table of `'METHOD /path'` handlers with
  `export =`; `routes/index.ts` spreads them.

The maintenance scripts in `api/scripts/` (build, recovery gate, schema dump,
dev seed, local SQL) are `.cts` files that Node runs directly by stripping
their types, so they are not compiled. They use only erasable TypeScript: load
modules with `require('x') as typeof import('x')`, and API code from
`../dist/src/` typed against `../src/`. `npm --prefix api run typecheck` also
checks them through `api/tsconfig.scripts.json`.

API tests, test helpers and historical fixture generators also use `.cts` and
run directly on Node.js 26. `api/tsconfig.tests.json` checks them in strict mode.
The shared `FixtureValue` type is restricted to tests: malformed inputs,
partial database rows and provider doubles intentionally have open shapes.
Production API types remain separate. Fixture generators are explicit
maintenance tools; ordinary tests never regenerate the frozen backup archives.

The root tools in `scripts/` and ESLint/PostCSS configuration use `.mts`.
`npm run typecheck` checks frontend code, browser workers, root configuration,
root tools, API source, API scripts and API tests. Install dependencies for both
packages first; the root mail smoke tool resolves its provider types from the
API's dependencies. `npm run typecheck:frontend` remains usable in the separate
frontend Docker build stage. The lint command uses Node's native TypeScript
configuration loader and requires Node.js 26.

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

The app creates and upgrades its own schema at startup. A new database starts
from the frozen 0.16.0 baseline in `api/src/services/database-baseline.ts`;
every schema change is a new numbered migration in `ensureSchema`
(`api/src/services/database.ts`). `docker/mariadb/schema.sql` is
generated, never edited: `schema-dump` runs the startup schema code
(`api/scripts/dump-schema.cts`) on an empty database and writes a sorted
`SHOW CREATE TABLE` dump. Commit the regenerated file with the migration;
`database-schema-file-mysql-integration.test.cts` fails in CI when it is stale.
`migrate-check` warns and prints a diff when an upgraded old database ends up
different from a fresh install.

`db:dev` runs `api/scripts/seed-dev.cts`, which refuses any database not ending
in `_dev`, builds the schema with the app's own startup code and inserts
deterministic synthetic data: contacts, calendars with events and todos,
four mail accounts (two Sync, one Download, one disconnected) with a few hundred
messages, and mail sync operations in queued, retry, needs-attention and
confirmed states. Re-running it without `--reset` changes nothing. The sample
mail servers use unresolvable `.test` hosts, so any sync attempt fails quickly
without leaving the machine; queued sample operations therefore move to a retry
state once the API runs. Sign in with `admin@example.com` or `alex@example.com`,
both with the password `local-dev-admin-password`.
