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

Since 0.19.3 each successful complete LIST also marks mailboxes the server no
longer lists as `missing` (`retireUnlistedMailboxes`). Views and sync policy
join active mailboxes only, so their mail leaves the folder views and stays in
All mail; nothing is deleted, and a later LIST that shows the folder again
makes it active through `ensureMailbox`.

Deleting a custom folder on the server (`DELETE /api/mail/folders/:slug?server=1`,
`mail-folder-delete.ts`) stops the account's read jobs, sends IMAP DELETE and
only then changes local rows, in one transaction. A login or connection failure,
or a refusal, changes nothing; a DELETE reply with `NONEXISTENT` (or a "does not
exist" reply for a folder the server no longer lists) counts as deleted. The
mailbox is retired as above. An item filed there is removed only when its last
present copy was in that mailbox; one still present in another active mailbox
(a Gmail label, All Mail) is filed there and re-pointed to that copy. Drafts,
items without a copy there, Legacy or cross-filed items and items with an
unsettled writeback stay and move to Drafts or Inbox. A discovery LIST taken
just before the DELETE can register the folder once more; the next one retires it.

An item's provider address (`emails.remote_folder/uid/uidvalidity`) always
names a copy the server still has: when a presence sweep proves the addressed
copy absent while another active mailbox still holds the message, the sweep
re-points the item there (`repointToLiveOccurrence`: a real folder before All
Mail, then the most recently observed copy). Queuing and Retry do the same
(Retry only on Sync accounts), so changes are never sent to a dead address.
A read or star change whose addressed copy is missing before it is sent
(another mail client moved the message after the last presence sweep) checks
that one UID's presence at once, re-points the item the same way and is then
set on the live copy. While UniHub knows no other copy yet, the change waits
for sync like any stall and ends in attention only after its bounded retries.
The writeback list carries UniHub's own reason as a `reason` code (`moved`,
`changed`, `mailbox_reset`), never the provider's error text.
After a confirmed move into Trash or Spam on Gmail, the item's other
copies are marked absent in the same transaction.

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
| Job kinds and operation states | `api/src/services/mail-engine/job-kinds.ts`, `mail-engine/operation-states.ts` | The one declaration of the scheduler's kinds (read-only, mutation) and of `mail_writebacks.state` lists (waiting, unresolved, settled, the "due" predicate, retry/cancel rules) |
| Raw archive | filesystem | Stores imported `.eml` source below `/app/uploads/mail-raw` |
| Attachments | filesystem + DB | Stores regular and inline attachments below `/app/uploads/attachments` |

## Database Tables

| Table | Purpose |
| --- | --- |
| `mail_accounts` | IMAP/SMTP settings, encrypted password, sync metadata, TLS trust state |
| `mail_folders` | User-owned catalog; new custom folders also have `mail_account_id`, old shared folders keep NULL |
| `mail_folder_remote_boxes` | Account-specific mapping from app folders to exact provider folder names |
| `mail_sync_state` | Pre-engine folder checkpoints; kept for upgrades, no longer read or written (restore rebuilds progress from `mail_engine_cursors`) |
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
| `trusted_imap_fingerprint256`, `trusted_smtp_fingerprint256` | With `accept_host_trust`: the SHA-256 fingerprints of the certificates shown in the confirmation; the account then trusts exactly these |
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

### Confirmed certificates

When the IMAP login cannot verify the certificate, the `409` confirmation
(`mailHostTrust.certificates`) lists both certificates (IMAP over implicit TLS,
SMTP over implicit TLS on 465 or after STARTTLS otherwise): owner, issuer,
expiry and SHA-256 fingerprint. Confirming stores both fingerprints in
`trusted_imap_fingerprint256` and `trusted_smtp_fingerprint256`. From then on
every IMAP and SMTP connection of the account accepts a certificate only if it
verifies normally or has exactly the confirmed fingerprint, checked by
`api/src/security/mail-certificates.ts` before the server receives anything
(no login, no message). A different certificate fails the connection with
`CERT_FINGERPRINT_MISMATCH`; editing the account's login then shows the new
certificate for confirmation. Moving a confirmed account to another SMTP
server asks again unless the new server's certificate verifies.

An account confirmed before fingerprints were kept (or whose SMTP certificate
could not be read during the confirmation) keeps the first certificate it is
shown afterwards. A server that presents different certificates on different
connections, such as several backends behind one name, cannot be confirmed
this way; give it a verifiable certificate.

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
| Periodic INBOX follow-up | `api/src/services/background-work.ts` interval | every 30 seconds: one `recent` job for the account's INBOX; every 5 minutes while the account's IDLE session is healthy |
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
messages again (**Sync now**). A message above 50 MiB, one that cannot be parsed, or one
whose rows the database refuses (`persist_failure`; the operator log carries the error
code, never message content) is set aside for good (`deferred`); the provider keeps the
message, and a rolled-back import releases no held notification. All keep the "Loading
message" placeholder. A deadlock, a lost database connection, a full disk or a lost lease
is not the message's fault: the job fails and the message stays queued for the next one.
Header-derived values (Message-ID, sender address and name, attachment file name, content
type and content ID) are cut to their column lengths before the import, so an overlong
header alone does not set a message aside; the raw `.eml` keeps the originals.

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
folder list by default. Their IDs, slugs, messages, routing rules and provider mappings
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
2. Load its stream cursors (`mail_engine_cursors`). A new folder, changed UIDVALIDITY, or
   missing UIDVALIDITY triggers a full UID search. A successfully initialized
   folder searches UIDs greater than its last successful checkpoint.
3. Include incomplete local imports below the checkpoint in the retry set.
4. Validate all returned UIDs before advancing any checkpoint. Filter already
   complete imports by account, exact source folder, UID and UIDVALIDITY.
5. Fetch pending UIDs sequentially and parse complete RFC 822 messages with
   `mailparser`. An HTML part over 2 Mi characters is stored and shown, but
   not converted to the plain text that search and previews use (the
   conversion blocks the API process). If an incomplete message is absent from
   the provider, its guarded local `.eml` archive can supply the content for
   repair.
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
produce historical notification floods. A mailbox's first `recent` pass is its
baseline (an empty mailbox records a cursor at UID 0); from then on a message
observed in that mailbox for the first time with a UID above the `recent`
cursor is new mail, whichever stream sees it first (`recent`, or a `flags`,
`presence` or `history` sweep that met it earlier), except a MOVE destination
the user asked for. The announcement is a held notification event written in
the same transaction as the message's row, one per message (a second copy, such
as another Gmail label, hits the event's dedupe key); the body import that
brings the sender and subject releases it, in its own transaction, by filling in
the text and queuing the deliveries (`releaseMailNotification`). Only mail the
account's notification filter lets through is announced: the account is
switched on, and its folder is not left out ("Notify except selected", by
default Junk, Sent, Drafts, Trash and Archive) or is chosen ("Notify only for
selected"). Folders are chosen by role (a system folder's slug, or the special
use its server reported, so each account's own Junk counts) or by folder id.
The filter is applied when the arrival is recorded, at release and again
before each delivery: a message read or filed away before its content arrived
(on Gmail this includes a message whose All Mail copy was seen before its
INBOX copy), whose content never arrives, or whose account or folder was
switched off meanwhile, is not sent and expires with the event.

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
| GET | `/api/mail/threads` | Conversations of a view, one row each (see [Conversations](#conversations)) |
| GET | `/api/mail/emails/:id/thread` | Every message of the conversation that message belongs to, oldest first |
| PUT | `/api/mail/emails/:id/read` | Set read state |
| PUT | `/api/mail/emails/:id/star` | Set starred state |
| POST | `/api/mail/emails/bulk-delete` | Move selected messages to `trash` |
| POST | `/api/mail/emails/bulk-move` | Move selected messages to another app folder |
| POST | `/api/mail/emails/bulk-update` | Bulk read/star updates |
| GET | `/api/mail/unread-counts` | Unread counts by folder and optionally account |
| GET | `/api/mail/attachments/:id` | Authenticated attachment download |
| POST | `/api/mail/drafts` | Create an app-local draft; answers the draft and `uploaded` (see below) |
| PUT | `/api/mail/drafts/:id` | Update an app-local draft; answers the draft and `uploaded` |
| DELETE | `/api/mail/drafts/:id` | Delete an app-local draft and its attachments |
| POST | `/api/mail/drafts/:id/send` | Send an app-local draft and remove it after SMTP succeeds |
| POST | `/api/mail/drafts/:id/schedule` | Schedule a saved draft (`{ send_at }`), or move its time (see [Scheduled send](#scheduled-send)) |
| DELETE | `/api/mail/drafts/:id/schedule` | Cancel a draft's schedule; the draft stays |
| POST | `/api/mail/emails/:id/snooze` | Snooze a message until `{ until }` (see [Snooze](#snooze)) |
| DELETE | `/api/mail/emails/:id/snooze` | Bring a snoozed message back now |
| PUT | `/api/mail/accounts/:id/signature` | Save the account's signature (`{ html, text }`; empty clears it) |
| GET, POST | `/api/mail/templates` | List or create the user's templates (name unique per user, 120 characters, at most 200) |
| PUT, DELETE | `/api/mail/templates/:id` | Change or delete one template |
| GET | `/api/mail/writebacks` | Unsettled provider changes with `can_retry`, `can_cancel`, `can_accept_server_state` |
| POST | `/api/mail/writebacks/:id/retry` | Retry, or for a sent MOVE a read-only outcome check |
| POST | `/api/mail/writebacks/:id/cancel` | Discard an unsent change or a stopped read/star change |
| POST | `/api/mail/writebacks/:id/accept-server-state` | Stop tracking a sent MOVE in attention and run a manual sync |
| POST | `/api/mail/sync` | Manual sync for one account |
| POST | `/api/mail/sync/background` | Non-blocking background sync trigger |
| POST | `/api/mail/send` | Send mail through SMTP |

`GET /api/mail/emails` supports `folder`, `account_id`, `is_read`,
`is_starred`, `search`, `limit`, `offset`, and `include_count`. Each row carries
its `thread_key`, `snoozed_until`, `snooze_returned_at`, and for a scheduled
draft `scheduled_send_at` and `scheduled_send_status`. `folder=snoozed` lists
the snoozed messages.

### Snooze

Snooze is UniHub's own state (`emails.snoozed_until`); nothing changes at the
provider and the message keeps its folders. Until its time the message is left
out of every list, conversation and count; search still finds it and the
Snoozed view lists it. The time must lie between one minute and a year ahead;
drafts cannot be snoozed. Every 30 seconds the worker brings back the messages
whose time has come (`services/mail-snooze.ts`), each in one transaction with
its notification (kind `snooze`), so a crash neither loses nor repeats it. The
notification follows the account's detail level but not its on/off switch or
folder filter: the person asked for it. Users whose Mail is off, paused or
being restored wait. Bringing a message back by hand sends no notification.
Backups carry the snooze state; a restored message whose time has passed
comes back on the next worker pass.

### Scheduled send

A saved draft can be scheduled (`mail_scheduled_sends`, one row per draft;
`services/mail-scheduled-send.ts`). Every 15 seconds the worker claims the due
schedules and sends each draft through the same send-once path as Send, under
the schedule's own key, so a second pass, a restart or a second process never
sends it twice. The statuses are:

| Status | Meaning |
| --- | --- |
| `scheduled` | Waiting; the draft can be edited, rescheduled, cancelled or sent by hand (which cancels the schedule) |
| `sending` | Claimed; editing, deleting or cancelling the draft answers `409 SCHEDULED_SEND_IN_PROGRESS`. A claim with no outcome after 10 minutes is settled from its receipt |
| `sent` | Sent, but the draft could not be removed (normally the sent draft takes its schedule with it) |
| `failed` | Refused before the message left; `last_error` holds a text written for the person, never the SMTP reply. Rescheduling uses a new key |
| `unknown` | The connection ended after the message was handed over; never retried. The person checks Sent |

Sending a draft by hand reserves it in the same row (`origin = 'send_now'`,
status `sending`), replacing its schedule: while either kind of send runs, a
new schedule, an edit, a delete and the scheduler leave the draft alone, so it
cannot go out twice. A send by hand whose process stopped is never resumed by
the worker; its receipt only decides whether the draft is marked sent, unknown
or free again. Every writer locks the draft row first and then this row. A
mail restore waits for running draft sends, and a draft the restore writes
loses its schedule.

`failed` and `unknown` scheduled sends send a notification (kind
`scheduled-send`) without message content. Schedules wait while the person's Mail is off, paused or
being restored, or the person is deactivated. Schedules are installation-local
work: a backup does not carry them and a restored draft is not scheduled.

### Conversations

Since 0.24 every message has a conversation key, `emails.thread_key`: the
SHA-256 (hex) of the conversation's root Message-ID, per user
(`services/mail-threading.ts`):

1. The root is the first id of `References`, else the id of `In-Reply-To`.
   When the user stores the root message with a key, that key is used, so a
   reply that names only its parent joins the parent's conversation even when
   the parent's own root lies further up.
2. A message with neither header whose subject starts with a reply or forward
   prefix (`Re:`, `AW:`, `Antw:`, `SV:`, `Fwd:`, `WG:`, `TR:`, ...) joins the
   most recent earlier message of the same user with the same subject
   (prefixes, list tags such as `[team]`, case and spacing ignored), received
   within 60 days, when the two share a correspondent other than the user's own
   account addresses. Only the user's latest 2000 messages before it are
   searched. A subject without a prefix never joins anything, so two unrelated
   "Invoice" mails stay apart.
3. Otherwise the message starts its own conversation: the hash of its own
   Message-ID, or of its row id when it has none (also for a message whose
   content has not arrived yet).

The arrival order does not matter: storing a message whose key is not the hash
of its own Message-ID moves the messages keyed by that hash (replies that
arrived first) into its conversation. Keys never cross users; another
person's message with the same Message-ID lends nothing.

`In-Reply-To` (its first well-formed id) and `References` are stored with each
imported message in both modes, with UniHub's Sent copy and with drafts
(`emails.in_reply_to`, `emails.references_header`). Header values are
untrusted: only well-formed `<id>` values of at most 500 characters are kept,
and `References` is shortened to its first and 39 latest ids (at most 8000
characters).

A reply answers the user's own copy of a message: it sends `In-Reply-To` with
that message's Message-ID and `References` with that message's `References`
(or its `In-Reply-To`) followed by its Message-ID; its Sent copy joins that
message's conversation. A reply draft keeps the same headers and conversation
when it is saved (`in_reply_to_email_id` on `POST /api/mail/drafts` and
`PUT /api/mail/drafts/:id`; `null` or `''` removes the link), so a reply
finished later from Drafts still goes out as a reply.

Mail stored before 0.24 is threaded in the background by the worker owner
(`services/mail-thread-backfill.ts`, every 15 seconds, at most 600 messages or
5 seconds a tick, then a 5-minute pause once nothing is left). It reads the
header part of each message's raw file (at most 64 KiB, inside the owner's raw
directory; both raw formats); a message without a raw file is keyed from what
its row holds. The rows still without a key are the progress marker, so a
restart resumes and nothing is done twice; mail restored from an older archive
is picked up the same way. A user whose mail section is being restored, whose
Mail module is off, or whose raw directory is not reachable (an unmounted
volume looks like missing files) waits.

`GET /api/mail/threads` takes the filters of `GET /api/mail/emails` and lists
the conversations of that view, newest first: a conversation is listed once,
at the place of its newest message in the view (`latest`, a message-list row),
with `message_count` and `unread_count` in the view, `total_count` in the whole
mailbox (drafts excluded), `has_attachments`, `is_starred` and up to five
`participants` (senders, most recent first). Pages are `limit`/`offset`, or the
`cursor` the previous page returned as `next_cursor`, which keeps pages apart
while new mail moves a conversation to the top; messages received in the same
second are ordered by id ascending (the order of `idx_emails_user_date`, so a
page reads only the index entries it needs). `include_count=true` also counts
the view's conversations; unlike the message list this is off by default,
because it reads the whole view. The message list itself is unchanged; the
app asks for conversations when the user turned on **Threaded view**
(`mail_threaded_view`). `GET /api/mail/emails/:id/thread` returns
`{ thread_key, messages, truncated }`: the user's messages of that message's
conversation in every folder and account, oldest first, at most the newest
200. Offline, both answer from the saved snapshot (the latest 100 messages),
so a conversation shows only its saved messages. Shapes:
`api/src/contracts/mail-threads.ts`.

## SMTP Sending

`POST /api/mail/send` sends with strict TLS by default and saves a local copy in
the `sent` folder. Drafts are app-local rows in the `drafts` folder with
`is_draft = true`; they are not synchronized to provider draft folders.

Both send routes accept an `Idempotency-Key` header; the app sends one per
composed message. The key is claimed in `mail_command_receipts` before SMTP and
holds the response afterwards, so a repeated request (a lost response, a second
click) returns the first response and sends nothing. While the first request
runs, a repeat gets `409 SEND_IN_PROGRESS`. A send that the server refused
before it took the message (connection, login, a refused recipient, or a
reply refusing the message) releases its key, so the same message can be
sent again. When the connection ended after the `DATA` command, the server may
have queued the message: the outcome is recorded as unknown, and the request
and every repeat get `409 SEND_OUTCOME_UNKNOWN`. A send that stopped without a
recorded outcome (the server restarted mid-send) is reported the same way once
its pending receipt is two minutes old and no send for it runs in this
process. The app then asks the user to check Sent and offers "Send again",
which is a new send under a new key, only while that message is still open
in the composer. The same key with a different message is
`409 IDEMPOTENCY_KEY_REUSED`, offered the same way. Receipts are deleted
30 days after their last change.

A reply names the message it answers with `in_reply_to_email_id` (on
`POST /api/mail/send`, or in the body of `POST /api/mail/drafts/:id/send`).
The server reads that message's `Message-ID` from the user's own copy and sends
it as `In-Reply-To` and, after that message's own `References`, in
`References`, so the recipient's mail program shows the reply in the same
conversation. Another user's message, or one without a usable
`Message-ID`, adds nothing. A reply draft keeps this link (see
[Conversations](#conversations)), so a reply finished later from Drafts goes out
with the same headers.

Send and draft requests take `to`, `cc` and `bcc` as comma-separated strings;
at least one of them needs a recipient. The Sent copy and drafts keep all three
(`to_addresses`, `cc_addresses`, `bcc_addresses`), and the email detail returns
them as arrays. Bcc is never part of the delivered message, only of your copy.

Compose attachment limits:

- maximum 20 attachments
- maximum 15 MB per attachment
- maximum 25 MB total attachment bytes
- request body cap is 40 MB to allow base64 JSON overhead and message text

Draft attachment payloads are validated before draft content changes. Replacements
retain old files until their metadata transaction commits; invalid replacements
and database failures preserve the previous draft. Retained plus new attachments
must fit the same limits. A new attachment may carry a `client_id` (letters,
digits and `-`, at most 64); the answer's `uploaded` pairs each such
`client_id` with the attachment id it became, so the composer keeps that file
by id (in `existing_attachment_ids`) and never uploads it again. The composer
runs a message's saves one at a time, each from the message as it is when it
starts. Attachment downloads stream from authenticated,
path-checked files rather than buffering the entire file in API memory.

SMTP port behavior:

- port 465 uses implicit TLS
- other ports require STARTTLS

## Password Encryption

Stored mail passwords use AES-256-GCM through `api/src/security/encryption.ts`.
The encryption key is derived from `ENCRYPTION_KEY` with SHA-256. Stored format:

```text
v1:iv_hex:auth_tag_hex:ciphertext_hex
```

Values from before 0.23.0 have no `v1:` prefix and are read the same way.
Reading falls back to `ENCRYPTION_KEY_PREVIOUS` after a key change (see
[Installation](INSTALLATION.md#changing-the-encryption-key)).

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
- TLS certificate verification is strict unless the user explicitly confirms the server's certificates; a confirmed account trusts only those certificates (by fingerprint) or ones that verify.
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
