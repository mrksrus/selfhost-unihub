# 0.19.3: Mail in step with the server

Mail actions now look done the moment you make them, while a small mark
shows what the mail server has not confirmed yet. Several slow drifts
between UniHub and the mail server are fixed.

### Changed

- **Immediate actions.** Moving, trashing, marking read and starring update
  the list, the reader and the unread counts at once. If UniHub rejects a
  change, everything returns to how it was and a message says so.
- **Quiet sync state.** A small hollow dot marks a change the server has not
  confirmed yet; the sync button still counts all waiting changes.
- **Less text.** Shorter confirmations ("Moved to Archive") and no
  "awaiting provider" text in every row.

### Fixed

- A message moved or archived in another mail app can be changed from UniHub
  again instead of failing and jumping back.
- On Gmail, a message moved to Trash leaves Archive, Important and labels at
  once.
- Sort now sorts exactly what the Inbox shows.
- Read and star changes made on the server to recently arrived mail are
  picked up by every check, not only the first.
- Folders deleted or renamed on the server show as empty instead of their old mail.
- Switching from Sync to Download no longer leaves unsent changes waiting.
- The account unread count matches the folder counts.
- "Last synced" updates after every sync.
- Mail actions work when the web app and the API are on different addresses.

### Upgrade

- Pull and restart. No database upgrade and no configuration change.
