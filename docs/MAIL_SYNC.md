# Mail Sync Technical Documentation

## 0.13.0: Sync follows the server

Download and Sync are two distinct modes; see [Download and Sync](MAIL_MODES.md)
for the user-facing rules. Technically, Sync adds one local job kind and one
module:

- `api/src/services/mail-sync-policy.ts` owns retention windows, proven-absence
  removal, Gmail X-GM-MSGID merging, the per-account confirmation gate
  (`mail_accounts.sync_policy_confirmed_at`), mode-impact counts and the
  `gmail_all_mail_hidden` warning. Download accounts are never touched by it.
- `commitWindow` (`mail-engine/sync.ts`) skips a provider message whose
  INTERNALDATE is older than its mailbox's window (Trash/Junk use
  `trash_window_days`, everything else `sync_window_days`) unless it is already
  known, is the mapped destination of an accepted MOVE, or is another Gmail label
  of a known message. Skipped messages create no row and queue no body. Each
  occurrence stores its INTERNALDATE (`mail_remote_occurrences.internal_date`).
- A presence window that proves absence in a Sync account queues a `prune` job;
  the folder discovery job queues one after every pass as well.
- `prune` runs without a provider connection, at priority 80 (below every
  provider job), as a read slot that yields to interactive work. Each slice is
  fenced by the account lease and handles at most 200 rows: it files missing
  Gmail mail as archived when All Mail is not visible (always), then, only when
  the account is confirmed, merges up to 50 Gmail duplicate groups, removes
  unlinked duplicates (below), removes items with no present or quarantined
  occurrence left (never on Gmail without
  a visible All Mail), and removes items whose every present occurrence is
  outside its window. Candidates are re-checked on locked rows; items with an
  unsettled operation, filed in another account, Legacy or drafts are never
  removed. Raw and attachment files are deleted after COMMIT, only inside the
  owner's directory and only when no row references them any more. A slice
  that removed, merged or refiled rows publishes `mail.changed` with reason
  `content`.
- An item with no provider identity (`remote_folder`, `remote_uid` and
  `remote_uidvalidity` all NULL) and no occurrence is local-only mail: UniHub's
  own Sent copy, or mail kept from before the account used Sync. Since 0.13.3
  `queueChanges` (`mail-writebacks.ts`) applies read/star/move to it locally
  without a provider operation, also inside a bulk request with linked items.
  An item with a partial identity, or an empty one while an occurrence still
  links it, refuses the whole request ("damaged link", with a count). `prune`
  removes an unlinked item only when a linked twin exists in the same account:
  same non-empty `message_id`, sender (case-insensitive) and subject,
  `received_at` within one day, `import_complete`, and a present occurrence in
  an active mailbox. The twin carries the server state; nothing is linked or
  merged. Unlinked items without a twin are kept. The mode impact counts them
  as `local_duplicates`.
- Folder discovery records a mailbox flagged `\All` as `special_use = 'all'`
  on `mail_remote_mailboxes` (the local folder mapping still uses `archive`).

## 0.10.5: existing-folder reconciliation

The [0.10.5 migration](../CHANGELOG.md#0105) supersedes the Legacy shared behavior
below. Existing server-folder mappings and exact display-name matches connect
without creating provider folders. Local-only messages are filed in a uniquely
matched To account's Inbox; unresolved mail appears under the Legacy account
view with its previous folder names. Since 0.17.3 the Legacy view is listed only
while it holds mail, so installations without such mail do not show it. A
successful complete LIST is required.
Each account commits once, with an assignment journal and per-account overrides
for old sender rules targeting disconnected folders. Later syncs refresh the
server inventory without repeating message moves.

`emails.mail_account_id` remains the source identity used by IMAP sync;
`filing_account_id` is an optional local display/recovery account. `is_legacy`
marks unresolved/pending messages. List/detail/unread queries use the local
filing account, and explicit Legacy recovery preserves source UIDs. Recovery preserves source ownership. Source-account deletion is blocked while
mail is filed under another account, preventing cascade deletion of recovered mail. Migration records are in
`mail_folder_reconciliations`, `mail_folder_recovery_items` and
`mail_folder_rule_overrides`.


## Overview

UniHub stores mail locally after fetching it from IMAP providers and sends
outbound mail through SMTP. The mail system includes:

- encrypted mail credentials
- strict TLS by default
- host policy checks for unknown/private mail hosts
- multi-folder IMAP import for common provider folders
- app-owned folders and sender/domain routing rules
- raw `.eml` archiving
- attachment storage and inline `cid:` rewriting
- optional delayed server-side deletion after safe local import
- manual and server-scheduled background sync, independent of open browser tabs

## Components

| Component | Module/library | Role |
| --- | --- | --- |
| IMAP client | `imapflow` (pinned 2.1.2) via `api/src/services/mail-imap-client.ts` | Connect, list, select, fetch, flag, move |
| Parser | `mailparser` | Parse RFC 822 messages |
| SMTP sender | `nodemailer` | Send composed mail |
| Encryption | `api/src/security/encryption.ts` | AES-256-GCM encryption for stored credentials |
| Host policy | `api/src/services/mail-host-policy.ts` | DNS/private-IP checks and known-provider classification |
| Import persistence | `api/src/services/mail-import.ts` | Stage files and commit complete message metadata atomically |
| Attachment handling | `api/src/services/mail-attachments.ts` | Shared validation, file staging and inline CID rewriting |
| Draft persistence | `api/src/services/mail-drafts.ts` | Transactional draft and attachment replacement |
| Folder checkpoints | `api/src/services/mail-sync-state.ts` | Durable per-folder UID progress |
| Raw archive | filesystem | Stores imported `.eml` source below `/app/uploads/mail-raw` |
| Attachments | filesystem + DB | Stores regular and inline attachments below `/app/uploads/attachments` |

## Database Tables

| Table | Purpose |
| --- | --- |
| `mail_accounts` | IMAP/SMTP settings, encrypted password, sync metadata, TLS trust state |
| `mail_folders` | User-owned catalog; new custom folders also have `mail_account_id`, old shared folders keep NULL |
| `mail_folder_remote_boxes` | Account-specific mapping from app folders to exact provider folder names |
| `mail_sync_state` | Folder UIDVALIDITY, last successful UID and initialization state |
| `mail_sender_rules` | Sender/domain routing rules |
| `emails` | Local email metadata, bodies, folder, read/star state, raw archive path and `import_complete` state |
| `mail_server_messages` | Runtime queue for imported IMAP copies eligible for optional server deletion |
| `email_attachments` | Attachment metadata and storage path |
| `mail_email_scores` | Reserved schema for future scam/spam scoring |

## Account Creation Flow

`POST /api/mail/accounts` accepts account details, validates the mail host, tests
IMAP credentials, saves the account, optionally connects its calendar, then
starts mail sync in the background.

Main payload fields:

| Field | Notes |
| --- | --- |
| `email_address` | Required |
| `encrypted_password` | Required; despite the name, this is the plaintext password from the client and is encrypted server-side |
| `provider` | Stored provider label |
| `username` | Optional IMAP/SMTP username; defaults to email address |
| `imap_host`, `imap_port` | Required host, port defaults to 993 |
| `smtp_host`, `smtp_port` | Required host, port defaults to 587 |
| `sync_fetch_limit` | Currently normalized to `all` |
| `delete_emails_on_server` | Optional, defaults to false; enables delayed provider-side deletion after import |
| `accept_host_trust` | Allows a user-confirmed TLS trust exception |
| `try_calendar_sync`, `caldav_url`, `time_zone` | Connect the account's calendar with the same login (see [Calendar](CALENDAR.md#connecting-a-calendar)); `caldav_url` may also be an ICS subscription address. The response's `calendarSync` says whether it worked |

### Host Policy

Before saving an account, the backend:

1. normalizes IMAP and SMTP hosts
2. classifies known provider suffixes such as Gmail, iCloud, Yahoo, Outlook, and Office 365
3. checks `TRUSTED_MAIL_HOSTS`
4. resolves DNS and detects private/local addresses
5. blocks private/local hosts unless allowlisted
6. returns warnings for unknown hosts
7. requires explicit user confirmation for TLS trust failures

Self-hosted mail servers that resolve to private/local addresses must be listed
in `TRUSTED_MAIL_HOSTS`.

The same policy is enforced immediately before every IMAP/SMTP connection,
including background work. DNS errors fail closed. Every returned address is
checked, and the socket connects directly to a checked IP while TLS verifies the
original hostname. There is no second DNS lookup between validation and use.
Private, link-local, reserved and special-use addresses are blocked unless the
administrator explicitly trusts the host. Restored accounts whose hosts fail
this policy remain inactive with a warning.

## Sync Triggers

| Trigger | Endpoint/process | Behavior |
| --- | --- | --- |
| Initial account add | account creation route | starts non-blocking sync when no other sync is running |
| INBOX push (IMAP IDLE) | `api/src/services/mail-idle.ts` | a change announced on the account's INBOX: `recent` (plus throttled `flags`/`presence` in Sync mode) about 2 seconds later; see [IMAP IDLE](#imap-idle-for-inbox) |
| Periodic INBOX follow-up | `api/src/app.ts` interval | every 30 seconds: one `recent` job for the account's INBOX; every 5 minutes while the account's IDLE session is healthy |
| Periodic folder discovery | same interval | at most every 5 minutes (or after a failed pass): folder LIST plus per-folder `recent`/`flags`/`history`/`presence` jobs |
| Manual sync | `POST /api/mail/sync` | immediate, complete folder discovery and fan-out |
| Service worker sync | `POST /api/mail/sync/background` | starts at most one sync if data is stale |
| Writeback follow-up | provider operation worker | ordinary (throttled) sync after an unsettled flag/move |
| Sync policy (`prune`) | presence sweep, folder discovery, mode switch, window change, policy confirmation | local only: retention, proven absence, Gmail merge (see 0.13.0 above) |

Periodic, IDLE-triggered and service-worker sync are background work: they are
skipped while the Mail module's background setting is off. Manual Sync, flag/move actions and their
follow-up refresh still run and do not change that setting. Only manual Sync
reopens a module pause or forces an immediate flags/presence resweep.

Only one mail sync runs at a time. A second request returns an already-running
result or skips starting a new sync.

### Provider connections

Durable jobs of one account are serialized by the account lease. After a job
completes successfully and unaborted, its authenticated IMAP session is parked
per account (`api/src/services/mail-engine/connection-pool.ts`) for up to 90
seconds (30-minute maximum age) and handed to the account's next job after a
NOOP health check, rebound to that job's cancellation signal. A session is
never shared by two running jobs and is destroyed, not reused, after an error,
abort, cancellation, lost fence, credential/host/TLS-trust change, account
stop/disconnect or module pause. The host policy check still runs before every
job. Jobs with provably no provider work finish without connecting: an
operation already settled by a sibling batch, and background `flags`/`presence`
sweeps completed within their 15-minute throttle. An `operation` job also
executes up to 50 other due, undispatched operations of the same account on its
transport, each with its own fence check and attempt record, so a bulk change
normally needs a single LOGIN.

Connections per account: at most one running job's session (jobs of an account
are serialized; at most three jobs run process-wide) or one parked session, plus
one long-lived IDLE session on INBOX while background sync is on and the server
supports IDLE. Server deletion and the connection test open their own short
sessions. Providers commonly allow 10 or more simultaneous sessions per account.

### IMAP transport

All IMAP traffic uses [ImapFlow](https://imapflow.com/). Only
`api/src/services/mail-imap-client.ts` constructs clients: it translates the
host-policy config (pinned address, TLS `servername`, `rejectUnauthorized` from
the account's trust decision) unchanged, so TLS verifies the account hostname
and only an explicit, confirmed trust decision accepts an unverified
certificate. Library logging is off (`logger: false`): protocol traffic carries
credentials and message content. Automatic IDLE and COMPRESS are disabled, so
the wire carries only the engine's own commands; the IDLE supervisor below calls
IDLE explicitly on its own session. Setup (TCP, TLS, greeting,
login, capability negotiation) is bounded by the connect plus authentication
timeouts; literals above 50 MiB are refused before they are read.

`api/src/services/mail-imap-guard.ts` gives every command its own deadline
(120 s; a message body FETCH 5 minutes). A deadline, abort signal, socket error or close stops the session for
good: the client is hard-closed (`close()`: socket and parser destroyed, no
LOGOUT queued behind a stalled command), every waiting command is rejected, and
nothing is dispatched on it again. A pooled session is rebound to each job's
signal; the pool probes it with `NOOP` and reuses it only while it is usable
and no command is outstanding.

`api/src/services/mail-engine/transport.ts` selects with SELECT/EXAMINE
(UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ; CONDSTORE counts only when the server
enabled it via ENABLE and reports a valid mod-sequence, so iCloud-style `0`
degrades to no CONDSTORE) and fetches metadata (`UID FLAGS INTERNALDATE`,
`MODSEQ`, Gmail `X-GM-MSGID`) and raw `BODY.PEEK[]` as exact octets. Flag and
move writebacks are issued as single explicit commands through ImapFlow's
command queue, not its convenience methods: `UID STORE <uid> [(UNCHANGEDSINCE
<modseq>)] ±FLAGS.SILENT (<flag>)` with tagged `MODIFIED`, `NO` and `BAD`
reported as such, and `UID MOVE` only when the server advertises MOVE, with
`COPYUID` evidence from the untagged and tagged responses. `messageMove()`
(which falls back to COPY + EXPUNGE) and `messageDelete()` (which can fall back
to a mailbox-wide EXPUNGE) are never used. Server deletion likewise issues
`UID STORE +FLAGS.SILENT (\Deleted)` and `UID EXPUNGE <uid>` only with UIDPLUS.

### IMAP IDLE for INBOX

`api/src/services/mail-idle.ts` keeps at most one dedicated IDLE session
(RFC 2177) per eligible account, separate from the job connection pool, so new
INBOX mail is imported within seconds instead of at the next 30-second tick.

- **Eligible:** the account is active, connected and not paused for any reason
  (module, settings change, recovery, deployment canary hold), it has a mapped
  INBOX (after its first folder discovery), the user's Mail module and
  background sync are on, no mail restore is running, and its mode is Sync or
  Download (both import new INBOX mail). A server that does not advertise IDLE
  is skipped (polling stays at 30 seconds) and asked again after 6 hours or a
  settings change.
- **Read-only:** the session logs in with the same host policy, pinned address
  and TLS trust decision as every job, opens INBOX with `EXAMINE`, and then only
  issues `IDLE`/`DONE` (plus ImapFlow's read-only `LIST`/`LSUB` before opening
  and a keepalive `NOOP` after a long silence). It never fetches, stores,
  moves, expunges or appends. Library logging stays off.
- **Changes become ordinary jobs:** an untagged `EXISTS` queues the account's
  durable `recent` job for that INBOX; in Sync mode `FLAGS` queues a `flags`
  job and `EXPUNGE`/`VANISHED` a `presence` job. Both are the normal
  background sweeps with their 15-minute throttle (a throttled one finishes
  without connecting), never a manual resweep. Events are coalesced for 2
  seconds into one admission (`enqueueIdleRefresh` in `mail-sync-control.ts`),
  which rechecks the account, pause, background setting and restore state,
  persists the jobs and nudges the scheduler. Fencing, leases and imports all
  stay in the durable jobs; the browser hears about the result through the
  usual `mail.job`/`mail.changed` events. Each new session also queues one
  `recent` job, since mail that arrived while nobody listened raises no event.
- **Cadence:** while an account's session is healthy (selected and idling) the
  30-second periodic INBOX follow-up runs only every 5 minutes as a safety net;
  it returns to 30 seconds as soon as the session is down. Folder discovery
  stays every 5 minutes.
- **Robustness:** IDLE is re-issued every 10 minutes on the same connection
  (RFC 2177 asks for less than 29). A lost session reconnects with exponential
  backoff (5 seconds doubling up to 15 minutes, with jitter; reset after a
  session stayed up for a minute). A rejected login stops IDLE for that account
  until its connection settings (host, port, user, password, trust) change, so
  the provider never sees repeated failed logins from it.
- **Limits:** one session per account and at most 50 in the process
  (`UNIHUB_MAIL_IDLE_MAX_SESSIONS` in the app environment; `0` turns IDLE off
  and keeps 30-second polling for everyone).
- **Lifecycle:** the supervisor starts after the first periodic pass at API
  startup and recomputes eligibility every 60 seconds. That one database pass is
  the backstop for every change (account add or reconnect, settings, canary hold
  or release, restore, recovery pauses) instead of hooks in every route. Paths
  that must close the socket at once do so directly: `stopMailAccountWork`
  (disconnect, purge, settings change, module off) and turning background sync
  off. SIGTERM/SIGINT close all sessions on the same path that ends the live
  event streams; sockets and timers are unreferenced so they never hold the
  process open.

### One job runner

Every mail job, including accepted provider changes (`operation`) and their
outcome checks (`reconcile`), runs on the one durable scheduler
(`api/src/services/mail-sync-scheduler.ts`, executor `runDurableMailJob` in
`api/src/services/mail-durable-jobs.ts`). It runs at most three jobs at once, of which at
most two may be read-only (`sync`, `recent`, `flags`, `history`, `presence`,
`body`, and the local `prune`); the third slot only ever takes operation/reconcile work, so a click is
never queued behind other accounts' long scans. After a read/star/move is
accepted (or retried), the API enqueues the job and nudges the scheduler: a
read-only job of the same account, which holds the account lease, yields at a
safe boundary (its progress is kept and it continues afterwards), then the
scheduler claims immediately instead of at its next one-second poll. A nudge
that arrives during a claim pass repeats that pass.

Message bodies are fetched by `body` jobs, one per mailbox, at priority 15:
behind manual sync (5) and new mail (`recent`, 10), ahead of the background
`flags` (20), `history` (60) and `presence` (70) sweeps, so a "Loading message"
backlog drains instead of waiting behind sweeps that on large Gmail accounts
never finish. A job imports up to 25 messages of its mailbox, newest first, or
stops after 20 seconds, then continues as a new job while queued content
remains; a yield or cancellation stops between messages and keeps the imported
ones. The folder discovery pass (`sync`, every five minutes) queues a body job
for every mailbox that still has queued content, so a chain stopped by an error
or a cancellation resumes, and raises older body jobs to priority 15.

A single message may take up to 5 minutes and 50 MiB to download; a transfer
that stops sending data still ends after the job's 30-second socket inactivity
timeout. A message whose download misses the 5-minute deadline is set aside
(`content_state = 'slow'`) so the messages behind it continue, since newest
first would otherwise pick it again in every job. A manual sync queues set-aside
messages again (**Sync now**). A message above 50 MiB, or one that cannot be parsed, is set
aside for good (`deferred`). Both keep the "Loading message" placeholder.

Operation and reconcile jobs also hold the in-process account lock (shared with
settings changes and server deletion), dial with shorter timeouts, and on a
connect/login failure back off the account's due operations. A job started by
a user action runs while background sync is off and is followed by a follow-up
sync; a retry found by the one-second due scan (`runDueWritebacks`, with
per-operation exponential backoff) is background work: with background sync off
it finishes as `paused` without connecting and is requeued once background sync
is on again, and its refresh is a background sync. Stopping an account
(disconnect, settings, module off) fences its generation, aborts its running
jobs including an operation (hard-closing that transport) and evicts its parked
session.

Expired-lease recovery (a crashed or stalled worker) runs when the durable
scheduler starts and then at most every 15 seconds, not on every poll. Until it
has run, a claim skips an account whose expired lease still names a worker, so
a successor never starts beside an unrecovered job. Finished jobs (`idle`,
`cancelled`, `error`) are pruned hourly once completed more than 7 days ago, in
batches of 1,000. The newest job of each account/kind/mailbox is kept for
status and discovery cadence, and every job of an unsettled operation is kept
for its retry backoff. Jobs are not part of backups.

### Status updates

The browser learns about job and provider-change progress from the live event
stream (`GET /api/events`, see [Architecture](ARCHITECTURE.md#live-status-events)).
Producers are small hooks:

- the durable scheduler's state callback (`mail-durable-jobs.ts`) publishes
  `mail.job` for every job start, progress report and completion; admission of a
  sync (`mail-sync-control.ts`) publishes `queued`, and `/sync/cancel` publishes
  `cancelled` for queued jobs it stopped;
- a finished job publishes `mail.changed` when it imported or changed rows
  (`recent`/`history` imports, `flags`/`presence` changes, a fetched body, folder
  discovery) and after operation/reconcile jobs; a scan that changed rows and
  every operation/reconcile job also publish `mail.operation`;
- the writeback executor publishes each committed operation state, and
  admission, retry, discard and accept-server-state publish theirs.

Events are throttled to one per second per account and type, carry ids, states
and counters only, and are hints: the client refetches `/mail/sync/status`,
`/mail/writebacks` and the affected lists. While the stream is connected the
client polls only as a safety net (sync status and writebacks every 60 seconds,
mail lists every 5 minutes). When it is not connected (stream refused, network
error, server restart, offline mode, or a browser without EventSource) the
previous polling applies: sync status every 3 seconds while a job is active and
30 seconds otherwise, writebacks every 3/15 seconds, lists every 60 seconds.
Reconnects back off exponentially (2 seconds up to 5 minutes, with jitter); a
reconnect refetches status, writebacks and lists once, because events sent
while disconnected are not replayed. A hidden tab keeps its stream but defers
refetches until it is visible again.

## IMAP Folder Strategy

The sync service lists provider folders and selects common folder names:

| UniHub folder | IMAP names checked |
| --- | --- |
| `inbox` | `INBOX` |
| `sent` | `Sent`, `Sent Items`, `Sent Mail`, Gmail sent folders |
| `drafts` | `Drafts`, Gmail draft folders |
| `archive` | `Archive`, `Archives`, Gmail all-mail folders |
| `trash` | `Trash`, `Deleted Items`, `Deleted Messages`, Gmail trash folders |

If no inbox candidate is found, `INBOX` is still tried.

System app folders created per user:

- `inbox`
- `sent`
- `drafts`
- `archive`
- `trash`
- `important`
- `marketing`
- `scam`
- `unknown`
- `twofactor_notifications`

From 0.10.4, newly discovered custom provider folders belong to their mail account.
The same name on two accounts receives two distinct local slugs. Creating a folder
requires `mail_account_id` and attempts creation only on that active account.
A folder already represented by a legacy provider mapping cannot be recreated
under the same remote name; choose a different name.

All pre-upgrade custom folders remain under **Legacy shared**, collapsed in the
sidebar by default. Their IDs, slugs, messages, routing rules and provider mappings
are preserved. Selecting an account shows its new folders plus shared/system
folders; All Accounts labels new folders with their account address. System views
such as Inbox still combine accounts in All Accounts.

IMAP special-use attributes recognize localized Sent, Drafts, Archive, All Mail,
Trash, Important and Junk boxes. Existing mappings take priority over new
classification: a legacy folder can gain the appropriate icon without moving
its contents. Newly discovered special boxes use the matching system view;
Junk remains a distinct account folder. No-select namespace parents are skipped.

Moving messages between app folders remains a **local classification change**;
it does not issue IMAP MOVE commands. The stored source account and remote
identity stay unchanged. The server rejects an entire mixed-account selection
when its target folder belongs to one account. Sender rules targeting an
account folder must belong to that same account. In All Accounts, the move menu
only offers shared/system destinations; select one account for its private folders.
Renaming or deleting synced custom folders through UniHub remains disabled;
change those folders at the provider.

Missing system folders are inserted in one batch. Existing display names and
positions are preserved. Sender rules and available folder slugs are loaded once
per routing operation, avoiding database reads and default-folder writes for each
matched message.

## Fetch Strategy

For each selected folder:

1. Open the folder and read its current `UIDVALIDITY`.
2. Load its entry in `mail_sync_state`. A new folder, changed UIDVALIDITY, or
   missing UIDVALIDITY triggers a full UID search. A successfully initialized
   folder searches UIDs greater than its last successful checkpoint.
3. Include incomplete local imports below the checkpoint in the retry set.
4. Validate all returned UIDs before advancing any checkpoint. Filter already
   complete imports by account, exact source folder, UID and UIDVALIDITY.
5. Fetch pending UIDs sequentially and parse complete RFC 822 messages with
   `mailparser`. If an incomplete message is absent from the provider, its
   guarded local `.eml` archive can supply the content for repair.
6. Preserve existing local folder/read/star choices when repairing a message.
   Apply the operation's sender-rule ordering to genuinely new messages.
7. Stage a raw archive and all attachments, then commit message metadata,
   attachment rows, `import_complete = TRUE`, and eligible deletion/notification
   queue rows in one transaction. Failed persistence rolls back metadata and
   removes uncommitted staged files.
8. Advance the folder checkpoint only after every selected message succeeds.
   Completed messages are skipped on retry, while failed older UIDs remain
   eligible. Update account `last_synced_at` only after the account's folder pass
   succeeds; it is a status timestamp, not the import cursor.

A first account import, new-folder baseline, UIDVALIDITY reset, and repairs do not
produce historical notification floods. Incremental arrivals can enqueue durable
notifications in the same transaction as the new message.

Existing installations receive `import_complete = FALSE` on older rows and no
preexisting per-folder checkpoint. The first upgraded sync therefore scans and
revalidates provider history once. This can take longer than an ordinary sync,
but later passes use UID progress and skip complete messages. Newly inserted
restored imports also default to incomplete and are eligible for repair without
resetting an existing folder checkpoint. Replacing an existing row through
restore retains that row's current import-complete flag.

Fetching one UID at a time bounds simultaneous message memory use. A failed
message does not discard successful imports. If a database connection fails while
COMMIT is in flight, staged files are retained because the server may have
committed their metadata; this favors recoverable orphan files over broken
references.

## Optional Server Deletion

Mail accounts default to keeping all provider-side messages. If
`delete_emails_on_server` is enabled for an account, UniHub waits 10 minutes
before attempting deletion so the user can turn the setting off again.

The deletion worker:

1. only runs after `server_delete_grace_until`
2. skips while normal mail sync is running
3. only processes complete imports with a stored `source_folder`, IMAP UID, and
   raw `.eml` archive; incomplete legacy queue entries wait for repair
4. re-checks the account setting before each message
5. marks each queue row as `deleted`, `missing`, `failed`, or `skipped`

UniHub deletes by IMAP UID in the original source folder and refuses to expunge
when the server lacks UID-scoped expunge support. Provider behavior can differ:
Gmail may archive or label messages depending on folder/server semantics.

Turning the setting off stops queued deletion and leaves local UniHub mail
untouched. Turning it on again starts a fresh 10-minute grace period and
re-queues safe, not-yet-deleted imported messages.

## Sender Routing Rules

Rules sort inbox mail into folders. They are not applied while mail is fetched;
Settings → Mail → **Sort now** applies them to the inbox.

| Rule field | Notes |
| --- | --- |
| `match_type` | `email` or `domain` |
| `match_value` | normalized sender email or domain |
| `target_folder` | existing mail folder slug |
| `mail_account_id` | optional account scope; null means global |
| `priority` | lower number wins |
| `is_active` | inactive rules are ignored |

Resolution order:

1. account-scoped rules before global rules
2. email rules before domain rules
3. lower priority first
4. older creation time first
5. ID tie-breaker

Rule endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/sender-rules` | List rules |
| POST | `/api/mail/sender-rules` | Create rule |
| PUT | `/api/mail/sender-rules/:id` | Update rule |
| DELETE | `/api/mail/sender-rules/:id` | Delete rule |
| POST | `/api/mail/sender-rules/backfill` | Dry-run or apply routing to existing inbox mail |

`POST /api/mail/sender-rules/backfill` is dry-run by default. Use
`{ "mode": "apply" }` to move matched existing messages. It scans up to `limit`
inbox messages per call (at most 5000) and returns `next_cursor` while more remain.

Applying uses the same move path as moving mail by hand. On a Sync account the
move is also queued for the mail server; on a Download account only the UniHub
folder changes. The response counts `applied` (moved), `queued` (server moves)
and `skipped`. A message is skipped when it was moved or refiled after the scan,
or when it is on a Sync account and the target folder is not connected to a
folder on that account's server.

## Mail API Endpoints

### Folders

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/folders` | List folders with total/unread counts |
| POST | `/api/mail/folders` | Create app-owned folder |
| PUT | `/api/mail/folders/:slug` | Reposition folders or rename system-folder display labels |
| DELETE | `/api/mail/folders/:slug` | Reject system deletion or unsupported synced-folder deletion |

System folders cannot be deleted. Synced custom-folder deletion returns a conflict response.

### Accounts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/accounts` | List accounts with unread counts |
| POST | `/api/mail/accounts` | Add account and start initial sync |
| GET | `/api/mail/accounts/:id` | One account, same fields as the list |
| PUT | `/api/mail/accounts/:id` | Update account settings and retest IMAP when needed; windows; a switch to Sync needs `confirm_address` |
| GET | `/api/mail/accounts/:id/mode-impact` | Local removals a mode/window choice would cause (counts only) |
| POST | `/api/mail/accounts/:id/confirm-sync-policy` | Confirm Sync removal for an existing Sync account |
| POST | `/api/mail/accounts/:id/backup-export` | Start a mail backup job of this account only |
| GET | `/api/mail/accounts/:id/purge-preview` | Counts and blocking reason for a purge; `?disconnect=true` previews disconnect and purge in one step |
| DELETE | `/api/mail/accounts/:id` | Disconnect, or purge with `purge=true&confirm_purge=<account email address>`; add `disconnect=true` to disconnect and purge a connected account in one step |

### Messages

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/emails` | List/paginate emails |
| GET | `/api/mail/emails/:id` | Load full email and regular attachment list |
| PUT | `/api/mail/emails/:id/read` | Set read state |
| PUT | `/api/mail/emails/:id/star` | Set starred state |
| POST | `/api/mail/emails/bulk-delete` | Move selected messages to `trash` |
| POST | `/api/mail/emails/bulk-move` | Move selected messages to another app folder |
| POST | `/api/mail/emails/bulk-update` | Bulk read/star updates |
| GET | `/api/mail/unread-counts` | Unread counts by folder and optionally account |
| GET | `/api/mail/attachments/:id` | Authenticated attachment download |
| POST | `/api/mail/drafts` | Create an app-local draft |
| PUT | `/api/mail/drafts/:id` | Update an app-local draft |
| DELETE | `/api/mail/drafts/:id` | Delete an app-local draft and its attachments |
| POST | `/api/mail/drafts/:id/send` | Send an app-local draft and remove it after SMTP succeeds |
| GET | `/api/mail/writebacks` | Unsettled provider changes with `can_retry`, `can_cancel`, `can_accept_server_state` |
| POST | `/api/mail/writebacks/:id/retry` | Retry, or for a sent MOVE a read-only outcome check |
| POST | `/api/mail/writebacks/:id/cancel` | Discard an unsent change or a stopped read/star change |
| POST | `/api/mail/writebacks/:id/accept-server-state` | Stop tracking a sent MOVE in attention and run a manual sync |
| POST | `/api/mail/sync` | Manual sync for one account |
| POST | `/api/mail/sync/background` | Non-blocking background sync trigger |
| POST | `/api/mail/send` | Send mail through SMTP |

`GET /api/mail/emails` supports `folder`, `account_id`, `is_read`,
`is_starred`, `search`, `limit`, `offset`, and `include_count`.

## SMTP Sending

`POST /api/mail/send` sends with strict TLS by default and saves a local copy in
the `sent` folder. Drafts are app-local rows in the `drafts` folder with
`is_draft = true`; they are not synchronized to provider draft folders.

Compose attachment limits:

- maximum 20 attachments
- maximum 15 MB per attachment
- maximum 25 MB total attachment bytes
- request body cap is 40 MB to allow base64 JSON overhead and message text

Draft attachment payloads are validated before draft content changes. Replacements
retain old files until their metadata transaction commits; invalid replacements
and database failures preserve the previous draft. Retained plus new attachments
must fit the same limits. Attachment downloads stream from authenticated,
path-checked files rather than buffering the entire file in API memory.

SMTP port behavior:

- port 465 uses implicit TLS
- other ports require STARTTLS

## Password Encryption

Stored mail passwords use AES-256-GCM through `api/src/security/encryption.ts`.
The encryption key is derived from `ENCRYPTION_KEY` with SHA-256. Stored format:

```text
iv_hex:auth_tag_hex:ciphertext_hex
```

The password is decrypted only when opening IMAP/SMTP connections or the
CalDAV connections of the account's calendar.

## Backup and Restore

Mail section backups include accounts, folders, sender rules, messages, scores,
attachment metadata/files, raw `.eml` archives, and IMAP identity fields.

Encrypted `.unihub-backup` files carry account credentials in a portable
credential bundle. On restore, the destination server encrypts them using its
own `ENCRYPTION_KEY`. Legacy/plain ZIP credentials work only when the destination
can decrypt the source ciphertext; otherwise newly restored accounts are
inactive until credentials are entered again.

Mail accounts match by email address first, then ID. Messages match by ID,
Message-ID, or source folder/UID/UIDVALIDITY. Attachments and child rows are
remapped when Keep both creates new message IDs.

Server deletion is always restored safely disabled. `mail_server_messages` is
not included. An active mail restore pauses new sync/deletion work and waits for
already-running IMAP work to finish.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Security Notes

- Mail account rows are scoped by `user_id`.
- State-changing endpoints require CSRF validation.
- CORS is controlled by `ALLOWED_ORIGINS`.
- Private/local mail hosts are blocked unless allowlisted.
- TLS certificate verification is strict unless the user explicitly accepts a trust exception.
- Email HTML is rendered by the frontend inside a sandboxed iframe.
- Attachments are served only through authenticated API routes with path guards.

## Limitations

- In Download mode, deletions on the server are not followed; in Sync mode they
  are, once the account's policy is confirmed (see [Download and Sync](MAIL_MODES.md)).
- On generic IMAP a move by another client is followed as a deletion plus a new
  message; the body is downloaded again.
- App-local draft edits/uploads are not propagated to the provider; provider draft folders can be imported for viewing.
- App folder moves are local and are not propagated to provider folders.
- First full imports can be slow for large mailboxes.
- There is no malware scanning for downloaded or uploaded attachments.
