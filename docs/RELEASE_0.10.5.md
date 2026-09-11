# UniHub 0.10.5 — Reconcile old folders against the mail server

This release replaces the 0.10.4 “leave everything under Legacy shared” approach
with an automatic, account-by-account reconciliation. Direct upgrades from
0.10.3 are supported; installing 0.10.4 first is not required.

## What happens to existing mail

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
The source account still owns its imported data: deleting that source account
also deletes its imported messages, including mail filed under another account.

## Upgrade safeguards and limits

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
