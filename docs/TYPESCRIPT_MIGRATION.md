# TypeScript conversion checkpoint for 0.19.0

Local review draft on `conversion/typescript-20261008`, based on
`283ed82071375d47bcb41201df4e92862443b5ec`. Nothing has been staged, committed,
pushed, tagged, published or deployed. The maintainer asked to review before
publication. Release preparation is in [RELEASE_0.19.0.md](RELEASE_0.19.0.md).

## Weekly usage agreement

The ceiling is 35% of total weekly Codex usage consumed. This task ended below
that ceiling. The exact account snapshot and timestamp are retained in ignored
`.private/typescript-validation-20261008/validation.json`. Check a fresh account
snapshot before resuming; snapshots can lag. Reserve enough room below 35% to
finish checks and update this document. At the ceiling, finish the handoff
instead of abandoning half-edited code. No further conversion is authorized
automatically for next week.

## Completed conversion

Converted 121 API JavaScript modules to `.ts`, plus two browser
workers. The frontend was already TypeScript. Coverage includes:

- HTTP startup, supervisor, readiness, routing, auth, 2FA, CSRF and outbound security.
- All feature routes, contacts, calendar discovery/recurrence/sync/writeback.
- Mail transport, IDLE, durable scheduling, body import, operations, receipts,
  filing, retention policy and verified Download-mode server deletion.
- Notification delivery, offline snapshots, recording uploads and audio helpers.
- Backup formats, ZIP/container transport, export/import, owner-safe mapping,
  recovery evidence, cancellation and uncertain-commit handling.
- The mail rollout operator CLI and calendar route helpers.

Shared interfaces cover requests, SQL executors, provider protocol values,
worker fences, calendar records, archives and import hooks. Converted modules
use strict checking, no explicit `any` and no `@ts-nocheck`. Runtime validation
of untrusted data still applies. SQL `RowDataPacket` has a broad library index
signature; some table projections and validated archive rows still rely on it.
This migration does not establish exhaustive per-column typing or validation
solely through TypeScript.

## Runtime and developer workflow

`api/tsconfig.json` emits CommonJS into ignored `api/dist/`. Source imports
retain CommonJS module objects and lazy dependencies used for test isolation.
`api/scripts/build.cjs` starts from a clean runtime tree, fails on compiler
errors, and writes runtime package metadata for 0.19.0. In the flattened
production tree its main/start point is `server.js`; local source package
commands build and use `dist/server.js`.

The browser worker compiler emits ignored `.worker-dist/`. Vite serves/emits
those classic scripts at the original URLs. API tests, seed/schema scripts and
local MariaDB commands use emitted API code. The source DDL inventory test
continues reading authored schema declarations independently of emitted layout.

```bash
npm ci
npm --prefix api ci
npm run typecheck
npm run lint
npm test
npm run build
npm --prefix api test
scripts/local-db.sh test
```

Direct API tests require `npm --prefix api run build` first. Ordinary API runs
may skip database checks; the MariaDB release gate requires zero skips. Never
point `MYSQL_TEST_*` at development or production data. The local helper
recreates only the verified disposable `unihub_test` database.

Docker has separate frontend and API compiler stages. Production dependencies
are installed with `--omit=dev`, and emitted API files are copied into
`/app/api/`. Existing startup paths in `docker/start.sh` remain valid.

## Validation

Local runtime: Node 26.7.0, MariaDB supplied by the existing local helper.
Node 24 remains the image/CI baseline; a Node 24 container run is pending.

- Baseline MariaDB gate before conversion: 669 passed, zero failures/skips.
- Current frontend: 41 files, 231 tests passed; production Vite/PWA build passed.
- Combined frontend, browser worker and API typecheck passed; lint passed.
- Focused synthetic protocol, security, calendar, storage and worker regressions
  passed throughout the conversion. The final focused batch passed 35 tests.
- Disposable flattened production install passed route/CLI import, metadata,
  startup-file presence and absence of a TypeScript runtime dependency.
- AST/SQL audit covered all 121 emitted API modules. SQL literal values were
  unchanged; the frozen database file and generated schema have no diff.
- Full post-conversion MariaDB release gate: 669 passed, zero failures/skips,
  about 12 minutes. The recovery runner confirmed its no-skip gate.
- Final whitespace cleanup changed no emitted API or worker file bytes. Fresh
  typecheck, Vite configuration check, lint and API build all passed afterward.
- Generated production notification/audio worker assets match their emitted
  worker files byte for byte.
- Docker build and container smoke are unverified. Daemon access is denied and
  non-interactive sudo is unavailable in this session.
- No live mailbox, deployed service, push subscription or production data was
  used for testing. Existing npm audit findings were not changed with a forced
  dependency upgrade. Vite's existing large-chunk warning remains.

Detailed local logs and the validation receipt are retained under ignored
`.private/typescript-validation-20261008/`. Do not publish these logs.

## Where conversion stops

The authored API JavaScript remaining is:

- `api/src/services/database.js`

`database.js` stays untouched because `ensureLegacySchema` is the frozen
0.11.1 baseline. Future schema work uses numbered migrations and the existing
schema-dump command. The migration registry and SQL schema were not changed.

The small `api/scripts/*.cjs` build/test/seed/schema tooling, API `node:test`
files and helpers, root `scripts/*.mjs` operational tools, and JavaScript build
configuration remain JavaScript. They support or verify the compiled product.
They are the next optional language-conversion tranche, separate from runtime
source. Keep compiled classic worker files as generated outputs.

Further typing work should replace broad SQL/validated-archive row projections
with table-specific interfaces, narrow dynamic JSON at service boundaries and
reduce non-null assertions where the existing runtime checks prove presence.
Do not weaken `strict` or convert the frozen database baseline just to change
its extension. Re-run focused failure-path tests as each boundary changes.

Review with `git diff` and `git ls-files --others --exclude-standard`. New `.ts`
files are untracked until reviewed/staged, so `git diff --stat` alone understates
this migration. Use `git diff --no-index /dev/null <new-file>` to inspect a new
file, or stage only the explicit code/documentation paths after review. Exclude
`.private/`, generated output, credentials and local database storage. Do not
push or publish without the maintainer's approval.

## Converted API modules

- `api/calendar-route-utils.ts`
- `api/mail-rollout.ts`
- `api/server.ts`
- `api/src/app.ts`
- `api/src/auth.ts`
- `api/src/config.ts`
- `api/src/database-readiness.ts`
- `api/src/drop-privileges.ts`
- `api/src/http/range.ts`
- `api/src/http/request.ts`
- `api/src/logger.ts`
- `api/src/request-handler.ts`
- `api/src/routes/admin.ts`
- `api/src/routes/auth.ts`
- `api/src/routes/backup.ts`
- `api/src/routes/calendar.ts`
- `api/src/routes/contacts.ts`
- `api/src/routes/events.ts`
- `api/src/routes/index.ts`
- `api/src/routes/mail-accounts.ts`
- `api/src/routes/mail-drafts.ts`
- `api/src/routes/mail-folders.ts`
- `api/src/routes/mail-messages.ts`
- `api/src/routes/mail-operations.ts`
- `api/src/routes/mail-route-helpers.ts`
- `api/src/routes/mail-sync.ts`
- `api/src/routes/mail.ts`
- `api/src/routes/modules.ts`
- `api/src/routes/notifications.ts`
- `api/src/routes/offline.ts`
- `api/src/routes/recordings.ts`
- `api/src/routes/search.ts`
- `api/src/routes/settings.ts`
- `api/src/routes/system.ts`
- `api/src/security/caldav-transport.ts`
- `api/src/security/client-ip.ts`
- `api/src/security/encryption.ts`
- `api/src/security/login-limits.ts`
- `api/src/security/outbound-network.ts`
- `api/src/service-supervisor.ts`
- `api/src/services/audio-conversion-queue.ts`
- `api/src/services/audio-transcode.ts`
- `api/src/services/backup-archive-keys.ts`
- `api/src/services/backup-availability.ts`
- `api/src/services/backup-catalog.ts`
- `api/src/services/backup-common.ts`
- `api/src/services/backup-container.ts`
- `api/src/services/backup-export.ts`
- `api/src/services/backup-format.ts`
- `api/src/services/backup-formats/v1.ts`
- `api/src/services/backup-formats/v2.ts`
- `api/src/services/backup-formats/v3.ts`
- `api/src/services/backup-formats/v4.ts`
- `api/src/services/backup-import.ts`
- `api/src/services/backup-mail-engine.ts`
- `api/src/services/backup-mail-recovery.ts`
- `api/src/services/backup-ownership.ts`
- `api/src/services/backup-restore-jobs.ts`
- `api/src/services/backup-restore-mapping.ts`
- `api/src/services/backup-validate.ts`
- `api/src/services/backup-zip-reader.ts`
- `api/src/services/backup.ts`
- `api/src/services/caldav.ts`
- `api/src/services/calendar-accounts.ts`
- `api/src/services/calendar-ical.ts`
- `api/src/services/calendar-sync.ts`
- `api/src/services/calendar.ts`
- `api/src/services/contacts.ts`
- `api/src/services/data-inventory.ts`
- `api/src/services/database-config.ts`
- `api/src/services/database-migrations.ts`
- `api/src/services/database-version.ts`
- `api/src/services/export-jobs.ts`
- `api/src/services/mail-account-lifecycle.ts`
- `api/src/services/mail-account-lock.ts`
- `api/src/services/mail-account-mode.ts`
- `api/src/services/mail-attachments.ts`
- `api/src/services/mail-drafts.ts`
- `api/src/services/mail-durable-jobs.ts`
- `api/src/services/mail-engine/connection-pool.ts`
- `api/src/services/mail-engine/content.ts`
- `api/src/services/mail-engine/operation-batch.ts`
- `api/src/services/mail-engine/operations.ts`
- `api/src/services/mail-engine/reconciliation.ts`
- `api/src/services/mail-engine/recovery-policy.ts`
- `api/src/services/mail-engine/repository-identity.ts`
- `api/src/services/mail-engine/repository.ts`
- `api/src/services/mail-engine/rollout.ts`
- `api/src/services/mail-engine/runtime.ts`
- `api/src/services/mail-engine/schema.ts`
- `api/src/services/mail-engine/sync.ts`
- `api/src/services/mail-engine/transport.ts`
- `api/src/services/mail-filing.ts`
- `api/src/services/mail-folder-reconciliation.ts`
- `api/src/services/mail-folder-view.ts`
- `api/src/services/mail-folders.ts`
- `api/src/services/mail-host-policy.ts`
- `api/src/services/mail-idle.ts`
- `api/src/services/mail-imap-client.ts`
- `api/src/services/mail-imap-guard.ts`
- `api/src/services/mail-import.ts`
- `api/src/services/mail-send.ts`
- `api/src/services/mail-server-delete.ts`
- `api/src/services/mail-sync-control.ts`
- `api/src/services/mail-sync-policy.ts`
- `api/src/services/mail-sync-scheduler.ts`
- `api/src/services/mail-sync-state.ts`
- `api/src/services/mail-writebacks.ts`
- `api/src/services/mail.ts`
- `api/src/services/module-catalog.ts`
- `api/src/services/module-settings.ts`
- `api/src/services/notification-rules.ts`
- `api/src/services/notifications.ts`
- `api/src/services/offline.ts`
- `api/src/services/push-transport.ts`
- `api/src/services/recording-audio.ts`
- `api/src/services/recordings.ts`
- `api/src/services/restore-locks.ts`
- `api/src/services/server-events.ts`
- `api/src/services/two-factor.ts`
- `api/src/state.ts`
