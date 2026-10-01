# 0.11.0 follow-up roadmap

Working list for making 0.11.0 a stable baseline. It combines the review of the
0.11.0 mail engine candidate (`feat/mail-engine-0.11.0`) with a general codebase
assessment made on 2026-09-30. Items are ordered by priority: first it must work,
then it must look right and never get stuck, then long-term maintainability.

P1 (correctness, deployment safety) was addressed on 2026-09-30: stuck
operation states, the background setting, canary holds, manual-vs-follow-up
syncs, IMAP connection reuse and MySQL 8.4. See `RELEASE_0.11.0.md`. Live
verification on the maintainer's server is still pending. This file tracks what
comes after.

## Open from the P1 work

- **Done (2026-09-30): A sent MOVE that cannot be proven can stay in attention forever.** When a
  MOVE was sent but no COPYUID arrived and the bounded outcome check cannot find
  the message, it stays `needs_attention`. By design it cannot be discarded
  (the move may have happened), so it blocks account purge and any newer move
  of that message. Add an explicit "Accept server state" action: mark the
  operation resolved without any provider write, then run a manual sync so the
  local copy follows wherever the message really is.
  *Done:* `POST /api/mail/writebacks/:id/accept-server-state` (only a
  dispatched MOVE in `needs_attention`) sets it `superseded`/`done`, not
  current, evidence reason `user_accepted_server_state`, attempts untouched,
  then queues a manual sync; the UI shows it behind a confirmation.
- **New SQL not yet run on MySQL.** The due-scan backoff subquery, cancel/retry
  transactions, epoch-change updates and canary-hold precedence are covered by
  unit tests with fake databases only. Run the MySQL integration suite
  (`npm --prefix api run test:ci` with a disposable database, or CI) before
  tagging.
- **Connection reuse relies on node-imap internals** (`_enqueue('NOOP')`,
  `_queue`, `_curReq`). Pinned to node-imap 0.8.19; revisit with ImapFlow.

## P2: Looks right in the UI and never gets stuck

1. **Done (2026-09-30): Prune finished mail engine jobs.** `enqueueJob` inserts a new
   `mail_engine_jobs` row whenever the previous job of that kind has finished,
   and nothing deletes finished rows. Periodic sync and retries add many rows per
   account per day. Delete `idle`/`cancelled`/`error` jobs older than N days on a
   timer (like the existing session cleanup in `api/src/app.js`), keep the latest
   row per account/kind for status, and check backup/export expectations.
   *Done:* `runtime.pruneFinishedJobs`, hourly from `app.js`: 7 days, 1,000
   rows per statement, 20 batches per run; keeps the newest job per
   account/kind/mailbox and all jobs of an unsettled operation. Jobs are
   ephemeral in backups, so nothing else depends on the history.
2. **Done (2026-09-30): Run expired-lease recovery on a timer, not every poll.**
   `recoverExpiredJobs` (runtime.js) runs from the durable scheduler's `drain()`
   on every 1 s poll, enqueue and job completion. It updates rows for all
   accounts and takes locks on `mail_writebacks` and `mail_engine_accounts`
   (`lease_owner IS NOT NULL` has no index). Run it at startup and every
   10–30 s instead; lease expiry is measured in tens of seconds anyway.
   *Done:* time-gated in `drain()` (start, then every 15 s); `claimDueJob`
   skips an account whose expired lease is not yet recovered. No new index:
   `mail_engine_accounts` has one row per mail account and already has
   `idx_engine_account_lease`; the job and writeback updates use
   `idx_job_lease` and `idx_mail_writeback_state`.
3. **Fix the flaky frontend test** `src/test/mail-retention-controls.test.tsx`
   ("disconnects by default without purging…"). It failed once in a full
   `vitest run` and passed three times in isolation, so it is likely a timeout
   or timing race under load.
   *Done 2026-09-30* (commit "Fix flaky mail retention controls test").
   *Done 2026-09-30 for `src/test/mail-flag-interactions.test.tsx`* ("keeps an
   unresolved HTTP admission visible…"): reproduced with six full suites in
   parallel. Fixtures resolve at once, but the first mail page render in a
   worker (~0.9 s to the first row) and cold `*ByRole` queries over the page
   DOM (~1.3 s each) ran into Testing Library's 1 s wait and Vitest's 5 s test
   limit. The whole-page mail tests (flag interactions, page UI, retention
   controls) share a 5 s wait / 20 s test budget in
   `src/test/helpers/mail-page-budget.ts`; they now pass under that load.
   `notification-event-links` (calendar) still fails under six parallel suites
   (a 1 s `waitFor`), not under a normal full run.
4. **Split `src/pages/MailPage.tsx` (3,184 lines, ~42 `useState`).** Extract the
   message list, reader, toolbar/bulk actions and dialogs into
   `src/components/mail/`, each with its own hook. Smaller units make it easier
   to guarantee that a late response never shows the wrong account or message.
   *Done 2026-09-30:* `MailPage.tsx` is a ~200-line composition layer. Hooks:
   `use-mail-folder-view`, `use-mail-list-view`, `use-mail-list-selection`,
   `use-mail-bulk-actions`, `use-mail-compose`, `use-mail-account-editor`,
   `use-mail-account-removal`, plus `useMailReaderRefresh` and
   `useRememberedMailAccount`. Components: `MailSidebar`, `MailListToolbar`,
   `MailMessageList`, `MailReader`, `MailCompose`, `MailAccountDialog`,
   `MailAccountRemovalDialogs`, `MailFolderDialogs`; shared types and helpers in
   `mail-page-model.ts`. Stale responses: the reader drops a message load still
   in flight when the account view changes, the list selection is stored with
   its account/folder view, and a late purge preview no longer fills a later
   or closed dialog (tests in `mail-reader` and `mail-stale-state`). The DOM was
   compared against the old page in 14 desktop/mobile interaction scenarios.
   The sync coverage explanation moved from above the list into the sync panel
   ("About sync coverage"). Converting mail to the shared page states (item 6)
   is still open.
5. **Use one toast system.** `use-toast` (Radix) is used in 16 files and
   `sonner` in 2, and both `<Toaster />` and `<Sonner />` are mounted in
   `src/App.tsx`. Pick one and remove the other.
   *Done 2026-09-30:* kept Radix `use-toast`; removed the `<Sonner />` mount,
   `src/components/ui/sonner.tsx`, the unused `src/components/ui/use-toast.ts`
   re-export and the `sonner` package.
6. **Consistent loading, empty and error states** across pages (mail, contacts,
   calendar, todo, recordings), reusing the same components.
   *Done 2026-09-30 for non-mail pages:* `LoadingState`, `EmptyState` and
   `ErrorState` (with "Try again") in `src/components/ui/page-states.tsx`, used by
   contacts, calendar, todo, recordings, music, notes, dashboard, admin users and
   settings (general, security, modules, data, mail rules). The mail page is
   not converted yet; do that with the split in item 4.

## P3: Future-proofing and tech debt

7. **Done (2026-09-30): Enable strict TypeScript.** `tsconfig.app.json` has `strict: false`, but
   `--strict` currently produces only 11 errors (9 in
   `src/components/games/AIGame.tsx`, 1 in `use-calendar-notifications.tsx`,
   1 in a test). Fix them, enable `strict`, and keep it on.
   *Done:* `strict` and `noUnusedLocals` are on in `tsconfig.app.json` (one more
   error, in `api.ts`, was hidden by `noImplicitAny: false`); no `any` added.
8. **Done (2026-09-30): Remove unused frontend code.** Not imported anywhere:
   - Pages: `src/pages/Index.tsx`, `src/pages/Install.tsx`.
   - 20 components in `src/components/ui/`: accordion, aspect-ratio, breadcrumb,
     calendar, carousel, chart, context-menu, drawer, form, hover-card,
     input-otp, menubar, navigation-menu, popover, radio-group, resizable,
     scroll-area, sidebar, toggle-group, toggle.
   - Packages only used by those: `recharts`, `embla-carousel-react`, `vaul`,
     `input-otp`, `react-resizable-panels`, `react-day-picker`,
     `react-hook-form`, `@hookform/resolvers`. (Found by searching imports; run
     a build after removing.)
   - Rename `CalendarPageRefactored.tsx`/`TodoPageRefactored.tsx` to
     `CalendarPage.tsx`/`TodoPage.tsx` and delete the one-line re-export files.
   *Done:* popover is used (sync panel) and kept; skeleton, toggle-variants,
   `NavLink.tsx` and 10 unused Radix packages were removed too. The main chunk
   did not change (tree-shaking already dropped them).
9. **Done (2026-09-30): Remove dead mail code and duplicates.** The retired `syncMailAccountOnce`
   (~200 lines), `withFencedMailAccountLock`, `recoverUncertainOperations`,
   `finishOperationAttempt`, `reconcileLegacyMove`, and the legacy
   `executeOperation`/`legacyReadRemote` in `mail-writebacks.js`. Merge the
   `transaction()` copies in `operations.js`/`reconciliation.js` into
   `repository.withTransaction`, and use `repository.recordReceipt/getReceipt`
   in `mutateMessages` and the bulk-move route (the inline `SELECT … FOR UPDATE`
   then `INSERT` can deadlock on concurrent requests with the same key).
   *Done:* removed those functions plus what only they used (`mail-server-follow.js`,
   the in-memory `createMailSyncScheduler`, `syncMailFolder`, raw-part rebuilders);
   receipts now claim the key with an INSERT first (`recordReceipt`/`finishReceipt`),
   proven by a concurrent same-key MySQL test. The two `transaction()` helpers were
   already one-line wrappers around `repository.withTransaction` and stay.
10. **Done (2026-10-01): Two mail job runners.** `mail-writebacks.js runWritebacks` (in-process
    queue that claims `operation`/`reconcile` jobs) and the durable scheduler's
    `runDurableMailJob` both execute operation jobs. Consolidate on the durable
    scheduler so there is one worker path, one connection lifecycle and one
    place for pause/background rules.
    *Done:* the in-process queue (`runWritebacks`/`startWritebacks`/`drainWritebacks`/
    `stopWritebacks`/`processPending`) is gone; `runDurableMutationJob` (now in `mail-durable-jobs.js`)
    runs operation/reconcile jobs. Admission and the due scan enqueue and call
    `runMailOperationsNow` (yield same-account reads, then drain). The scheduler runs
    3 jobs, at most 2 read-only, so one slot is always free for provider changes.
11. **Done (2026-09-30): One source of truth for the database schema.** Today the schema lives in
    `docker/mysql/init/01-schema.sql` (tests only), ~900 lines of
    add-column-if-missing code in `database.js ensureLegacySchema` that runs on
    every startup, and the numbered migrations. Freeze the legacy code as a
    baseline, make every future change a numbered migration, and generate or
    test `01-schema.sql` against a migrated database.
    *Done:* `ensureLegacySchema` frozen; `01-schema.sql` generated by `scripts/local-mysql.sh schema-dump`
    and checked by a MySQL test. Follow-up: upgraded 0.9.x installs keep `color DEFAULT '#22c55e'` on
    `calendar_calendars`/`calendar_events` (fresh: `'#2563eb'`); aligned by migration 9 `calendar-color-default`.
12. **Done (2026-09-30): Run the API as a non-root user** inside the container. Nginx already
    drops its workers to the nginx user; `service-supervisor.js` could start the
    Node API with a dedicated uid/gid, with `/app/uploads` owned by that user.
    *Done:* the supervisor spawns the API as `unihub` (10001:10001); `start.sh`
    chowns uploads only when ownership differs; the container smoke test checks
    the API's uid/gid/capabilities and a root-owned legacy volume.
13. **Done (2026-10-01): Split the largest backend files** by area: `api/src/services/mail.js`
    (~2,000 lines), `api/src/routes/mail.js` (~1,900), `api/src/services/backup.js`
    (~2,400).
    *Done:* pure moves. `services/mail.js` re-exports `mail-host-policy`, `mail-folders`,
    `mail-durable-jobs`, `mail-sync-control`, `mail-server-delete` and `mail-send`;
    `routes/mail.js` combines `mail-folders`, `mail-accounts`, `mail-drafts`, `mail-messages`,
    `mail-operations` and `mail-sync` (helpers in `mail-route-helpers`); `services/backup.js`
    re-exports `backup-common`, `backup-export`, `backup-validate`, `backup-restore-mapping`,
    `backup-zip-reader` and `backup-import`. `importBackupForUser` stays one ~650-line function.
14. **Done (2026-09-30): One changelog.** Merge the 13 `docs/RELEASE_0.10.*.md` files and the root
    `RELEASE_v0.9.20.0.md` into `CHANGELOG.md`.
    *Done:* root `CHANGELOG.md`; only `RELEASE_0.10.13.md` and `RELEASE_0.11.0.md`
    remain for GitHub releases.
15. **Done (2026-09-30): Commit `AGENTS.md`.** It is tracked in git.

## P4: Next version (0.12)

16. **Replace `imap-simple`/`node-imap` with ImapFlow.** Both are unmaintained
    since around 2019–2022. 0.11.0 already works around them
    (`mail-imap-conditional-store.js` uses raw `imap` for CONDSTORE). ImapFlow is
    maintained, promise-based, supports CONDSTORE/QRESYNC/MOVE/IDLE, and
    serializes commands on one connection. Do this after 0.11 has settled so
    the engine and the transport do not change at the same time.
17. **Decide the scope of the Games module.** `AIGame.tsx` alone is 1,463 lines
    and holds most of the strict-mode errors. Freeze it, or move it to a
    separate optional package.
18. **Push instead of polling** for sync/operation status (Server-Sent Events).
    The UI polls every 3–30 s today (`use-mail-sync-jobs.ts`, `MailSyncStatus.tsx`,
    `use-mail-queries.ts`).
19. **IMAP IDLE for INBOX** once on ImapFlow, so new mail arrives without
    periodic polling.

## Notes on decisions kept on purpose

- `docker-compose.yml` keeps `:latest` with `pull_policy: always` so a container
  restart is the update. The file documents the alternatives. Because database
  migrations are one-way, take a backup before a restart that may pull a new
  release.
- Mail and backup workers use in-process coordination, so the API must run as a
  single replica. That is fine for self-hosting; keep it documented.
