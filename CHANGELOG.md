# Changelog

All notable user-visible changes to UniHub, newest first. Each release is
published as the container image `ghcr.io/mrksrus/selfhost-unihub:<version>`.
Read the [upgrade guide](docs/UPGRADING.md) before updating an existing
installation, and keep a consistent backup of the database, uploads, configuration and
secrets. Releases between 0.9.20.0 and 0.10.0 have no entry here.

## 0.19.0

The API and the two browser workers are now written in TypeScript and
compiled before they run. UniHub works the same as before: the same pages,
routes, database and backup format. No database upgrade runs at startup.

### Changed

- **The API is compiled from TypeScript.** Routes, services, security helpers
  and the `mail-rollout` operator command are checked in strict mode and
  compiled to the same CommonJS layout as before. The image holds only the
  compiled code and the production dependencies. `/app/api/server.js` and
  `/app/api/mail-rollout.js` are where they were. The frozen database
  baseline (`database.js`) stays JavaScript.
- **The browser workers are compiled too.** The notification service worker
  and the recording worklet keep their URLs (`/sw-custom.js`,
  `/audio-recorder-worklet.js`). Installed apps and push subscriptions keep
  working.
- **The image runs on Node.js 26.** The container, CI and the package
  manifests move from Node 24 to Node 26.

### Upgrade

- With the container image there is nothing to do: pull and restart. The
  database is not changed, and backups from earlier versions restore as
  before.
- Running the API from source (not the image) now needs Node.js 26 and its
  development dependencies to compile it: `npm --prefix api ci`, then
  `npm --prefix api start`, which builds `api/dist/` first.

## 0.18.2

A calendar connected from a mail account no longer keeps its own copy of the
mail password. It reads the mail account's login each time it syncs or saves
a change. This removes a whole group of cases where the copy and the mail
account got out of step. Database upgrade 14 runs at startup. See
[Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md).

### Changed

- **A linked calendar follows its mail account.** A new mail password or a
  reconnect applies to the calendar right away, also when Calendar was turned
  off or being restored at the time. While the mail account is disconnected,
  or paused by a restore, the calendar is shown as paused with "The mail
  account is disconnected" and syncs again once the mail account is
  reconnected. Disconnecting mail no longer switches the calendar off; a
  calendar you paused yourself stays paused.
- **Restored mail calendars find their mail account.** A calendar restored
  from a backup that belonged to a mail account is no longer restored paused
  for lack of a password. It finds the mail account with its address and uses
  that login. From backups of older versions, the copied mail password of a
  marked mail calendar is left out (one from before 0.17 never uses its copy
  while a mail account with its address exists), and a calendar that only a
  mail disconnect had switched off comes back on.
- **Collapsed sidebars stay collapsed.** On desktop, the app navigation and
  the mail account and folder list remember whether you collapsed them, also
  after a reload. The choice is kept in this browser.

### Upgrade

- The upgrade removes the copied mail passwords from linked calendars, and
  turns calendars that were switched off only by a mail disconnect back on.
  They sync once their mail account is connected.

## 0.18.1

Removes a mail account together with its local data in one step, reconnects
accounts that a restore paused, and ends offline mode by itself once UniHub is
reachable again. No database upgrade. See [Disconnect and purge](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/MAIL_MODES.md#disconnect-and-purge)
and [Offline](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/OFFLINE.md).

### Added

- **Disconnect and delete local data in one step.** The Disconnect dialog now
  also offers **delete local data…**. It shows what will be removed (emails,
  attachments, raw messages and the linked calendar with its events) and asks
  for the account address. Confirming disconnects the account and removes it
  with that data from UniHub. Mail and events at the provider are not touched.
  The account and its calendar are removed together or not at all. A delete
  that is blocked (unresolved provider changes, mail filed in another account,
  a linked calendar while Calendar is turned off or being restored) changes
  nothing.

### Changed

- **Deleting a disconnected account's data** (the bin icon) also lists the
  linked calendar and its events, and is confirmed with the account address
  instead of the account ID. The server checks the typed address too.

### Fixed

- **Accounts paused by a restore can be reconnected, with their saved
  password.** A restore pauses every mail account so Sync cannot remove
  restored mail before you check it again. Entering the password in the account
  settings did not switch such an account back on, and resuming it from the
  sync overview was refused. Now **Save** in the account settings reconnects
  it. When the backup included the password (credentials restored), leave the
  field empty: UniHub tests the saved password with the provider and uses it,
  so no new app password is needed. The sidebar shows such an account as
  **Paused** instead of **Disconnected**. Do not disconnect it first:
  Disconnect deletes the saved password.
- **Disconnect also stops the linked calendar.** Disconnecting a mail account
  now cancels a sync or event change of its linked calendar that is running at
  that moment, and no later one uses the mail password again, also when
  Calendar was turned off at the time. Reconnecting the mail account resumes
  the calendar, also when that was missed at the time (Calendar off, or a
  failed update), and a missed password change reaches it the same way; a
  calendar you paused yourself stays paused.
- **Offline mode ends by itself.** One request that failed in the network (a
  restart, a proxy hiccup) switched the open app to read-only offline mode until
  **Retry connection** was clicked or the page was reloaded, even though
  everything else kept loading. Writes then failed with "Offline mode is
  read-only". The next answer from UniHub now ends offline mode, and a refused
  write checks the connection so a retry a moment later works.

## 0.18.0

Backups can now include any mix of sections, and a new **Account settings**
backup sets up mail and calendar accounts again without importing their content.
No database upgrade. See [Account Settings Backup](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/BACKUP_RESTORE.md#account-settings-backup).

### Added

- **Choose what to back up.** In **Settings > Data Management > Create a
  backup**, the section buttons (Settings, Contacts, Calendar/ToDo, Mail,
  Recordings) are now selectors. Pick one or more and press **Backup** to create
  one backup with all of them. **Create full backup** works as before.
- **Account settings backup.** The new **Account settings** selector backs up
  only your mail and calendar account connections: servers, logins, Sync or
  Archive mode, and the sync and trash windows. Restoring it signs in to each
  account as if you had just added it, then downloads mail and calendars from
  the provider according to those settings. No emails, events or files are in
  the backup. Accounts that are already connected are left unchanged. Local
  calendars are calendar content and are not included.

### Changed

- **Turning Mail back on resumes a Sync you asked for.** A Sync that was
  waiting while Mail was turned off now continues when Mail is turned on, also
  with background sync off. Background sync work still waits for the next Sync.
- **Clearer backup names.** Saved backups and restore reviews show section
  names, such as "Settings, Account settings backup", instead of internal IDs.

### Fixed

- **A new calendar account's first sync is not lost.** If UniHub restarted
  right after a calendar account was connected or restored, or Calendar was
  off, its first sync waited for background sync. It now runs once Calendar is
  on, also with background sync off.
- **Several calendar subscriptions in one restore.** Restoring a backup with
  more than one calendar subscription (ICS feed) without an email address kept
  only the first; with **Replace matching** the others overwrote it.
  Subscriptions are now matched by their feed address.
- **Saved backup buttons on phones.** Download, Review for restore and Delete
  no longer overflow the backup card on narrow screens.

## 0.17.4

Makes recordings safe to close the app on, and lets each page be shown, hidden
and ordered on its own: Calendar and ToDo, Recordings and Music, and Today. No
database upgrade. See [Recordings on the device](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/RECORDINGS.md#recordings-on-the-device)
and [Modules](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/MODULES.md).

### Added

- **Recordings are kept on the device until they are uploaded.** A recording is
  written to the browser's storage every 2 seconds while it runs and stays
  there until the server has stored it. If the app or the browser closes before
  **Stop**, the next visit to Recordings offers it as a recovered draft. The
  new **On this device** list shows drafts, waiting uploads with their progress,
  and files the server refused, each with Download.
- **Uploads continue after the app is closed.** The upload runs while UniHub is
  open, on any page. When it is closed, the service worker finishes it where the
  browser allows (Background Sync in Chrome, Edge and Android). If it cannot,
  the device shows **Recording not uploaded yet**, or **Sign in to finish
  uploading** when the session ended. If the browser stops the worker before it
  can say so (iOS), the server sends that notice as a push after 10 minutes
  without progress. Notifications need permission in Settings → Notifications.
- **Pages can be hidden and ordered one by one.** Settings → Modules now lists
  **Pages** (Mail, Calendar, ToDo, Contacts, Recordings, Music, Today), each with
  **Show in navigation** and its place in the order. Music and Today are regular
  pages in the sidebar and mobile bar instead of fixed links under More.
- **Music as start page.** Settings → General → Default start page offers Music.

### Changed

- **Modules switch their pages on and off together.** The **Modules** list keeps
  **Enabled** and **Background work**. Calendar and ToDo still share one module,
  and so do Recordings and Music, now named **Recordings and Music**. A module
  hidden before this release keeps all its pages hidden until changed.
- **Uploads resume without duplicates.** The browser picks the upload ID, so
  repeating a start after a lost answer resumes the same upload, and a chunk or
  completion whose answer was lost is not stored twice. Every 512 KiB chunk is
  checked with SHA-256 on the server.

### Fixed

- **Volume swelling and fading in recordings.** UniHub already asked the
  browser to turn off automatic gain control, noise suppression and echo
  cancellation, but some browsers ignore that request. Recording now checks what
  was applied, asks again, and warns when one is still on. A recording also
  survives the microphone being taken away (it stops and keeps the audio) and
  the browser suspending audio (it resumes and says so).

### Documentation

- [Recordings on the device](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/RECORDINGS.md#recordings-on-the-device)
  describes capture, recovery, the upload queue and the notifications.
- [Modules](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/MODULES.md)
  covers pages and how they relate to modules.

## 0.17.3

Makes two-factor authentication easier to set up and to recover from, and
hides the empty Legacy mail view. No database upgrade. See [Two-factor authentication](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/AUTH_ADMIN_SETTINGS.md#two-factor-authentication).

### Added

- **QR code for setup.** **Settings > Security > Set Up 2FA** shows a QR code to
  scan with an authenticator app, the setup key, and an **Open in authenticator
  app** link for an app on the same device. The code is drawn in the browser;
  the secret is not sent anywhere else. Before, setup showed only the key and
  the raw `otpauth://` link.
- **Admins can reset another user's 2FA.** For a user who lost both the
  authenticator and the recovery codes, **Admin > Users** has a **Reset 2FA**
  button on accounts with 2FA, marked with a **2FA** badge. The admin confirms
  with their own password. The user is signed out everywhere and signs in with
  their password. Admins cannot reset their own 2FA this way; the docs describe
  what to do if the only admin is locked out.

### Changed

- **Turning on 2FA signs out your other devices.** Sessions opened with the
  password alone end when 2FA is enabled, as they already did when it is
  disabled. The device you set it up on stays signed in. Setup now asks for
  your password, so a browser left signed in is not enough to turn on 2FA with
  someone else's authenticator and lock you out.
- **Legacy mail view is hidden when empty.** The **Legacy** entry in the mail
  account list holds mail that the 0.10.5 folder migration could not file. It
  is now listed only while it holds mail, so installations without such mail no
  longer show **Legacy (0)**. A view left on Legacy switches to All accounts
  once it is empty.

### Fixed

- **After an `ENCRYPTION_KEY` change.** The authenticator key is stored
  encrypted with `ENCRYPTION_KEY`, so after that key changes authenticator codes
  stop working. Recovery codes always kept working for sign-in. Now Settings
  says what happened and how to fix it: turn 2FA off with a recovery code and
  set it up again. Generating new recovery codes in that state used up the
  recovery code entered and then failed with a server error; it now refuses
  before checking the code.

### Documentation

- [Two-factor authentication](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/AUTH_ADMIN_SETTINGS.md#two-factor-authentication)
  covers setup, `ENCRYPTION_KEY` changes, the admin reset and turning 2FA off in
  the database when the only admin is locked out.

## 0.17.2

Makes turning on the calendar of an existing mail account clearer. No
database upgrade. See [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md#connecting-a-calendar).

### Changed

- **Connect calendar button.** While a mail account's calendar is off, its
  Calendar section has a **Connect calendar** button, and Enter in the address
  field connects too. It uses the typed address, or finds the server when the
  field is empty. Before, Enter did nothing while the calendar was off, so an
  address could only be used through the switch.
- **Saving does not change the calendar, and the section says so.** The
  Calendar section applies its changes right away; **Save** on the mail account
  never turned the calendar on, which was easy to miss.
- **The last error stays visible.** When connecting fails, the error appears
  below the section until the next attempt instead of only in a toast that
  disappears.

### Documentation

- [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md)
  explains what a self-hosted server such as Stalwart needs: CalDAV over HTTPS
  under a hostname with a valid certificate. The MX hostname alone is not
  enough.

## 0.17.1

Fixes four calendar sync problems found in review after 0.17.0. A small
database upgrade runs at startup. See [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md)
and [Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0171-calendar-sync-fixes).

### Fixed

- **An unreadable event no longer deletes its local copy.** When a calendar
  server sends an event UniHub cannot parse, the last readable version stays,
  with its ToDo state and subtasks. The sync status says how many entries could
  not be read, and the next sync tries them again, also for unreadable copies
  0.17.0 had already stored. Before, the event and its ToDo state were removed
  and the sync reported success.
- **Turning off a mail account's calendar respects the Calendar module.** The
  Calendar section's requests are refused while the Calendar module is off or a
  calendar restore runs, so they can no longer delete calendar data then.
- **Events from before 0.17 are not deleted or moved only locally.** Until the
  first sync has replaced them, deleting or moving one is refused with "This
  event is still being synced", as editing already was. Before, the event was
  removed in UniHub only and came back with the next sync.
- **A calendar account added on its own is not taken over by a mail account.**
  Only calendars that belonged to a mail account (from 0.16 or earlier, or
  linked before a backup) are linked by address when the mail account's
  settings are opened. Before, any calendar account with the same address was
  linked, so turning off or disconnecting the mail account also affected it.
  The startup upgrade marks the calendar accounts 0.17.0 linked, so a backup
  taken right after upgrading still links them again when restored. For one
  restored from a 0.17.0 backup, turn the calendar on in the mail account's
  settings: an account with the same server and login is now taken over with
  its events and ToDo state instead of being replaced.

## 0.17.0

Calendars now sync both ways with the login you already use for mail. UniHub
needs no OAuth app, API key or other setup on the server.
See [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md)
and [Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0170-calendar-sync).

### Added

- **Calendar settings on the mail account.** The edit dialog of a mail account
  has a Calendar section: turn it on or off, see the status, the last sync, the
  server that was found and the synced calendars, sync now, or enter a
  different address. Turning it off removes the imported calendars and events
  from UniHub; nothing changes on the server.
- **Finds the calendar server by itself.** From the email address and IMAP
  server, UniHub tries built-in providers (iCloud, Fastmail, Yahoo,
  mailbox.org, Posteo), DNS SRV records and `/.well-known/caldav`. This covers
  Stalwart, Nextcloud, Radicale, Baïkal, SOGo, mailcow and other CalDAV
  servers that publish it; otherwise enter the address once. New mail accounts
  try this by default.
- **Real sync.** Every account syncs every 15 minutes and on demand. Only
  changed events are downloaded. Recurring events, exceptions, time zones and
  event reminders are supported. New events from the server send a
  notification, and open pages update live.
- **Changes go back to the server.** Creating, editing, deleting and moving
  events in a CalDAV calendar writes them to the server. For repeating events
  you choose this event or all events. An event changed elsewhere in the
  meantime is never overwritten: UniHub refreshes it and asks you to try again.
- **Subscriptions.** Any ICS or webcal address can be added as a read-only
  calendar. This is how Gmail, Outlook and Exchange calendars appear: paste the
  calendar's secret (Google) or published (Outlook) ICS link.
- **Calendar page.** Add CalDAV accounts and subscriptions directly; each
  account shows its sync status, with sync now, pause and resume. Read-only
  calendars and events are marked as such.

### Changed

- Calendars imported by earlier versions start syncing; their first sync
  replaces the imported events, so their ToDo status starts empty.
- Synced calendars start with auto-ToDo off.

### Known limitations

- Google and Microsoft calendars are read-only; their two-way APIs need OAuth.
  Exchange Web Services is not supported.
- Attendees and RSVP are not synced.
- Changing the time of a whole repeating series resets the ToDo status and
  subtasks of its events.
- A color set on a single synced event is replaced by the calendar color.

## 0.16.0

**Breaking: UniHub now runs on MariaDB instead of MySQL, and there is no in-place
upgrade.** 0.16.0 is for new installations. An existing 0.15.x installation that
pulls 0.16.0 stops at startup with a message and leaves its data untouched. Pin
`ghcr.io/mrksrus/selfhost-unihub:0.15.1` to keep it running, or move to a new
installation with account backups. See
[Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0160-mariadb).

### Changed

- **MariaDB 11.8 LTS.** The database container is now `mariadb:11.8`
  (supported until 2030). Any MariaDB 10.11 or later works if you bring your
  own server. UniHub refuses MySQL and older MariaDB versions at startup,
  before it changes anything.
- **One file to install.** `docker-compose.yml` no longer mounts files from the
  repository. Download it, set the two passwords and start it; the app creates
  its database tables itself. This also works in Portainer, Dockge and similar
  tools that take only a Compose file.
- **New names in the Compose file.** The database service is `unihub-db`, its
  volume is `mariadb_data`, and the `.env` fields are `UNIHUB_DB_PASSWORD` and
  `UNIHUB_DB_ROOT_PASSWORD`. The MySQL configuration file
  `docker/mysql/conf/custom.cnf` is gone; its settings are now options of the
  database service.
- **Health check.** The database uses MariaDB's own `healthcheck.sh`, and the
  app container starts only once the database reports ready.

## 0.15.1

### Fixed

- **Notifications stopped after 3 weeks.** A sign-in lasted 21 days from
  sign-in, however often UniHub was used. When it ended, that device's
  notifications stopped without any sign. Now:
  - A sign-in lasts 21 days from the last time UniHub was used on that device,
    so opening the app now and then keeps it signed in.
  - When an unused device has 2 days left, it gets a "Notifications will stop
    soon" notification.
  - After signing in again, notifications on that device turn back on by
    themselves if they were on before. This also happens when the browser's
    push service replaced the subscription.
- **Pushes are never dropped silently.** A push the device cannot show (for
  example for an account that is not signed in there) now shows a generic
  "You have a new notification" notice without content. Some browsers revoke
  subscriptions that receive pushes without a notification.
- **Install card appeared too often.** It now has **Install**, **Later** and
  **No**. Later asks again after a day, and so does cancelling the browser's
  install dialog. No stops asking in that browser. A card that is ignored
  appears at most once a day.

### Changed

- **Notification status per device.** Settings → Notifications shows the last
  notification delivered to this device, any unresolved delivery problem, and
  until when the device stays signed in. The text about how often mail is
  checked was wrong (it said every 10 minutes) and was removed.

### After updating

Reload UniHub, or accept the update prompt, so the new service worker is used.
Devices that were already signed out need to sign in once. See
[Upgrading](docs/UPGRADING.md#0151-sliding-sessions).

## 0.15.0

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
[Upgrading](docs/UPGRADING.md#0150-downloads-and-sort-now).

## 0.14.0

**This release permanently deletes all Notes.** Export any note you want to keep
before updating (open the note and use **Download Markdown**, or keep a 0.13.x
backup that includes Notes). Database upgrade 11 removes them on first start.

### Removed

- **Notes.** The Notes page, its API, search results, command palette entries and
  backup section are gone. Database upgrade 11 drops the `notes`,
  `note_revisions`, `note_attachments` and `note_links` tables and deletes the
  attachment files under `/app/uploads/notes`. If that folder cannot be deleted
  (for example because it is a separate mount), UniHub logs a warning and starts
  normally; delete the folder by hand.
- A Notes start page falls back to the default start page.
- Older backups that contain Notes still import. Notes are skipped with a
  warning and everything else is restored.

### New

- **Module order.** Settings → Modules has up and down buttons for each module.
  The sidebar, the mobile bar and the More page follow this order. The mobile
  bar shows the first four pages (Calendar and ToDo count as two); the rest are
  on More. The order is saved per user and included in settings backups.

### Changed

- The default mobile bar is now Mail, Calendar, ToDo and Contacts. Recordings
  moved to More. Move Recordings up in Settings → Modules to bring it back.

### After updating

Check the log for `[DB] Could not remove old note attachments` and delete the
named folder if it appears. See [Upgrading](docs/UPGRADING.md#0140-notes-removed).

## 0.13.3

### Fixes

- **Marking mail read no longer fails for messages without a server link.** In
  a Sync account, UniHub's own copy of sent mail and mail kept from before the
  account used Sync are not linked to a server message. Changing such a message
  failed with "Sync this account before changing this message on the provider",
  and a bulk action that included one (for example marking all unread mail
  read) failed for every selected message. Read, star, move and delete on these
  messages now change only UniHub, and the rest of the selection is sent to the
  server as usual.
- **Extra local copies are cleaned up.** When such a local copy is the same
  message as one downloaded from the server (same Message-ID header, sender and
  subject, dated within a day), Sync removes the local copy and keeps the
  downloaded one, after the account's Sync confirmation. Local copies without
  a downloaded twin are kept. The mode-switch preview counts them.
- A message whose server link is damaged now says so, with the number of
  affected messages, instead of asking you to sync the account.

## 0.13.2

### Fixes

- **A large message no longer blocks every message behind it.** A message had
  30 seconds to download in full, which large Gmail messages often missed;
  since contents download newest first, the same message was tried again in
  every job and the messages behind it stayed at "Loading message". A message
  now has up to 5 minutes, and a download that stops sending data is still cut
  off after 30 seconds. A message that misses the deadline is set aside so the
  rest continue; **Sync now** tries it again.
- **Messages up to 50 MiB are downloaded** (previously 32 MiB), the largest
  message Gmail accepts.

## 0.13.1

### Fixes

- **Messages no longer stay at "Loading message" on large accounts.** Message
  contents were downloaded one at a time at the lowest priority, behind
  read/star and presence checks that on large Gmail accounts run almost
  continuously, so thousands of messages could wait for days. Contents now
  download in batches of up to 25, newest first, ahead of those background
  checks. Messages whose download stopped after an error resume within five
  minutes instead of only when new mail arrives.

## 0.13.0

Read the [upgrade notes](docs/UPGRADING.md#0130-sync-follows-the-server) first:
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

## 0.12.1

### Fixes

- **Gmail sync no longer stalls after updating to 0.12.0.** The new IMAP library
  reads Gmail's stable message id, which the old one never did. Mail imported
  before 0.12.0 was stored as one local copy per Gmail label, so the same id
  appeared on several copies and every sync window containing such a message
  failed with "Gmail identity belongs to another local item", leaving the Gmail
  queue to back up. Such copies now keep their own entry, as before 0.12.0, and
  the conflict is recorded for review instead of failing the sync. Nothing is
  merged or deleted.
- **Failed mail jobs are logged.** Each failed sync job now writes one
  `[MAIL JOB] <kind> failed for account <id>: <reason>` line to the container
  log (no addresses or mail content). Before, failures were only visible in the
  database.

## 0.12.0

### Improvements

- **Mail sync and server-change status update live.** The app now receives
  sync progress, provider change outcomes and new-mail notices over a
  Server-Sent Events stream (`/api/events`) instead of asking the server every
  few seconds. Status changes appear within about a second, and an idle app
  sends far fewer requests. If the stream is unavailable (for example behind a
  proxy that buffers responses), the app falls back to the previous polling.
  A custom reverse proxy in front of UniHub should not buffer `/api/events`;
  see [architecture](docs/ARCHITECTURE.md#live-status-events).

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
  [mail sync](docs/MAIL_SYNC.md#imap-idle-for-inbox).

### Removed

- **The Games module is gone.** Its page, navigation entries, module setting and
  `/api/games` endpoints were removed. Saved module settings that still mention
  Games are ignored, so nothing else changes for existing accounts. Saved Tetris
  scores stay in the database but are no longer used or included in new
  backups; older backups that contain them still import, with a warning that the
  scores were skipped. Game progress saved only in the browser is no longer read.
  See [upgrading](docs/UPGRADING.md#0120-games-removed).

## 0.11.1

### Security

- **The API no longer runs as root in the container.** The Node API runs as the
  `unihub` user (uid/gid 10001) without capabilities; Nginx is unchanged. The
  first start after updating hands `/app/uploads` over to that user. If you
  bind-mount uploads from the host, it must be writable by uid 10001. See
  [upgrading](docs/UPGRADING.md#0111-non-root-api).

### Fixes

- **Retried mail actions no longer fail on a database deadlock.** Two identical
  requests with the same `Idempotency-Key` (for example a move or read change
  resent after a slow response) could deadlock and one of them failed. The
  second request now waits and returns the first one's result.
- **Correct due times on MySQL servers not set to UTC.** The API now switches
  every database connection to UTC. Before, a MySQL server with a different
  default time zone shifted scheduled work, expiries and timestamps by hours.

### Maintenance

- Removed the retired pre-0.11 mail sync code and other unused mail helpers.
- Mail has one job runner. Read/star/move changes now run on the same durable
  scheduler as sync instead of a separate in-process queue. One worker slot is
  kept free for these changes, so a click starts right away even while other
  accounts are syncing long folders.
- Split the three largest API files (mail service, mail routes, backup service)
  into smaller modules by area. No behavior change.
- Upgraded pre-0.9.23 installations now get the same calendar colour default as
  fresh installs (migration 9).
- `docker/mysql/init/01-schema.sql` is generated from the app's own upgrades
  (`scripts/local-mysql.sh schema-dump`) and checked by a MySQL test; the legacy
  baseline upgrade is frozen and every schema change is a numbered migration.
- Frontend: strict TypeScript, and unused pages, UI components and 18 packages
  removed.
- Development: an on-demand local MySQL 8.4 (`scripts/local-mysql.sh`, nothing runs
  at boot) and deterministic sample data (`npm run db:dev`). See
  [development](docs/DEVELOPMENT.md#local-mysql-and-sample-data).
- Release notes are collected in this changelog.

## 0.11.0

*Calmer mail sync and a stable baseline*

0.11.0 finishes the durable mail engine that shipped as a preview in
[0.10.13](docs/RELEASE_0.10.13.md). It fixes the queues that stopped draining on real
Gmail, iCloud and self-hosted accounts, moves sync status out of the way, and
cleans up the UI and code that later work builds on.

**Back up MySQL and uploads before updating.** No new migration is required
compared with 0.10.13; updating from 0.10.12 or older runs the 0.10.13
migrations. See [upgrading](docs/UPGRADING.md).

### Mail sync fixes

- **Queues no longer starve.** One busy account's backlog could fill the
  scheduler's candidate window and stop every other account from syncing. Only
  accounts that can run now are considered.
- **Database deadlocks are retried.** Lock conflicts between the scheduler and
  the due-work pass were aborting whole passes and failing sync jobs. Deadlocked
  transactions now run again, and the due-work pass skips a contended row
  instead of stopping.
- **Gmail sync no longer fails on duplicate system folders.** A second mailbox
  that looks like a system folder (for example a label "Sent" next to
  `[Gmail]/Sent Mail`) becomes its own folder instead of failing every sync.
- **iCloud sync no longer fails on out-of-spec mod-sequences.** An invalid
  `HIGHESTMODSEQ`/`MODSEQ` is treated as "no CONDSTORE" for that mailbox.
- **A failing change no longer blocks the others.** It is counted, backs off,
  ends in "needs attention" after 8 attempts, and its reason is written to the
  server log (`[MAIL OPERATION]`, never to the database or UI).
- **Accept server state.** A sent move whose result cannot be proven can now be
  resolved from the sync panel: UniHub stops tracking it, sends nothing to the
  provider and syncs the account again.
- Finished mail jobs are pruned after 7 days, and lease recovery runs every
  15 seconds instead of on every scheduler poll.

### Interface

- **Sync status lives in the sync button.** The pending-changes sentence and the
  per-account rows above the mail list are gone. The toolbar sync button shows a
  spinner while syncing (✕ on hover on desktop), a badge with the number of
  changes waiting for the server, and an amber dot when something needs you. It
  opens a sync panel (popover on desktop, bottom sheet on phones) with each
  account's status, Cancel / Sync now, the waiting changes with Retry, Discard
  and Accept server state, and a Background sync switch.
- The only inline notice above the list is one line when changes need your
  decision: "N changes need your attention · Review".
- Consistent loading, empty and error-with-retry states on Contacts, Calendar,
  Todo, Recordings, Music, Notes, Dashboard, Admin users and Settings. Failed
  loads no longer look like empty lists, Save preferences is disabled until
  preferences have loaded, and 2FA status errors no longer offer "Set up 2FA".
- One toast system (the unused `sonner` toaster was removed).

### Under the hood

- `MailPage.tsx` is split into focused components and hooks.
- New real-MySQL integration tests cover job pruning, the claim filter, the
  due-work back-off, Accept server state, mailbox epoch changes and deadlock
  retry.
- Flaky frontend tests were fixed.

### Not verified before release

- The new interface was not reviewed in a browser before publishing (desktop and
  phone, dark and light). Please report anything that looks off.
- Provider behaviour was fixed from live diagnostics; confirm on your accounts
  that the change count goes down after updating. If one change keeps failing,
  `docker logs unihub 2>&1 | grep "MAIL OPERATION"` shows why.

### Compatibility and limits

- Native IMAP MOVE is required for provider moves.
- CONDSTORE is provider-dependent. Without it (including iCloud mailboxes with
  invalid mod-sequences), a change made by another client between UniHub's read
  and write cannot be detected atomically.
- Backups use data schema 4, which 0.10.12 and older cannot read.

## 0.10.13

*Durable mail engine preview*

This release ships the new durable mail engine planned for 0.11.0, plus review
fixes. 0.11.0 follows once the UI and stability work in
[the roadmap](docs/ROADMAP_0.11.0.md) (P2) is done. The engine itself is described in
[the 0.11.0 notes](docs/RELEASE_0.11.0.md).

**Back up MySQL and uploads before updating.** Database migrations run on
startup and cannot be undone by switching back to an older image. Backups made by
this version use data schema 4, which 0.10.12 and older cannot read.

### Changed

- Mail changes (read, star, move) are durable operations with explicit
  accepted / pending / confirmed / needs-attention states. A move that may have
  reached the provider is never sent twice.
- Mail sync runs as bounded, resumable jobs per folder and stream instead of one
  long scan per account.
- One IMAP session per account is reused between jobs, bulk changes run in
  batches of up to 50 on one connection, and the periodic wake-up only follows
  INBOX every 30 seconds. Full folder discovery runs at most every 5 minutes.
- The bundled `docker-compose.yml` uses MySQL 8.4 LTS. Switch the database image
  as a separate step after the application update; see [upgrading](docs/UPGRADING.md).
  Comments in the file list the image tag and pull policy options.

### Fixed

- Stuck operations: every state has a working Retry or Discard, and the due-work
  pass backs off per operation (15 s up to 1 h) instead of retrying every second.
- The Mail background setting is respected and no longer cleared by a single
  foreground action.
- Follow-up syncs after a change are no longer treated as manual refreshes.
- Operator canary holds can only be released with `mail-rollout.js release`.

### Known limits

- A move that was sent but whose outcome cannot be proven stays in
  needs-attention and cannot be discarded yet.
- Native IMAP MOVE is required for provider moves.

## 0.10.12

*Working provider writes and independent mail jobs*

### Fixed

- Correct conditional IMAP flag commands. The pinned `imap@0.8.19` library
  omitted the parentheses around `UNCHANGEDSINCE`, causing real servers to reject
  read/star updates. A narrow, version-checked protocol adapter sends the correct
  single-UID flag delta and treats tagged `MODIFIED` responses as conflicts. It
  does not remove conflict checks or replace all of a message's flags.
- Mail sync is queued per account instead of treating any account's active sync
  as completion for everyone else. The API acknowledges acceptance promptly;
  owner-scoped status reports queued/running/progress/finished/error/cancelled
  states. At most two complete account syncs run concurrently.
- Read/star/move intents are accepted in a short database transaction rather
  than waiting for an account's entire provider scan. Provider commands remain
  serialized per account. Opposite flag intents are protected from stale worker
  completions; bulk acceptance retains all-or-nothing validation.
- An independent due-work pass runs at startup and every 30 seconds. Both direct
  and scheduled writebacks share a four-connection bound. Accounts waiting for
  sync do not consume independent provider-worker slots.
- Long syncs service accepted provider changes at safe checkpoints. A move
  invalidates and restarts the snapshot instead of applying stale location data;
  flags are read again before committing confirmed metadata.
- Verified, unambiguous new messages are imported during the scan, so later
  inventory churn does not discard their progress. Adjacent body reads reuse
  the selected folder; a bounded cache avoids duplicate reads where safe.
- The browser no longer says “Sync complete” for a queued or already-running
  request. Progress and cancellation are account-scoped. Other messages, views
  and accounts remain usable while a request/provider job is active.
- Background jobs are discovered without a reload; status polling recovers from
  temporary errors. Mail lists refresh during progressing imports at a bounded
  cadence without repeatedly refreshing the open reader or all other queries.
- Bulk actions deduplicate matching requests, preserve newer flag edits, and
  distinguish provider-pending acceptance from an actual failure.

### Safety and limits

No queue reset, account-mode change, historical flag upload, new schema migration,
volume, secret, or Compose change is required relative to 0.10.11. Existing
**pending** user intents can resume through the due worker. Failed/conflicting
operations still need review; uncertain provider moves are not blindly replayed.

Network confirmation is necessarily asynchronous: immediate UI feedback means
an intent was accepted, not that a disconnected provider has already applied it.
Busy job pools show queued work instead of pretending it completed. Reconciliation
of location/missing state is deliberately deferred if a complete consistent
inventory cannot be established; verified new imports remain saved. A continually
changing mailbox can therefore still report a reconciliation error.

The protocol adapter intentionally fails closed if its pinned IMAP dependency
changes. Dependency upgrades must rerun the actual-wire regression tests and
review the adapter. Providers without safe IMAP MOVE retain the existing safe
failure behavior; there is no unsafe COPY/EXPUNGE fallback.

### Validation and reproducibility

Before publication, **124 frontend tests** passed, along with TypeScript and lint
(zero errors; three existing unrelated Fast Refresh warnings). The API release
gate passed **394 tests with zero skips** against disposable MySQL 8 and Node 24.
The production Dockerfile also built successfully and reported version 0.10.12.
The publication workflow additionally requires container smoke checks before
pushing the tested image.

The IMAP regressions use the installed library over a local protocol peer, rather
than only mocking `addFlagsSince`/`delFlagsSince` method calls.

The opt-in [live mail acceptance test](docs/LIVE_MAIL_TESTING.md) uses normal public
API authentication/actions plus independent IMAP readback. It tests delivery,
incoming sync/content, prompt actions, rapid reversals, incoming external-client
changes, folder creation and moves with exact body preservation. A pending UI
flag or successful HTTP response alone cannot pass the test. Use a dedicated test
mailbox; this is not automatically run against an operator's personal messages.

A passing test on one provider is not a guarantee for all providers or networks.
Account backup/import/restore remain ALPHA.

### Updating

Keep a consistent database/uploads/configuration backup and existing encryption
keys. Follow [Upgrading](docs/UPGRADING.md) for older installations. Refresh the browser
or PWA after installing the new image so its UI and API contract match.

## 0.10.11

*Correct mail flags and responsive interactions*

### Fixed

- Mail list, detail and draft responses now explicitly decode database flags.
  MySQL can return computed flags as strings: JavaScript previously interpreted
  `"0"` as true, making unstarred or unread messages appear starred/read even
  though the Starred folder and stored flags were correct.
- Read and star actions keep list/detail caches consistent during a slow request,
  block duplicate submissions, preserve newer edits across stale detail responses,
  and roll back only the failed flag without undoing a concurrent successful edit.
- Accepted queued changes remain visible until provider settlement; pending UI
  distinguishes saving the request from waiting for the mail provider. An unstarred
  message leaves the Starred list without losing its open reader.
- Failed bulk flag actions show an error. A rejected bulk read no longer looks
  applied, even if the subsequent list refresh also fails.
- Provider-writeback polling no longer invalidates itself after every poll.
- A busy account rejects competing mutations/retries immediately with HTTP 409
  before queuing a write. No delayed action is applied after that rejection.
- IMAP has a 60-second socket inactivity timeout and 120-second per-command
  deadline, rather than a whole-import deadline. Cancellation closes stalled
  transport; account locks are retained through cleanup and durable outcome
  handling so another writer cannot race an uncertain provider result.

### Behavior and limits

This does not rewrite stored mail flags, change account modes, shorten successful
large imports to two minutes, or upload historical local flags. The provider stays
authoritative in Sync mode. A busy-account error means nothing was changed: retry
when syncing or the other operation finishes. This release does not permit
simultaneous provider mutations on the same account. Connection/authentication
cancellation can still await its handshake/socket timeout; arbitrary database
stalls are not covered by the IMAP command deadline.

### Validation

Before publication, the full frontend suite passed **113 tests**; TypeScript and
lint passed (three existing unrelated Fast Refresh warnings). The complete API
release gate passed **372 tests with no skips** using disposable MySQL 8 and
Node 24 containers on an isolated network, without production data or mounts.
Coverage includes MySQL string-valued flags, pending/confirmed state, rollback,
filters/counts, ownership isolation, stalled IMAP cancellation and slow UI actions.

The release workflow additionally requires frontend checks, the zero-skip MySQL
API gate, production image build, and container startup/authentication/recording/
backup smoke checks before publishing the tested image. Provider-write tests use
simulated mail servers; no live mailbox mutation was used as a release test.

### Updating

Keep existing volumes, settings and encryption keys. No new schema migration or
Compose change is required relative to 0.10.10. Earlier installations still need
the [upgrade guide](docs/UPGRADING.md). Retain a consistent database/uploads/config
backup, then refresh the browser/PWA after updating the container.

Account backup, import and restore remain ALPHA.

## 0.10.10

*Immediate mail read state and working retries*

Read/unread actions update the visible mail list immediately. In Sync mode,
accepted read and star changes stay visible while provider confirmation is
pending, including after a page reload. Message details, filters, unread counts
and account/folder badges use the same pending state. Mail shows a pending label;
failed or conflicting requests fall back to the last confirmed state.

The provider remains authoritative. UniHub sends the targeted IMAP flag request
and reads it back before updating confirmed storage. A full mailbox download is
not required to confirm a flag change, although an active account sync can delay
the write behind its account lock. This release does not change sync scheduling.

The Retry button for failed provider changes now reaches the parameterized API
handler instead of returning 404.

### Why the previous image workflow failed

The workflow for commit `2781d72` stopped in the API test step, before Docker
construction or publication. The mail-filing test distinguished list and detail
queries by looking for `SELECT *`. The pending-state query uses `SELECT emails.*`
and computed flags, so the mock incorrectly applied list-filter assertions to a
detail request. The real MySQL pending-state integration test passed in that run.

The fixture now distinguishes the request by its owner-scoped ID lookup and
returns the computed flag fields. It checks successful responses and flag values
alongside the existing provider-identity assertions. The release workflow runs
the full API suite with disposable MySQL 8 and no skipped checks, frontend tests,
lint/typecheck/build, and container startup/auth/recording smoke checks before
publishing the tested image.

### Updating

Keep existing volumes, configuration and encryption keys. No new migration or
Docker/YAML change is required relative to 0.10.9. Earlier installations must
still follow the [upgrade guide](docs/UPGRADING.md). Refresh the browser/PWA after
updating the container.

Provider tests use simulated mail-server responses; this release has not been
verified against a live mailbox. Account backup, import and restore remain ALPHA.

## 0.10.9

*Two-way mail updates*

Sync mode now sends new read/unread changes, stars and folder moves from UniHub
back to the email provider. Moving mail to Trash uses the provider's mapped Trash
folder. Changes made at the provider continue to flow into UniHub.

Only new explicit actions are sent. Upgrading does not upload historical local
differences. Download mode and retained local-only messages keep their existing
behavior. Pending or failed provider changes are visible in the mail UI.

### Interrupted updates and conflicts

Commands survive an app restart. UniHub checks the provider before at most one
safe automatic retry. It preserves provider state when an interrupted flag update
cannot be reconciled safely. Flag changes use conditional writes where supported;
servers without CONDSTORE retain a small race between checking and writing.
Uncertain moves are never blindly repeated. Moves require native IMAP MOVE and
an existing mapped folder on the same account.

This release does not add draft mirroring, remote folder rename/deletion,
permanent server deletion, cross-account transfers or browser-offline editing.
Existing SMTP sending is unchanged. See [mail modes](docs/MAIL_MODES.md) for details.

### Updating an existing installation

Keep existing volumes, configuration and encryption keys. Migration 5 adds the
outgoing-command table without rewriting existing messages or changing account
modes. No new Docker/YAML changes are required relative to 0.10.8. Installations
older than 0.10.8 must still apply its Nginx capability correction; see
[the upgrade guide](docs/UPGRADING.md). An image downgrade does not undo migrations.

**Account backup, import and restore remain ALPHA.** Keep independent, consistent
backups of MySQL, uploads, configuration and secrets. Outgoing commands are
excluded from account archives; restoring mail clears destination commands so
old actions cannot be replayed against a provider.

### Verification

Focused protocol and UI checks passed, including durable-command tests on MySQL.
All 131 recovery checks passed with no skipped checks, including historical
upgrades and production export/restore. TypeScript and the production build
passed. Mail-server responses were simulated; this release has not been tested
against the maintainer's live Gmail account. GitHub's image workflow additionally
runs the full API/frontend checks and container startup/auth/recording smoke test.

## 0.10.8

*Fix restricted-container Nginx startup*

The reference Compose file dropped capabilities that Nginx needs to access its
owned log/temp paths and start workers as the nginx user/group. A fresh catalog
installation exposed permission errors and a restart loop. The application image
smoke test previously used Docker's default capabilities and missed this.

The app now retains `CHOWN`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`, `SETGID` and
`SETUID` while still dropping all other capabilities and keeping
`no-new-privileges`. The release smoke test now uses those same restrictions.
These permissions apply inside the container; no privileged mode or Docker socket
mount is added. The API/supervisor still run as root, as before.

### Updating an existing installation

**An image update alone does not fix saved custom-app YAML.** Update the `unihub`
service's `cap_add` list to the five capabilities above, matching the reference
Compose file. Keep `cap_drop: ALL`, `no-new-privileges`, the same volumes and keys.
The proposed TrueNAS catalog includes the corrected settings.

No new database migrations, archive format changes or data changes are introduced.
The five-minute MySQL readiness allowance is unchanged and ends when ready.

**Account backup, import and restore remain ALPHA.** Keep independent backups of
the database, uploads, configuration and secrets. Do not rely solely on account
archives before deleting mail from your email provider.

## 0.10.7

*Mark account backup and restore ALPHA*

Account backup creation, import and restore are experimental. Data Management,
export/import headings, the recovery-password dialog and the mail server-deletion
setting now say ALPHA. Installation, backup and compatibility documentation carry
the same status. These features remain available; no data is removed.

Do not rely on account archives as your only copy of important data. Keep an
independent, consistent backup of MySQL, uploads, deployment configuration and
secrets, especially before deleting messages from the email provider.

### Upgrading

This release changes UI wording, documentation and version metadata only.
There are no new database migrations, archive format changes or deployment-setting
changes. Existing 0.10.6 installations keep the same volumes, keys and credentials.
For older versions, follow [the upgrade guide](docs/UPGRADING.md).

The 0.10.6 image remains unchanged. Its release notes now also identify account
backup/import/restore as ALPHA; the visible UI labels require 0.10.7.

## 0.10.6

*Durable recovery, mail sync and privacy*

### Updating an existing installation

Direct updates from 0.10.3, 0.10.4 and 0.10.5 use the existing additive folder
migration plus a new upgrade ledger. The source mail accounts, provider UIDs,
messages and files are preserved. Completed database repairs no longer repeat
on every restart. Required upgrade failures stop startup with the failed step
rather than continuing with an incomplete schema. The MySQL wait still allows
five minutes and continues on the first successful authenticated connection.

Retain a consistent database/uploads/configuration snapshot before updating.
Changing back to an older image is not a database rollback. New schema-3 backups
cannot be read by releases that only understand schemas 1 or 2.

### Mail and navigation

Recovered mail uses the same local filing account in list, detail, sender rules,
unread counts and new offline snapshots. Original provider identity is retained.
Rules no longer file recovered messages into another account's hidden folder,
and concurrent manual filing is protected. Refresh an existing offline snapshot
to obtain the new identity metadata; missing historical snapshot fields cannot
be reconstructed offline.

Folder navigation is searchable, custom folders can collapse, and selected
account context remains visible. Virtual views cannot supply a sending/sync
account. Collapsed navigation has accessible labels, the shell uses dynamic
viewport height, and navigation respects the user's reduced-motion setting.

### Account modes and email privacy

Accounts now offer Download or Sync from email server. Existing installations stay
in Download and keep their deletion preference. Switching to Sync requires
confirmation, follows provider read/star/folder changes, and disables automatic
server deletion. Missing server messages remain as labeled local copies. Switching
back leaves deletion off until explicitly enabled again. Local UniHub changes do
not write back to the provider in this release. See [mail modes](docs/MAIL_MODES.md)
for matching, label support, cancellation and account-identity limits.

Remote images remain blocked even in original appearance. A default-on filter can
block suspected tracking pixels after other images are allowed. Re-blocking and
navigation reset are supported. Resource loading through CSS, SVG, srcset and
embedded content is removed. This can simplify sender formatting. Detection is
imperfect; explicitly loaded images still expose the requesting IP and open time.
Stored originals are unchanged. No proxy or automatic prefetching is introduced.

### Backups and imports (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of MySQL, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Creation and restore are enabled again. Schema 3 preserves account-scoped folder
metadata, filing/Legacy state, rule overrides, translated recovery journals and
completion markers, completed transcripts and server-side Tetris scores. The UI
gets its section list from the server's shared recovery catalog. Section exports
read selected data instead of loading all mail for a contacts-only backup.

Schema-1 and schema-2 archives select their readers automatically. Older archives
cannot provide fields or bytes they never contained; warnings explain defaults.
Unknown data and incomplete schema-3 files are rejected. Conflicting folder
ownership or a merge that would make restored mail invisible fails and rolls
back. Optional deleted historical account references are reported and cleared;
live references remain required. This can reject an unsafe merge that previously
appeared successful. Use a clean destination account when scopes conflict.

Browser-only game progress, other users, sessions and deployment configuration
are not included. Uploaded archives remain retained while automatic expiry is
paused; successful restores and explicit deletion still remove their upload.
Generated backups remain until deleted. No installation Dockerfile or Compose
changes are required.

Recovery hardening also preserves separate calendar events with matching titles
and times, and separate contacts sharing an email address. Repeated imports
prefer matching content and keep distinct destination rows. Events with distinct
content retain their own subtasks and attendees. Fully indistinguishable duplicate
parents cannot provide historical identity that the archive never recorded.

Schema-3 ZIP readers now require valid SHA-256 metadata in `checksums.json`;
archives missing it are rejected. Older readers' compatibility behavior remains.
Recovery declarations are checked for section membership, file handling and parent
mappings against actual MySQL foreign keys. CI now requires database tests to run
and pass before image publication; no installation Compose change is needed.

### Optional modules, Notes and workspace layout

Settings now separates navigation visibility, feature access and supported
background work for each built-in module. Pausing keeps data and full-backup
coverage. Calendar and ToDo stay together. Settings and recovery remain available.
Queued notifications keep their attempt state while paused; already-issued network
operations may finish, and expired notifications are not replayed on resume.

Notes adds text/Markdown editing, explicit saves, text revisions, Trash, linked
notes, bounded attachments and readable Markdown downloads. Revision conflicts
preserve the editor draft rather than overwriting another device's changes. Notes
is online-only for now. Migration 4 is additive; schema-3 recovery includes all
four Notes tables and attachment bytes, including disabled Notes and trashed notes.
See [Modules and Notes](docs/MODULES.md) for limits and recovery behavior.

Wide desktop mail now shows folders, list and reader together; mobile retains its
account/folder context when returning from a message. Data Management separates
creation, existing downloads and import review, and distinguishes archive counts
from restored/skipped results. Module settings are included in new device snapshots;
refresh older snapshots to get current choices.

### Validation scope

Focused checks cover populated historical upgrades, repeated startup, actual
MySQL field coverage, current encrypted recovery, frozen historical archives,
folder conflicts, cancellation, ownership, mail consistency and navigation.
Synthetic MySQL fixtures are not a restoration of a particular live deployment.
See [Recovery contracts](docs/DATA_RECOVERY.md) for the check locations and maintenance
rules. Release publication is separate from preparing these source changes.

## 0.10.5

*Reconcile old folders against the mail server*

This release replaces the 0.10.4 “leave everything under Legacy shared” approach
with an automatic, account-by-account reconciliation. Direct upgrades from
0.10.3 are supported; installing 0.10.4 first is not required.

### What happens to existing mail

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
The source account still owns its imported data. Deleting a source account is
blocked while it has mail recovered into another account, preventing accidental
loss through account deletion.

### Upgrade safeguards and limits

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

## 0.10.4

*Account folders and backup suspension*

### Folders

- New custom folders belong to one mail account. Select that account before
  creating a folder; creation no longer affects every connected account.
- Existing custom folders remain under a collapsible **Legacy shared** section.
  Their contents, IDs, slugs and provider mappings are preserved.
- Provider special-use markers recognize localized Sent, Drafts, Archive, Trash,
  Important and Junk folders. Existing mappings take precedence, so improved
  icons do not silently reorganize old mail.
- Account-specific folders are filtered by the selected account and labelled
  with their account in All Accounts. Mixed-account moves into an account folder
  are rejected completely. Sender rules follow the same account boundary.
- Moves remain local grouping changes. No IMAP MOVE or automatic folder deletion
  is introduced. Source account identity stays intact.

### Backups — temporarily unavailable

**Backup creation, import/validation and restore are disabled in the UI and API.**
They return HTTP 503 while the data model evolves. This also blocks old cached
clients. Existing completed backups and their recovery passwords remain
available for download. Interrupted jobs are marked failed with an explanation;
archives are retained and automatic restore-upload expiry is paused.

Use an infrastructure backup of MySQL, uploads and deployment configuration.
Contact vCard import/export and individual mail/recording downloads are unchanged.

### Updating

Update an existing 0.10.3 installation using the same database, volumes and keys.
The folder schema migration adds nullable columns; it does not reassign existing
folders or emails. The populated v0.9.23.0 upgrade regression also remains part
of verification; earlier 0.9.x variants have not all been tested individually.
No Dockerfile or YAML changes are needed. The five-minute MySQL readiness limit
is unchanged and exits immediately when the authenticated connection succeeds.
Finish any running backup/restore before updating. An older app does not
understand new folder scopes: rollback requires a matching pre-upgrade
infrastructure snapshot. See [Upgrading](docs/UPGRADING.md).

### Notifications

No notification-code change is included. Vanadium on GrapheneOS can depend on
sandboxed Google Play services for background Web Push. Notification permission
alone does not establish that delivery is configured correctly. See the
[GrapheneOS usage guide](https://grapheneos.org/usage#sandboxed-google-play) and
[Vanadium PWA discussion](https://discuss.grapheneos.org/d/7043-forum-notifications-any-way-to-enable-push).

## 0.10.3

*Backup reliability and automatic format detection*

This release fixes gaps in backup completeness and restoration. It preserves
provider-folder mappings, separate messages and files, and restored attachment
links, with automatic readers for older backups.

### Backup and restore corrections

- Include account-specific provider-folder mappings and remap both parent IDs
  with ownership checks during restore.
- Preserve distinct source messages, attachments and recordings even when their
  Message-ID, filename, size or other matching metadata repeats.
- Rewrite attachment URLs in restored email HTML to the new attachment IDs;
  preserve original EML, attachment and audio bytes.
- Read related database rows from one consistent snapshot. Reject newly created
  backups when selected files are missing, unreadable, unsupported audio, or
  change while being archived. Original files remain untouched.
- Import incomplete historical archives with warnings without clearing good
  existing file references. Skip unavailable new recordings and their links
  instead of rolling back unrelated recoverable data.
- Prevent late cancellation from invalidating a completed restore. Honor accepted
  cancellation before committing. Preserve restored files when a database commit
  acknowledgement is lost, then check the durable transaction outcome.
- Reject exports exceeding the import upload limit rather than offering a file
  the application cannot restore.

### Upgrade and compatibility

**Existing 0.10.x installations can update in place with the same database,
uploads and keys. No database migration, folder reorganization, Dockerfile or
Compose change is introduced.** Existing live data is not rewritten by this
update. The five-minute maximum MySQL readiness wait still ends immediately
when an authenticated connection succeeds.

**New backups use data schema 2. UniHub 0.10.3 automatically imports schemas 1
and 2, but 0.10.2 and earlier cannot import new schema-2 backups.** Keep a
pre-update archive or consistent database/uploads/configuration backup if
recovery onto an older release may be necessary. ZIP packaging and the encrypted
container remain version 1. The manifest identifies the data version and producer;
unknown future versions are rejected before import.

Schema-1 archives omitted provider-folder mappings. Their local folders and
email account/source-folder identities remain importable, but mappings absent
from the archive cannot be reconstructed; existing destination mappings stay
unchanged. Folder behavior in the application is unchanged by this release.

The tested older upgrade/export baseline is **0.9.23.0**, not every historical
0.9.x release. An account restore merges one user's data; it is not a full server
rollback. See [Upgrading](docs/UPGRADING.md) and [Backup and Restore](docs/BACKUP_RESTORE.md).

A single uploaded archive remains limited to **3900 MiB** (about 3.81 GiB),
including encryption overhead. ZIP64 and automatic section splitting are not
implemented. Export smaller sections where possible, and retain consistent
MySQL/uploads backups for larger datasets. Missing historical file bytes cannot
be recovered from an archive that never included them.

### Validation

The backup changes passed 247 API tests with no skips, 73 frontend tests, lint,
type checking, production/image builds and container checks before release
preparation. CI reruns the checks for the release commits.

Tests exercise production export/restore jobs against disposable MySQL, every
supported data section, repeated conflict modes, different deployment keys,
duplicate metadata, missing/corrupt files and commit/cancellation failures.
Frozen plain and encrypted archives were generated by the actual 0.9.23.0
exporter. A running-container HTTP test creates, downloads, uploads, unlocks and
restores an encrypted backup, checks contact content and exact WAV bytes, and
verifies user isolation. These synthetic tests do not constitute a restore of
any particular live installation.

## 0.10.2

This release corrects backup ownership, outbound network validation, login and
two-factor authentication, and request/service failure handling. It also reduces
recording overhead and limits simultaneous audio conversion on older hardware.

### Security corrections

- **Backup ownership:** newly restored objects receive fresh IDs unless matched
  to existing data owned by the restoring user. Updates always include the owner;
  linked records are remapped and checked. A restore cannot overwrite another
  user's data by supplying its IDs. Keep existing, Replace and Keep both remain
  supported. Unexpected foreign or inconsistent relationships reject the restore.
- **Mail and calendar connections:** DNS is checked immediately before each
  connection, including background workers. Connections use the checked address
  while preserving the original hostname for TLS certificate verification.
  DNS failures and private/special-use address tricks fail closed. The existing
  administrator-controlled `TRUSTED_MAIL_HOSTS` exception still supports private
  mail/CalDAV servers.
- **Calendar credentials:** CalDAV requires HTTPS and validates every redirect
  and discovered URL. Credentials stay within the explicitly configured server
  origin. Responses and connection time are bounded. Restored account settings
  that fail network policy remain inactive with an explanatory warning.
- **Request handling and recovery:** malformed request addresses return a client
  error instead of escaping the request error handler. A service supervisor
  terminates the container if the API or nginx stops, allowing the existing
  Docker restart policy to recover it. Shutdown signals reach both services.
- **Login protection:** separate user and short IP attempt budgets replace the
  five-hour shared-IP lockout. Successful authentication never resets counters.
  Trusted proxies are resolved from the actual connection through a configured
  `X-Forwarded-For` chain; untrusted forwarded values are ignored. See the
  [authentication guide](docs/AUTH_ADMIN_SETTINGS.md#rate-limiting) for exact limits.
- **Two-factor login:** session creation uses the user's ID, and challenge
  consumption, recovery-code removal and session insertion are atomic. Recovery
  codes and challenges cannot be reused concurrently. Session cookies are sent
  only after commit. New JWTs include random identifiers so simultaneous logins
  cannot collide; existing sessions remain compatible.
- **Audio input:** uploads/restores identify supported audio from file signatures
  instead of trusting its supplied content type. HTML/playlists cannot be served
  as restored recordings. MP3 conversion uses an explicit supported demuxer and
  file-only input protocols.
- **Dependencies:** patched mail parsing, MySQL client and other dependencies.
  React Router moves to the patched v7 declarative router; application routes
  and deployment requirements stay the same. Dependency audits and the full
  application checks are rerun with the locked versions used for this image.

### Recording efficiency

Microphone recording remains uncompressed mono PCM WAV. Original audio remains
the normal playback source; saving a recording does not automatically convert it.
MP3 export remains optional, with a user-triggered playback fallback if the
browser cannot decode the original format.

The capture worklet batches 4,096 samples per transfer instead of sending every
128-sample render block: 32 times fewer messages for full batches, while retaining
the same PCM samples. Capture uses the microphone's reported sample rate where
available instead of forcing 44.1 kHz. Uploads read and verify 512 KiB chunks rather
than copying and hashing a complete recording in browser memory.

One MP3 conversion runs at a time, with one decoder/encoder thread, bounded queue,
15-minute conversion deadline and 500 MiB output ceiling. A busy queue asks the
user to retry. Existing cached exports remain usable; originals are retained.
This reduces avoidable overhead but does not establish that Linux microphone or
driver-related popping is resolved on every device.

### Upgrade and configuration notes

**Existing 0.10.x installations can update in place using the same database,
uploads and keys. This patch adds no database migration.** Existing data IDs and
stored audio are not rewritten. Legacy restorable ZIP and encrypted backup
formats remain supported, subject to the new ownership and media validation.

**0.9.23.0 remains the tested in-place upgrade baseline for 0.10.x.** Earlier
0.9.x and customized schemas need a rehearsal on a copy; they are not all verified.
Keep a consistent backup of MySQL, uploads and configuration before upgrading.
An image-only downgrade is not a verified rollback. See [Upgrading](docs/UPGRADING.md).

There are intentional compatibility restrictions:

- For an extra HTTPS reverse proxy, configure `UNIHUB_TRUSTED_PROXY_CIDRS` in the
  supplied Compose `.env` (runtime variable: `TRUSTED_PROXY_CIDRS`) to include the
  bundled loopback proxy and only your actual proxy addresses. See the
  [configuration example](docs/AUTH_ADMIN_SETTINGS.md#trusted-proxies). An image pull
  alone cannot add this environment variable to an existing container.
- Private mail/calendar hosts require the administrator's existing allowlist.
  Cross-origin CalDAV discovery now requires explicitly configuring the final
  server URL rather than silently forwarding credentials there.
- New audio uploads/restores accept recognized WAV, MP3, M4A/MP4 audio, Ogg, WebM,
  FLAC, AAC and AIFF files. Files merely labeled as audio are rejected. Existing
  original files remain available, but MP3 conversion requires a supported format.
- Imported records get fresh IDs when no same-owner match exists. Backups with
  missing, foreign or inconsistent parent references fail instead of linking to
  unrelated data. Invalid network settings are restored inactive with warnings.

The **300-second maximum MySQL wait** is unchanged and ends immediately after an
authenticated connection succeeds. The **360-second health startup grace** is
unchanged. The only Compose addition is explicit proxy trust configuration;
service supervision is implemented inside the image.

### Validation

Release checks include API and frontend tests, lint, TypeScript and production
build, MySQL 8 two-user restore and authentication regressions, the populated
0.9.23.0 migration/restart test, and a built-container smoke test. The container
smoke checks production authentication, file handling, audio conversion,
malformed-request handling and container exit after an essential service dies.
CI results accompany the published release.

Synthetic audio tests cover PCM sample preservation, chunk integrity, queue
limits and supported-format conversion. Actual microphone behavior and background
PWA notification delivery still require checking on the intended device.

## 0.10.1

This documentation and licensing release makes UniHub's maintenance approach,
usage terms and upgrade procedure explicit. The application features introduced
in 0.10.0 remain the same.

### Maintenance and documentation

UniHub is AI-written code maintained using OpenAI models, primarily **GPT 6
Astra**, with AI-assisted security reviews, regression tests and release checks.
The README now describes the project directly and welcomes feedback. A security
document explains the review process and private vulnerability reporting.

Documentation has been reviewed against the implementation, including mail
import transactions, streamed attachment downloads, session/cache isolation,
contacts pagination, calendar notifications, offline reading, backups and
deployment settings.

### License

Starting with **0.10.1**, project-owned code and documentation use **PolyForm
Noncommercial 1.0.0**: noncommercial use is free, and commercial use is welcome
under a separate paid written agreement. See Licensing for how to send a
commercial licence enquiry. See [Licensing](LICENSING.md).

The project is source-available. Earlier releases retain the permissions they
were supplied with; this change is prospective. Third-party components retain
their own licenses. The image now includes the project license, third-party
notices and collected frontend dependency notices under `/app/licenses`.

### Upgrading from 0.9.x

**0.9.23.0 is the tested schema baseline for an in-place upgrade to 0.10.x.**
The migration regression starts with that release's actual schema and populated
synthetic records, runs production initialization twice, and checks preservation
of users, mail/calendar data, encrypted credentials, attachment metadata and
custom folder settings. It also verifies new sync progress and encrypted VAPID
identity across restart. File contents and external mail providers are outside
that schema test.

Earlier 0.9.x versions and customized databases are not all runtime-verified.
Rehearse those upgrades on an isolated copy. Keep a consistent pre-upgrade backup
of MySQL, uploads and configuration. Preserve deployment keys and volume
mappings. **An image-only downgrade is not a verified rollback procedure.**
The [upgrade guide](docs/UPGRADING.md) includes the commands and recovery path.

Retain the **300-second maximum MySQL wait**, which ends when an authenticated
probe succeeds, and **360-second application health startup grace**. Older
Compose files with explicit values need those values updated. The first mail
sync revalidates old imports and can take longer. Device notifications and
offline reading require opt-in after the upgrade.

### Validation

Publication requires the API suite, including the populated MySQL 8 upgrade and
fresh-install checks, frontend tests, lint, TypeScript and production build,
followed by the built-container startup/authentication/file/conversion smoke
test. The container smoke also checks that licensing notices and metadata are
present. CI results are linked from the GitHub release.

Actual minimized/locked-screen PWA notification delivery still needs checking
on the intended device; browser and OS policies are not reproduced by CI.

## 0.10.0

This release adds a black, white and blue appearance, server-driven Web Push, opt-in offline reading, and a focused mail/state refactor.

### Changes

- Dark mode defaults to black backgrounds, white text and blue accents. Light/System remain available in Settings. HTML mail has a dark reading view and an explicit original-format option.
- Notifications use persistent encrypted VAPID keys, per-device subscriptions, a transactional outbox, retries and service-worker delivery. Calendar reminders survive restarts and revalidate edits/cancellations and restores. Notification links open the specific item. Enable and test notifications in Settings.
- Offline reading saves the latest 100 full non-draft emails across accounts, all contacts and calendar entries in a bounded 32 MiB snapshot. The offline view is read-only; attachments remain online. Snapshot ownership and clearing are enforced across tabs and in-flight requests.
- Private query state is isolated per signed-in user. Generic service-worker API caches are removed. Temporary network errors and confirmed session revocation are handled separately.
- Routes and games load lazily. The main production JavaScript bundle decreased from 1,061.79 kB (310.01 kB gzip) to approximately 610.92 kB (196.21 kB gzip). Service-worker precaching still downloads the offline-capable chunks during installation.
- Mail search is debounced and cancellable; stale reader responses cannot reopen or replace a later selection. Shared query invalidation refreshes lists, counts and dashboard previews.
- Backup status polling runs only for active jobs in the active tab. Contact pagination no longer silently stops at 2,000 records.
- Default folder creation preserves renamed/reordered system folders. A 1,000-message routing fixture now uses three SQL calls to load its folder/rule context instead of 11,000 repeated calls.
- Draft replacements and imported attachment metadata commit atomically. Per-folder IMAP UID/UIDVALIDITY progress preserves retryability, including new folders and incomplete imports. Attachment downloads stream from disk; request parsing preserves split UTF-8 characters and rejects invalid JSON.
- Builds now enforce TypeScript checking. Node 24 is used in both Docker stages and CI. Image publication is gated by tests and a container smoke test.

### Upgrade

**0.9.23.0 is the checked upgrade baseline.** The changes are designed for an in-place upgrade using the existing database, uploads and keys. The subsequent 0.10.1 validation adds a populated 0.9.23.0 schema migration/restart test; earlier 0.9.x versions and locally modified schemas are not all runtime-verified. Rehearse those upgrades on an isolated copy first. See the [upgrade guide](docs/UPGRADING.md) for the procedure and exact validation scope.

**Keep a matching pre-upgrade database/uploads/configuration backup. An image-only downgrade is not a verified rollback path.** Preserve the Compose project/volume mappings and encryption keys; changing them can make data appear missing or credentials unreadable.

Volumes and required environment variables remain unchanged. MySQL readiness now allows up to five minutes (300 seconds) for slower hosts, and startup continues immediately after an authenticated check succeeds. The probe uses the same driver and DATABASE_URL/MYSQL_* configuration as the API. The application image and supplied Compose health checks allow 360 seconds for startup. Update older Compose files that explicitly set a 120-second readiness budget or shorter health-check grace period; pulling the image alone cannot override an explicit Compose environment setting. Custom timing overrides remain supported.

Database migrations are additive. Keep a backup of the database and uploads before upgrading, and retain the existing ENCRYPTION_KEY: it also protects the deployment's new Web Push private key.

The first mail sync after upgrading revalidates existing imports and establishes per-folder progress, so it can take longer. Historical first imports and UIDVALIDITY resets do not send a flood of notifications. Existing calendar colors are preserved.

After upgrading over HTTPS, open Settings and enable notifications on each device. Test once with the PWA minimized. Mail discovery still follows the server's roughly ten-minute IMAP sync interval. Browser permission, OS settings and connectivity affect delivery; closed-app alarms while completely offline require native scheduling.

Enable Offline reading separately on each device, and wait for the saved timestamp. App updates prompt before reload so you can save edits first.

See [PWA notifications](docs/PWA.md), [Offline reading and appearance](docs/OFFLINE.md), and [Mail sync](docs/MAIL_SYNC.md).

### Validation

The refactor is covered by frontend state/lifecycle tests and API regression tests, including optional MySQL tests. CI uses MySQL 8 for real SQL, production schema initialization/reinitialization, stable encrypted VAPID identity and session-revocation cascades. A built-container smoke test checks Node 24, Nginx/API health, authentication/CSRF, isolated recording storage, byte/range downloads, MP3 conversion and cleanup before publication.

The black/blue sign-in layout was checked at desktop and phone widths. A real two-tab service-worker update test confirmed that the requesting tab refreshes while the other retains its unsaved input and can refresh later. Actual minimized/locked-screen delivery still needs verification on the intended phone/browser; CI does not simulate its OS policies.

## 0.9.20.0

This release replaces the previous foreground backup import flow with a durable,
encrypted backup and restore system designed for large mail archives and
long-running restores.

### Highlights

#### Encrypted, Portable Backups

- Backup encryption is enabled by default.
- Encrypted backups use the `.unihub-backup` extension.
- Each encrypted backup receives a unique recovery password.
- Recovery passwords can be revealed only once. Save the password before
  downloading the backup.
- Encrypted backups can restore mail and calendar credentials on another UniHub
  installation, even when the destination uses a different `ENCRYPTION_KEY`.
- Unencrypted `.zip` backups remain available and existing restorable UniHub ZIP
  backups are still supported.

#### Background Backup and Restore Jobs

- Backup creation, validation, and restore now continue without an open browser
  connection.
- Closing the page or hitting a reverse-proxy timeout no longer stops a running
  restore.
- Interrupted jobs are recovered after an application restart.
- Data Management now shows job status, phase, progress, start/end times, file
  size, warnings, errors, and restored counts.
- Running backup and restore jobs can be stopped before their final commit.
- Failed retained uploads can be retried without uploading the archive again.

#### Server-Retained Restore Points

- Completed backups remain available on the server until manually deleted.
- A retained backup can be validated and restored directly without downloading
  and uploading it again.
- Uploaded backup archives expire after seven days.
- Successfully restored uploaded archives are removed, while restore history is
  retained until manually deleted.
- Server-retained backups are a convenience feature, not a replacement for
  off-server backups.

#### Safer Restore Behavior

- Restore remains merge-based and does not delete unrelated existing data.
- Conflict modes support keeping existing data, replacing matching items, or
  keeping both where the schema permits it.
- Same-name local calendars merge by default.
- Existing matched accounts keep their current credentials by default.
- Database changes are restored in a transaction.
- Files are checksum-verified and cleaned up when a restore fails or is
  cancelled before commit.
- Only sections affected by an active restore become temporarily read-only.
- Mail sync and server-side mail deletion pause during a mail restore.
- Restored mail accounts always have **Delete Emails on Server disabled**.

### Backup Contents

Full backups can include:

- user display settings
- contacts
- calendar accounts, calendars, events, ToDos, attendees, and subtasks
- mail accounts, folders, sender rules, emails, raw `.eml` files, attachments,
  and mail scores
- recordings, recording files, tags, and tag links

Section backups are available for Mail, Calendar/ToDo, Contacts, Recordings, and
Settings.

User login password hashes, roles, sessions, 2FA secrets, and mail
server-deletion queue entries are not restored.

### Fixes

- Fixed `Invalid string length` failures while creating large backups.
- Added streaming and range support for large backup downloads.
- Fixed large binary backup uploads being parsed as text or JSON.
- Fixed attachment validation incorrectly reporting existing files as missing.
- Fixed restore failures caused by ISO timestamps being inserted directly into
  MySQL `DATETIME` columns.
- Fixed calendar restore parameter ordering that could cause
  `Incorrect arguments to COM_STMT_EXECUTE`.
- Improved restore compatibility for existing UniHub backup ZIP files.
- Improved cleanup of partial backup and restore files.
- Added clearer backup, validation, restore, cancellation, and recovery-password
  errors in Data Management.

### Upgrade Notes

This update requires an application redeploy/restart so the backend can create
the new backup job tables and start the background workers.

Add the following optional variable to your deployment:

```env
UNIHUB_BACKUP_MASTER_KEY=<strong-random-secret>
```

`UNIHUB_BACKUP_MASTER_KEY` protects server-retained archive keys. When it is not
set, UniHub falls back to `UNIHUB_ENCRYPTION_KEY`.

Important:

- Do not use `UNIHUB_JWT_SECRET` as the backup master key.
- Do not change or lose an existing `UNIHUB_ENCRYPTION_KEY`.
- Do not change `UNIHUB_BACKUP_MASTER_KEY` while relying on automatic restore
  for server-retained encrypted backups.
- Download important backups and store them away from the UniHub server.
- Keep each recovery password separate from its backup file.
- Back up the MySQL and uploads volumes independently for full infrastructure
  disaster recovery.

### Compatibility and Limits

- Existing restorable UniHub `.zip` backups remain accepted.
- Encrypted `.unihub-backup` files are portable using their recovery password.
- The upload request limit is 3900 MiB.
- The inner archive currently uses ZIP32. ZIP64 is not yet supported, so very
  large backups may still exceed archive size, offset, or entry-count limits.
- Only one restore is processed globally at a time.

### Documentation

See the [Backup and Restore Guide](docs/BACKUP_RESTORE.md) for backup contents,
encryption details, recovery-password handling, restore merge rules, retention,
API endpoints, and troubleshooting.
