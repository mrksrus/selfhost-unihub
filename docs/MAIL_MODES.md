# Download and Sync

Choose a mode in each mail account's settings. Existing accounts stay in Download,
with their existing automatic-deletion preference. Updating does not switch modes.

| Mode | What follows the server | Automatic server deletion |
| --- | --- | --- |
| Download | New mail is imported; local filing and read status stay local | Optional, with the existing ten-minute grace period |
| Sync from email server | Read/unread, stars and verified folder locations for existing and new mail | Unavailable |

Sync currently follows changes **from the provider into UniHub**. Local read,
star and folder changes do not update the provider and may be replaced during the
next successful sync. Sender rules do not override server filing in this mode.
Providers' labels appear only when exposed as selectable folders; other keywords,
category names and provider importance flags are not translated. Multiple label
folders can hold separate copies.

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
cancels pending deletion work. It cannot undo a deletion already completed.
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
leaves automatic deletion off. Older archives default to Download. Conflicting
provider mailbox identities cannot be merged during restore. See
[backup compatibility](BACKUP_FORMAT.md).

Email privacy choices apply independently of account mode. Remote images remain
blocked until consent, with optional suspected-tracker filtering. Choices last
only for the current visit to a message. See [email privacy](OFFLINE.md).
