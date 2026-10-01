# 0.13.0: Sync works like a mail client

Sync and Download are now two clearly separate modes. **Sync** follows the server like a mail client (deleted or moved there means removed or moved here, Gmail messages appear once with labels as folders, optional keep-windows for mail and trash/spam). **Download** keeps everything as an archive, as before.

**Nothing is deleted automatically after updating.** Each existing Sync account shows a decision in the sync panel; local mail that is no longer on the server is only removed after you confirm that account (with a backup offer). Back up MySQL and uploads before updating; migration 10 runs on startup.

Gmail users: enable *Settings → Labels → All Mail → Show in IMAP*, otherwise UniHub cannot tell archived from deleted mail and keeps it.

Read the [upgrade notes](UPGRADING.md#0130-sync-follows-the-server) first:
existing Sync accounts remove nothing until you confirm them.

### Improvements

- **Download and Sync are two distinct mail modes.** Download keeps importing
  and archiving as before and never changes the server. Sync now behaves like a
  full mail client with the server as the source of truth: mail deleted on the
  server is removed from UniHub together with its stored files, moves and
  read/star changes made elsewhere are followed, and your own read, star, move
  and delete still go to the server (delete moves to Trash).
- **Retention windows for Sync accounts.** Choose how much mail UniHub keeps
  (2 weeks, 1, 3, 6 or 12 months, or all) and, separately, how long Trash and
  Spam are kept (default 30 days). Older messages, by the date the server
  received them, are not downloaded and existing local copies are removed; they
  stay on the server.
- **Gmail messages exist once.** In Sync mode a Gmail message is one item whose
  labels are the folders it appears in. Copies stored per label by earlier
  versions are merged by Gmail's message id (never by header or content), with
  read and star taken from Gmail. All Mail is synced as a label, so archived
  mail stays; a message is removed only when it is gone from every label and
  All Mail.
- **The account settings explain both modes** and show, before saving, how many
  local emails a change would remove (not on the server, outside the windows,
  duplicate Gmail copies). Switching to Sync asks you to type the account's
  address and offers a backup of just that account's mail first.
- **Upgrade safety gate.** Accounts that were already in Sync mode keep all
  local mail after upgrading. The mail view and sync panel show how many local
  emails confirming would remove; nothing is removed until you confirm with the
  account address. The removal then runs in the background in small batches.
- **Gmail All Mail warning.** When Gmail's All Mail is hidden from IMAP, UniHub
  keeps mail that disappears from every label (it may only be archived), files
  it in Archive, and asks you to enable "Show in IMAP" for All Mail.
- **Per-account mail backup.** A backup job can now export a single mail
  account (its mail, files and sync evidence); it is listed, downloaded and
  restored like any other backup.

### Changes

- Switching from Sync to Download deletes nothing; it stops sending changes to
  the server.
- Restoring a backup leaves Sync accounts unconfirmed, so restored local copies
  are not removed until you confirm again.

### Not verified before release

- Tested with the full MySQL suite and protocol-level fake servers, not yet against live Gmail/iCloud. Confirm one account first and watch the sync panel.
