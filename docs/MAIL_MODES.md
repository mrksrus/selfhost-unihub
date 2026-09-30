# Download and Sync

**ALPHA: account backup, import and restore are experimental. Keep an independent, consistent backup of MySQL, uploads, deployment configuration and secrets. An application backup is not your only copy of important mail.**

Choose a mode in each account's settings. Upgrading preserves the selected mode; it does not turn Download accounts into Sync accounts.

| Mode | Provider interaction | Automatic server deletion |
| --- | --- | --- |
| Download | Import messages; filing and read/star changes stay local | Optional, with the existing ten-minute grace period and verified-archive checks |
| Sync | Import provider observations; explicitly accepted read/star/MOVE actions can update the provider | Unavailable |

## Durable changes since 0.10.13

The browser first receives confirmation that UniHub **accepted** a request, not that the provider completed it. Accepted intents and request receipts are stored in MySQL. A retry with the same idempotency key returns the same accepted result; using that key for a different request is rejected. The browser must reach UniHub to submit an action. This is not offline browser editing.

Read/star/folder overlays show the latest accepted intention while the provider is pending. Confirmation requires provider evidence and local settlement; a failed or attention-required request is not silently labelled successful. Later provider changes continue to arrive normally. The operation list distinguishes queued, executing, verifying, reconciling, retrying, confirmed and attention-required changes. A change can be discarded before dispatch, or when a read/star change has stopped in attention (flags are idempotent; retry first re-reads the provider). A sent MOVE is never discarded or retried; checking its outcome never issues another MOVE. When that check cannot prove where the message went, **Accept server state** stops tracking the move without any provider write: the operation is closed as superseded (its attempts and evidence are kept, with reason `user_accepted_server_state`), it no longer blocks purge or a newer move of that message, and a manual sync then files the message wherever the provider has it. A newer move queued behind an unresolved sent MOVE, and an unsent change whose mailbox was reset (UIDVALIDITY changed), wait in attention for a retry after sync or a discard. Changes that cannot progress back off exponentially (up to an hour) rather than reconnecting every second.

In the mail view, the sync button at the end of the list toolbar carries this state. Idle, it requests a sync of the account in view (every active account in combined views). While a sync is queued or running it shows a ring (static with reduced motion), a count badge shows changes waiting for the provider, and a warning dot marks changes in attention, a failed sync or unavailable status; then a click opens the sync panel instead of syncing, and the chevron beside it always does. The panel (a popover on desktop, a bottom sheet on touch screens) lists each account with Cancel or Sync now, the operation list with its Retry, Discard and Accept server state actions, and the Mail module's Background sync switch. The only inline notice above the list is a one-line "changes need your attention · Review" while a change is in attention.

Flag writes change only the requested flag, not the entire flag set. CONDSTORE is used when available, with lossless modification-sequence values and readback. Without it there is no atomic protection against another client editing between the read and write. A timeout or lost reply is not evidence that the provider rejected the command.

Moves require native IMAP MOVE. There is **no COPY/EXPUNGE fallback**. A valid COPYUID mapping and verified destination can settle the original operation, including when ordinary synchronization discovers that destination first. If COPYUID is missing or invalid, bounded read-only reconciliation may end in **needs attention**. Matching bytes, Message-ID or a missing source alone do not prove which independent copy moved. Do not repeatedly submit new MOVE requests to hide an uncertain result.

A scanned provisional destination can be associated with the original item only with direct mapping evidence and no conflicting accepted intent or other occurrence. Its existing local archive is retained rather than deleted. Ambiguous cases remain separate and require attention. Cross-account transfer, permanent provider deletion, remote folder rename/deletion and draft mirroring are not added by these commands.

## Mailboxes, labels and coverage

Discovery, flags, presence sweeps and body acquisition run in bounded durable jobs. Recent mail does not require a complete historical mailbox scan first. Complete windows checkpoint; failed or partial windows do not establish absence. Cancellation of **sync** stops read-only work, not previously accepted provider changes. Interactive work can yield a slow read-only job, preserving its committed progress for continuation.

A logical item can have several provider occurrences. Account-scoped Gmail X-GM-MSGID can associate label memberships with one item; ordinary IMAP copies remain separate, even with identical Message-ID or bytes. Gmail-like behavior has dedicated fixtures, but synthetic fixtures are not proof of every provider's label semantics. Coverage and counts must not be interpreted as a global snapshot during ongoing changes.

After verified provider absence, a retained copy remains in **All mail** rather than being guessed back into an old provider folder. A remaining live label keeps its membership. Explicit Legacy/local filing and Download folders remain local. Old archives without current engine observations retain compatibility projections until revalidated. UIDVALIDITY changes invalidate old addresses; an old UID is never sufficient authority for a new provider mutation.

Raw provider bytes and content-completion status are separate from metadata discovery. A visible header is not proof that its full body or attachment archive is complete. Legacy normalized raw files are retained with their provenance; upgrading does not declare them newly verified or eligible for upstream deletion.

## Modes, disconnect and purge

Download-to-Sync confirmation keeps local archives but permits provider observations to replace local projections. Switching modes stops workers, disables automatic deletion and records cancellation/reconciliation of outgoing work rather than deleting its journal. It cannot undo an already transmitted provider command. Account credentials/settings changes are validated before stopping the old workers. An account with imported provider identities cannot be redirected to another IMAP host, port, address or login; add a separate account instead.

**Disconnect** stops work, removes stored account credentials and disables server deletion. It retains local messages, attachments and operation history. Reconnect requires credentials and successful provider authentication. Unknown provider effects are not converted into new mutation jobs merely because the account reconnects.

**Purge** is a separate, explicitly confirmed permanent local removal. It is blocked while connected, while provider outcomes are unresolved, or while this account supplies retained mail filed elsewhere. It is not a provider-mail deletion action.

Disabling the mail module stops its work. Disabling background activity pauses automatic work while preserving accepted intentions. Foreground actions can resume the explicitly requested work; they do not bypass restore or disconnect protection.

## Recovery and privacy

Backup data schema 4 includes durable intentions, receipts and provider-attempt/mapping evidence. Runtime leases and jobs are not portable execution authority. Restore pauses accounts, turns server deletion off, preserves existing intention history, and imports provider identities/attempts as quarantined evidence. Restored receipts carry a recovery warning. Reconnecting and revalidating are required; restore never silently replays an archived command. Older supported backup readers remain available. Conflicting provider mailbox identities cannot be merged. See [backup compatibility](BACKUP_FORMAT.md) and [upgrading](UPGRADING.md).

SMTP delivery and saving a Sent copy are distinct outcomes. A failed Sent copy after successful delivery must not cause automatic SMTP resending. Follow the explicit copy status rather than treating a local Sent entry as provider verification.

Remote images remain blocked until consent, independently of account mode. See [email privacy](OFFLINE.md). For provider-confirmed checks, see [live mail testing](LIVE_MAIL_TESTING.md).
