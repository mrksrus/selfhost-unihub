# UniHub agent guide

UniHub is a self-hosted PWA for mail, contacts, calendars, tasks and recordings, accessible through one UniHub login across devices. People trust it with private data. Favor correct ownership, recoverability, and clear behavior over clever abstractions. These are project defaults; the task and the maintainer's instructions take priority.

## How the app fits together

    React/TypeScript PWA -> Nginx -> Node HTTP API -> MariaDB
                                          |-> /app/uploads (files and backups)
                                          |-> IMAP, SMTP, CalDAV, Web Push

The standard deployment is one app container and one MariaDB container. Nginx serves the built frontend and proxies /api/* to the Node API. Mail and backup workers use in-process coordination, so do not assume that multiple API replicas are safe. Read [architecture](docs/ARCHITECTURE.md) for detailed contracts and [development](docs/DEVELOPMENT.md) for local setup.

| Area | Start here |
| --- | --- |
| Routes and page entry points | src/App.tsx, then the feature in src/pages/ |
| Shared layout and navigation | src/components/layout/, src/components/GlobalCommandPalette.tsx |
| UI primitives, tokens, and theme | src/components/ui/, src/index.css, tailwind.config.ts, src/components/theme/ |
| Browser API calls and state | src/lib/, src/hooks/, src/contexts/AuthContext.tsx, src/components/SessionQueryProvider.tsx |
| Offline and PWA behavior | src/lib/offline.ts, src/lib/pwa-update.ts, src/utils/service-worker.ts, workers/sw-custom.ts |
| API startup and request boundary | api/server.ts, api/src/app.ts, api/src/request-handler.ts, api/src/routes/ (routes/mail.ts combines the routes/mail-* area files) |
| Authentication and outbound connections | api/src/auth.ts, api/src/routes/auth.ts, api/src/services/two-factor.ts, api/src/security/ |
| Calendar accounts, sync and recurrence | src/lib/calendar-api.ts, api/src/routes/calendar.ts, api/src/services/calendar*.ts, api/src/services/caldav.ts; docs/CALENDAR.md |
| Durable mail sync and operations | api/src/services/mail-engine/, api/src/services/mail-account-lock.ts, api/src/services/mail-sync-control.ts; docs/MAIL_MODES.md, docs/MAIL_SYNC.md |
| Domain logic and persistence | api/src/services/, api/src/security/, api/src/services/database.ts; services/mail.ts and services/backup.ts are facades over the mail-* and backup-* modules |
| Recovery and schema contracts | api/src/services/backup-catalog.ts, api/src/services/data-inventory.ts, api/src/services/mail-engine/recovery-policy.ts, api/src/services/restore-locks.ts, api/src/services/database-migrations.ts; docker/mariadb/schema.sql |
| Tests and deployment | src/test/, api/tests/, Dockerfile, docker-compose.yml, .github/workflows/ |

For feature details, follow the corresponding file in docs/ rather than treating this guide as a second specification. Mail work usually spans src/pages/MailPage.tsx, src/lib/mail-api.ts, src/hooks/use-mail-queries.ts, api/src/routes/mail-* (combined in routes/mail.ts), and the api/src/services/mail-* files (re-exported by services/mail.ts). Backup and restore work spans api/src/services/backup*, export-jobs.ts, and docs/DATA_RECOVERY.md.

## Contracts to keep intact

- The API is a vanilla Node HTTP server, not Express. request-handler.ts normalizes parameterized paths, then handles CORS, authentication, CSRF, module access, body limits, and dispatch. Add new routes through that boundary.
- User data is owner-scoped. Keep user_id checks on queries, file access, background jobs, exports, and restores. Admin-only operations need an explicit role check.
- Browser session state is account-specific. SessionQueryProvider clears private query data on account change. Offline snapshots in IndexedDB are read-only, owner/epoch-scoped copies; a cached profile is not an authenticated server session. API responses are not service-worker cached.
- Authentication requires a valid JWT signature, a live database session and an active user. Session expiry slides from last use; the database session is authoritative. Preserve revocation, production cookie flags, CSRF checks, atomic 2FA challenge consumption and trusted-proxy login limits. See docs/AUTH_ADMIN_SETTINGS.md.
- Mail has Download and Sync modes, provider writebacks, and optional server deletion. Read docs/MAIL_MODES.md and docs/MAIL_SYNC.md before changing message identity, folders, read/star/move behavior, or deletion.
- Backup/import/restore is experimental and has durable jobs and recovery-format contracts. A change to stored data may need a migration, backup/export mapping, restore mapping, and tests. Do not test against a live database or real uploads.
- Optional modules affect navigation, API access, background work, search, and offline reads. Calendar and ToDo share one module, as do Recordings and Music; their pages are shown, hidden and ordered separately (page preferences), but enabling stays per module. A route affecting another module must check that module and its restore lock before side effects, regardless of its URL prefix. See docs/MODULES.md.
- MariaDB 10.11 or later is required; Compose and CI use 11.8. Keep database sessions and DATETIME handling in UTC. Historical MYSQL_* configuration names, mysql2 and *-mysql-integration.test.js filenames still apply to MariaDB.

## Visual style

- Preserve UniHub's black, white, and blue identity unless the task asks for a redesign. Dark is the default; Light and System must also work. Use the semantic CSS variables in src/index.css through Tailwind classes, including the existing module and success/warning/destructive colors. Avoid hard-coded colors in feature views.
- Use Inter for interface text and JetBrains Mono where code or fixed-width data helps. Keep headings and actions in plain, sentence-case language. Let spacing, type, and alignment show hierarchy; add borders, cards, gradients, or motion only when they clarify a real distinction.
- Reuse src/components/ui/ controls and their variants. Keep feature-specific layout in the feature component. Do not create a new visual treatment for a common control when an existing variant fits.
- The desktop shell has a sidebar; narrow screens use a header and bottom navigation. Check both widths, long content, scrolling, touch targets, and safe-area clearance. A change should remain usable with keyboard focus, visible errors, useful empty/loading states, sufficient contrast, and reduced motion.
- Treat displayed email as untrusted content. Keep SafeEmailContent and its privacy controls in charge of HTML mail and remote images; do not render sender HTML as ordinary application UI.
- Per-user color customization is planned; preserve the existing visual identity unless the task changes that requirement.

## Code style and change shape

- Frontend code is TypeScript with React components and hooks; backend source is strict TypeScript compiled to CommonJS. Classic browser workers are authored in workers/ and emitted as JavaScript. Match the surrounding file's naming and formatting instead of reformatting unrelated code. Use the existing API helpers, query keys, hooks, and UI components before adding parallel ones.
- Keep route handlers focused on HTTP concerns and put reusable domain behavior in api/src/services/. Validate external input at the boundary. Use parameterized SQL and explicit ownership checks. Preserve the existing mail/CalDAV outbound-network and TLS checks.
- Account for pending, failure, retry, cancellation, and stale responses in asynchronous UI work. In particular, do not let a late response show data from the previous account or an earlier mail selection.
- Change only the needed layers, but follow a behavior through all affected layers: UI, API, database, workers, offline snapshot, backup/restore, and documentation. Avoid dependencies and abstractions that solve no current requirement. Comments should explain a constraint or reason that the code alone does not show.
- Database schema: database-baseline.ts is the frozen 0.16.0 starting schema of new databases (upgrade steps 1 to 11), never change it; every schema change is a new numbered migration in database.ts, then regenerate `docker/mariadb/schema.sql` with `scripts/local-db.sh schema-dump`.
- Tests should prove observable behavior and important failure paths with synthetic data. Do not copy a real mailbox, database, contact list, or server volume into a test fixture.

## Code Review Rules

Review the changed behavior through its callers, workers, database writes and recovery paths. Apply these rules to relevant changes; do not turn a small PR into an unrelated refactor. Prioritize exploitable security failures and irreversible data loss, then correctness and concrete maintenance costs. For each finding, cite the narrowest affected lines and explain the trigger, impact and missing guard. Check existing safeguards before reporting; distinguish demonstrated behavior from an unverified risk. Follow SECURITY.md for private vulnerability reporting and use synthetic examples.

Every review must end with an explicit verdict for the reviewed commit. When nothing needs fixing, say so in a review comment, for example "No issues found in <commit>.", rather than staying silent, so whoever waits on the review knows it is finished.

### Access and secrets

- Trace user ownership through IDs, parent/child relationships, joins, bulk operations, files, job polling, downloads and SSE. Check with two users; an owned parent does not make an arbitrary child ID safe. Admin routes also need a server-side role check.
- Check authentication, CSRF, body limits and module/restore gates at the request boundary and before service side effects. Test disabled modules and active restores, including Mail-prefixed calendar routes. Background work must recheck applicable permissions after waits or retries.
- Preserve session revocation and single-use login challenges/recovery codes under concurrency. Do not trust forwarded client IPs beyond configured proxy hops or expand public/CSRF exceptions without a concrete reason and a boundary test.
- Credentials, ICS subscription URLs, push endpoints, archive unlock keys and raw provider errors can contain secrets. Check API serialization, logs, notifications, exports and browser storage; keep stored credentials encrypted and use allowlisted public fields. Intentional encrypted credential backup must follow the recovery policy.

### Untrusted input and network access

- Validate mail, CalDAV, ICS, discovery and restored connection targets through the existing network policy. Check every redirect and DNS-resolved connection, including IPv6/private addresses; retain the original TLS hostname. TRUSTED_MAIL_HOSTS permits explicit network exceptions, not blanket TLS bypass. Preserve the existing user-confirmed mail trust policy; CalDAV/ICS require HTTPS and certificate verification. CalDAV credentials may only follow a confirmed origin or the configured built-in provider scope.
- Treat email HTML, calendar data, backup archives and uploaded filenames as untrusted. Preserve inert email sanitization and restricted iframe/CSP. Remote-image consent resets on leaving a message, including A -> B -> A; changing the display format must not grant consent. Review path traversal, symlinks, archive expansion limits, bounded parsing/recurrence, stream size/time limits and subprocess argument handling where applicable.
- File and recording changes must preserve original bytes, ownership and storage-root checks, bounded chunk uploads/conversion, Range validators and disconnect cleanup. Keep streaming downloads outside service-worker interception. Failed conversion must leave the original recording available.

### Synchronization and recovery

- Distinguish a verified remote deletion from an incomplete listing, parse failure or transport error. Keep last known-good data on failure; do not advance ETags, checkpoints or successful status before the corresponding work is safely stored. Preserve local ToDo state and subtasks when occurrences remain valid.
- Check writeback identity, read-only providers and conflict handling before mutation. CalDAV writes must respect ETags and recurrence scope; missing restored/legacy remote links must not silently fall back to local-only edits or deletes. Account links need explicit provenance, not email equality alone. Inspect partial failure of cross-calendar moves and retries for duplicates or data loss.
- Preserve mail mode, UID/UIDVALIDITY identity, account locking, cancellation and provider-deletion opt-in. Distinguish accepted intent from confirmed provider state. Accepted jobs/intents and pending UI state must survive retries or recover predictably; a lost connection does not prove a remote operation failed. A dispatched IMAP MOVE must reconcile its outcome without sending the MOVE again. Restore must not replay destructive provider operations.
- For persisted-data changes, review migrations, backup-catalog field policies, data-inventory coverage, mail-engine/recovery-policy.ts, owner-safe ID remapping and credentials together. Stage files before writes; clean replaced files only after a known commit, and retain staged files while a commit outcome is uncertain. Restore must not resurrect sessions, push credentials or installation-local worker leases. Keep archive versions distinct from database migration IDs; preserve historical fixtures. Respect section locks and retired-module handling; test old archives as well as new round trips. Confirm older documentation against the current catalog and format readers when they disagree.

### Browser state and maintainability

- Check account switches, sign-out, expired sessions, module pauses and reconnects for private-data leaks through React Query, IndexedDB, delayed responses, SSE and push messages. Only transport failure may fall back to saved offline identity; 401/403 or server errors must not. Keep offline writes disabled and service-worker caches free of private API/download responses; notification links must stay on the application origin and load owned records.
- Keep HTTP handling in the request boundary/routes, domain behavior in services and browser requests in existing API helpers. Flag duplicated security policy, hidden mutable state, unbounded work or inconsistent error/pending states only when they cause a concrete failure or maintenance cost. Prefer a focused regression test over a speculative abstraction; leave formatting and lint checks to tooling.

## Working and verification

- Use Node.js 26 or newer. Install frontend and API dependencies separately with npm ci and npm --prefix api ci when needed.
- Run focused tests for changed behavior. Frontend checks are npm run typecheck, npm run lint, npm test -- src/test/<file>.test.tsx and npm run build for production-build changes; backend unit tests first build with npm --prefix api run build, then use node --test api/tests/<file>.test.js or npm --prefix api test. Match the actual test filename and extension. Ordinary API runs can skip database tests; they do not establish the database release gate.
- Database checks require a verified disposable test database. scripts/local-db.sh test recreates unihub_test; never point it or MYSQL_TEST_* at a live database. Use npm run test:db for the full local gate, or scripts/local-db.sh test api/tests/<file>.test.js for focused integration checks. With an independently configured empty *_test MariaDB database, npm --prefix api run test:ci runs all API tests and fails on skips; test:recovery runs the recovery subset. Read docs/DEVELOPMENT.md before initializing or resetting local databases.
- Choose checks by the affected boundary: auth/request/login limits for access changes; outbound-network/caldav-network and mail transport tests for connections; safe-email-content/email-privacy plus the synthetic browser request check for email rendering; offline/auth-session-switch/server-events for device state; backup ownership/roundtrip/schema-file integration tests for recovery and migrations. Calendar sync/writeback changes need synthetic malformed input, conflict, read-only, recurrence and retry coverage, not only parser tests.
- For UI changes, inspect the actual result at desktop and mobile widths in dark and light themes. For PWA, offline, push, or updates, verify the relevant browser state and consult docs/PWA.md and docs/OFFLINE.md. Report what was and was not verified.
- Update the relevant feature documentation when a user-visible behavior or cross-component contract changes. Keep this file short and revise a stale rule instead of appending a conflicting one.
- Add a CHANGELOG.md entry under the upcoming version for every user-visible change.
- For release or deployment work, follow .github/workflows/docker-image.yml: API test:ci without skips, frontend tests/lint/build, then the built-image smoke test in scripts/container-smoke.sh. Keep local, CI, container and real-provider/device verification separate; report failures and skips. Documentation-only edits need link/path and diff checks, not an application test run.

## Private data and checks before committing

- Never commit real passwords, API tokens, private keys, .env values, database contents, email, contacts, calendar data, recordings, logs, screenshots, or other personal information.
- Keep any real data needed for local development under .private/ or outside the repository. .private/ is ignored by Git and Docker. Do not force-add ignored files.
- Use made-up data and reserved example domains in source, tests, fixtures, documentation, and screenshots intended for the repository.
- Before committing or pushing, review the staged diff and staged filenames for private data. Check content as well as filenames: .gitignore does not protect a file that is already tracked or data pasted into source code.
- If private data was committed, stop before pushing. Remove it from the commit and rotate any exposed credential. If it was already pushed, flag that history may still contain it.
