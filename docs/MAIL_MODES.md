# Download and Sync

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of MySQL, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Choose a mode in each mail account's settings. Existing accounts stay in Download,
with their existing automatic-deletion preference. Updating does not switch modes.

| Mode | What follows the server | Automatic server deletion |
| --- | --- | --- |
| Download | New mail is imported; local filing and read status stay local | Optional, with the existing ten-minute grace period |
| Sync | Provider changes arrive in UniHub; new read/unread, star and message-move actions in UniHub update the provider | Unavailable |

## Two-way message changes (0.10.9)

The server is authoritative. Opening a message or explicitly changing read/unread,
stars, folder placement or moving to Trash sends that specific action to the
provider. It never uploads the complete local state. Existing local differences
are not replayed when upgrading. Download behavior stays local.

Commands persist in MySQL until processed, so an interrupted connection or app
restart does not silently lose them. UniHub shows pending, failed and conflicting
changes. A successful provider confirmation/read-back updates the saved local
state. Changes made later at the provider, another client or AI arrive normally.

If an update is interrupted, UniHub checks the server before at most one automatic
retry on a later sync. Already-applied flags require no second write. An uncertain
flag update is retried only with an unchanged saved server modification version;
otherwise the server wins. Conditional flag writes are used when the server supports
CONDSTORE. Servers without it get targeted flag changes, but a simultaneous edit
between the check and write cannot be detected atomically. Uncertain writes on
those servers are not repeated automatically. Failed changes can be retried manually.

Moves use native IMAP MOVE only; there is no COPY/EXPUNGE fallback. An uncertain
move is never blindly resent. Refresh the account and check the provider when a
move needs reconciliation. Destinations must be verified folders of the same
provider account. This does not add cross-account transfers, permanent deletion,
remote folder rename/deletion or draft mirroring. Existing SMTP sending is unchanged.
Legacy, drafts and retained missing/local-only copies remain local. Messages lacking
a verified current provider identity require synchronization before provider writes.

Sender rules do not override server filing. Provider labels appear only when
exposed as selectable folders; other keywords, category names and importance flags
are not translated. Multiple label folders can hold separate local copies.
No new offline browser editing support is added: the browser must reach UniHub to
queue an action; UniHub can retain that action while its provider connection fails.

## Switching modes

Download to Sync requires confirmation because server filing/read status can
replace local choices. It keeps originals and locally stored attachments. Messages
missing from a complete server scan remain in their last local folder with a
**Local copy** label. A failed or incomplete scan cannot mark messages missing.
Messages that cannot be matched safely stay unchanged; a manual sync reports the
number of ambiguous locations. Matching never relies on recipient or Message-ID
alone. A changed UIDVALIDITY requires content evidence before reconnecting a copy.

Saving a mode change requests worker cancellation and waits for any operation
already deleting a provider copy to finish. It disables automatic deletion and
cancels pending deletion work and outgoing message changes. Account edits cancel pending outgoing changes too. It cannot undo a deletion already completed.
Switching back to Download retains local data and leaves deletion off. Save that
mode first, then explicitly enable deletion if wanted.

Use Sync now to reconcile immediately, or let the background sync run. Account
status shows pending/running/idle/cancelled/error. Interrupted work resumes from
completed imports on the next run. Complete metadata inventories are checked on
each pass; only unknown or incomplete messages need raw content. Large accounts
can take time, especially on first reconciliation. This is polling, not push.

An account with imported provider identities cannot be redirected to a different
IMAP host, port, address or login. Add a separate account instead. Password,
SMTP and display-name edits remain available. This prevents reused provider IDs
from matching unrelated retained messages.

## Recovery and privacy

Schema-3 backups include mode, original/current provider identities and the
local-copy marker. Restoring restarts Sync reconciliation as pending and always
leaves automatic deletion off. Outgoing commands are excluded from archives, and applying a mail restore clears destination commands in the restore transaction. Older archives default to Download. Conflicting
provider mailbox identities cannot be merged during restore. See
[backup compatibility](BACKUP_FORMAT.md).

Email privacy choices apply independently of account mode. Remote images remain
blocked until consent, with optional suspected-tracker filtering. Choices last
only for the current visit to a message. See [email privacy](OFFLINE.md).
