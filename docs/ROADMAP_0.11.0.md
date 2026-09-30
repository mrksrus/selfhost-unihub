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
   *Still open:* `src/test/mail-flag-interactions.test.tsx` ("keeps an unresolved
   HTTP admission visible…") failed once in two full runs and passes alone.
4. **Split `src/pages/MailPage.tsx` (3,184 lines, ~42 `useState`).** Extract the
   message list, reader, toolbar/bulk actions and dialogs into
   `src/components/mail/`, each with its own hook. Smaller units make it easier
   to guarantee that a late response never shows the wrong account or message.
   *Not done.* A first extraction step was started and saved, unmerged, as
   branch `worktree-agent-ab4ba6c5408d19dbc` ("WIP: start splitting MailPage",
   `src/components/mail/mail-page-model.ts`). Continue from there or restart.
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

7. **Enable strict TypeScript.** `tsconfig.app.json` has `strict: false`, but
   `--strict` currently produces only 11 errors (9 in
   `src/components/games/AIGame.tsx`, 1 in `use-calendar-notifications.tsx`,
   1 in a test). Fix them, enable `strict`, and keep it on.
8. **Remove unused frontend code.** Not imported anywhere:
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
9. **Remove dead mail code and duplicates.** The retired `syncMailAccountOnce`
   (~200 lines), `withFencedMailAccountLock`, `recoverUncertainOperations`,
   `finishOperationAttempt`, `reconcileLegacyMove`, and the legacy
   `executeOperation`/`legacyReadRemote` in `mail-writebacks.js`. Merge the
   `transaction()` copies in `operations.js`/`reconciliation.js` into
   `repository.withTransaction`, and use `repository.recordReceipt/getReceipt`
   in `mutateMessages` and the bulk-move route (the inline `SELECT … FOR UPDATE`
   then `INSERT` can deadlock on concurrent requests with the same key).
10. **Two mail job runners.** `mail-writebacks.js runWritebacks` (in-process
    queue that claims `operation`/`reconcile` jobs) and the durable scheduler's
    `runDurableMailJob` both execute operation jobs. Consolidate on the durable
    scheduler so there is one worker path, one connection lifecycle and one
    place for pause/background rules.
11. **One source of truth for the database schema.** Today the schema lives in
    `docker/mysql/init/01-schema.sql` (tests only), ~900 lines of
    add-column-if-missing code in `database.js ensureLegacySchema` that runs on
    every startup, and the numbered migrations. Freeze the legacy code as a
    baseline, make every future change a numbered migration, and generate or
    test `01-schema.sql` against a migrated database.
12. **Run the API as a non-root user** inside the container. Nginx already
    drops its workers to the nginx user; `service-supervisor.js` could start the
    Node API with a dedicated uid/gid, with `/app/uploads` owned by that user.
13. **Split the largest backend files** by area: `api/src/services/mail.js`
    (~2,000 lines), `api/src/routes/mail.js` (~1,900), `api/src/services/backup.js`
    (~2,400).
14. **One changelog.** Merge the 13 `docs/RELEASE_0.10.*.md` files and the root
    `RELEASE_v0.9.20.0.md` into `CHANGELOG.md`.
15. **Commit `AGENTS.md`** (currently untracked).

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
