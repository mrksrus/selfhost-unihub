# 0.11.0: calmer mail sync and a stable baseline

0.11.0 finishes the durable mail engine that shipped as a preview in
[0.10.13](RELEASE_0.10.13.md). It fixes the queues that stopped draining on real
Gmail, iCloud and self-hosted accounts, moves sync status out of the way, and
cleans up the UI and code that later work builds on.

**Back up MySQL and uploads before updating.** No new migration is required
compared with 0.10.13; updating from 0.10.12 or older runs the 0.10.13
migrations. See [upgrading](UPGRADING.md).

## Mail sync fixes

- **Queues no longer starve.** One busy account's backlog could fill the
  scheduler's candidate window and stop every other account from syncing. Only
  accounts that can run now are considered.
- **Database deadlocks are retried.** Lock conflicts between the scheduler and
  the due-work pass were aborting whole passes and failing sync jobs. Deadlocked
  transactions now run again, and the due-work pass skips a contended row
  instead of stopping.
- **Gmail sync no longer fails on duplicate system folders.** A second mailbox
  that looks like a system folder (for example a label "Sent" next to
  `[Gmail]/Sent Mail`) becomes its own folder instead of failing every sync.
- **iCloud sync no longer fails on out-of-spec mod-sequences.** An invalid
  `HIGHESTMODSEQ`/`MODSEQ` is treated as "no CONDSTORE" for that mailbox.
- **A failing change no longer blocks the others.** It is counted, backs off,
  ends in "needs attention" after 8 attempts, and its reason is written to the
  server log (`[MAIL OPERATION]`, never to the database or UI).
- **Accept server state.** A sent move whose result cannot be proven can now be
  resolved from the sync panel: UniHub stops tracking it, sends nothing to the
  provider and syncs the account again.
- Finished mail jobs are pruned after 7 days, and lease recovery runs every
  15 seconds instead of on every scheduler poll.

## Interface

- **Sync status lives in the sync button.** The pending-changes sentence and the
  per-account rows above the mail list are gone. The toolbar sync button shows a
  spinner while syncing (✕ on hover on desktop), a badge with the number of
  changes waiting for the server, and an amber dot when something needs you. It
  opens a sync panel (popover on desktop, bottom sheet on phones) with each
  account's status, Cancel / Sync now, the waiting changes with Retry, Discard
  and Accept server state, and a Background sync switch.
- The only inline notice above the list is one line when changes need your
  decision: "N changes need your attention · Review".
- Consistent loading, empty and error-with-retry states on Contacts, Calendar,
  Todo, Recordings, Music, Notes, Dashboard, Admin users and Settings. Failed
  loads no longer look like empty lists, Save preferences is disabled until
  preferences have loaded, and 2FA status errors no longer offer "Set up 2FA".
- One toast system (the unused `sonner` toaster was removed).

## Under the hood

- `MailPage.tsx` is split into focused components and hooks.
- New real-MySQL integration tests cover job pruning, the claim filter, the
  due-work back-off, Accept server state, mailbox epoch changes and deadlock
  retry.
- Flaky frontend tests were fixed.

## Not verified before release

- The new interface was not reviewed in a browser before publishing (desktop and
  phone, dark and light). Please report anything that looks off.
- Provider behaviour was fixed from live diagnostics; confirm on your accounts
  that the change count goes down after updating. If one change keeps failing,
  `docker logs unihub 2>&1 | grep "MAIL OPERATION"` shows why.

## Compatibility and limits

- Native IMAP MOVE is required for provider moves.
- CONDSTORE is provider-dependent. Without it (including iCloud mailboxes with
  invalid mod-sequences), a change made by another client between UniHub's read
  and write cannot be detected atomically.
- Backups use data schema 4, which 0.10.12 and older cannot read.
