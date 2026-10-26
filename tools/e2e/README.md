# Agent end-to-end checks

A disposable UniHub installation that agents drive in a browser with
[e2e](https://github.com/tester-army/e2e) (Apache-2.0), so a flow can be
checked through the real request handler, database, mail transport and the
image's nginx configuration before the maintainer tests it on a phone. It is
development tooling, never shipped, and holds only synthetic data.

## What runs

`./stack.sh up` starts, all on 127.0.0.1:

| Part | Port | Notes |
| --- | --- | --- |
| nginx with `docker/nginx/*.conf` | 8088 | Alpine's `mime.types`, so headers match the image |
| API (`api/dist/server.js`) | 4100 | development cookies (plain HTTP), `TRUSTED_MAIL_HOSTS=127.0.0.1` |
| MariaDB (`scripts/local-db.sh`) | 3311 | database `unihub_dev` with the dev seed |
| GreenMail | IMAPS 993, SMTPS 465, REST 8085 | synthetic IMAP/SMTP provider with a self-signed certificate |

Sign in as `admin@example.com` or `alex@example.com` with
`local-dev-admin-password`. GreenMail has the mailboxes
`admin@example.com`, `alex@example.com` and `sam@example.org` with the
password `e2e-mail-password`; add them in UniHub as mail accounts with host
`127.0.0.1` and confirm the certificate fingerprint. The dev seed already has
mail accounts named like the first two (pointing at an unreachable host), so
`sam@example.org` is the simplest one to add. GreenMail's REST API
(`http://127.0.0.1:8085/api/user`, `/api/mail/purge`) shows what was
delivered.

State, logs and uploads live in `~/.local/state/unihub-e2e`
(`UNIHUB_E2E_STATE`). `UNIHUB_E2E_INSTANCE=2` (up to 9) runs a second stack
beside the first, for example one per agent: its ports shift by one, its mail
server binds 127.0.0.2 (use that as the mail host), and its state goes to
`~/.local/state/unihub-e2e-2`. `stack.sh status` prints the values of the
selected instance, and the e2e config follows the same variable. Each
instance uses about 1.5 GB of memory while it runs, plus a browser during a
test.

## Start and stop

```bash
export UNIHUB_E2E_NGINX=/path/to/nginx                 # any nginx 1.22 or later
export UNIHUB_E2E_MIME_TYPES=/path/to/alpine/mime.types # etc/nginx/mime.types from Alpine's nginx package
export UNIHUB_E2E_GREENMAIL_JAR=/path/to/greenmail-standalone.jar  # com.icegreen:greenmail-standalone from Maven Central
tools/e2e/stack.sh up            # builds the frontend once; --rebuild after frontend changes
tools/e2e/stack.sh status
tools/e2e/stack.sh down          # stops everything; do this when finished to free memory
tools/e2e/stack.sh reset         # also deletes the database, mail and uploads
tools/e2e/stack.sh restart-api   # restart only the API, for restart checks
```

Java 17 or later runs GreenMail. Ports 465 and 993 need
`net.ipv4.ip_unprivileged_port_start` at or below 465, or root.

## Run and write tests

```bash
cd tools/e2e
npm ci
export E2E_TELEMETRY_DISABLED=1
export PLAYWRIGHT_BROWSERS_PATH=$PWD/../ui-regression/.browsers   # after npm run browsers there
npx e2e run                              # every test on every target
npx e2e run tests/mail.e2e.ts --target phone
npx e2e guide                            # the framework's own instructions for agents
```

Targets: `desktop` (1440×900), `phone` (412×915, Android Chrome user agent)
and `android-app` (412×915 with the Android shell's user agent, which puts
the page in app mode). `tests/auth.setup.e2e.ts` signs in once per user;
start a test with `{ session: 'admin' }` or `{ session: 'alex' }`.

Tests here use locators and `expect`, so they need no model. `agent.act`
steps need a model in `e2e.config.ts` (see the framework's `models` docs);
none is configured. `npx e2e mcp` gives a coding agent a live browser
session on the same targets.

## What it cannot prove

- The Android shell itself: keyboard insets, the native bridge, notifications,
  file pickers, downloads and installs. The `android-app` target is Chromium
  with the shell's user agent, not a WebView. For those, use a real phone, the
  CI emulator jobs, or `@e2e-dev/mobile` with an emulator or a phone over adb.
- Real providers (Gmail, Outlook, a real CalDAV server) and push delivery.
- HTTPS-only behaviour: production cookie flags and HSTS.
- Backup import and restore, whose staging directories are fixed to
  `/app/uploads`.
