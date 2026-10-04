# Download and Sync

**ALPHA: account backup, import and restore are experimental. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets. An application backup is not your only copy of important mail.**

Each mail account runs in one of two modes. They are deliberately different; choose per account in its settings. Upgrading keeps the selected mode.

| | Download | Sync |
| --- | --- | --- |
| Idea | The server is a source to archive from | UniHub is a full mail client; **the server is the source of truth** |
| New mail | Imported and kept | Imported (inside the account's windows) |
| Mail deleted on the server | Local copy stays | Local copy (and its stored files) is removed |
| Mail moved on the server | Local copy stays where it is | Follows the move |
| Read/star changed elsewhere | Not followed | Followed |
| Your read/star/move/delete in UniHub | Stays local | Sent to the server (delete = move to Trash) |
| Retention windows | None; everything imported is kept | Mail older than the window is not kept locally (stays on the server) |
| Optional server deletion | Available (ten-minute grace, verified archive) | Unavailable |

## Download

Download imports mail and never writes to the server: filing and read/star changes stay local. Local copies are kept even after the server deletes them. Optional server deletion removes the server copy after a verified local archive exists. Download ignores retention windows. Nothing in this release changes Download behaviour.

## Sync

Sync keeps UniHub equal to the server:

- **Deleted on the server, deleted here.** When a complete presence sweep proves a message is gone from every mailbox it was in, UniHub removes the local item together with its raw message and attachment files. An item that still exists in another mailbox (another Gmail label, All Mail, a copy) stays. A message with a pending change of yours (read, star, move not yet confirmed) is kept until that change settles.
- **Moves follow the server.** On Gmail the same message (same X-GM-MSGID) in another mailbox is the same item; the occurrence simply moves. On other IMAP servers a move by another client looks like a deletion plus a new message; the new copy is imported as a new item.
- **Read and star follow the server**, and your own read/star/move/delete in UniHub are sent to the server as before (delete moves the message to Trash). See [durable provider changes](#durable-provider-changes).
- **Sender rules move on the server too.** *Sort now* (Settings → Mail) queues a server move for each matched message. Messages whose target folder has no folder on this account's server stay in the inbox and are counted as skipped.
- **Retention windows.** Per account, *Keep mail* (`sync_window_days`: 2 weeks, 1, 3, 6 or 12 months, or all) and *Keep Trash and Spam* (`trash_window_days`, default 30 days) limit what UniHub keeps. The Trash/Spam window applies to mailboxes marked `\Trash` or `\Junk` (and Gmail's Trash and Spam). The age is the server's INTERNALDATE (when the server received the message), not when it was trashed. Older messages are not imported, their bodies are not downloaded, and existing local copies older than the window are removed locally. The server keeps them. Widening a window imports the older history again.
- **Mail without a server link stays local.** Some messages in a Sync account were never linked to a server message: UniHub's own copy of mail you sent, and mail kept from before the account used Sync. Read, star, move and delete on such a message change only UniHub; the server has nothing to change. If the same message was also downloaded from the server (same Message-ID header, sender and subject, dated within a day), the extra local copy is removed after confirmation and the downloaded one is kept. A message without such a twin is never removed by Sync.
- Removal never touches the server. It is applied by a low-priority background job (`prune`) in batches of at most 200 messages, after other mail work, and announced to open tabs as `mail.changed` with reason `content`.

### Gmail

Each Gmail message exists once in UniHub; its labels are the folders it appears in. Identity of server messages is Gmail's X-GM-MSGID only, never a Message-ID header or matching content (the Message-ID rule above only removes local copies that have no server link). Mail imported before 0.12 was stored as one copy per label; in Sync mode these copies are merged by X-GM-MSGID after confirmation: one item is kept (preferring a complete download), every label, operation history and Gmail mapping is moved to it, read/star are taken from the server, and the redundant copies and their files are removed.

**All Mail matters.** Archiving in Gmail only removes the INBOX label; the message stays in All Mail. UniHub syncs All Mail like any other label (it is not a second copy, just another label of the same item), so an archived message stays. A Gmail message is deleted locally only when it is gone from every mailbox including All Mail. Retention windows apply to All Mail like any folder.

If All Mail is hidden from IMAP (Gmail setting *Labels → All Mail → Show in IMAP* off), UniHub cannot tell archived mail from deleted mail. It then keeps such mail, files it in the local Archive view and shows a warning on the account (`sync_warnings: ["gmail_all_mail_hidden"]`). **For Sync mode, keep All Mail visible in IMAP.**

### Confirmation before anything is removed

Removing local mail needs a per-account confirmation (`sync_policy_confirmed_at`):

- **Accounts that were already in Sync mode before 0.13.0 are unconfirmed.** UniHub keeps importing, following flags and moves, merging nothing and removing nothing. Mail the server no longer has stays visible only in **All mail** until you confirm. The account shows how many local messages confirmation would remove; confirm with the account address (below). Then removal runs in the background.
- **Switching Download → Sync** asks you to type the account's email address. Before saving, UniHub shows how many local messages would be removed: not on the server (known from earlier syncs, and messages UniHub itself deleted on the server), outside the chosen windows, redundant Gmail copies, and local copies of messages also downloaded from the server. Messages deleted on the server since the last sync are not known yet and are removed once Sync sees they are gone. You can first export a backup of this account's mail. The typed address confirms the policy for this account.
- **New accounts created in Sync mode** are confirmed at creation; they have no local-only mail.
- **Switching Sync → Download** deletes nothing. UniHub stops sending changes to the server and drops the confirmation; a later switch back asks again.
- **A restore** never brings back a confirmed policy, so restored local copies are not removed until you confirm again.

### API

| Call | Purpose |
| --- | --- |
| `GET /api/mail/accounts`, `GET /api/mail/accounts/:id` | Account JSON includes `sync_window_days`, `trash_window_days`, `sync_policy_confirmed`, `sync_policy_pending_removals` (Sync and unconfirmed only, else `null`) and `sync_warnings` |
| `PUT /api/mail/accounts/:id` | Accepts `sync_window_days` and `trash_window_days` (14, 30, 90, 180, 365, or empty/`null` for all) in either mode; a change to `sync` requires `confirm_address` equal to the account address (case-insensitive), otherwise `400 { error, requires_confirmation: true }` |
| `GET /api/mail/accounts/:id/mode-impact?mode=sync\|download&sync_window_days=&trash_window_days=` | Counts only: `{ mode, local_only, outside_window, outside_trash_window, gmail_duplicates, total_removals, notes }`; an empty window means all mail, an absent one the stored value |
| `POST /api/mail/accounts/:id/confirm-sync-policy` `{ confirm_address }` | Confirms an existing Sync account and queues the removal job: `{ confirmed: true, queued: true }` |
| `POST /api/mail/accounts/:id/backup-export` `{ encrypt? }` | Starts a mail-only backup job of this account: `202 { job }` in the shape of `POST /api/backup/jobs`; poll and download it with the usual `/api/backup/jobs/:id` calls |

`total_removals` adds the categories; a message that is both outside a window and a Gmail copy can be counted twice, so read it as an upper bound.

## Durable provider changes

The browser first receives confirmation that UniHub **accepted** a request, not that the provider completed it. Accepted intents and request receipts are stored in MariaDB. A retry with the same idempotency key returns the same accepted result; using that key for a different request is rejected. The browser must reach UniHub to submit an action. This is not offline browser editing.

Read/star/folder overlays show the latest accepted intention while the provider is pending. Confirmation requires provider evidence and local settlement; a failed or attention-required request is not silently labelled successful. Later provider changes continue to arrive normally. The operation list distinguishes queued, executing, verifying, reconciling, retrying, confirmed and attention-required changes. A change can be discarded before dispatch, or when a read/star change has stopped in attention (flags are idempotent; retry first re-reads the provider). A sent MOVE is never discarded or retried; checking its outcome never issues another MOVE. When that check cannot prove where the message went, **Accept server state** stops tracking the move without any provider write: the operation is closed as superseded (its attempts and evidence are kept, with reason `user_accepted_server_state`), it no longer blocks purge or a newer move of that message, and a manual sync then files the message wherever the provider has it. A newer move queued behind an unresolved sent MOVE, and an unsent change whose mailbox was reset (UIDVALIDITY changed), wait in attention for a retry after sync or a discard. Changes that cannot progress back off exponentially (up to an hour) rather than reconnecting every second.

Flag writes change only the requested flag, not the entire flag set. CONDSTORE is used when available, with lossless modification-sequence values and readback. Without it there is no atomic protection against another client editing between the read and write. A timeout or lost reply is not evidence that the provider rejected the command.

Moves require native IMAP MOVE. There is **no COPY/EXPUNGE fallback**. A valid COPYUID mapping and verified destination can settle the original operation, including when ordinary synchronization discovers that destination first. If COPYUID is missing or invalid, bounded read-only reconciliation may end in **needs attention**. Matching bytes, Message-ID or a missing source alone do not prove which independent copy moved. Do not repeatedly submit new MOVE requests to hide an uncertain result.

In the mail view, the sync button at the end of the list toolbar carries this state; the sync panel lists each account, its operations and their Retry, Discard and Accept server state actions. See [mail sync](MAIL_SYNC.md#status-updates).

## Mailboxes, labels and coverage

Discovery, flags, presence sweeps, body acquisition and the Sync policy job run in bounded durable jobs. Recent mail does not require a complete historical mailbox scan first. Complete windows checkpoint; failed or partial windows never establish absence. Cancellation of **sync** stops read-only work, not previously accepted provider changes. Interactive work can yield a slow read-only job, preserving its committed progress.

UIDVALIDITY changes invalidate old addresses; an old UID is never sufficient authority for a new provider mutation, and occurrences of a reset mailbox are quarantined rather than treated as deleted (such items are kept). Explicit Legacy/local filing (mail filed in another account) is never removed by the Sync policy. Raw provider bytes and content-completion status are separate from metadata discovery; legacy normalized raw files keep their provenance.

## Disconnect and purge

Switching modes stops workers, disables automatic deletion and records cancellation of outgoing work rather than deleting its journal. It cannot undo an already transmitted provider command. Account credentials/settings changes are validated before stopping the old workers. An account with imported provider identities cannot be redirected to another IMAP host, port, address or login; add a separate account instead.

**Disconnect** stops work, removes stored account credentials and disables server deletion. It retains local messages, attachments and operation history. Reconnect requires credentials and successful provider authentication. A restore pauses every restored account without disconnecting it; entering the password in the account settings reconnects it the same way.

**Purge** (**Delete local data** in the app) is an explicitly confirmed permanent local removal of the account, its messages, attachments and raw copies, and its linked calendar account with its calendars and events. The preview lists these counts; confirming needs the typed account address. A disconnected account is purged on its own. The disconnect dialog also offers **delete local data…** for a connected account: the preview then ignores the connection, and confirming disconnects and purges in one step. Purge is blocked while provider outcomes are unresolved, while this account supplies retained mail filed elsewhere, or while a calendar restore runs and a linked calendar would be removed; a blocked one-step delete changes nothing, and a purge refused after the disconnect (an outcome became unresolved meanwhile) leaves the account disconnected with its mail kept. It is not a provider-mail or provider-calendar deletion action.

Disabling the mail module stops its work. Disabling background activity pauses automatic work while preserving accepted intentions.

## Recovery and privacy

Backup data schema 4 includes durable intentions, receipts, provider-attempt/mapping evidence and, since 0.13.0, the account windows and each occurrence's INTERNALDATE. Runtime leases and jobs are not portable execution authority. Restore pauses accounts, turns server deletion off, resets the Sync confirmation, preserves existing intention history, and imports provider identities/attempts as quarantined evidence. Reconnecting and revalidating are required; restore never silently replays an archived command. See [backup compatibility](BACKUP_FORMAT.md) and [upgrading](UPGRADING.md).

A per-account mail backup contains that account, its mail, attachments, raw messages and engine evidence, plus the shared folders and global sender rules its mappings refer to. Messages filed in another account are restored under their own account.

SMTP delivery and saving a Sent copy are distinct outcomes. A failed Sent copy after successful delivery must not cause automatic SMTP resending.

Remote images remain blocked until consent, independently of account mode. See [email privacy](OFFLINE.md). For provider-confirmed checks, see [live mail testing](LIVE_MAIL_TESTING.md).
