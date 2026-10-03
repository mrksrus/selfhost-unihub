# 0.15.0: Simpler Today page, Sort now on Sync accounts, resumable downloads

### Changed

- **Today page.** The Dashboard is now a short Today page with three cards:
  agenda, tasks and unread mail. The count tiles and the search hint are gone.
  It is called Today in the sidebar, on More, in the command palette and in the
  start page setting. The address stays `/dashboard`.
- **Sort now works on Sync accounts.** Settings → Mail → Sender rules → **Sort
  now** used to skip Sync accounts. It now moves matching inbox mail on every
  account. On a Sync account each move is also queued for the mail server, the
  same way as moving a message by hand. A message is skipped when its target
  folder has no folder on that account's server, or when it was moved while
  sorting ran. The result says how many messages moved, how many will also move
  on the server, and how many were skipped.
- **Shorter texts.** The More page is a plain list of links. Settings → Modules,
  Offline reading and Sender rules have shorter descriptions. The Mail settings
  card is now called Sender rules.

### Fixed

- **Large downloads.** Backup, recording and attachment downloads no longer go
  through the app's service worker, which could cut them off (seen in Brave at
  about 100 MB). Downloads now send `ETag` and `Last-Modified` and honour
  `If-Range`, so a browser can resume an interrupted download. Recordings and
  attachments are streamed by nginx without buffering, like backups already were.

### After updating

Reload UniHub, or accept the update prompt, so the browser installs the new
service worker. Until then downloads still go through the old one. See
[Upgrading](UPGRADING.md#0150-downloads-and-sort-now).
