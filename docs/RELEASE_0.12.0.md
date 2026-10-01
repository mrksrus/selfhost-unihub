# 0.12.0: instant mail and a modern IMAP library

New mail arrives within seconds, status updates are pushed live, and IMAP now runs on the maintained ImapFlow library. The Games module was removed.

**Back up MySQL and uploads before updating.** No new database migration, but the IMAP layer changed completely.
Behind your own reverse proxy (e.g. Nginx Proxy Manager), make sure `/api/events` is not buffered; UniHub already sends `X-Accel-Buffering: no`.

### Improvements

- **Mail sync and server-change status update live.** The app now receives
  sync progress, provider change outcomes and new-mail notices over a
  Server-Sent Events stream (`/api/events`) instead of asking the server every
  few seconds. Status changes appear within about a second, and an idle app
  sends far fewer requests. If the stream is unavailable (for example behind a
  proxy that buffers responses), the app falls back to the previous polling.
  A custom reverse proxy in front of UniHub should not buffer `/api/events`;
  see [architecture](ARCHITECTURE.md#live-status-events).

- **New IMAP library.** Mail now talks to IMAP servers through the maintained
  [ImapFlow](https://imapflow.com/) library instead of `imap-simple`/`node-imap`,
  which were no longer maintained. Sync, read/star/move writebacks, folder
  listing and creation, the connection test and optional server deletion behave
  as before: moves still require native IMAP MOVE (never COPY plus delete),
  conditional flag changes still respect concurrent server changes, and
  certificate checks, the trusted-host policy and confirmed self-signed
  certificates apply unchanged. Small visible differences: the account
  connection test opens INBOX read-only, a newly created remote folder is also
  subscribed (and an already existing one counts as present instead of
  failing), and connection-test error details may be worded differently.
  Server deletion now has the same per-command time limit as sync.

- **New mail arrives within seconds.** For each mail account with background
  sync on, UniHub now keeps one read-only IMAP IDLE connection to INBOX, so the
  server announces new mail and UniHub imports it right away instead of
  checking every 30 seconds. In Sync mode, read/star changes and deletions
  made on other devices also prompt the regular flag and deletion checks
  (which still run at most every 15 minutes). While IDLE works for an
  account, the regular INBOX check runs only every 5 minutes as a safety net;
  servers without IDLE keep the 30-second check. A rejected login stops IDLE for
  that account until its settings change. Up to 50 accounts use IDLE at once
  (`UNIHUB_MAIL_IDLE_MAX_SESSIONS`, `0` turns it off). See
  [mail sync](MAIL_SYNC.md#imap-idle-for-inbox).

### Removed

- **The Games module is gone.** Its page, navigation entries, module setting and
  `/api/games` endpoints were removed. Saved module settings that still mention
  Games are ignored, so nothing else changes for existing accounts. Saved Tetris
  scores stay in the database but are no longer used or included in new
  backups; older backups that contain them still import, with a warning that the
  scores were skipped. Game progress saved only in the browser is no longer read.
  See [upgrading](UPGRADING.md#0120-games-removed).

### Not verified before release

- The new IMAP library was tested against protocol-level fake servers and the MySQL suite, not yet against real providers (Gmail, iCloud, your own server). Please watch the sync panel after updating and report `docker logs unihub 2>&1 | grep -E "MAIL|IMAP"` if anything fails.
