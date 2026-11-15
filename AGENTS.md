# UniHub agent guide

UniHub is a self-hosted PWA for mail, contacts, calendars, tasks and recordings, accessible through one UniHub login across devices. It is heading to 1.0 as the self-hosted workplace and communication system of one organisation: the same apps plus administration, sharing, end-to-end encrypted chat and internal calls, on the web and Android. People trust it with private data. Favor correct ownership, recoverability, and clear behavior over clever abstractions. These are project defaults; the task and the maintainer's instructions take priority.

## Accepted decisions and verification

Before changing behavior, read [PROJECT-PREFERENCES.md](PROJECT-PREFERENCES.md). Use the shared `project-preferences` skill when available to preserve accepted choices, record new durable user decisions and surface genuinely unresolved conflicts. Explicit new user direction may supersede an old choice; general design freedom does not. Use the canonical project file across local worktrees when a user registry is available. In a scoped/read-only task, propose any update outside that scope rather than editing it.

For frontend work, read [UI acceptance](docs/UI_ACCEPTANCE.md) before applying frontend-design. Preserve accepted tokens, components and interactions during ordinary changes. For feature acceptance and releases, use [unihub-verify](.agents/skills/unihub-verify/SKILL.md) and the [release contract](docs/RELEASE_CONTRACT.md); use focused checks for ordinary changes and full required gates before publishing. A missing required runtime check is not a pass. Keep model routing in user-wide guidance rather than copying model IDs here.

## Read when the task needs it

This guide holds what every task needs. Read the matching file before the work it covers; a reviewer or a small fix does not need the others.

| Before you | Read |
| --- | --- |
| start, decide, build, release or finish a version, or record a test result | [the version flow](docs/agents/version-flow.md) |
| add a table, route, setting, policy, notification, shared resource, device behaviour, export or dependency | [Building toward 1.0](docs/agents/building-toward-1.0.md) |
| change anything a person sees | [Visual style](docs/agents/visual-style.md) and [UI acceptance](docs/UI_ACCEPTANCE.md) |
| run checks, add tests or prepare a release | [Working and verification](docs/agents/verification.md), [unihub-verify](.agents/skills/unihub-verify/SKILL.md) |
| review a change or brief a reviewer | [Code review](docs/agents/review.md) |

## Road to 1.0

[docs/ROADMAP.md](docs/ROADMAP.md) is the public plan up to 1.0: what 1.0 contains, the versions with their themes, the foundations F1 to F15, the scope rules and the parking lot. The maintainer's private plan lives in `.private/road-to-1.0/` of the canonical checkout (the `projectRoot` reported by the project-preferences `locate` helper); Git and Docker ignore it, and its contents (decisions, test results, devices, known-bug details) stay out of commits, issues, PRs and public documents.

**Scope.** Work only on what the current version lists, or on a bug in what already exists. Bug fixes ship in patch releases, never together with features. Any other idea, including an agent's own, goes to the parking lot as a proposal. Only the maintainer swaps something into a version.

Test results never live only in a chat: before a thread ends, record every result and problem the maintainer reported in the tracker. The five steps of a version, the private files and the end-of-thread duties are in [the version flow](docs/agents/version-flow.md).

## How the app fits together

    React/TypeScript PWA -> Nginx -> Node HTTP API -> MariaDB
                                          |-> /app/uploads (files and backups)
                                          |-> IMAP, SMTP, CalDAV, Web Push

The standard deployment is one app container and one MariaDB container. Nginx serves the built frontend and proxies /api/* to the Node API. Mail and backup workers use in-process coordination, so do not assume that multiple API replicas are safe. Read [architecture](docs/ARCHITECTURE.md) for detailed contracts and [development](docs/DEVELOPMENT.md) for local setup.

| Area | Start here |
| --- | --- |
| Routes and page entry points | src/App.tsx, then the feature in src/pages/ |
| Shared layout and navigation | src/components/layout/ (NavRail, BottomNav, PageShell), src/components/GlobalCommandPalette.tsx |
| UI primitives, tokens, and theme | src/components/ui/, src/index.css, tailwind.config.ts, src/components/theme/ |
| Browser API calls and state | src/lib/, src/hooks/, src/contexts/AuthContext.tsx, src/components/SessionQueryProvider.tsx |
| Offline and PWA behavior | src/lib/offline.ts, src/lib/pwa-update.ts, src/utils/service-worker.ts, workers/sw-custom.ts |
| Android app and the device boundary | android/ (thin WebView shell), src/lib/platform.ts, src/lib/install-prompt.ts, api/src/services/app-version.ts; docs/ANDROID.md |
| API startup and request boundary | api/server.ts, api/src/app.ts, api/src/request-handler.ts, api/src/routes/ (routes/mail.ts combines the routes/mail-* area files) |
| Authentication and outbound connections | api/src/auth.ts, api/src/routes/auth.ts, api/src/services/two-factor.ts, api/src/security/ |
| User preferences and settings pages | api/src/services/settings.ts (preferences, sign-up mode), api/src/routes/settings.ts, src/lib/settings-api.ts, src/components/settings/; docs/AUTH_ADMIN_SETTINGS.md |
| Calendar accounts, sync and recurrence | src/lib/calendar-api.ts, api/src/routes/calendar.ts, api/src/services/calendar*.ts, api/src/services/caldav.ts; docs/CALENDAR.md |
| Durable mail sync and operations | api/src/services/mail-engine/, api/src/services/mail-account-lock.ts, api/src/services/mail-sync-control.ts; docs/MAIL_MODES.md, docs/MAIL_SYNC.md |
| Domain logic and persistence | api/src/services/, api/src/security/, api/src/services/database.ts; services/mail.ts and services/backup.ts are facades over the mail-* and backup-* modules |
| Recovery and schema contracts | api/src/services/backup-catalog.ts, api/src/services/data-inventory.ts, api/src/services/mail-engine/recovery-policy.ts, api/src/services/restore-locks.ts, api/src/services/database-migrations.ts; docker/mariadb/schema.sql |
| Tests and deployment | src/test/, api/tests/, Dockerfile, docker-compose.yml, .github/workflows/ |

For feature details, follow the corresponding file in docs/ rather than treating this guide as a second specification. Mail work usually spans src/pages/MailPage.tsx, src/lib/mail-api.ts, src/hooks/use-mail-queries.ts, api/src/routes/mail-* (combined in routes/mail.ts), and the api/src/services/mail-* files (re-exported by services/mail.ts). Backup and restore work spans api/src/services/backup*, export-jobs.ts, and docs/DATA_RECOVERY.md.

## Contracts to keep intact

- The API is a vanilla Node HTTP server, not Express. request-handler.ts normalizes parameterized paths, then handles CORS, authentication, CSRF, module access, body limits, and dispatch. Every route is declared with a spec (api/src/http/route.ts: auth level, module, restore section, body limit, CSRF rule, streaming) and the boundary reads only that spec; add new routes with `defineRoutes()` in their feature file.
- User data is owner-scoped. Keep user_id checks on queries, file access, background jobs, exports, and restores. Admin-only operations need an explicit role check.
- Browser session state is account-specific. SessionQueryProvider clears private query data on account change. Offline snapshots in IndexedDB are read-only, owner/epoch-scoped copies; a cached profile is not an authenticated server session. API responses are not service-worker cached.
- Authentication requires a valid JWT signature, a live database session and an active user. Session expiry slides from last use; the database session is authoritative. Preserve revocation, production cookie flags, CSRF checks, atomic 2FA challenge consumption and trusted-proxy login limits. See docs/AUTH_ADMIN_SETTINGS.md.
- Mail has Download and Sync modes, provider writebacks, and optional server deletion. Read docs/MAIL_MODES.md and docs/MAIL_SYNC.md before changing message identity, folders, read/star/move behavior, or deletion.
- Backup/import/restore is experimental and has durable jobs and recovery-format contracts. A change to stored data may need a migration, backup/export mapping, restore mapping, and tests. Do not test against a live database or real uploads.
- Optional modules affect navigation, API access, background work, search, and offline reads. Calendar and ToDo share one module, as do Recordings and Music; their pages are shown, hidden and ordered separately (page preferences), but enabling stays per module. A route affecting another module must check that module and its restore lock before side effects, regardless of its URL prefix. See docs/MODULES.md.
- MariaDB 10.11 or later is required; Compose uses 11.8 LTS, and CI runs the API tests and the instance backup drill on 13.0 as well (the TrueNAS catalog's version). Keep database sessions and DATETIME handling in UTC. Historical MYSQL_* configuration names, mysql2 and *-mysql-integration.test.cts filenames still apply to MariaDB.

## Code style and change shape

- Frontend code is TypeScript with React components and hooks; backend source is strict TypeScript compiled to CommonJS. Classic browser workers are authored in workers/ and emitted as JavaScript. Match the surrounding file's naming and formatting instead of reformatting unrelated code. Use the existing API helpers, query keys, hooks, and UI components before adding parallel ones.
- Keep route handlers focused on HTTP concerns and put reusable domain behavior in api/src/services/. Validate external input at the boundary. Use parameterized SQL and explicit ownership checks. Preserve the existing mail/CalDAV outbound-network and TLS checks.
- Account for pending, failure, retry, cancellation, and stale responses in asynchronous UI work. In particular, do not let a late response show data from the previous account or an earlier mail selection.
- Change only the needed layers, but follow a behavior through all affected layers: UI, API, database, workers, offline snapshot, backup/restore, and documentation. Avoid dependencies and abstractions that solve no current requirement. Comments should explain a constraint or reason that the code alone does not show.
- Database schema: database-baseline.ts is the frozen 0.16.0 starting schema of new databases (upgrade steps 1 to 11), never change it; every schema change is a new numbered migration in database.ts, then regenerate `docker/mariadb/schema.sql` with `scripts/local-db.sh schema-dump`.
- Tests should prove observable behavior and important failure paths with synthetic data. Do not copy a real mailbox, database, contact list, or server volume into a test fixture.
- Keep a test only if a real failure would make it fail: lost, duplicated or wrongly shown data, a security or privacy boundary, a recovery or concurrency rule, or a user-visible flow. Prefer the real thing: the disposable test MariaDB (`*-mysql-integration.test.cts`), the real request handler, the installed IMAP wire peer, and rendered components with only the network mocked. Reject brittle SQL/config text, incidental labels/layout and duplicate helper assertions. Approved visual baselines, non-overlapping hit-target geometry, keyboard focus and pinned UI behavior are legitimate regression checks under docs/UI_ACCEPTANCE.md. Extend an existing scenario instead of adding a near-duplicate. When a fake database fixture breaks on a harmless query change, prefer moving that case to a real-database test over patching the fixture.

## Change size

Maintainer's rules of 2026-11-15 ([P-42](PROJECT-PREFERENCES.md#p-42-small-parts-a-blocking-bar-for-reviews-one-test-layer-per-behaviour)), from the review of 0.23.0 to 0.30.0: pull requests of 10,000 to 35,000 lines were too large to review well, and behaviours were tested and described several times over.

- **Parts.** Build a version as parts of at most about 3,000 production lines along its seams. Each part is reviewed on its own before it joins `feat/0.N.0-<theme>`; the release pull request carries the version change and gets the review of the whole flows. The product decisions are answered before the build starts.
- **Patch releases.** One branch per patch release, one commit per fix, one review, one CI run. Only a fix that must ship alone and at once gets a release of its own.
- **One owning test layer per behaviour.** A server rule (permission, policy, ownership, recovery) is proven by a real-database test through the request handler. A user flow is proven by an e2e test. A component test is for state only the client has: stale responses, account switches, focus. Do not prove the same behaviour again at another layer: a user-visible change to a server rule gets one e2e test of the flow and the rule's cases (stranger, revoked member, refused policy) in the real-database test.
- **Tests and documents scale with the change.** A small fix gets the one test that fails without it and a CHANGELOG line, not a new document or a new test file per layer.
- **Say it once.** CHANGELOG.md tells users what changed. One feature page in docs/ holds the contract. docs/UPGRADING.md holds only what an upgrade requires someone to do. PROJECT-PREFERENCES.md holds the decision. Link instead of repeating.
- **Comments.** One line for the reason the code cannot show. No version numbers, foundation or decision ids, review rounds or history in code and tests.
- **A review fix stays small** ([Code review](docs/agents/review.md)): it adds no table, migration, queue, lock layer, route, state or option.
- **Test tooling and CI changes** ship in a pull request of their own, never inside a fix release.

## Private data and checks before committing

- Never commit real passwords, API tokens, private keys, .env values, database contents, email, contacts, calendar data, recordings, logs, screenshots, or other personal information.
- Keep any real data needed for local development under .private/ or outside the repository. .private/ is ignored by Git and Docker. Do not force-add ignored files.
- Use made-up data and reserved example domains in source, tests, fixtures, documentation, and screenshots intended for the repository.
- Before committing or pushing, review the staged diff and staged filenames for private data. Check content as well as filenames: .gitignore does not protect a file that is already tracked or data pasted into source code.
- If private data was committed, stop before pushing. Remove it from the commit and rotate any exposed credential. If it was already pushed, flag that history may still contain it.
