# Mail Sync Technical Documentation

## 0.10.5: existing-folder reconciliation

The [0.10.5 migration](../CHANGELOG.md#0105) supersedes the Legacy shared behavior
below. Existing server-folder mappings and exact display-name matches connect
without creating provider folders. Local-only messages are filed in a uniquely
matched To account's Inbox; unresolved mail appears under the Legacy account
view with its previous folder names. A successful complete LIST is required.
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
| IMAP client | `imapflow` (pinned 2.1.2) via `api/src/services/mail-imap-client.js` | Connect, list, select, fetch, flag, move |
| Parser | `mailparser` | Parse RFC 822 messages |
| SMTP sender | `nodemailer` | Send composed mail |
| Encryption | `api/src/security/encryption.js` | AES-256-GCM encryption for stored credentials |
| Host policy | `api/src/services/mail-host-policy.js` | DNS/private-IP checks and known-provider classification |
| Import persistence | `api/src/services/mail-import.js` | Stage files and commit complete message metadata atomically |
| Attachment handling | `api/src/services/mail-attachments.js` | Shared validation, file staging and inline CID rewriting |
| Draft persistence | `api/src/services/mail-drafts.js` | Transactional draft and attachment replacement |
| Folder checkpoints | `api/src/services/mail-sync-state.js` | Durable per-folder UID progress |
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
IMAP credentials, saves the account, optionally attempts CalDAV import, then
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
| `try_calendar_sync`, `caldav_url` | Optional one-time CalDAV discovery/import after mail account creation |

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
| Periodic INBOX follow-up | `api/src/app.js` interval | every 30 seconds: one `recent` job for the account's INBOX |
| Periodic folder discovery | same interval | at most every 5 minutes (or after a failed pass): folder LIST plus per-folder `recent`/`flags`/`history`/`presence` jobs |
| Manual sync | `POST /api/mail/sync` | immediate, complete folder discovery and fan-out |
| Service worker sync | `POST /api/mail/sync/background` | starts at most one sync if data is stale |
| Writeback follow-up | provider operation worker | ordinary (throttled) sync after an unsettled flag/move |

Periodic and service-worker sync are background work: they are skipped while the
Mail module's background setting is off. Manual Sync, flag/move actions and their
follow-up refresh still run and do not change that setting. Only manual Sync
reopens a module pause or forces an immediate flags/presence resweep.

Only one mail sync runs at a time. A second request returns an already-running
result or skips starting a new sync.

### Provider connections

Durable jobs of one account are serialized by the account lease. After a job
completes successfully and unaborted, its authenticated IMAP session is parked
per account (`api/src/services/mail-engine/connection-pool.js`) for up to 90
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

### IMAP transport

All IMAP traffic uses [ImapFlow](https://imapflow.com/). Only
`api/src/services/mail-imap-client.js` constructs clients: it translates the
host-policy config (pinned address, TLS `servername`, `rejectUnauthorized` from
the account's trust decision) unchanged, so TLS verifies the account hostname
and only an explicit, confirmed trust decision accepts an unverified
certificate. Library logging is off (`logger: false`): protocol traffic carries
credentials and message content. Automatic IDLE and COMPRESS are disabled, so
the wire carries only the engine's own commands. Setup (TCP, TLS, greeting,
login, capability negotiation) is bounded by the connect plus authentication
timeouts; literals above 32 MiB are refused before they are read.

`api/src/services/mail-imap-guard.js` gives every command its own deadline
(120 s). A deadline, abort signal, socket error or close stops the session for
good: the client is hard-closed (`close()`: socket and parser destroyed, no
LOGOUT queued behind a stalled command), every waiting command is rejected, and
nothing is dispatched on it again. A pooled session is rebound to each job's
signal; the pool probes it with `NOOP` and reuses it only while it is usable
and no command is outstanding.

`api/src/services/mail-engine/transport.js` selects with SELECT/EXAMINE
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

### One job runner

Every mail job, including accepted provider changes (`operation`) and their
outcome checks (`reconcile`), runs on the one durable scheduler
(`api/src/services/mail-sync-scheduler.js`, executor `runDurableMailJob` in
`api/src/services/mail-durable-jobs.js`). It runs at most three jobs at once, of which at
most two may be read-only (`sync`, `recent`, `flags`, `history`, `presence`,
`body`); the third slot only ever takes operation/reconcile work, so a click is
never queued behind other accounts' long scans. After a read/star/move is
accepted (or retried), the API enqueues the job and nudges the scheduler: a
read-only job of the same account, which holds the account lease, yields at a
safe boundary (its progress is kept and it continues afterwards), then the
scheduler claims immediately instead of at its next one-second poll. A nudge
that arrives during a claim pass repeats that pass.

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

- the durable scheduler's state callback (`mail-durable-jobs.js`) publishes
  `mail.job` for every job start, progress report and completion; admission of a
  sync (`mail-sync-control.js`) publishes `queued`, and `/sync/cancel` publishes
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

Rules route new inbound messages into app folders during sync.

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
`{ "mode": "apply" }` to move matched existing messages.

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
| PUT | `/api/mail/accounts/:id` | Update account settings and retest IMAP when needed |
| DELETE | `/api/mail/accounts/:id` | Delete account and attachment files for that account |

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

Stored mail passwords use AES-256-GCM through `api/src/security/encryption.js`.
The encryption key is derived from `ENCRYPTION_KEY` with SHA-256. Stored format:

```text
iv_hex:auth_tag_hex:ciphertext_hex
```

The password is decrypted only when opening IMAP/SMTP connections or optional
CalDAV import connections.

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

- Provider-side delete sync is not implemented.
- App-local draft edits/uploads are not propagated to the provider; provider draft folders can be imported for viewing.
- App folder moves are local and are not propagated to provider folders.
- First full imports can be slow for large mailboxes.
- There is no malware scanning for downloaded or uploaded attachments.
