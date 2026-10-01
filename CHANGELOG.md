# Changelog

All notable user-visible changes to UniHub, newest first. Each release is
published as the container image `ghcr.io/mrksrus/selfhost-unihub:<version>`.
Read the [upgrade guide](docs/UPGRADING.md) before updating an existing
installation, and keep a consistent backup of MySQL, uploads, configuration and
secrets. Releases between 0.9.20.0 and 0.10.0 have no entry here.

## 0.11.1 (unreleased)

### Security

- **The API no longer runs as root in the container.** The Node API runs as the
  `unihub` user (uid/gid 10001) without capabilities; Nginx is unchanged. The
  first start after updating hands `/app/uploads` over to that user. If you
  bind-mount uploads from the host, it must be writable by uid 10001. See
  [upgrading](docs/UPGRADING.md#0111-non-root-api).

### Fixes

- **Retried mail actions no longer fail on a database deadlock.** Two identical
  requests with the same `Idempotency-Key` (for example a move or read change
  resent after a slow response) could deadlock and one of them failed. The
  second request now waits and returns the first one's result.
- **Correct due times on MySQL servers not set to UTC.** The API now switches
  every database connection to UTC. Before, a MySQL server with a different
  default time zone shifted scheduled work, expiries and timestamps by hours.

### Maintenance

- Removed the retired pre-0.11 mail sync code and other unused mail helpers.
- Mail has one job runner. Read/star/move changes now run on the same durable
  scheduler as sync instead of a separate in-process queue. One worker slot is
  kept free for these changes, so a click starts right away even while other
  accounts are syncing long folders.
- Split the three largest API files (mail service, mail routes, backup service)
  into smaller modules by area. No behavior change.

## 0.11.0

*Calmer mail sync and a stable baseline*

0.11.0 finishes the durable mail engine that shipped as a preview in
[0.10.13](docs/RELEASE_0.10.13.md). It fixes the queues that stopped draining on real
Gmail, iCloud and self-hosted accounts, moves sync status out of the way, and
cleans up the UI and code that later work builds on.

**Back up MySQL and uploads before updating.** No new migration is required
compared with 0.10.13; updating from 0.10.12 or older runs the 0.10.13
migrations. See [upgrading](docs/UPGRADING.md).

### Mail sync fixes

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

### Interface

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

### Under the hood

- `MailPage.tsx` is split into focused components and hooks.
- New real-MySQL integration tests cover job pruning, the claim filter, the
  due-work back-off, Accept server state, mailbox epoch changes and deadlock
  retry.
- Flaky frontend tests were fixed.

### Not verified before release

- The new interface was not reviewed in a browser before publishing (desktop and
  phone, dark and light). Please report anything that looks off.
- Provider behaviour was fixed from live diagnostics; confirm on your accounts
  that the change count goes down after updating. If one change keeps failing,
  `docker logs unihub 2>&1 | grep "MAIL OPERATION"` shows why.

### Compatibility and limits

- Native IMAP MOVE is required for provider moves.
- CONDSTORE is provider-dependent. Without it (including iCloud mailboxes with
  invalid mod-sequences), a change made by another client between UniHub's read
  and write cannot be detected atomically.
- Backups use data schema 4, which 0.10.12 and older cannot read.

## 0.10.13

*Durable mail engine preview*

This release ships the new durable mail engine planned for 0.11.0, plus review
fixes. 0.11.0 follows once the UI and stability work in
[the roadmap](docs/ROADMAP_0.11.0.md) (P2) is done. The engine itself is described in
[the 0.11.0 notes](docs/RELEASE_0.11.0.md).

**Back up MySQL and uploads before updating.** Database migrations run on
startup and cannot be undone by switching back to an older image. Backups made by
this version use data schema 4, which 0.10.12 and older cannot read.

### Changed

- Mail changes (read, star, move) are durable operations with explicit
  accepted / pending / confirmed / needs-attention states. A move that may have
  reached the provider is never sent twice.
- Mail sync runs as bounded, resumable jobs per folder and stream instead of one
  long scan per account.
- One IMAP session per account is reused between jobs, bulk changes run in
  batches of up to 50 on one connection, and the periodic wake-up only follows
  INBOX every 30 seconds. Full folder discovery runs at most every 5 minutes.
- The bundled `docker-compose.yml` uses MySQL 8.4 LTS. Switch the database image
  as a separate step after the application update; see [upgrading](docs/UPGRADING.md).
  Comments in the file list the image tag and pull policy options.

### Fixed

- Stuck operations: every state has a working Retry or Discard, and the due-work
  pass backs off per operation (15 s up to 1 h) instead of retrying every second.
- The Mail background setting is respected and no longer cleared by a single
  foreground action.
- Follow-up syncs after a change are no longer treated as manual refreshes.
- Operator canary holds can only be released with `mail-rollout.js release`.

### Known limits

- A move that was sent but whose outcome cannot be proven stays in
  needs-attention and cannot be discarded yet.
- Native IMAP MOVE is required for provider moves.

## 0.10.12

*Working provider writes and independent mail jobs*

### Fixed

- Correct conditional IMAP flag commands. The pinned `imap@0.8.19` library
  omitted the parentheses around `UNCHANGEDSINCE`, causing real servers to reject
  read/star updates. A narrow, version-checked protocol adapter sends the correct
  single-UID flag delta and treats tagged `MODIFIED` responses as conflicts. It
  does not remove conflict checks or replace all of a message's flags.
- Mail sync is queued per account instead of treating any account's active sync
  as completion for everyone else. The API acknowledges acceptance promptly;
  owner-scoped status reports queued/running/progress/finished/error/cancelled
  states. At most two complete account syncs run concurrently.
- Read/star/move intents are accepted in a short database transaction rather
  than waiting for an account's entire provider scan. Provider commands remain
  serialized per account. Opposite flag intents are protected from stale worker
  completions; bulk acceptance retains all-or-nothing validation.
- An independent due-work pass runs at startup and every 30 seconds. Both direct
  and scheduled writebacks share a four-connection bound. Accounts waiting for
  sync do not consume independent provider-worker slots.
- Long syncs service accepted provider changes at safe checkpoints. A move
  invalidates and restarts the snapshot instead of applying stale location data;
  flags are read again before committing confirmed metadata.
- Verified, unambiguous new messages are imported during the scan, so later
  inventory churn does not discard their progress. Adjacent body reads reuse
  the selected folder; a bounded cache avoids duplicate reads where safe.
- The browser no longer says “Sync complete” for a queued or already-running
  request. Progress and cancellation are account-scoped. Other messages, views
  and accounts remain usable while a request/provider job is active.
- Background jobs are discovered without a reload; status polling recovers from
  temporary errors. Mail lists refresh during progressing imports at a bounded
  cadence without repeatedly refreshing the open reader or all other queries.
- Bulk actions deduplicate matching requests, preserve newer flag edits, and
  distinguish provider-pending acceptance from an actual failure.

### Safety and limits

No queue reset, account-mode change, historical flag upload, new schema migration,
volume, secret, or Compose change is required relative to 0.10.11. Existing
**pending** user intents can resume through the due worker. Failed/conflicting
operations still need review; uncertain provider moves are not blindly replayed.

Network confirmation is necessarily asynchronous: immediate UI feedback means
an intent was accepted, not that a disconnected provider has already applied it.
Busy job pools show queued work instead of pretending it completed. Reconciliation
of location/missing state is deliberately deferred if a complete consistent
inventory cannot be established; verified new imports remain saved. A continually
changing mailbox can therefore still report a reconciliation error.

The protocol adapter intentionally fails closed if its pinned IMAP dependency
changes. Dependency upgrades must rerun the actual-wire regression tests and
review the adapter. Providers without safe IMAP MOVE retain the existing safe
failure behavior; there is no unsafe COPY/EXPUNGE fallback.

### Validation and reproducibility

Before publication, **124 frontend tests** passed, along with TypeScript and lint
(zero errors; three existing unrelated Fast Refresh warnings). The API release
gate passed **394 tests with zero skips** against disposable MySQL 8 and Node 24.
The production Dockerfile also built successfully and reported version 0.10.12.
The publication workflow additionally requires container smoke checks before
pushing the tested image.

The IMAP regressions use the installed library over a local protocol peer, rather
than only mocking `addFlagsSince`/`delFlagsSince` method calls.

The opt-in [live mail acceptance test](docs/LIVE_MAIL_TESTING.md) uses normal public
API authentication/actions plus independent IMAP readback. It tests delivery,
incoming sync/content, prompt actions, rapid reversals, incoming external-client
changes, folder creation and moves with exact body preservation. A pending UI
flag or successful HTTP response alone cannot pass the test. Use a dedicated test
mailbox; this is not automatically run against an operator's personal messages.

A passing test on one provider is not a guarantee for all providers or networks.
Account backup/import/restore remain ALPHA.

### Updating

Keep a consistent database/uploads/configuration backup and existing encryption
keys. Follow [Upgrading](docs/UPGRADING.md) for older installations. Refresh the browser
or PWA after installing the new image so its UI and API contract match.

## 0.10.11

*Correct mail flags and responsive interactions*

### Fixed

- Mail list, detail and draft responses now explicitly decode database flags.
  MySQL can return computed flags as strings: JavaScript previously interpreted
  `"0"` as true, making unstarred or unread messages appear starred/read even
  though the Starred folder and stored flags were correct.
- Read and star actions keep list/detail caches consistent during a slow request,
  block duplicate submissions, preserve newer edits across stale detail responses,
  and roll back only the failed flag without undoing a concurrent successful edit.
- Accepted queued changes remain visible until provider settlement; pending UI
  distinguishes saving the request from waiting for the mail provider. An unstarred
  message leaves the Starred list without losing its open reader.
- Failed bulk flag actions show an error. A rejected bulk read no longer looks
  applied, even if the subsequent list refresh also fails.
- Provider-writeback polling no longer invalidates itself after every poll.
- A busy account rejects competing mutations/retries immediately with HTTP 409
  before queuing a write. No delayed action is applied after that rejection.
- IMAP has a 60-second socket inactivity timeout and 120-second per-command
  deadline, rather than a whole-import deadline. Cancellation closes stalled
  transport; account locks are retained through cleanup and durable outcome
  handling so another writer cannot race an uncertain provider result.

### Behavior and limits

This does not rewrite stored mail flags, change account modes, shorten successful
large imports to two minutes, or upload historical local flags. The provider stays
authoritative in Sync mode. A busy-account error means nothing was changed: retry
when syncing or the other operation finishes. This release does not permit
simultaneous provider mutations on the same account. Connection/authentication
cancellation can still await its handshake/socket timeout; arbitrary database
stalls are not covered by the IMAP command deadline.

### Validation

Before publication, the full frontend suite passed **113 tests**; TypeScript and
lint passed (three existing unrelated Fast Refresh warnings). The complete API
release gate passed **372 tests with no skips** using disposable MySQL 8 and
Node 24 containers on an isolated network, without production data or mounts.
Coverage includes MySQL string-valued flags, pending/confirmed state, rollback,
filters/counts, ownership isolation, stalled IMAP cancellation and slow UI actions.

The release workflow additionally requires frontend checks, the zero-skip MySQL
API gate, production image build, and container startup/authentication/recording/
backup smoke checks before publishing the tested image. Provider-write tests use
simulated mail servers; no live mailbox mutation was used as a release test.

### Updating

Keep existing volumes, settings and encryption keys. No new schema migration or
Compose change is required relative to 0.10.10. Earlier installations still need
the [upgrade guide](docs/UPGRADING.md). Retain a consistent database/uploads/config
backup, then refresh the browser/PWA after updating the container.

Account backup, import and restore remain ALPHA.

## 0.10.10

*Immediate mail read state and working retries*

Read/unread actions update the visible mail list immediately. In Sync mode,
accepted read and star changes stay visible while provider confirmation is
pending, including after a page reload. Message details, filters, unread counts
and account/folder badges use the same pending state. Mail shows a pending label;
failed or conflicting requests fall back to the last confirmed state.

The provider remains authoritative. UniHub sends the targeted IMAP flag request
and reads it back before updating confirmed storage. A full mailbox download is
not required to confirm a flag change, although an active account sync can delay
the write behind its account lock. This release does not change sync scheduling.

The Retry button for failed provider changes now reaches the parameterized API
handler instead of returning 404.

### Why the previous image workflow failed

The workflow for commit `2781d72` stopped in the API test step, before Docker
construction or publication. The mail-filing test distinguished list and detail
queries by looking for `SELECT *`. The pending-state query uses `SELECT emails.*`
and computed flags, so the mock incorrectly applied list-filter assertions to a
detail request. The real MySQL pending-state integration test passed in that run.

The fixture now distinguishes the request by its owner-scoped ID lookup and
returns the computed flag fields. It checks successful responses and flag values
alongside the existing provider-identity assertions. The release workflow runs
the full API suite with disposable MySQL 8 and no skipped checks, frontend tests,
lint/typecheck/build, and container startup/auth/recording smoke checks before
publishing the tested image.

### Updating

Keep existing volumes, configuration and encryption keys. No new migration or
Docker/YAML change is required relative to 0.10.9. Earlier installations must
still follow the [upgrade guide](docs/UPGRADING.md). Refresh the browser/PWA after
updating the container.

Provider tests use simulated mail-server responses; this release has not been
verified against a live mailbox. Account backup, import and restore remain ALPHA.

## 0.10.9

*Two-way mail updates*

Sync mode now sends new read/unread changes, stars and folder moves from UniHub
back to the email provider. Moving mail to Trash uses the provider's mapped Trash
folder. Changes made at the provider continue to flow into UniHub.

Only new explicit actions are sent. Upgrading does not upload historical local
differences. Download mode and retained local-only messages keep their existing
behavior. Pending or failed provider changes are visible in the mail UI.

### Interrupted updates and conflicts

Commands survive an app restart. UniHub checks the provider before at most one
safe automatic retry. It preserves provider state when an interrupted flag update
cannot be reconciled safely. Flag changes use conditional writes where supported;
servers without CONDSTORE retain a small race between checking and writing.
Uncertain moves are never blindly repeated. Moves require native IMAP MOVE and
an existing mapped folder on the same account.

This release does not add draft mirroring, remote folder rename/deletion,
permanent server deletion, cross-account transfers or browser-offline editing.
Existing SMTP sending is unchanged. See [mail modes](docs/MAIL_MODES.md) for details.

### Updating an existing installation

Keep existing volumes, configuration and encryption keys. Migration 5 adds the
outgoing-command table without rewriting existing messages or changing account
modes. No new Docker/YAML changes are required relative to 0.10.8. Installations
older than 0.10.8 must still apply its Nginx capability correction; see
[the upgrade guide](docs/UPGRADING.md). An image downgrade does not undo migrations.

**Account backup, import and restore remain ALPHA.** Keep independent, consistent
backups of MySQL, uploads, configuration and secrets. Outgoing commands are
excluded from account archives; restoring mail clears destination commands so
old actions cannot be replayed against a provider.

### Verification

Focused protocol and UI checks passed, including durable-command tests on MySQL.
All 131 recovery checks passed with no skipped checks, including historical
upgrades and production export/restore. TypeScript and the production build
passed. Mail-server responses were simulated; this release has not been tested
against the maintainer's live Gmail account. GitHub's image workflow additionally
runs the full API/frontend checks and container startup/auth/recording smoke test.

## 0.10.8

*Fix restricted-container Nginx startup*

The reference Compose file dropped capabilities that Nginx needs to access its
owned log/temp paths and start workers as the nginx user/group. A fresh catalog
installation exposed permission errors and a restart loop. The application image
smoke test previously used Docker's default capabilities and missed this.

The app now retains `CHOWN`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`, `SETGID` and
`SETUID` while still dropping all other capabilities and keeping
`no-new-privileges`. The release smoke test now uses those same restrictions.
These permissions apply inside the container; no privileged mode or Docker socket
mount is added. The API/supervisor still run as root, as before.

### Updating an existing installation

**An image update alone does not fix saved custom-app YAML.** Update the `unihub`
service's `cap_add` list to the five capabilities above, matching the reference
Compose file. Keep `cap_drop: ALL`, `no-new-privileges`, the same volumes and keys.
The proposed TrueNAS catalog includes the corrected settings.

No new database migrations, archive format changes or data changes are introduced.
The five-minute MySQL readiness allowance is unchanged and ends when ready.

**Account backup, import and restore remain ALPHA.** Keep independent backups of
the database, uploads, configuration and secrets. Do not rely solely on account
archives before deleting mail from your email provider.

## 0.10.7

*Mark account backup and restore ALPHA*

Account backup creation, import and restore are experimental. Data Management,
export/import headings, the recovery-password dialog and the mail server-deletion
setting now say ALPHA. Installation, backup and compatibility documentation carry
the same status. These features remain available; no data is removed.

Do not rely on account archives as your only copy of important data. Keep an
independent, consistent backup of MySQL, uploads, deployment configuration and
secrets, especially before deleting messages from the email provider.

### Upgrading

This release changes UI wording, documentation and version metadata only.
There are no new database migrations, archive format changes or deployment-setting
changes. Existing 0.10.6 installations keep the same volumes, keys and credentials.
For older versions, follow [the upgrade guide](docs/UPGRADING.md).

The 0.10.6 image remains unchanged. Its release notes now also identify account
backup/import/restore as ALPHA; the visible UI labels require 0.10.7.

## 0.10.6

*Durable recovery, mail sync and privacy*

### Updating an existing installation

Direct updates from 0.10.3, 0.10.4 and 0.10.5 use the existing additive folder
migration plus a new upgrade ledger. The source mail accounts, provider UIDs,
messages and files are preserved. Completed database repairs no longer repeat
on every restart. Required upgrade failures stop startup with the failed step
rather than continuing with an incomplete schema. The MySQL wait still allows
five minutes and continues on the first successful authenticated connection.

Retain a consistent database/uploads/configuration snapshot before updating.
Changing back to an older image is not a database rollback. New schema-3 backups
cannot be read by releases that only understand schemas 1 or 2.

### Mail and navigation

Recovered mail uses the same local filing account in list, detail, sender rules,
unread counts and new offline snapshots. Original provider identity is retained.
Rules no longer file recovered messages into another account's hidden folder,
and concurrent manual filing is protected. Refresh an existing offline snapshot
to obtain the new identity metadata; missing historical snapshot fields cannot
be reconstructed offline.

Folder navigation is searchable, custom folders can collapse, and selected
account context remains visible. Virtual views cannot supply a sending/sync
account. Collapsed navigation has accessible labels, the shell uses dynamic
viewport height, and navigation respects the user's reduced-motion setting.

### Account modes and email privacy

Accounts now offer Download or Sync from email server. Existing installations stay
in Download and keep their deletion preference. Switching to Sync requires
confirmation, follows provider read/star/folder changes, and disables automatic
server deletion. Missing server messages remain as labeled local copies. Switching
back leaves deletion off until explicitly enabled again. Local UniHub changes do
not write back to the provider in this release. See [mail modes](docs/MAIL_MODES.md)
for matching, label support, cancellation and account-identity limits.

Remote images remain blocked even in original appearance. A default-on filter can
block suspected tracking pixels after other images are allowed. Re-blocking and
navigation reset are supported. Resource loading through CSS, SVG, srcset and
embedded content is removed. This can simplify sender formatting. Detection is
imperfect; explicitly loaded images still expose the requesting IP and open time.
Stored originals are unchanged. No proxy or automatic prefetching is introduced.

### Backups and imports (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of MySQL, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Creation and restore are enabled again. Schema 3 preserves account-scoped folder
metadata, filing/Legacy state, rule overrides, translated recovery journals and
completion markers, completed transcripts and server-side Tetris scores. The UI
gets its section list from the server's shared recovery catalog. Section exports
read selected data instead of loading all mail for a contacts-only backup.

Schema-1 and schema-2 archives select their readers automatically. Older archives
cannot provide fields or bytes they never contained; warnings explain defaults.
Unknown data and incomplete schema-3 files are rejected. Conflicting folder
ownership or a merge that would make restored mail invisible fails and rolls
back. Optional deleted historical account references are reported and cleared;
live references remain required. This can reject an unsafe merge that previously
appeared successful. Use a clean destination account when scopes conflict.

Browser-only game progress, other users, sessions and deployment configuration
are not included. Uploaded archives remain retained while automatic expiry is
paused; successful restores and explicit deletion still remove their upload.
Generated backups remain until deleted. No installation Dockerfile or Compose
changes are required.

Recovery hardening also preserves separate calendar events with matching titles
and times, and separate contacts sharing an email address. Repeated imports
prefer matching content and keep distinct destination rows. Events with distinct
content retain their own subtasks and attendees. Fully indistinguishable duplicate
parents cannot provide historical identity that the archive never recorded.

Schema-3 ZIP readers now require valid SHA-256 metadata in `checksums.json`;
archives missing it are rejected. Older readers' compatibility behavior remains.
Recovery declarations are checked for section membership, file handling and parent
mappings against actual MySQL foreign keys. CI now requires database tests to run
and pass before image publication; no installation Compose change is needed.

### Optional modules, Notes and workspace layout

Settings now separates navigation visibility, feature access and supported
background work for each built-in module. Pausing keeps data and full-backup
coverage. Calendar and ToDo stay together. Settings and recovery remain available.
Queued notifications keep their attempt state while paused; already-issued network
operations may finish, and expired notifications are not replayed on resume.

Notes adds text/Markdown editing, explicit saves, text revisions, Trash, linked
notes, bounded attachments and readable Markdown downloads. Revision conflicts
preserve the editor draft rather than overwriting another device's changes. Notes
is online-only for now. Migration 4 is additive; schema-3 recovery includes all
four Notes tables and attachment bytes, including disabled Notes and trashed notes.
See [Modules and Notes](docs/MODULES_AND_NOTES.md) for limits and recovery behavior.

Wide desktop mail now shows folders, list and reader together; mobile retains its
account/folder context when returning from a message. Data Management separates
creation, existing downloads and import review, and distinguishes archive counts
from restored/skipped results. Module settings are included in new device snapshots;
refresh older snapshots to get current choices.

### Validation scope

Focused checks cover populated historical upgrades, repeated startup, actual
MySQL field coverage, current encrypted recovery, frozen historical archives,
folder conflicts, cancellation, ownership, mail consistency and navigation.
Synthetic MySQL fixtures are not a restoration of a particular live deployment.
See [Recovery contracts](docs/DATA_RECOVERY.md) for the check locations and maintenance
rules. Release publication is separate from preparing these source changes.

## 0.10.5

*Reconcile old folders against the mail server*

This release replaces the 0.10.4 “leave everything under Legacy shared” approach
with an automatic, account-by-account reconciliation. Direct upgrades from
0.10.3 are supported; installing 0.10.4 first is not required.

### What happens to existing mail

After a successful server folder listing:

1. An exact, case-sensitive local display-name match connects to that existing
   server folder. Previously saved mappings and recognized system-folder metadata
   take precedence. Local mail stays in the connected folder. No remote folders
   are created, renamed or deleted by reconciliation.
2. For local-only folders, one unique match between the message's To recipients
   and the user's configured account addresses sends that message to that
   account's local Inbox. Folder-name case differences are not guessed away.
3. Unmatched or ambiguous recipients remain in their original folders in a
   dedicated **Legacy** account view. Private-relay addresses are not guessed.
   Mail waiting for an unavailable server is also visible there.

Inbox, Sent, Drafts and Trash retain their existing behavior; drafts are excluded.
Other local-only filing folders, including Important and Archive when not linked
to a recognized server folder, are included. New provider folders are mirrored
by the existing sync logic, but reconciliation never manufactures server folders
from obsolete local names.

Legacy is a UI view, not a login or a new mail-provider account. Select messages,
choose their receiving account and destination folder, then use **Recover selected
mail**. Source account IDs and IMAP UIDs remain intact; a separate local filing
account controls where recovered mail appears. This preserves sync identity and
avoids making a message from one server look as though it originated on another.
The source account still owns its imported data. Deleting a source account is
blocked while it has mail recovered into another account, preventing accidental
loss through account deletion.

### Upgrade safeguards and limits

- Folder-list failures abort reconciliation; an INBOX fallback is never evidence
  that other folders do not exist.
- One transaction per source account records original assignments, changes local
  filing and commits a completion marker. Interrupted work rolls back. Restarts
  do not repeat completed moves or undo later manual organization.
- Existing sender rules for disconnected folders receive an account-specific
  Inbox override, preventing old rules from immediately refilling those folders.
  Editing a rule removes its migration override; new rules are unaffected.
- The database retains original folder/account assignments and the prior provider
  mappings for audit. This is **not a full backup or a one-click undo feature**.
- Bodies, attachments, message IDs, read/star flags and source IMAP identity are
  not rewritten. No provider-side email moves or deletions are issued by this
  migration. Existing optional server-deletion settings retain their behavior.

The first successful sync performs the migration, automatically on the normal
server sync interval or via Sync on a selected account. Failed/offline accounts
wait for a later successful sync. No manual SQL script is needed. Use the same
MySQL database, uploads volume and encryption keys. Dockerfile/YAML changes are
not required; the existing five-minute readiness wait is unchanged.

**Back up the database, uploads and configuration at the server level before
updating.** Application backup creation/import/restore remain disabled, as in
0.10.4. Existing completed backup downloads remain available. Do not downgrade
against the migrated database: restore the complete pre-update infrastructure
snapshot with its matching application version instead.

## 0.10.4

*Account folders and backup suspension*

### Folders

- New custom folders belong to one mail account. Select that account before
  creating a folder; creation no longer affects every connected account.
- Existing custom folders remain under a collapsible **Legacy shared** section.
  Their contents, IDs, slugs and provider mappings are preserved.
- Provider special-use markers recognize localized Sent, Drafts, Archive, Trash,
  Important and Junk folders. Existing mappings take precedence, so improved
  icons do not silently reorganize old mail.
- Account-specific folders are filtered by the selected account and labelled
  with their account in All Accounts. Mixed-account moves into an account folder
  are rejected completely. Sender rules follow the same account boundary.
- Moves remain local grouping changes. No IMAP MOVE or automatic folder deletion
  is introduced. Source account identity stays intact.

### Backups — temporarily unavailable

**Backup creation, import/validation and restore are disabled in the UI and API.**
They return HTTP 503 while the data model evolves. This also blocks old cached
clients. Existing completed backups and their recovery passwords remain
available for download. Interrupted jobs are marked failed with an explanation;
archives are retained and automatic restore-upload expiry is paused.

Use an infrastructure backup of MySQL, uploads and deployment configuration.
Contact vCard import/export and individual mail/recording downloads are unchanged.

### Updating

Update an existing 0.10.3 installation using the same database, volumes and keys.
The folder schema migration adds nullable columns; it does not reassign existing
folders or emails. The populated v0.9.23.0 upgrade regression also remains part
of verification; earlier 0.9.x variants have not all been tested individually.
No Dockerfile or YAML changes are needed. The five-minute MySQL readiness limit
is unchanged and exits immediately when the authenticated connection succeeds.
Finish any running backup/restore before updating. An older app does not
understand new folder scopes: rollback requires a matching pre-upgrade
infrastructure snapshot. See [Upgrading](docs/UPGRADING.md).

### Notifications

No notification-code change is included. Vanadium on GrapheneOS can depend on
sandboxed Google Play services for background Web Push. Notification permission
alone does not establish that delivery is configured correctly. See the
[GrapheneOS usage guide](https://grapheneos.org/usage#sandboxed-google-play) and
[Vanadium PWA discussion](https://discuss.grapheneos.org/d/7043-forum-notifications-any-way-to-enable-push).

## 0.10.3

*Backup reliability and automatic format detection*

This release fixes gaps in backup completeness and restoration. It preserves
provider-folder mappings, separate messages and files, and restored attachment
links, with automatic readers for older backups.

### Backup and restore corrections

- Include account-specific provider-folder mappings and remap both parent IDs
  with ownership checks during restore.
- Preserve distinct source messages, attachments and recordings even when their
  Message-ID, filename, size or other matching metadata repeats.
- Rewrite attachment URLs in restored email HTML to the new attachment IDs;
  preserve original EML, attachment and audio bytes.
- Read related database rows from one consistent snapshot. Reject newly created
  backups when selected files are missing, unreadable, unsupported audio, or
  change while being archived. Original files remain untouched.
- Import incomplete historical archives with warnings without clearing good
  existing file references. Skip unavailable new recordings and their links
  instead of rolling back unrelated recoverable data.
- Prevent late cancellation from invalidating a completed restore. Honor accepted
  cancellation before committing. Preserve restored files when a database commit
  acknowledgement is lost, then check the durable transaction outcome.
- Reject exports exceeding the import upload limit rather than offering a file
  the application cannot restore.

### Upgrade and compatibility

**Existing 0.10.x installations can update in place with the same database,
uploads and keys. No database migration, folder reorganization, Dockerfile or
Compose change is introduced.** Existing live data is not rewritten by this
update. The five-minute maximum MySQL readiness wait still ends immediately
when an authenticated connection succeeds.

**New backups use data schema 2. UniHub 0.10.3 automatically imports schemas 1
and 2, but 0.10.2 and earlier cannot import new schema-2 backups.** Keep a
pre-update archive or consistent database/uploads/configuration backup if
recovery onto an older release may be necessary. ZIP packaging and the encrypted
container remain version 1. The manifest identifies the data version and producer;
unknown future versions are rejected before import.

Schema-1 archives omitted provider-folder mappings. Their local folders and
email account/source-folder identities remain importable, but mappings absent
from the archive cannot be reconstructed; existing destination mappings stay
unchanged. Folder behavior in the application is unchanged by this release.

The tested older upgrade/export baseline is **0.9.23.0**, not every historical
0.9.x release. An account restore merges one user's data; it is not a full server
rollback. See [Upgrading](docs/UPGRADING.md) and [Backup and Restore](docs/BACKUP_RESTORE.md).

A single uploaded archive remains limited to **3900 MiB** (about 3.81 GiB),
including encryption overhead. ZIP64 and automatic section splitting are not
implemented. Export smaller sections where possible, and retain consistent
MySQL/uploads backups for larger datasets. Missing historical file bytes cannot
be recovered from an archive that never included them.

### Validation

The backup changes passed 247 API tests with no skips, 73 frontend tests, lint,
type checking, production/image builds and container checks before release
preparation. CI reruns the checks for the release commits.

Tests exercise production export/restore jobs against disposable MySQL, every
supported data section, repeated conflict modes, different deployment keys,
duplicate metadata, missing/corrupt files and commit/cancellation failures.
Frozen plain and encrypted archives were generated by the actual 0.9.23.0
exporter. A running-container HTTP test creates, downloads, uploads, unlocks and
restores an encrypted backup, checks contact content and exact WAV bytes, and
verifies user isolation. These synthetic tests do not constitute a restore of
any particular live installation.

## 0.10.2

This release corrects backup ownership, outbound network validation, login and
two-factor authentication, and request/service failure handling. It also reduces
recording overhead and limits simultaneous audio conversion on older hardware.

### Security corrections

- **Backup ownership:** newly restored objects receive fresh IDs unless matched
  to existing data owned by the restoring user. Updates always include the owner;
  linked records are remapped and checked. A restore cannot overwrite another
  user's data by supplying its IDs. Keep existing, Replace and Keep both remain
  supported. Unexpected foreign or inconsistent relationships reject the restore.
- **Mail and calendar connections:** DNS is checked immediately before each
  connection, including background workers. Connections use the checked address
  while preserving the original hostname for TLS certificate verification.
  DNS failures and private/special-use address tricks fail closed. The existing
  administrator-controlled `TRUSTED_MAIL_HOSTS` exception still supports private
  mail/CalDAV servers.
- **Calendar credentials:** CalDAV requires HTTPS and validates every redirect
  and discovered URL. Credentials stay within the explicitly configured server
  origin. Responses and connection time are bounded. Restored account settings
  that fail network policy remain inactive with an explanatory warning.
- **Request handling and recovery:** malformed request addresses return a client
  error instead of escaping the request error handler. A service supervisor
  terminates the container if the API or nginx stops, allowing the existing
  Docker restart policy to recover it. Shutdown signals reach both services.
- **Login protection:** separate user and short IP attempt budgets replace the
  five-hour shared-IP lockout. Successful authentication never resets counters.
  Trusted proxies are resolved from the actual connection through a configured
  `X-Forwarded-For` chain; untrusted forwarded values are ignored. See the
  [authentication guide](docs/AUTH_ADMIN_SETTINGS.md#rate-limiting) for exact limits.
- **Two-factor login:** session creation uses the user's ID, and challenge
  consumption, recovery-code removal and session insertion are atomic. Recovery
  codes and challenges cannot be reused concurrently. Session cookies are sent
  only after commit. New JWTs include random identifiers so simultaneous logins
  cannot collide; existing sessions remain compatible.
- **Audio input:** uploads/restores identify supported audio from file signatures
  instead of trusting its supplied content type. HTML/playlists cannot be served
  as restored recordings. MP3 conversion uses an explicit supported demuxer and
  file-only input protocols.
- **Dependencies:** patched mail parsing, MySQL client and other dependencies.
  React Router moves to the patched v7 declarative router; application routes
  and deployment requirements stay the same. Dependency audits and the full
  application checks are rerun with the locked versions used for this image.

### Recording efficiency

Microphone recording remains uncompressed mono PCM WAV. Original audio remains
the normal playback source; saving a recording does not automatically convert it.
MP3 export remains optional, with a user-triggered playback fallback if the
browser cannot decode the original format.

The capture worklet batches 4,096 samples per transfer instead of sending every
128-sample render block: 32 times fewer messages for full batches, while retaining
the same PCM samples. Capture uses the microphone's reported sample rate where
available instead of forcing 44.1 kHz. Uploads read and verify 512 KiB chunks rather
than copying and hashing a complete recording in browser memory.

One MP3 conversion runs at a time, with one decoder/encoder thread, bounded queue,
15-minute conversion deadline and 500 MiB output ceiling. A busy queue asks the
user to retry. Existing cached exports remain usable; originals are retained.
This reduces avoidable overhead but does not establish that Linux microphone or
driver-related popping is resolved on every device.

### Upgrade and configuration notes

**Existing 0.10.x installations can update in place using the same database,
uploads and keys. This patch adds no database migration.** Existing data IDs and
stored audio are not rewritten. Legacy restorable ZIP and encrypted backup
formats remain supported, subject to the new ownership and media validation.

**0.9.23.0 remains the tested in-place upgrade baseline for 0.10.x.** Earlier
0.9.x and customized schemas need a rehearsal on a copy; they are not all verified.
Keep a consistent backup of MySQL, uploads and configuration before upgrading.
An image-only downgrade is not a verified rollback. See [Upgrading](docs/UPGRADING.md).

There are intentional compatibility restrictions:

- For an extra HTTPS reverse proxy, configure `UNIHUB_TRUSTED_PROXY_CIDRS` in the
  supplied Compose `.env` (runtime variable: `TRUSTED_PROXY_CIDRS`) to include the
  bundled loopback proxy and only your actual proxy addresses. See the
  [configuration example](docs/AUTH_ADMIN_SETTINGS.md#trusted-proxies). An image pull
  alone cannot add this environment variable to an existing container.
- Private mail/calendar hosts require the administrator's existing allowlist.
  Cross-origin CalDAV discovery now requires explicitly configuring the final
  server URL rather than silently forwarding credentials there.
- New audio uploads/restores accept recognized WAV, MP3, M4A/MP4 audio, Ogg, WebM,
  FLAC, AAC and AIFF files. Files merely labeled as audio are rejected. Existing
  original files remain available, but MP3 conversion requires a supported format.
- Imported records get fresh IDs when no same-owner match exists. Backups with
  missing, foreign or inconsistent parent references fail instead of linking to
  unrelated data. Invalid network settings are restored inactive with warnings.

The **300-second maximum MySQL wait** is unchanged and ends immediately after an
authenticated connection succeeds. The **360-second health startup grace** is
unchanged. The only Compose addition is explicit proxy trust configuration;
service supervision is implemented inside the image.

### Validation

Release checks include API and frontend tests, lint, TypeScript and production
build, MySQL 8 two-user restore and authentication regressions, the populated
0.9.23.0 migration/restart test, and a built-container smoke test. The container
smoke checks production authentication, file handling, audio conversion,
malformed-request handling and container exit after an essential service dies.
CI results accompany the published release.

Synthetic audio tests cover PCM sample preservation, chunk integrity, queue
limits and supported-format conversion. Actual microphone behavior and background
PWA notification delivery still require checking on the intended device.

## 0.10.1

This documentation and licensing release makes UniHub's maintenance approach,
usage terms and upgrade procedure explicit. The application features introduced
in 0.10.0 remain the same.

### Maintenance and documentation

UniHub is AI-written code maintained using OpenAI models, primarily **GPT 6
Astra**, with AI-assisted security reviews, regression tests and release checks.
The README now describes the project directly and welcomes feedback. A security
document explains the review process and private vulnerability reporting.

Documentation has been reviewed against the implementation, including mail
import transactions, streamed attachment downloads, session/cache isolation,
contacts pagination, calendar notifications, offline reading, backups and
deployment settings.

### License

Starting with **0.10.1**, project-owned code and documentation use **PolyForm
Noncommercial 1.0.0**: noncommercial use is free, and commercial use is welcome
under a separate paid written agreement. See Licensing for how to send a
commercial licence enquiry. See [Licensing](LICENSING.md).

The project is source-available. Earlier releases retain the permissions they
were supplied with; this change is prospective. Third-party components retain
their own licenses. The image now includes the project license, third-party
notices and collected frontend dependency notices under `/app/licenses`.

### Upgrading from 0.9.x

**0.9.23.0 is the tested schema baseline for an in-place upgrade to 0.10.x.**
The migration regression starts with that release's actual schema and populated
synthetic records, runs production initialization twice, and checks preservation
of users, mail/calendar data, encrypted credentials, attachment metadata and
custom folder settings. It also verifies new sync progress and encrypted VAPID
identity across restart. File contents and external mail providers are outside
that schema test.

Earlier 0.9.x versions and customized databases are not all runtime-verified.
Rehearse those upgrades on an isolated copy. Keep a consistent pre-upgrade backup
of MySQL, uploads and configuration. Preserve deployment keys and volume
mappings. **An image-only downgrade is not a verified rollback procedure.**
The [upgrade guide](docs/UPGRADING.md) includes the commands and recovery path.

Retain the **300-second maximum MySQL wait**, which ends when an authenticated
probe succeeds, and **360-second application health startup grace**. Older
Compose files with explicit values need those values updated. The first mail
sync revalidates old imports and can take longer. Device notifications and
offline reading require opt-in after the upgrade.

### Validation

Publication requires the API suite, including the populated MySQL 8 upgrade and
fresh-install checks, frontend tests, lint, TypeScript and production build,
followed by the built-container startup/authentication/file/conversion smoke
test. The container smoke also checks that licensing notices and metadata are
present. CI results are linked from the GitHub release.

Actual minimized/locked-screen PWA notification delivery still needs checking
on the intended device; browser and OS policies are not reproduced by CI.

## 0.10.0

This release adds a black, white and blue appearance, server-driven Web Push, opt-in offline reading, and a focused mail/state refactor.

### Changes

- Dark mode defaults to black backgrounds, white text and blue accents. Light/System remain available in Settings. HTML mail has a dark reading view and an explicit original-format option.
- Notifications use persistent encrypted VAPID keys, per-device subscriptions, a transactional outbox, retries and service-worker delivery. Calendar reminders survive restarts and revalidate edits/cancellations and restores. Notification links open the specific item. Enable and test notifications in Settings.
- Offline reading saves the latest 100 full non-draft emails across accounts, all contacts and calendar entries in a bounded 32 MiB snapshot. The offline view is read-only; attachments remain online. Snapshot ownership and clearing are enforced across tabs and in-flight requests.
- Private query state is isolated per signed-in user. Generic service-worker API caches are removed. Temporary network errors and confirmed session revocation are handled separately.
- Routes and games load lazily. The main production JavaScript bundle decreased from 1,061.79 kB (310.01 kB gzip) to approximately 610.92 kB (196.21 kB gzip). Service-worker precaching still downloads the offline-capable chunks during installation.
- Mail search is debounced and cancellable; stale reader responses cannot reopen or replace a later selection. Shared query invalidation refreshes lists, counts and dashboard previews.
- Backup status polling runs only for active jobs in the active tab. Contact pagination no longer silently stops at 2,000 records.
- Default folder creation preserves renamed/reordered system folders. A 1,000-message routing fixture now uses three SQL calls to load its folder/rule context instead of 11,000 repeated calls.
- Draft replacements and imported attachment metadata commit atomically. Per-folder IMAP UID/UIDVALIDITY progress preserves retryability, including new folders and incomplete imports. Attachment downloads stream from disk; request parsing preserves split UTF-8 characters and rejects invalid JSON.
- Builds now enforce TypeScript checking. Node 24 is used in both Docker stages and CI. Image publication is gated by tests and a container smoke test.

### Upgrade

**0.9.23.0 is the checked upgrade baseline.** The changes are designed for an in-place upgrade using the existing database, uploads and keys. The subsequent 0.10.1 validation adds a populated 0.9.23.0 schema migration/restart test; earlier 0.9.x versions and locally modified schemas are not all runtime-verified. Rehearse those upgrades on an isolated copy first. See the [upgrade guide](docs/UPGRADING.md) for the procedure and exact validation scope.

**Keep a matching pre-upgrade database/uploads/configuration backup. An image-only downgrade is not a verified rollback path.** Preserve the Compose project/volume mappings and encryption keys; changing them can make data appear missing or credentials unreadable.

Volumes and required environment variables remain unchanged. MySQL readiness now allows up to five minutes (300 seconds) for slower hosts, and startup continues immediately after an authenticated check succeeds. The probe uses the same driver and DATABASE_URL/MYSQL_* configuration as the API. The application image and supplied Compose health checks allow 360 seconds for startup. Update older Compose files that explicitly set a 120-second readiness budget or shorter health-check grace period; pulling the image alone cannot override an explicit Compose environment setting. Custom timing overrides remain supported.

Database migrations are additive. Keep a backup of the database and uploads before upgrading, and retain the existing ENCRYPTION_KEY: it also protects the deployment's new Web Push private key.

The first mail sync after upgrading revalidates existing imports and establishes per-folder progress, so it can take longer. Historical first imports and UIDVALIDITY resets do not send a flood of notifications. Existing calendar colors are preserved.

After upgrading over HTTPS, open Settings and enable notifications on each device. Test once with the PWA minimized. Mail discovery still follows the server's roughly ten-minute IMAP sync interval. Browser permission, OS settings and connectivity affect delivery; closed-app alarms while completely offline require native scheduling.

Enable Offline reading separately on each device, and wait for the saved timestamp. App updates prompt before reload so you can save edits first.

See [PWA notifications](docs/PWA.md), [Offline reading and appearance](docs/OFFLINE.md), and [Mail sync](docs/MAIL_SYNC.md).

### Validation

The refactor is covered by frontend state/lifecycle tests and API regression tests, including optional MySQL tests. CI uses MySQL 8 for real SQL, production schema initialization/reinitialization, stable encrypted VAPID identity and session-revocation cascades. A built-container smoke test checks Node 24, Nginx/API health, authentication/CSRF, isolated recording storage, byte/range downloads, MP3 conversion and cleanup before publication.

The black/blue sign-in layout was checked at desktop and phone widths. A real two-tab service-worker update test confirmed that the requesting tab refreshes while the other retains its unsaved input and can refresh later. Actual minimized/locked-screen delivery still needs verification on the intended phone/browser; CI does not simulate its OS policies.

## 0.9.20.0

This release replaces the previous foreground backup import flow with a durable,
encrypted backup and restore system designed for large mail archives and
long-running restores.

### Highlights

#### Encrypted, Portable Backups

- Backup encryption is enabled by default.
- Encrypted backups use the `.unihub-backup` extension.
- Each encrypted backup receives a unique recovery password.
- Recovery passwords can be revealed only once. Save the password before
  downloading the backup.
- Encrypted backups can restore mail and calendar credentials on another UniHub
  installation, even when the destination uses a different `ENCRYPTION_KEY`.
- Unencrypted `.zip` backups remain available and existing restorable UniHub ZIP
  backups are still supported.

#### Background Backup and Restore Jobs

- Backup creation, validation, and restore now continue without an open browser
  connection.
- Closing the page or hitting a reverse-proxy timeout no longer stops a running
  restore.
- Interrupted jobs are recovered after an application restart.
- Data Management now shows job status, phase, progress, start/end times, file
  size, warnings, errors, and restored counts.
- Running backup and restore jobs can be stopped before their final commit.
- Failed retained uploads can be retried without uploading the archive again.

#### Server-Retained Restore Points

- Completed backups remain available on the server until manually deleted.
- A retained backup can be validated and restored directly without downloading
  and uploading it again.
- Uploaded backup archives expire after seven days.
- Successfully restored uploaded archives are removed, while restore history is
  retained until manually deleted.
- Server-retained backups are a convenience feature, not a replacement for
  off-server backups.

#### Safer Restore Behavior

- Restore remains merge-based and does not delete unrelated existing data.
- Conflict modes support keeping existing data, replacing matching items, or
  keeping both where the schema permits it.
- Same-name local calendars merge by default.
- Existing matched accounts keep their current credentials by default.
- Database changes are restored in a transaction.
- Files are checksum-verified and cleaned up when a restore fails or is
  cancelled before commit.
- Only sections affected by an active restore become temporarily read-only.
- Mail sync and server-side mail deletion pause during a mail restore.
- Restored mail accounts always have **Delete Emails on Server disabled**.

### Backup Contents

Full backups can include:

- user display settings
- contacts
- calendar accounts, calendars, events, ToDos, attendees, and subtasks
- mail accounts, folders, sender rules, emails, raw `.eml` files, attachments,
  and mail scores
- recordings, recording files, tags, and tag links

Section backups are available for Mail, Calendar/ToDo, Contacts, Recordings, and
Settings.

User login password hashes, roles, sessions, 2FA secrets, and mail
server-deletion queue entries are not restored.

### Fixes

- Fixed `Invalid string length` failures while creating large backups.
- Added streaming and range support for large backup downloads.
- Fixed large binary backup uploads being parsed as text or JSON.
- Fixed attachment validation incorrectly reporting existing files as missing.
- Fixed restore failures caused by ISO timestamps being inserted directly into
  MySQL `DATETIME` columns.
- Fixed calendar restore parameter ordering that could cause
  `Incorrect arguments to COM_STMT_EXECUTE`.
- Improved restore compatibility for existing UniHub backup ZIP files.
- Improved cleanup of partial backup and restore files.
- Added clearer backup, validation, restore, cancellation, and recovery-password
  errors in Data Management.

### Upgrade Notes

This update requires an application redeploy/restart so the backend can create
the new backup job tables and start the background workers.

Add the following optional variable to your deployment:

```env
UNIHUB_BACKUP_MASTER_KEY=<strong-random-secret>
```

`UNIHUB_BACKUP_MASTER_KEY` protects server-retained archive keys. When it is not
set, UniHub falls back to `UNIHUB_ENCRYPTION_KEY`.

Important:

- Do not use `UNIHUB_JWT_SECRET` as the backup master key.
- Do not change or lose an existing `UNIHUB_ENCRYPTION_KEY`.
- Do not change `UNIHUB_BACKUP_MASTER_KEY` while relying on automatic restore
  for server-retained encrypted backups.
- Download important backups and store them away from the UniHub server.
- Keep each recovery password separate from its backup file.
- Back up the MySQL and uploads volumes independently for full infrastructure
  disaster recovery.

### Compatibility and Limits

- Existing restorable UniHub `.zip` backups remain accepted.
- Encrypted `.unihub-backup` files are portable using their recovery password.
- The upload request limit is 3900 MiB.
- The inner archive currently uses ZIP32. ZIP64 is not yet supported, so very
  large backups may still exceed archive size, offset, or entry-count limits.
- Only one restore is processed globally at a time.

### Documentation

See the [Backup and Restore Guide](docs/BACKUP_RESTORE.md) for backup contents,
encryption details, recovery-password handling, restore merge rules, retention,
API endpoints, and troubleshooting.
