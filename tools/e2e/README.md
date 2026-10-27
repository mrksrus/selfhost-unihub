# End-to-end tests

A disposable UniHub installation, made-up data and tests that drive it like a
person would: in a browser at desktop and phone sizes, and in the real Android
app in an emulator. Agents use it to prove a feature before the maintainer
sees it (PROJECT-PREFERENCES P-28); CI runs it on the built image. It is
development tooling, never shipped. Tests use
[e2e](https://github.com/tester-army/e2e) (Apache-2.0) for the web and
Playwright's Android driver for the app.

## What runs

`./stack.sh up` starts one instance on loopback:

| Part | Address (instance 1) | Notes |
| --- | --- | --- |
| nginx with `docker/nginx/*.conf` | 127.0.0.1:8088 | Alpine's `mime.types`, so headers match the image |
| API (`api/dist/server.js`) | 127.0.0.1:4100 | development cookies (plain HTTP); trusts the test CA |
| MariaDB (`scripts/local-db.sh`) | 127.0.0.1:3311 | database `unihub_dev` with the dev seed |
| GreenMail (IMAP/SMTP) | 127.0.0.1:993 and :465, REST :8085 | accepts mail for any address |
| Radicale (CalDAV) | https://127.0.0.1:5232/ | one calendar and one task list per account |

Users (password `local-dev-admin-password`): `admin@example.com` (admin),
`alex@example.com` and `blair@example.com`, enough for owner, grantee and
stranger checks. Each has a connected Sync-mode mail account
`<name>@mail.test` and a CalDAV account with the same login (password
`e2e-provider-password`). Outside correspondents: `sam@example.org`,
`carol@example.org`. The dev seed also gives admin and alex sample contacts,
events, tasks and mail on accounts whose host does not exist.

The providers use a certificate from a local test CA
(`~/.local/state/unihub-e2e-ca`), so connections are verified like real ones.
GreenMail's REST API (`/api/user`, `/api/user/<email>/messages`,
`/api/mail/purge`) shows what was delivered.

`UNIHUB_E2E_INSTANCE=2` (up to 9) runs another instance beside the first, for
example one per agent: ports shift by one, the providers bind 127.0.0.2,
state goes to `~/.local/state/unihub-e2e-2`. `./stack.sh env` prints the
instance's values; the e2e config follows the same variable. Each instance
uses about 1.5 GB of memory.

## Start and stop

```bash
tools/e2e/stack.sh up            # builds the frontend once; --rebuild after frontend changes
tools/e2e/stack.sh status
tools/e2e/stack.sh restart-api   # restart only the API, for restart checks
tools/e2e/stack.sh down          # stop everything when finished
tools/e2e/stack.sh reset         # also delete the database, mail, calendars and uploads
```

The stack needs nginx 1.22 or later, Alpine nginx's `mime.types` (from the
`nginx` package of the Alpine release the image uses), GreenMail standalone
(`com.icegreen:greenmail-standalone` from Maven Central) with Java 17,
Radicale 3.5 (`pip install radicale` in a virtual environment) and the
MariaDB tarball `scripts/local-db.sh` uses. Point to them with
`UNIHUB_E2E_NGINX`, `UNIHUB_E2E_MIME_TYPES`, `UNIHUB_E2E_GREENMAIL_JAR`,
`UNIHUB_E2E_RADICALE` and `JAVA`, in the environment or in
`~/.config/unihub-e2e/tools.env` (sourced by the scripts). Ports 465 and 993
need `net.ipv4.ip_unprivileged_port_start` at or below 465, or root.

## Web tests

```bash
cd tools/e2e && npm ci
npm test                          # every area except real providers
npm run test:smoke                # the fast subset for every change
npx e2e run tests/mail/reply.e2e.ts --target android-app
npx e2e guide                     # the framework's instructions for agents
```

Targets: `desktop` (1440×900), `phone` (412×915, Android Chrome) and
`android-app` (412×915 with the Android shell's user agent, which puts the
page in app mode). Set `PLAYWRIGHT_BROWSERS_PATH` to a Chromium matching the
installed `playwright-core` (for example `../ui-regression/.browsers` after
`npm run browsers` there) and `E2E_TELEMETRY_DISABLED=1`.

Tests sit in `tests/<area>/` and share `tests/support/`. A test is named after
the behaviour and its tracker row or bug, for example
`[24-12] reply all reaches To and Cc but not the sender`, checks outcomes
(what was delivered, stored or shown) rather than incidental layout, and
creates its own uniquely named data, so tests run in any order on a used
database. Tests that wait on server timers (scheduled send, snooze) stay out
of `test:smoke`. No model is configured: tests use locators, not `agent.act`.

## Android app tests

```bash
tools/e2e/android.sh up           # boot the emulator, build and install the debug app, connect it to the stack
npm run android                   # node --test android/*.test.mjs
tools/e2e/android.sh install      # after Android or web changes
tools/e2e/android.sh down
```

The emulator needs KVM and an AVD (`UNIHUB_E2E_AVD`, default `unihub35`); it
runs on port 5560 (`UNIHUB_E2E_EMULATOR_PORT`) and reaches the stack through
`adb reverse`. A host without `libX11-xcb.so.1` can point
`UNIHUB_E2E_EMULATOR_LIBS` at a folder holding Debian's `libx11-xcb1`.
`support/android.mjs` drives the page inside the app through Playwright's
Android driver (the debug build enables WebView debugging) and Android's own
screens (document picker, permission and system dialogs) through
uiautomator; it answers the "isn't responding" dialogs a slow emulator shows.

## Real providers

`npm run test:providers` connects real accounts (for example Stalwart for
IMAP, SMTP and CalDAV) read from `.private/e2e-providers.env` of the canonical
checkout (`UNIHUB_E2E_PROVIDERS` overrides the path). The tests skip when the
file or an account block is empty and never print its values. Use test
accounts only.

## What it cannot prove

- The maintainer's own phone: other keyboards (Samsung, SwiftKey), battery
  and background limits over hours, real notifications through a locked
  phone, biometrics, call audio and headsets.
- Provider quirks beyond the configured real accounts (Gmail, Outlook) and
  the live server's upgrade and data.
- HTTPS-only behaviour such as production cookie flags and HSTS.
- Backup import and restore, whose staging directories are fixed to
  `/app/uploads` (the container smoke test covers them in CI).
