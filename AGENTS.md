# UniHub agent guide

UniHub is a self-hosted app for mail, contacts, calendars, tasks, notes, recordings, and optional games. People trust it with private data. Favor correct ownership, recoverability (Data Structure for backups and imports), and clear behavior over clever abstractions. These are project defaults; the task and the maintainer's instructions take priority.
The goal of the App is to have a centralized Service as a PWA that connects to Mailing and has contacts and events, so you can access them with only one log in. So if you move to a newer device you sign in once and get the PWA and you have access to everything again. 
## How the app fits together

    React/TypeScript PWA -> Nginx -> Node HTTP API -> MySQL
                                          |-> /app/uploads (files and backups)
                                          |-> IMAP, SMTP, CalDAV, Web Push

The standard deployment is one app container and one MySQL container. Nginx serves the built frontend and proxies /api/* to the Node API. Mail and backup workers use in-process coordination, so do not assume that multiple API replicas are safe. Read [architecture](docs/ARCHITECTURE.md) for detailed contracts and [development](docs/DEVELOPMENT.md) for local setup.

| Area | Start here |
| --- | --- |
| Routes and page entry points | src/App.tsx, then the feature in src/pages/ |
| Shared layout and navigation | src/components/layout/, src/components/GlobalCommandPalette.tsx |
| UI primitives, tokens, and theme | src/components/ui/, src/index.css, tailwind.config.ts, src/components/theme/ |
| Browser API calls and state | src/lib/, src/hooks/, src/contexts/AuthContext.tsx, src/components/SessionQueryProvider.tsx |
| Offline and PWA behavior | src/lib/offline.ts, src/lib/pwa-update.ts, src/utils/service-worker.ts, public/sw-custom.js |
| API startup and request boundary | api/server.js, api/src/app.js, api/src/request-handler.js, api/src/routes/ |
| Domain logic and persistence | api/src/services/, api/src/security/, api/src/services/database.js |
| Tests and deployment | src/test/, api/tests/, Dockerfile, docker-compose.yml, .github/workflows/ |

For feature details, follow the corresponding file in docs/ rather than treating this guide as a second specification. Mail work usually spans src/pages/MailPage.tsx, src/lib/mail-api.ts, src/hooks/use-mail-queries.ts, api/src/routes/mail.js, and the api/src/services/mail-* files. Backup and restore work spans api/src/services/backup*, export-jobs.js, and docs/DATA_RECOVERY.md.

## Contracts to keep intact

- The API is a vanilla Node HTTP server, not Express. request-handler.js normalizes parameterized paths, then handles CORS, authentication, CSRF, module access, body limits, and dispatch. Add new routes through that boundary.
- User data is owner-scoped. Keep user_id checks on queries, file access, background jobs, exports, and restores. Admin-only operations need an explicit role check.
- Browser session state is account-specific. SessionQueryProvider clears private query data on account change. Offline snapshots in IndexedDB are read-only, owner/epoch-scoped copies; a cached profile is not an authenticated server session. API responses are not service-worker cached.
- Mail has Download and Sync modes, provider writebacks, and optional server deletion. Read docs/MAIL_MODES.md and docs/MAIL_SYNC.md before changing message identity, folders, read/star/move behavior, or deletion.
- Backup/import/restore is experimental and has durable jobs and recovery-format contracts. A change to stored data may need a migration, backup/export mapping, restore mapping, and tests. Do not test against a live database or real uploads.
- Optional modules affect navigation, API access, background work, search, and offline reads. Check both the UI guard and backend module checks when adding or changing a feature.

## Visual style

- Preserve UniHub's black, white, and blue identity unless the task asks for a redesign. Dark is the default; Light and System must also work. Use the semantic CSS variables in src/index.css through Tailwind classes, including the existing module and success/warning/destructive colors. Avoid hard-coded colors in feature views.
- Use Inter for interface text and JetBrains Mono where code or fixed-width data helps. Keep headings and actions in plain, sentence-case language. Let spacing, type, and alignment show hierarchy; add borders, cards, gradients, or motion only when they clarify a real distinction.
- Reuse src/components/ui/ controls and their variants. Keep feature-specific layout in the feature component. Do not create a new visual treatment for a common control when an existing variant fits.
- The desktop shell has a sidebar; narrow screens use a header and bottom navigation. Check both widths, long content, scrolling, touch targets, and safe-area clearance. A change should remain usable with keyboard focus, visible errors, useful empty/loading states, sufficient contrast, and reduced motion.
- Treat displayed email as untrusted content. Keep SafeEmailContent and its privacy controls in charge of HTML mail and remote images; do not render sender HTML as ordinary application UI.
- ( Per user Customization for Colors is planned for future releases,  but the general Style is intended to remains as is)

## Code style and change shape

- Frontend code is TypeScript with React components and hooks; backend code is CommonJS JavaScript. Match the surrounding file's naming and formatting instead of reformatting unrelated code. Use the existing API helpers, query keys, hooks, and UI components before adding parallel ones.
- Keep route handlers focused on HTTP concerns and put reusable domain behavior in api/src/services/. Validate external input at the boundary. Use parameterized SQL and explicit ownership checks. Preserve the existing mail/CalDAV outbound-network and TLS checks.
- Account for pending, failure, retry, cancellation, and stale responses in asynchronous UI work. In particular, do not let a late response show data from the previous account or an earlier mail selection.
- Change only the needed layers, but follow a behavior through all affected layers: UI, API, database, workers, offline snapshot, backup/restore, and documentation. Avoid dependencies and abstractions that solve no current requirement. Comments should explain a constraint or reason that the code alone does not show.
- Tests should prove observable behavior and important failure paths with synthetic data. Do not copy a real mailbox, database, contact list, or server volume into a test fixture.

## Working and verification

- Use Node.js 24 or newer. Install frontend and API dependencies separately with npm ci and npm --prefix api ci when needed.
- Run focused tests for the code changed. Frontend checks are npm run typecheck, npm run lint, and npm test -- <test-file>; backend tests use node --test api/tests/<file>.test.js or npm --prefix api test. MySQL integration tests need a disposable configured database.
- For UI changes, inspect the actual result at desktop and mobile widths in dark and light themes. For PWA, offline, push, or updates, verify the relevant browser state and consult docs/PWA.md and docs/OFFLINE.md. Report what was and was not verified.
- Update the relevant feature documentation when a user-visible behavior or cross-component contract changes. Keep this file short and revise a stale rule instead of appending a conflicting one.
- Add a CHANGELOG.md entry under the upcoming version for every user-visible change.

## Private data in this repository /  Checks before commiting

- Never commit real passwords, API tokens, private keys, .env values, database contents, email, contacts, calendar data, recordings, logs, screenshots, or other personal information.
- Keep any real data needed for local development under .private/ or outside the repository. .private/ is ignored by Git and Docker. Do not force-add ignored files.
- Use made-up data and reserved example domains in source, tests, fixtures, documentation, and screenshots intended for the repository.
- Before committing or pushing, review the staged diff and staged filenames for private data. Check content as well as filenames: .gitignore does not protect a file that is already tracked or data pasted into source code.
- If private data was committed, stop before pushing. Remove it from the commit and rotate any exposed credential. If it was already pushed, flag that history may still contain it.
