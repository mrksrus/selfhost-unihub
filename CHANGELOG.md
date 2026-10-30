# Changelog

All notable user-visible changes to UniHub, newest first. Each release is
published as the container image `ghcr.io/mrksrus/selfhost-unihub:<version>`.
Read the [upgrade guide](docs/UPGRADING.md) before updating an existing
installation, and keep a consistent backup of the database, uploads, configuration and
secrets. Releases between 0.9.20.0 and 0.10.0 have no entry here.

## 0.26.0

Contacts: complete fields and duplicate handling. Two automatic database
upgrades; back up first, and install the new Android app (see
[Upgrading](docs/UPGRADING.md#0260-contacts-complete-fields-and-duplicate-handling)).

### Added

- **Every field a contact card has.** A contact holds any number of email
  addresses and phone numbers, each with a label (Mobile, Work, Home, Fax,
  Pager, … or your own) and one marked as preferred; postal addresses;
  websites, messaging addresses, related people and nicknames; categories;
  a birthday and an anniversary, with or without the year; title, middle
  name, suffix and the name it is shown as; and the department. Before,
  UniHub kept three emails and three numbers without labels.
- **Contact photos.** Choose any picture in the editor (JPEG, PNG, WebP,
  HEIC from an iPhone, AVIF, GIF); UniHub turns it upright, makes it square
  and small, and removes its location and other metadata. Nothing to crop.
  Photos show in the list and the detail, and come and go with vCard files.
  A picture that cannot be used says so in the editor; the rest of the
  contact is still saved.
- **A new contact detail and editor.** The detail groups numbers, emails,
  addresses, dates, websites, messaging and related people, each with a copy
  button; categories and notes; and, folded away, the other details an
  import brought along. The editor has a row per value with its label, the
  preferred star and remove, and "Add field" for the rarer fields; on a
  phone it fills the screen.
- **Import shows what it will do before writing anything.** Import contacts
  reads vCard 4.0, 3.0 and 2.1 files (from iPhones, Android phones, Outlook
  and other apps) and Google and Outlook CSV exports, in any of the usual
  character sets. You see the format, how many contacts are new, already
  there or likely duplicates, any warnings, and the first names of the file,
  so garbled umlauts show before they are saved. Choose per match whether
  to merge, add or skip (or for all at once), look at the differences under
  "Review conflicts", then import with a progress bar. An interrupted import
  continues where it stopped. Importing a file again does not add its
  contacts twice; details UniHub has no field for are kept and exported
  again.
- **Export in the format the other app reads.** vCard 4.0 (recommended,
  with photos and every detail), vCard 3.0 for older apps, Google CSV or
  Outlook CSV, for all contacts or the selected ones ("Export selected").
- **Possible duplicates, reviewed before merging.** Contacts → Possible
  duplicates lists contacts that look like the same person, with how sure
  UniHub is and why ("Same email anna@example.com", "Same name, order
  swapped"). "Review and merge" shows the contacts side by side (stacked on
  a phone): every number, email and other value is kept, and where only one
  value can stay (the name, the company, the birthday, the photo …) you
  choose it. "Not the same person" is remembered on every device. "Merge
  all high-confidence" merges, after a confirmation, only the groups where
  nothing has to be chosen.
- **Undo a merge for 30 days.** After merging, Undo is offered right away,
  and Contacts → Recently merged lists every merge of the last 30 days with
  its Undo, imports that merged into a contact included. Undo brings the
  merged contacts back as they were.
- **Edits are not lost to a change made elsewhere.** If a contact was changed
  on another device while you edited it, Save says so and keeps your edits:
  load the other version, or save yours anyway.

### Changed

- **Merging is never automatic or permanent any more.** The old "Merge
  duplicates" merged every match at once, kept only three emails and three
  numbers and one company, and deleted the rest for good. It is gone; merges
  go through the review (or "Merge all high-confidence") and can be undone.
- **vCard export is 4.0 by default and keeps the labels.** Before, it wrote
  vCard 3.0 and called every number a mobile number.
- **Search and suggestions use every value.** The contacts search finds a
  contact by any email or number (numbers also by their digits, so "0171 12"
  finds "+49 171 12…"), nickname, category or department; the composer
  suggests every email of a contact, the preferred one first. Offline
  search does the same; offline, contacts show their initials instead of
  photos.
- **The Android apps of 0.25.1, 0.25.0 and 0.24.3 keep working.** They show
  and edit the first three emails and numbers as before; the values they
  cannot show (a fourth number, labels, addresses) stay in UniHub when they
  save. The 0.26.0 app syncs every field.

### Fixed

- **Umlauts and other accented letters in older vCard files.** Names in
  vCard 2.1 files from older phones (quoted-printable, or ISO-8859-1 and
  windows-1252) were imported garbled; they now read as written.

### Database upgrade

- Upgrade step 22 copies every contact's emails and numbers unchanged into
  the new table of labelled values, gives every contact a vCard UID and a
  version, and checks the copy contact by contact; step 23 then removes the
  old columns (`email`…`email3`, `phone`…`phone3`, `avatar_url`).
- Backups use data schema 5, with contact values, kept details, photos and
  "Not the same person" choices. An older UniHub cannot read them; 0.26.0
  reads every older backup. Merges and their undo are not part of backups.

### API

- Contacts follow the vCard model in `api/src/contracts/contacts.ts`: a
  full body with labelled lists, a `version` (or `If-Match`) on every full
  update and 409 `VERSION_CONFLICT` when it is stale; the input rules are in
  [Contacts](docs/CONTACTS.md#writing-a-contact-input-contract-d17). New
  routes for photos, import, export, duplicates, merges and undo. The flat
  3+3 fields stay for the older Android apps and are deprecated.
- Removed: `POST /api/contacts/merge-duplicates`, its `/preview` and the
  JSON `POST /api/contacts/import`.

### Pinned interface pictures

- `contact-detail`, `contact-editor` and `merge-review`, each wide and on a
  phone, dark and light: the new contact screens, designed under D29 for
  0.26.0.

## 0.25.1

Follow-up fixes for 0.25: interrupted sends, the start screen, the phone
composer, notification settings and app updates in the Android app. No
database upgrade; install the new Android app once from Files (see
[Upgrading](docs/UPGRADING.md#0251-follow-up-fixes)).

### Fixed

- **A send interrupted by a server restart no longer blocks its draft for ten
  minutes.** After about two minutes the draft can be edited, deleted or sent
  again: pressing Send then says the message may have been sent, and Send
  again sends it once. Nothing is sent twice.
- **Screen readers reach notices while a dialog is open.** The "Send again"
  action after a send with an unknown outcome, and every other notice shown
  over the composer or another dialog, stays in the accessibility tree.
- **The Android app installs its update without the Files app.** When the
  update has downloaded, the app opens Android's installer itself (or, if it
  was in the background, its "UniHub update downloaded" notification does).
  The first time, Android asks to allow UniHub to install apps. Before, the
  download manager's notification led to "isn't allowed to install unknown
  apps from this source". The app installs only itself, signed with the same
  key: any other file at the update's address is deleted and the app says
  that nothing was installed. Needs the new app; this update itself still has
  to be opened from Files once.
- **Opening UniHub shows one start screen.** A cold start went through
  "Loading UniHub…", "Loading…", "Opening UniHub…" over a half-built bottom
  bar, a blank page and a false "No mail account yet" before the mail
  appeared. Now one "Opening UniHub…" screen stays until the start page shows,
  and Mail says "Loading mail…" until its accounts are known. In the Android
  app (Android 13 and later, with the new app) the splash screen also follows
  UniHub's light or dark theme instead of the phone's, from the second start.
- **The phone composer no longer jumps to the top of a long message while you
  type.** When the keyboard changed its height (its suggestion strip after
  Enter) or the new line went below the screen, the composer scrolled back to
  the start of the message. It now moves only as far as the line you are
  writing needs.
- **Each mail account's notification settings are one visible group.** In
  Settings → Notifications the account's address looked like just another
  row, so it was hard to see where one account's settings ended and the next
  began, worst in the OLED look. The address now stands at the left with
  more space above it, and the account's rows are indented beneath it, so the
  only lines across the whole list are the account boundaries, in every look.

### Development

- `scripts/local-db.sh` keeps its socket under `TMPDIR` when
  `XDG_RUNTIME_DIR` is unset, and the database tests write their temporary
  files to the caller's `TMPDIR` instead of replacing it.

## 0.25.0

Mail on the phone: the composer and attachments. One automatic database
upgrade; install the new Android app (see
[Upgrading](docs/UPGRADING.md#0250-mail-on-the-phone-composer-and-attachments)).

### Added

- **Phone composer modelled on Apple Mail.** On a phone, To holds the
  recipients as chips: a typed address becomes a chip on a comma, on Enter or
  when you leave the field; tap a chip for its full address and to remove it,
  or press Backspace in the empty field to edit the last one. Cc, Bcc and From
  are folded into one line, "Cc/Bcc, From: <account>", that opens into three
  rows on tap (open from the start when a draft or reply already has a Cc or
  Bcc). Subject is one row; the message fills the rest, the header rows scroll
  away when you tap into the message, and the formatting toolbar is one row
  that scrolls sideways, pinned above the buttons so it sits above the
  keyboard while you write. Wide windows keep the previous composer.
- **The page follows the keyboard in the browser and the PWA.** The browser
  is asked to shrink the page above the on-screen keyboard
  (`interactive-widget=resizes-content`); where it shrinks only the visible
  area, the composer follows that height instead of staying under the
  keyboard.
- **Remove a mail account together with its mail.** "Disconnect mail
  account?" now offers two choices: disconnect and keep the mail, or remove
  the account with UniHub's copy of its mail, attachments and linked calendar.
  The second continues in the existing preview with its counts and the typed
  address confirmation. Only UniHub's copy is deleted; the provider keeps its
  mail.
- **Snoozed messages can stay in their folder.** Settings > Mail > Snooze has
  a new choice, **Snoozed messages**: *Hide until due* (as before, the
  default) or *Keep in the folder*. Kept, a snoozed message stays in its
  folder and conversation with a "Snoozed until …" mark and still counts as
  unread, and it still comes back with a notification at its time. The
  Snoozed view lists it either way. Changing the choice applies at once to
  messages already snoozed.
- **Open with, Save to Downloads and Share in the Android app.** The
  attachment viewer in the app offers Android's own "Open with" and "Share"
  sheets and saves to Downloads. The app fetches the file with a download
  link that works once, for one minute, for that file only; the app's sign-in
  never leaves it. Copies made for other apps are deleted after six hours and
  when you sign out. Browsers keep Download as before.

### Changed

- **Removing a mail account is recorded.** Disconnecting a mail account and
  deleting it with UniHub's copy of its mail each add an entry to the
  activity log (Settings > Server settings > Activity), with the account's
  id and how many messages and events were removed, never its address. The
  provider's mail is not touched.

### Fixed

- **Files picked in the Android app arrived empty on Android 16.** A file
  chosen in Android's picker reached the page as 0 bytes on Android 16, so a
  recording upload was refused and an attachment was empty. The app now
  passes the picked files so that the WebView can read them. Apps up to
  0.24.3 have this problem; install the new app from the server. The app
  copies up to 3.9 GB per pick while the phone keeps 256 MB free, and names
  any file it left out and why.
- **The keyboard in the Android app.** The app now makes room for the
  keyboard itself on every Android version (before only from Android 15),
  so the page ends at the keyboard on Android 10 to 16.

### Database upgrade

- Upgrade step 21 adds the table of download links (`file_tickets`). It is
  not part of backups.

### Release checks

- **The Android app is tested against a real server.** Every pull request
  now runs the Android app on the Android 16 emulator against the image it
  built, and against the earlier server releases it supports, instead of a
  stub page; the apps of those earlier releases run against the new image.
  Each run connects, signs in with and without a two-factor code, stays
  signed in after the app is ended, uploads a file picked in Android's
  document picker, records with the microphone after Android asks for
  permission, downloads the recording unchanged, and signs out; with an app
  and a server from 0.25.0 it also opens a mailed PDF with "Open with…",
  shares a photo and saves it to Downloads unchanged. The results
  appear as a table in the run (see the
  [release contract](docs/RELEASE_CONTRACT.md)).

### Pinned interface pictures

- `composer-phone-dark` and `composer-phone-light` show the new phone composer
  (the folded "Cc/Bcc, From" line and the toolbar above the buttons), the
  design chosen under decision D29 for 0.25.0.

## 0.24.3

Follow-up fixes for 0.24: PDFs, attachments, links from tasks, signatures,
sending, reply subjects and chords. No database upgrade and no configuration
change (see [Upgrading](docs/UPGRADING.md#0243-follow-up-fixes)).

### Fixed

- **PDFs did not open.** The container served the PDF viewer's worker
  (`.mjs`) with a type browsers refuse to run as a script, so every PDF
  failed with "Setting up fake worker failed". It is now served as
  JavaScript.
- **While UniHub restarted, the app reported a missing endpoint.** Requests
  that reached the container while the API was starting got a 404 page. They
  now get a 502 with the message that UniHub is starting or restarting, which
  the app treats as a temporary outage.
- **Files picked in the Android app were not attached.** When the picker
  allowed several files, the app ignored them. Every picked file is attached
  now.
- **On a wide window the attachments were out of view.** In the compose
  dialog the Attachments section sat below the visible part. The message box
  now gets shorter when the window is not tall enough, so the section shows,
  and files just added scroll into view.
- **Open in Mail from a task kept loading.** The message opened from a task
  (or from a notification or search link) was loaded again and again, and
  its read mark repeated. It now opens once.
- **A signature lost its line breaks in plain text.** A signature written as
  two lines ("Sam Sender", then the company on the next line) became one line
  in plain-text mail. Save the signature again in Settings → Mail to store
  the corrected plain version; the same fix applies to templates and the
  plain-text part of formatted mail.
- **Sending a saved draft showed no progress.** Send went back to normal
  while the draft was still being sent, and a second press showed "Attachment
  error". Send now shows "Sending…" until the draft has gone, and a second
  press waits for the first.
- **Long chords were cut without a word.** Chords over 10,000 characters were
  saved shortened while Music said "Chords saved". They are now refused with
  the limit and their length, and the editor stays open to shorten them. A
  new recording with chords that long is refused before it is queued.
- **A failed Save draft left an error behind in the browser console** after
  its message. It no longer does.
- **Replies to replies said "Re: Re:".** A reply or forward now adds its
  prefix only when the subject does not already carry it (also "AW:", "SV:"
  or "WG:" from other mail apps).

## 0.24.2

Attachments stay in reach on a phone. No database upgrade and no configuration
change (see [Upgrading](docs/UPGRADING.md#0242-phone-attachments)).

### Fixed

- **On a phone the attachments were below the screen.** The phone composer
  kept its Attachments section under the message, which fills the screen, so
  adding or seeing a file meant scrolling past the whole message. The attach
  button (a paperclip) now follows Image URL in the message's toolbar, and each
  attached file shows there as a small square with its type (`.pdf`, `.jpg`).
  A mark on the square says whether the draft holds it: a spinner while it is
  saved, a green check once it is, red when saving failed. Tap the square for
  the name and size, to remove it, or to try a failed save again. Many files
  scroll sideways in the row. The composer on wide screens is unchanged.

### Pinned interface pictures

- The phone composer's reference pictures (Dark and Light) show the paperclip
  after Image URL, as the maintainer asked on 2026-10-24
  (PROJECT-PREFERENCES P-26).

## 0.24.1

The phone composer gets the screen. No database upgrade and no configuration
change (see [Upgrading](docs/UPGRADING.md#0241-phone-composer)).

### Fixed

- **Writing on a phone left one line above the keyboard.** The composer sat
  between the page header and the bottom bar, with each label on a row of its
  own, so with the keyboard open only one line of the message showed. On
  phones the composer now fills the screen from the top, its header is
  compact, and From, To, Cc, Bcc and Subject each take one row with the label
  beside the field. Once you write in the message, the fields scroll away and
  the message keeps the space above the keyboard. The title reads "New
  message". The composer on wide screens is unchanged.

### Pinned interface pictures

- The phone composer's reference pictures (Dark and Light) show the
  full-screen, compact composer the maintainer asked for on 2026-10-24
  (PROJECT-PREFERENCES P-26).

## 0.24.0

Notifications, settings and mail essentials: settings per account, mail
account and calendar, notifications you can filter, signatures, reply all,
templates, sending later, snooze and conversations. One automatic database
upgrade; no configuration change is needed (see
[Upgrading](docs/UPGRADING.md#0240-notifications-settings-and-mail-essentials)).

### Added

- **Settings → General: Calendar.** The week start (Monday, Sunday or
  Saturday) and the reminder a new event starts with follow the account.
- **Settings → Mail.** A page of its own (the sender rules moved to *Mail
  rules* next to it): the account new messages are sent from, the compose
  format (formatted or plain text), the optional compose features
  *Templates*, *Send later* and *Format switch*, each off until switched on
  and only then shown in the composer, the message appearance while reading
  (match the app's theme, simplified, original or decided per message),
  conversations, the number of preview lines in the list, the snooze times
  offered, the mail templates (add, edit, delete) and a signature per mail
  account, written as formatted text with its plain version derived for
  plain-text mail.
- **Settings → Notifications: what is announced.** Per mail account:
  notifications on or off, which folders announce new mail (all folders
  except the ticked ones, or only the ticked ones; new accounts leave out
  Junk, Sent, Drafts, Trash and Archive) and how much a notification shows
  (sender and subject, sender only, or nothing but "New email"). For
  reminders: how much they show (title and time, or only "Event reminder"),
  and notifications on or off per calendar. The server applies every choice
  before a notification leaves it.
- **Settings an administrator fixed** are shown greyed out with "Set by your
  administrator" instead of disappearing; where a policy only sets a minimum
  privacy level, the less private choices are greyed out the same way.
- **Mail: reply all and signatures.** The reader and the row menu offer
  Reply all, which writes to the sender and everyone on To and Cc, without
  your own address or anyone twice, from the account that received the
  message. A new message, reply or forward starts with the signature of the
  account it is sent from (above the quoted message), in formatted or plain
  text; while nothing is written yet, it follows a change of the From account.
- **Mail: optional compose features, off until you switch them on.** Settings,
  Mail lists three new switches: Templates, Send later and the text-format
  switch. With none on, the composer looks as before. Templates and the format
  switch end the formatting toolbar row (plain text keeps a one-row strip for
  them); the Templates menu inserts a template where you are writing (the
  subject only while it is empty) and offers "Save as template". Switching a
  formatted message to plain text asks first. Send later turns Send into a
  split button: in 1 hour, tomorrow morning, Monday morning before a weekend,
  or a date and time of your own; the draft is saved first and the message
  waits in Drafts, with Undo on the confirmation. On phones the composer's
  footer is one row: Add task is an icon and Cancel is folded into the close
  control.
- **Mail: scheduled sends in Drafts.** A scheduled draft shows its time with
  "Cancel schedule" and "Edit time"; one that could not be sent says "Not sent"
  with "Send now" and "Reschedule"; one whose outcome is unknown says so and is
  never retried by itself. A draft can still be opened and edited until it is
  being sent.
- **Mail: snooze.** Snooze a message from the reader or the row menu for the
  times chosen in Settings (or a date and time of your own); it leaves its
  list at once, with Undo, and comes back at that time with a notification. The
  new Snoozed view lists what is waiting, each with its return time and
  "Unsnooze"; a message that just came back carries a "Back from snooze" mark.
  Offline, these actions are disabled.
- **Mail: conversations.** With "Threaded view" on in Settings, Mail, each
  list shows conversations: who took part, how many messages (and unread), the
  latest subject and preview. Opening one shows its messages in the reader,
  the newest in full and the earlier ones folded to one line each. Off, the
  list is as before.

### Fixed

- **Switches had no tap area on touch screens.** Every switch in Settings now
  has the 44 px tap area the other small controls have.
- **In-page reminders respected neither the reminder detail level nor a
  calendar's notification switch.** The reminder an open, offline page shows
  itself now follows both, as the server's reminders do: at the "nothing"
  level it says only "Event reminder" or "ToDo reminder", and a calendar
  switched off stays quiet.
- **The mail reader's Mark read/unread and star stay on the top row.** They
  sat centred beside the reply buttons and drifted between rows as the
  buttons wrapped; where the reader has room they now sit beside the back
  arrow. On a phone they still follow the buttons, as before.

### Pinned interface pictures

- The reference pictures of the mail reader (wide), the phone composer and
  Settings → Appearance (wide), in Dark and Light, are replaced: Reply all,
  Snooze and the Snoozed folder; the one-row phone composer footer of compose
  layout A; the new Mail section in Settings (approved by the maintainer on
  2026-10-24, PROJECT-PREFERENCES P-27); and the reader's flag buttons on the
  top row, the fix for the misalignment the maintainer reported that day.

## 0.23.3

> **Security update: install it promptly.** This release replaces the Node.js
> runtime in the image to stop trusting certificates that anyone can forge.
> No database upgrade and no configuration change (see
> [Upgrading](docs/UPGRADING.md#0233-security-update)).

### Security

- **The server no longer trusts the compromised eMudhra certificates.** In
  October 2026 the Indian certificate authority eMudhra was found to have eight
  intermediate certificates whose private keys could be worked out from the
  certificates themselves, so anyone could make a certificate for any website
  that chains to its *emSign ECC Root CA - G3*. Browsers and phone systems
  blocked them, but UniHub's server checks the certificates of mail servers
  (IMAP and SMTP), calendar servers and subscriptions (CalDAV and ICS) and push
  services against the root list built into Node.js, which still trusted that
  root up to 0.23.2. Someone able to intercept the server's connections could
  therefore pose as your mail or calendar provider and receive the stored
  password and the data. This includes mail accounts with a confirmed
  certificate fingerprint, because UniHub also accepts any certificate that
  this root list vouches for. The image now runs on Node.js 26.12.1, which
  drops that root and refuses certificate chains containing the compromised
  keys, also through their cross-signature by Sectigo. Nothing in UniHub can
  show whether this was used against an installation; if the server's
  connections could have been intercepted (a network or VPN you do not
  control), change the mail and calendar passwords stored in UniHub.
- **Node.js 26.12.1 also fixes certificate host name checks** that accepted a
  certificate for the wrong host when the address was written in unusual forms
  (full-width digits, non-canonical IPv4 notation, names that loosely resolve to
  an IP address), along with its other October 2026 security fixes.
- **The image pins its Node.js release by version and digest,** so rebuilding
  an older UniHub release no longer picks up whichever Node.js 26 is current,
  and the release checks fail if the image runs a different Node.js or still
  trusts the eMudhra root.

## 0.23.2

Two mail fixes found in the first use of 0.23.1: marking a message read no
longer gets stuck when another mail app has moved it, and attachments of a
draft stay as you left them while it saves. No database upgrade and no
configuration change (see [Upgrading](docs/UPGRADING.md#0232-mail-fixes)).

### Fixed

- **Marking a message read or starred no longer gets stuck when another mail
  app moved it.** When another app or a mail rule archived a message (on Gmail,
  for example) before UniHub noticed, the change waited for you with "provider
  change needs review", and Retry failed the same way. UniHub now finds the
  message where it is now and sets it there. If it has not seen the new place
  yet, the change waits for the next sync instead of asking you.
- **Mail sync says why a change waits.** A change that waits or needs your
  attention now says so in plain words when UniHub knows the reason, for
  example that the message was moved on the server.
- **Draft attachments stay as you left them.** An attachment removed while the
  draft was being saved came back, and the next save kept it. Draft saves now
  run one after the other, each file is uploaded once, and what you remove stays
  removed.
- **Sending or discarding a new message right after you started it** no longer
  leaves a copy in Drafts: when its first save is still running, Send sends that
  draft and Discard deletes it.

## 0.23.1

Fixes found in the reviews and first use of 0.23.0: a message is never sent
twice by itself, PDFs open on older phones, replies stay in their
conversation, the phone composer keeps room for the message, and admin
actions are confirmed and limited separately from sign-in. No database upgrade
and no configuration change (see [Upgrading](docs/UPGRADING.md#0231-fixes)).

### Fixed

- **A message whose sending was cut off is never sent twice by itself.** When
  the connection to the mail server ended after the message had been handed
  over, UniHub treated the send as failed, and pressing Send again could
  deliver it a second time. UniHub now says that the email may have been sent
  and asks you to check Sent; "Send again" sends it anyway if you choose to,
  while that message is still open. A message closed while its attachments
  are still being prepared is not sent.
  A send interrupted by a server restart no longer stays "already being sent"
  until the message is closed: after two minutes it is reported the same way.
- **PDF attachments open on older phones and browsers.** The viewer showed
  "Could not show this PDF" for ordinary PDFs where the browser engine (for
  example an Android WebView that is not fully up to date) lacks some very new
  JavaScript features. It now uses a build of the PDF library that works
  there, shows images in scanned PDFs (JPEG 2000, JBIG2), and names the
  reason under the message when a PDF still cannot be shown.
- **Replies stay in the conversation at the recipient.** A reply sent from
  UniHub carried no reference to the message it answered, so the recipient's
  mail program showed it as a new conversation. Replies now carry the
  standard In-Reply-To and References headers. A reply saved as a draft and
  finished later from Drafts does not have them yet.
- **Edits made while a draft is being saved are kept.** Text typed while the
  automatic draft save was running counted as saved when that save ended, so
  closing the message did not ask and the newest text could be lost. It is
  now saved by the next draft save, and "Save draft" when closing keeps the
  message open if you went on writing. A save, send or Discard that ends after
  its message was closed no longer changes or closes the message opened
  since.
- **The keyboard no longer squeezes the message out of the phone composer.**
  With the keyboard open, From, To, Subject and the buttons kept their space
  and the message had almost none. On a short screen the fields now scroll
  away while you write. The compact phone composer follows in 0.25.0.
- **No duplicate background work when the database connection drops.** If
  the API process lost its database session briefly, a second API process
  (for example the next one during an update) could start mail sync and
  notifications while the first still ran them for up to 30 seconds, and a
  calendar sync already running could still write. A process now waits 15
  seconds after taking over; the first one notices within 10, does no more
  background work and stops its running calendar syncs. Background work
  starts 15 seconds after the server starts; if starting it fails, the
  process tries again instead of running only part of it.
- **Calendar sync no longer redoes work on every run.** An event that the
  server's listing kept leaving out, although the server still had it, was
  downloaded and written again on every sync; now only when it changed.
  Calendars whose name and permissions did not change are no longer
  rewritten either.
- **Deleting or deactivating a user asks for your password,** like changing
  their role, password or two-factor authentication already did.
- **Failed sign-ins no longer lock an admin out of admin actions.** Confirming
  an admin action with your password has its own limit, separate from signing
  in, and only wrong passwords count towards it.

## 0.23.0

Hardening across the server, mail, calendar and the apps: hashed sessions,
an activity log, signed-in devices, pinned mail certificates, verified calendar
deletions, sending a message once, bundled fonts and pinch zoom. Two automatic
database upgrades; no configuration change is needed (see
[Upgrading](docs/UPGRADING.md#0230-hardening)).

### Added

- **Signed-in devices.** Settings > Security lists the browsers and apps
  signed in to your account, with the address and day of last use, and signs
  out any one of them except the one you are using.
- **The encryption key can be changed without losing saved sign-ins.** With
  `ENCRYPTION_KEY_PREVIOUS` set to the old key, mail and calendar passwords,
  authenticator keys and the push key stored before the change stay readable,
  and new values use the new key (docs/INSTALLATION.md, Changing the
  encryption key). Stored secrets now carry a format version (`v1:`); older
  values are read as before.
- **Activity log for administrators.** Settings > Server settings > Activity
  shows sign-ins, failed sign-ins, password and two-factor changes and every
  admin action on accounts and sign-up, kept for a year.

### Fixed

- **The Android app tells you when it does not fit the server.** Connecting
  the app to a server that needs a newer app (or another app version) now says
  so and points to the server's app download, instead of opening pages that
  may not work. The app also pauses its page's media and animations while it
  is in the background.
- **A message is sent once, even when Send is pressed again.** When the answer
  to Send got lost (a weak mobile connection, a server restart) and you pressed
  Send again, the message went out twice. Each composed message now carries a
  key: a repeat gets the first answer, and a repeat while the first send is
  still running is refused with a hint to check Sent.
- **Calendar sync removes only what the server confirms is gone.** An event,
  or a whole calendar with its events and ToDo state, was deleted as soon as
  one listing from the server left it out, so a server hiccup or an
  incomplete answer could wipe them. UniHub now asks the server about each
  missing entry and removes it only when the server says it no longer exists.
  A subscription that suddenly returns no events keeps the saved ones and
  shows an error instead.
- **A confirmed mail server is trusted only with the certificate you
  confirmed.** Confirming a mail server whose certificate could not be
  verified turned certificate checks off for that account's IMAP and SMTP
  connections for good, so anyone able to intercept the connection later could
  read the password and mail. The confirmation now shows the IMAP and the SMTP
  certificate with their fingerprints, and the account connects only while the
  server presents one of those (or a certificate that verifies). A different
  one stops the connection before the password is sent, and editing the
  account shows it for confirmation. Accounts confirmed earlier keep the
  certificate their next connection sees.
- **A draft's HTML is made inert before it reaches the editor.** Opening a
  draft put its stored HTML into the message editor as it was. A draft written
  in another client that quoted a hostile message (the provider's Drafts
  folder brings such drafts in) could therefore run scripts and event handlers
  in the app. The draft now passes through the same sanitizer as displayed
  mail before it enters the editor; everything the editor's own toolbar writes
  (bold, italic, underline, lists, colour, size, links, images, quotes) is
  kept. The editor also shows a draft's body when the compose dialog opens for
  the first time in a session, where it used to come up empty.
- **SVG attachments open with no access to the app.** The attachment viewer
  showed an SVG from a same-origin `blob:` address, so the browser's own "Open
  image in new tab" could run the file's scripts with this app's session. SVG
  is now drawn from a `data:` address, which is identical in the viewer and has
  no origin when opened on its own; "Open in new tab" stays unavailable for it.
- **Reading mail works after an email was shown over another page.** Once an
  email had been opened from a task or event, marking any message read on the
  Mail page failed inside the list cache and the reader showed "(No content)"
  without a request. The over-the-page email has its own cache entry, and the
  list update skips entries that are not lists.
- **Login cookies are secure however the container is started.** The `Secure`
  flag on the session and CSRF cookies depended on `NODE_ENV=production` being
  passed by the Compose file; an installer form that left it out (Portainer,
  TrueNAS) got a healthy container whose cookies could travel over plain HTTP.
  The image now sets production mode itself; a `NODE_ENV` entry stays harmless.
- **Deleting a user as an administrator removes their files.** The admin
  "Delete user" action removed the person's rows and recordings but left their
  mail attachments, raw mail copies and generated backup archives on the
  server, where the storage overview showed them as orphaned with no way to
  remove them. Both the admin action and "Delete my account" now use one
  deletion path that stops the person's mail work, deletes their rows and then
  removes every file under the configured roots. Deleting a user whose restore
  is still running is refused (409) instead of leaving the restore writing for
  a vanished account.
- **Mail sending library updated for security fixes.** Nodemailer 10.1.7 and
  mailparser 3.9.46 fix, among others, a shared DNS cache that could present
  one SMTP server's name to another account's connection, recipient-domain
  checks that a crafted address could bypass, and slow parsing of crafted
  address lists.
- **A huge mail or calendar feed no longer stalls the server.** Converting a
  very large HTML email to text, or reading a very large calendar
  subscription, ran on the process that serves every user. HTML over 2 Mi
  characters is now shown but not converted for search and previews, and a
  subscription may be at most 8 MiB and 10,000 entries; a larger one shows an
  error and keeps its last synced entries instead of being imported in part.
- **Server errors can be traced in the log.** A request that fails with a
  server error now returns a request id (`requestId`, and `X-Request-Id` on
  every response), and every log line written while handling it carries the
  same id. `UNIHUB_LOG_FORMAT=json` writes JSON log lines for a log collector.
- **A second UniHub container on the same database no longer duplicates mail
  work.** Only one API process at a time runs the mail sync, IDLE sessions and
  timers; another one logs a warning, serves requests and takes over when the
  first stops.
- **Admins confirm with their password before changing someone's password or
  role.** Resetting two-factor authentication already asked for it; setting a
  new password and making someone an admin (or removing that) now ask too, so
  an unattended admin session cannot be used to take over an account.
- **Session tokens are stored hashed.** The database kept a copy of every
  signed-in session's token, so anyone holding a database dump or a copy of
  the volume could sign in as any of those users for up to 21 days. It now
  keeps only a hash; existing sign-ins stay valid through the upgrade.
- **Restarts finish what they can.** Stopping or updating the container now
  lets requests in progress and running mail jobs finish (up to 8 seconds),
  and hands any job still running to the next start at once instead of after
  a 30-second wait. Compose gives the container 15 seconds to stop.
- **The interface fonts load in the installed app.** Inter and JetBrains Mono
  were requested from Google Fonts, which the app's own security policy
  refused, so an installed UniHub showed the system's fallback fonts. Both
  fonts now ship with the app: no request leaves your server for them, and they
  also work offline.
- **Pinch zoom works on phones.** The page forbade zooming, which locked out
  anyone who needs larger text, in Android browsers and in the Android app.
  Pinch zoom now works everywhere; iPhones keep their behaviour of not zooming
  into a text field when it is tapped.
- **ToDo rows fit the screen with a long email subject.** A task made from an
  email with a long subject was wider than the list: on phones its menu, the
  "Show email" button and the subtasks were cut off, and the page scrolled
  sideways. The subject is now shortened inside the row.
- **Browsers stay on HTTPS.** Behind an HTTPS reverse proxy, UniHub now sends
  `Strict-Transport-Security` (one year), so a browser that has reached it
  securely never falls back to plain HTTP, where a network attacker could read
  or change the page. Plain-HTTP requests are unaffected.
- **The Android app survives a crash of its page renderer.** When Android
  ended the WebView's renderer (a very large mail, or memory pressure while the
  app was in the background), the whole app closed and its notification
  service stopped with it until the next restart. The app now replaces the
  page and loads it again from the server.
- **Internal error text no longer shown to the browser.** When a calendar,
  recording or notification request failed inside the server (for example a
  database or file system error), the browser showed the raw internal message.
  Such failures now show the request's own message ("Failed to update event")
  and keep the details in the server log. A refusal the server meant for you
  (not found, conflict, invalid input) keeps its text and now also keeps its
  status instead of being reported as a server error.
- **One refused message no longer stalls its mailbox.** A message whose rows
  the database refused (for example a sender name, Message-ID or attachment
  name or type longer than its column) was downloaded and refused again by
  every body job and kept every older queued message in that mailbox from
  loading. Overlong header values are now cut to their column lengths (the
  stored raw message keeps the originals), and a message the database still
  refuses is set aside like an unparsable one so the rest of the mailbox loads.
- **Theme flash and remote images in the deployed image.** The container's
  Content Security Policy refused the page's inline theme script, so a Light or
  System-light user, and anyone with a chosen look, saw the dark default first
  on every load; the same policy refused remote images in HTML mail even after
  "Load remote images". The theme script is now the file `/theme-init.js`, and
  the page policy leaves remote images to the mail frame's own per-message
  consent, which still blocks them until asked.
- **Security headers on every file.** The service worker, `/assets/`, the
  manifest and icons were served without the security headers because their
  caching headers replaced them (nginx inheritance). Every response now carries
  them, and the deprecated `X-XSS-Protection` filter is turned off (`0`).
- **Long chord sheets, contact notes and passphrases save.** Ordinary writes
  were limited to 1000 bytes including the JSON itself, so a Music chord sheet
  beyond a few lines, a contact with longer notes or a sign-in with a long
  passphrase was refused with a message about attachments. The default is now
  16 KiB, with room for recordings (256 KiB), contacts (64 KiB) and password
  routes (4 KiB); a refused request shows the server's actual limit, and the
  attachment hint appears only when composing mail.
- **Sent attachments are saved with the Sent copy or not at all.** The copy
  of a sent message wrote its attachment files and rows one by one after the
  message row, outside its transaction and to a fixed folder that ignored the
  configured attachment root; an interruption could leave a Sent copy marked
  as having attachments that were missing, and a moved root made the files
  undownloadable and undeletable. The Sent copy now stages its files like
  drafts and imports and commits the message and attachment rows together; a
  failed copy removes the staged files and still reports the message as sent,
  so it is never sent twice.
- **Mail account settings are checked before they are saved.** A port that
  was not a number was tested against the old port and then stored as typed,
  a display name longer than its column or a missing provider reached the
  database and came back as the database driver's message, and the email
  address was never checked to be one. Adding and changing an account now
  checks and normalizes every field first and answers with a plain message;
  the connection test and the saved account use the same values. Every mail
  route answers an unexpected failure with a short message instead of the
  database's text.
- **Sent mail stays out of the server log.** A leftover debugging hook printed
  the recipients and subject of every sent message to the container log (and
  tried to write them to a file). It is removed; a failed send logs only the
  error kind.
- **A display name no longer changes the sender address.** The From header is
  built from the account's name and address separately, so a display name that
  contains `<` and `>` (for example a pasted address) is quoted instead of
  becoming the envelope sender.
- **Plain-text drafts with attachments are sent as text.** A text draft with an
  attachment was sent as HTML, collapsing line breaks and treating `<` as
  markup; only an empty body with attachments still uses the HTML placeholder.
- **Changing the time of a whole series with attendees no longer reports an
  error.** The server accepted the change and the occurrences were rebuilt, but
  the attendee rows were then written for the replaced occurrence id and the
  edit answered "Failed to update event". The local update is skipped once the
  occurrences are rebuilt, and the dialog's "Series updated" answer is returned.
- **A synced event can no longer lose its calendar.** An update with
  `calendar_id: null` on an event linked to a calendar server (reachable
  through the API, not the dialog) detached it locally, so later edits stayed
  local until the next sync overwrote them. It is now refused with a message;
  move or delete the event instead.
- **Contact fields are checked before they are saved.** A name, phone,
  email, company or title longer than its column reached the database and the
  dialog saw "Failed to create contact". Creating and editing a contact now
  trims every field except the notes, and refuses one that does not fit (with
  the limit in the message) or that is neither text nor a number. An email
  field still keeps whatever was typed, and a contact imported without a name
  can still be edited, so contacts from phones and vCards keep syncing. Editing
  a contact that is not yours, or no longer exists, answers "Contact not found"
  instead of succeeding with no contact.
- **vCard import keeps a card with an over-long field.** An `ORG`, `NOTE` or
  other value longer than its column was reported as a failed card with the
  database's message; the card is now imported with that field cut to the
  column size.
- **Merging duplicates is all-or-nothing per group.** The kept contact's
  update and the removal of its duplicates were separate statements, so an
  interruption between them could leave a merged primary with its duplicates
  still present and wrong counts; each group now commits in one transaction,
  and a group whose kept contact vanished since the listing is skipped.
- **A `%` or `_` in a search matches that character.** Contacts search and
  the mail list's search treated `%` and `_` as wildcards (so `100%` matched
  everything containing `100`); they now match literally, as in global search
  and recordings, which share the one escaper.

### Internal

- `COOKIE_SECURE` in `api/src/config.ts` is the one `NODE_ENV` read; `database.ts` exports
  `MIGRATIONS` and `LATEST_MIGRATION_ID`, checked without a database by
  `api/tests/database-migration-list.test.cts` (consecutive ids, unique kebab-case names,
  inventory `introducedIn` bounds, the `-- Through migration N.` header that
  `docker/mariadb/schema.sql` now carries); `initDatabase` throws its startup refusals
  (server.ts logs and exits) instead of calling `process.exit`; `docker/start.sh` skips the
  uploads ownership scan once the marker `/app/uploads/.owned-by-<uid>` exists.
- `api/src/services/user-lifecycle.ts::deleteUser(userId, { actor })` owns account
  deletion for both routes (restore refusal, mail stop, cascade delete in `withTransaction`,
  file removal under the roots, stream close); `BACKUP_ARCHIVES_ROOT` overrides the backup
  archive root for tests, like the mail and recording roots.
- One error contract at the request boundary (`api/src/http/errors.ts`): `ApiError` with
  `badRequest`/`unauthorized`/`forbidden`/`notFound`/`conflict`, and `clientError(error, fallback)`
  used by the request handler, the mail `routeError` helper and the calendar, recording and
  notification routes; the notification services throw typed 400/401 errors instead of plain
  errors matched by a regular expression. Responses are `{ error, code?, status }`
  (docs/ARCHITECTURE.md, Request Handling).
- The mail attachment and raw-message roots, and the checks that a stored
  path lies inside them, are defined once in `api/src/services/mail-storage.ts`
  and used by mail, the admin storage overview, account deletion and backup.
- Mail routes share one `routeError` helper (`api/src/routes/mail-route-helpers.ts`)
  and the account routes one input parser (`api/src/services/mail-account-input.ts`).
- Mail job kinds and operation states are declared once (`api/src/services/mail-engine/job-kinds.ts`,
  `operation-states.ts`) and the SQL lists, due predicate and retry/cancel rules are built from them;
  one idempotency-key grammar (`CLIENT_KEY_PATTERN`) is shared by the route, the writeback service,
  the receipt store and restore. The unused `mail-sync-state.ts` module and unused mail exports are removed.
- The deadlock-retrying `withTransaction` helper moved from the mail engine to
  `api/src/services/transactions.ts` (exported from `services/database.ts` and still from
  `mail-engine/repository.ts`), typed with `SqlExecutor` so any service can use it.
- Contact input normalization (`normalizeContactInput`, `boundContactFields`) and the
  duplicate merge (`mergeDuplicateGroups`) live in `api/src/services/contacts.ts`; the routes
  read `:id` from `req.params`; `escapeLike` is shared from `api/src/services/sql.ts`.
- Every API route is declared with a spec (`api/src/http/route.ts`: `auth`, `module`,
  `restoreSection`, `body`, `csrf`, `response`) and `request-handler.ts` reads only the spec;
  `mergeRouteTables` refuses duplicate keys and `assertRouteTable` checks the table at startup
  (admin level under `/api/admin/`, module under `/api/<module>/`, a restore section on every
  write, a write route for every section, every key resolving). The notifications, admin, auth,
  settings, modules, system, offline, search and events files declare native specs; the admin
  role check and the per-route 401 lines moved to the boundary, admin routes read `:id` from
  `req.params`, and the two live streams are declared `response: 'stream'` (the `__handled`
  return is gone). Calendar, mail, contacts, recordings and backup still derive their policy
  through `api/src/routes/legacy-spec.ts`, pinned by `route-spec.test.cts`.
  `routes-policy.test.cts` walks the production table through the real boundary (401 without
  a session, 403 for a non-admin on every admin route, the public, CSRF and restore
  declarations).
- The restore write policy left the backup catalog: `WRITE_PATHS` is replaced by
  `restoreSection` on the specs (a prefix table in `legacy-spec.ts` for the derived files);
  `api/src/routes/restore-sections.ts::getRestoreSectionForWrite(method, path)` looks it up
  over the route table. CSRF exemptions are the matched spec's `csrf` (`'none'` for sign-in and
  sign-up, `'background-header'` for the service-worker routes) instead of URL matching in
  `auth.ts`; the cookie/header token compare is constant-time.
- `services/module-lifecycle.ts::applyModuleChange(userId, previous, next)` owns what a
  changed module choice means for running work; the mail hook
  (`mail-sync-control.ts::onMailModuleChanged`) replaces the six lazy requires in
  `routes/modules.ts`, and the toggle tests moved to the service.
- `api/src/services/realtime.ts` fronts both live channels (the browser event bus and the
  Android notification stream bus): `publishToUser(s)`, `closeSession`, `closeUser`,
  `isOnline`, `setUserModules`, `stats`, and the mail and calendar producers moved there from
  `server-events.ts`. Sign-out, password and two-factor changes and deactivation now end the
  user's Android stream at once instead of at its next 45-second session check.
- The nine periodic timers and their startup resets moved from `app.ts` to
  `api/src/services/background-work.ts::startBackgroundWork()`, which returns `stop()`;
  `everyInterval` returns `{ run, stop }`. Shutdown stops the timers as well as the IDLE
  sessions (docs/ARCHITECTURE.md, Scheduled Jobs, now lists all nine).
- Import layering is checked by `npm run lint` (docs/ARCHITECTURE.md, Layering): security/ and
  http/ import no services or routes, routes do not import `db` or split `req.url`, views call the
  API through `src/lib/` feature modules, and `scripts/import-graph.mts` fails on a static import
  cycle. The files that predate a rule are listed in `eslint.boundaries.js`, which only shrinks.
  The mail read, star and attachment routes read their id from `req.params`.
- `android/scripts/build-apk.sh` reads the version from `package.json` independent of its
  formatting and stops on anything but `major.minor.patch`; the server ignores app metadata with
  version code 0 or an empty version name instead of advertising it. docs/ANDROID_COMPATIBILITY.md
  lists the 0.22.4 window.
- CI names third-party actions by commit SHA; `.github/dependabot.yml` proposes action, npm,
  Docker and Gradle updates; each run reports `npm audit` for shipped dependencies; a monthly
  workflow deletes `candidate-*` images older than 30 days that no release adopted
  (docs/RELEASE_CONTRACT.md).
- `api/src/log.ts` is the API logger (area, fields, request id via `AsyncLocalStorage`, text or
  JSON); the request boundary, startup, background work, timers, auth, database, health and user
  deletion use it, and `no-console` with a shrink-only list in `eslint.boundaries.js` covers the
  remaining 36 files.
- `api/src/services/sessions.ts` owns every session query by token (create, find, renew, lock,
  end, end others, end all); routes and the notification services call it. Upgrade step 18
  (`session-token-hashes`) hashes existing tokens in place.
- `api/tests/helpers/test-database.cts` (`withTestDatabase`, `startTestApi`) replaces the copied
  setup of new database tests; a golden-path test runs sign-in, sign-up, CSRF, contact ownership
  and sign-out through the real HTTP stack.
- Feature modules throw `ApiError` (`src/lib/api-error.ts`: message, status, the server's `code`
  and request id) through `unwrap()`; an error state shows the request id of a server failure.
  The admin pages, the sign-in page, Security settings and the compose hook call the API through
  `admin-api.ts`, `auth-api.ts`, `account-api.ts` and `mail-compose-api.ts`; the list of views
  allowed to use the API client directly shrank from 28 to 23.
- `sendEmail` takes `{ userId, accountId }` and loads the account with its owner, so a draft's
  stored account reference cannot send from another user's account.
- `api/src/services/settings.ts` owns the account preferences (one declaration of keys, defaults
  and allowed values) and the sign-up mode; the settings, auth and admin routes call it. A stored
  sign-up mode that is not one of the three reads as closed.
- Admin routes name a permission (`api/src/security/permissions.ts`) that the request boundary
  checks; `defineRoutes()` refuses an admin route without one. Upgrade step 19 (`audit-log`) adds
  the activity log, written by `api/src/services/audit.ts` inside the change's transaction where
  there is one; sessions record their address and user agent.

## 0.22.4

New mail is announced again. No database upgrade and no app update; the
server does it.

### Fixed

- **No notification for new mail.** Since the durable mail engine of 0.11, the
  server recorded a new message without ever queuing its "New Email"
  notification, so neither a browser nor the Android app heard about new mail
  while reminders, event and sign-in notices worked. A message that arrives
  after a folder's first pass is now announced as soon as its content is
  downloaded, with the sender and subject. The first import of an account or
  folder, a UIDVALIDITY reset, older history and messages the server already
  shows as read stay quiet, as do Sent, Drafts, Trash and Archive.

## 0.22.3

Contacts on the phone sync both ways. Install the app again from Settings →
General → Install; the server is unchanged.

### Changed

- **Contacts you add, change or delete on the phone now reach UniHub.**
  Contacts apps can edit UniHub's contacts on the phone, and a contact saved
  in the phone's UniHub account is added to UniHub. That includes the phone's
  own contacts when Android offers to move them into the account after you
  choose UniHub as the place to save contacts. A phone contact with the same
  email address or number as one in UniHub is joined to it, not added twice.
  When both sides changed the same detail, UniHub's version is kept. Notes
  still stay in UniHub, and a change from the phone keeps them. Photos,
  addresses, birthdays and more than three numbers or addresses stay on the
  phone. Deleting many contacts on the phone at once waits for Android's
  "Too many deletions" question.

### Fixed

- **Contacts moved into the UniHub account were deleted.** The 0.22.0 and
  0.22.1 apps removed every contact in the UniHub account that did not come
  from UniHub, so contacts Android moved there from the phone were deleted at
  the next sync instead of being added. If that happened on your phone,
  restore them from a backup of the phone's contacts; after the update, moving
  them in again adds them to UniHub.
- **Signing out keeps the phone's own contacts.** Signing out still removes
  UniHub's contacts from the phone, but no longer a contact the phone has not
  sent yet or one with details only the phone holds.

## 0.22.2

Live updates and app notifications behind your own reverse proxy. No database
upgrade.

### Fixed

- **Notifications in the Android app stayed "waiting" behind Nginx Proxy
  Manager** and other Nginx-based reverse proxies. Such a proxy held back the
  app's notification stream until its buffer filled, and could hold back the
  pages' live updates the same way. UniHub now tells the proxy not to buffer
  either stream, so notifications arrive at once without a custom location in
  the proxy. A custom location you added for 0.22.1 can stay or go. Update the
  server; the app needs no update.

## 0.22.1

### Added

- **Notifications in the Android app.** The app now shows UniHub's
  notifications (new mail, new events and tasks, reminders, recording and
  sign-in notices) like any phone app, also while it is closed. Your server
  sends them straight to the app over the app's own connection: no Google,
  Apple or other push service is involved, and each notification is encrypted
  for your phone. After signing in, the app asks once; Settings →
  Notifications turns them on and off and shows their state, and the ongoing
  "Connected" notification Android requires has a **Turn off** action and can
  be hidden. Notifications that arrive while the phone is offline are shown
  when it reconnects. When the phone is set to hide sensitive content on the
  lock screen, it shows only "New notification" there. Update
  the server and install the app again from Settings → General → Install.

## 0.22.0

### Added

- **Contacts on the phone.** The Android app can put your UniHub contacts in
  the phone's own contacts, so the Phone app, WhatsApp, Messages and other
  apps show their names. Once you are signed in, the app asks once; later,
  Android's Settings → Accounts → Add account → UniHub asks again. The phone
  gets names, phone numbers, email addresses, company and job title, never
  notes, as a read-only copy that follows UniHub: changes arrive when you
  leave the app and every few hours. Signing out or turning off the Contacts
  module empties it, another user signing in replaces it; removing the UniHub account in
  Android's settings or connecting the app to another server deletes it. The
  server needs nothing new for it: install the app again from Settings →
  General → Install.

- Pinned the existing interface with twelve synthetic desktop/phone reference
  screens and browser checks for themes, visible rows, panel preferences,
  keyboard focus and touch targets. Initial references preserve the current
  appearance; the documented ToDo overflow and recording-tag touch defects
  remain open bugs. Future baseline changes require an intentional decision.

### Fixed

- **A second tab can save after another tab reloads.** With UniHub open in
  two tabs, loading or refreshing one of them (for example with "Refresh now"
  on the update notice) made the other tab's next save fail, so a contact
  typed there could not be added until that tab was reloaded too. Opening a
  page now keeps the security token the other tabs already use; signing in
  still issues a new one, and signing out removes it.

## 0.21.4

### Fixed

- **The Android app opens again.** On Android 12 and newer, the app closed
  as soon as it started, and "Open in app" seemed to do nothing because it
  started the same crash. The app set the colour of the status bar icons
  before its window was ready, which these Android versions do not allow.
  Install the app again from the install card or Settings → General →
  Install; it updates the installed one.
- Every build now starts the app on Android emulators (Android 10 and 16)
  and checks the first start, "Open in app" and a start with a saved server
  before an image is published.

## 0.21.3

### Fixed

- **The in-app update applies again.** Since 0.19.2, "Refresh now" on the
  "UniHub update ready" notice often ended in "The update could not be
  applied". Every request to the server passed through the app's service
  worker, and the browser would not switch to the new version while any such
  request was still open, even one the page had already given up on. Requests
  to the server no longer pass through the worker, so only a running recording
  upload can delay the switch. The first update after installing 0.21.3 may
  still fail once, because the worker already installed in the browser has the
  old behaviour: close every UniHub tab and the Android app, or restart the
  browser, and open UniHub again. The failure notice now says what is holding
  the update back instead of blaming the connection.

## 0.21.2

### Fixed

- Recipients keep their display name: a message to `Jane Doe <jane@example.com>`
  now arrives with "Jane Doe" in its To or Cc header again, and drafts and the
  Sent copy show the name too. 0.21.1 had reduced every recipient to the bare
  address.

## 0.21.1

### Added

- **Looks** for the dark and the light theme, under Settings → Appearance,
  chosen per device. Dark: Default, **OLED black** (every surface true black,
  so those pixels stay off), **Dim** (soft grey, no pure black or white),
  **High contrast** (7:1 text, strong borders, thick focus outline),
  **Colour-safe** (warnings, errors and success in colours that stay apart
  with red-green colour blindness) and **Neon** (deep violet, glowing edges).
  Light: Default, **Paper** (warm off-white for long reading), **High
  contrast** and **Colour-safe**. Your accent colour works on top of every
  look; the Android app's status bar follows the look's page colour.
- The composer has **Cc** and **Bcc**, behind small Cc and Bcc buttons at the
  right end of To. A message needs at least one recipient in any of the three.
  The reader shows **Cc** under **To**: on received mail (for messages
  downloaded from now on) and on messages you send or save as drafts, which
  also keep their Bcc in your own copy.
- Contacts can be selected with the mouse: Ctrl/Cmd+click adds one, Shift+click
  adds a range. Escape clears the selection, Delete asks to delete it, and
  **Set company…** writes a company or job title to all selected contacts at
  once.

### Changed

- Controls on touch screens are visibly larger, about 15 percent: buttons,
  inputs, chips, menu rows, checkboxes, the done circle and the bottom bar
  glyphs, so you can tell what you are about to press. Nothing changes
  for a mouse.
- On wide windows the panel of a page (mail accounts and folders, contact
  lists, calendars, settings sections) can be folded away from its header; it
  then opens from the scope in the page title, as on phones. Each page's
  choice is remembered on the device.
- The mail reader can be dragged wider or narrower at its left edge on wide
  windows (double-click resets it); the width is remembered on the device.
- Tasks, songs and recordings show everything at once: description, subtasks,
  the email a task came from, chords and details are on the row, nothing folds
  away. Press the circle at the start of a song or recording to play it.

### Fixed

- Picking a contact in the composer closes the suggestion list; it opens
  again when you type. Escape closes it without leaving the field.
- Deleting more than about 25 selected contacts no longer fails with "Request
  body too large"; up to 5000 can be deleted at once.
- A recipient written as "Doe, Jane" <jane@example.com> is kept as one
  address; a saved draft no longer turns it into two broken ones.
- When a page's panel opens as a sheet, closing it puts keyboard focus back
  on the scope button in the page title instead of losing it; folding or
  pinning the panel keeps focus on the button that replaces the one you pressed.

## 0.21.0

The Android app, delivered by your own server. No database upgrade.

### Added

- **Android app.** Each UniHub image now carries a matching Android app. On an
  Android phone the install card offers **Android app** next to **Web app**:
  **Download**, open the file, allow the browser to install apps if asked, then
  **Open in app**, which connects the app to this server. The app shows
  UniHub's own pages, so it always matches the server's version. You sign in
  in the app as in the browser, two-factor codes included, and the status bar
  follows UniHub's light or dark theme. Notifications in the app come in a
  later release; keep the web app for them until then. Needs Android 10 or newer.
- **Settings → General → Install** offers the Android app and the web app at
  any time. Inside the app it shows the app version, the server, a newer app
  when the server has one (also in the attention tray), and **Change server**.
- `GET /api/version` tells apps which server they reached and which Android
  app it carries, before signing in.

### Changed

- Building the image also builds the Android app (Android SDK and Gradle).
  `--build-arg UNIHUB_ANDROID=0` leaves it out. See
  [Android app](docs/ANDROID.md) for the signing key.

## 0.20.0

Turn an email into a task. Database upgrade 16 runs at startup and adds two
fields to tasks and events; nothing else changes.

### Added

- **Add task from an email.** In the reader (and the message's right-click
  menu) **Add task** makes a task with the subject as its title, in a list of
  your choice, and keeps the email with it. Lists are your own calendars; a
  new one can be made right there. Give the task a day, with a reminder, and
  it shows in the calendar; without a day it waits under No date.
- **Back to the email.** The task shows the email it came from in ToDo, on
  Today and in the Calendar event, with its sender, date and attachment names
  and **Open email**. If the email is later removed from UniHub, the task
  keeps that summary and says so.
- The reader lists the tasks made from the open message, each leading to its
  row in ToDo; a mail row shows a small task mark when one exists. Mail shows
  no tasks while Calendar is turned off, and a task cannot be linked to an
  email while Mail is turned off or being restored.
- Offline reading shows the email summary on tasks too. Backups carry the link
  and the summary.
- **Show email** on a task or event shows the email over the page you are on
  (a column on the right on wide windows, a sheet on phones) instead of leaving
  for Mail. You can reply or forward right there, and **Open in Mail** still
  goes to the full page. **Set aside** (or dragging the sheet down on a phone)
  shrinks it to a small bar while you copy something from the page; bringing
  it back keeps a reply you had started.
- The link from a task or event to its email can be removed (the small
  unlink icon next to **Show email**); **Undo** in the message that follows
  links the email again while it is still in UniHub.
- A draft can become a task too: **Add task** in the compose form (and in a
  draft row's menu) saves the draft and links the task to it; the task shows
  "Draft to …" and **Open draft**.
- **Accent colour.** Settings has a new **Appearance** section (the theme
  choice moved there from General) with six accent colours: Blue, Indigo,
  Violet, Pink, Teal and Green. The accent colours buttons, links, the
  selected page, the UniHub mark and the page icon in the browser tab. It is
  saved with your account, so every device and the app follow; warning and
  delete colours stay as they are.
- **Delete a folder on the mail server.** Custom folders can be deleted again
  from the folder dialog. A folder that exists only in UniHub moves its
  messages and rules back to Inbox. A folder on the mail server is deleted
  together with its server copy and the messages in it, after you tick that
  choice; if the server refuses, nothing changes in UniHub. A message the
  server still has elsewhere (on Gmail, another label or All Mail) moves to
  that folder; drafts, mail kept only in UniHub and messages with a change
  still on its way to the server stay too and move to Drafts or Inbox.
- **Attachments open in UniHub.** An attachment row in the reader (and in the
  email shown over a task) opens a viewer: images, PDFs (drawn by UniHub, so
  phones without a PDF viewer work too, with selectable text), plain text and
  CSV, HTML without scripts or remote images, audio and video. Previous and
  next move through a message's attachments; the arrow keys do too. Other file
  types offer Download, as before.

### Changed

- **Send from.** A new message written from All accounts starts from the
  account chosen under Settings → General → Mail (the first account until you
  choose one), so From is never empty. Choosing another account in the From
  field of a message no longer switches the Mail page to that account. A reply
  always comes from the account that received the message. Restoring a
  backup keeps this choice on the restored account, or returns to the first
  account when that account is not part of the restore.
- ToDo and Music no longer hide their views and lists in a side panel or
  behind the title. The views (Open, Today, Overdue, …) and the lists are a row
  of chips above the list on every window size.
- Tasks from emails are offered only the lists that show in ToDo; a task that
  still lands in a hidden list says so in ToDo with a link to the Calendar.
  "Tomorrow" is the next calendar day in your timezone, also on the night the
  clocks change.
- The email shown over a page asks to save or discard an unsaved reply before
  it closes, opens the full Mail page or switches to another email, as the
  Mail page does. Dialogs and menus opened from it show above it.
- Long PDFs keep only the pages near the view drawn, so a hundred-page file no
  longer holds every page in memory.
- On touch screens, small controls are easier to hit: icon buttons, the task
  and message checkboxes, chips, menu and list rows get a larger tap area
  without growing on screen or changing the layout for a mouse.

### Fixed

- **A busy server no longer looks like a sign-out, and no longer restarts.**
  When the database was slow, the API's one-second and thirty-second timers
  kept starting new runs on top of unfinished ones; each waited for a
  database connection until the pool (50) was full and every request queued
  behind them, which showed as "Loading UniHub…" for a long time. Timers now
  skip a tick while the previous run is still going. A failure in the
  periodic mail sync could also end the API process unnoticed, which
  restarted the container; it is handled, and any such failure is now logged
  with its cause. The container's health check reports a saturated pool as
  busy (200) rather than as failed, so nothing restarts a server that is
  merely working through a queue; the pool counts are logged every minute
  while that lasts. A database that stops answering while connections are
  free, or a pool that stays full for ten minutes without one answer, is
  still reported as failed (503), and waiting checks share one query instead
  of each adding one to the queue. A failure during startup ends the process,
  so the container restarts rather than staying up without serving.
- When the server gave no answer (restarting, busy, or the proxy answered
  502), the app showed the sign-in page. It now says the server is not
  answering, keeps the session and retries on its own. Reloading after
  **Load new version** therefore no longer needs a new sign-in.
- The waiting screen retries only after the previous check has finished, so a
  server that answers slowly can still be reached, and the state clears on
  sign-in and sign-out.

## 0.19.4

Two refinements to how UniHub follows mail moved in another app. No
database upgrade and no configuration change.

### Fixed

- When a message exists in several places on the server, UniHub now acts on
  the copy it saw most recently. Before, it could pick an older copy that had
  meanwhile been deleted too, so a star or move failed until that folder was
  checked again.
- Retry on an account switched to Download no longer changes the message's
  folder in UniHub; in Download mode the folder is yours, not the server's.

## 0.19.3

Mail actions feel immediate without hiding what the server has confirmed,
and fixes for cases where UniHub and the mail server slowly drifted apart.
No database upgrade and no configuration change.

### Changed

- **Mail changes look done at once.** Moving or trashing a message takes it
  out of the list, closes it in the reader and updates the folder's unread
  count immediately; marking read or starring already did. A message opens
  from its row right away with its sender, subject and date while the body
  loads, and is marked read at that moment. If UniHub rejects a request, the
  rows and counts return to how they were and a message says so.
- **One quiet pending mark.** Instead of "Saving change…" and "awaiting
  provider" text in every row, a small hollow dot on the row and in the reader
  marks a read or star change the provider has not confirmed yet. Its tooltip
  (and screen-reader text) names the change; nothing is disabled while it
  waits. The sync button's count and panel keep showing all waiting changes.
- **Shorter confirmations.** After a move or trash the notice says only where
  the message went ("Moved to Archive") and, for a synced account, "Waiting
  for the server". Undo stays for local (Download) accounts.
- Marking many messages read or starred refreshes the view once, not once
  per message.

### Fixed

- **Read and star changes made on the server after the first sync are
  picked up.** Each check of read, starred and deleted state now covers all
  mail up to the moment it starts; before, mail that arrived after the
  account's first full check was left out of later checks.
- **A message moved or archived in another mail app can be changed from
  UniHub again.** UniHub kept acting on the message's old place on the server,
  so starring, reading or moving it failed, the message jumped back and the
  change waited for review; Retry did not help. UniHub now follows the copy
  the server still has, and Retry recovers changes already stuck this way.
- **On Gmail, a message moved to Trash leaves Archive, Important and labels at
  once** instead of reappearing there until the slower checks of those
  folders caught up.
- **Sort now** sorts what the Inbox shows, so mail archived in another app is
  no longer sorted and Gmail mail first seen in All Mail is no longer missed.
- **Folders deleted or renamed on the server** no longer keep showing their
  old mail; they show as empty, and moving mail into them is refused. The
  mail stays in All mail and comes back into the folder if the folder
  returns.
- **Switching an account from Sync to Download** applies changes that had not
  been sent yet to UniHub's copy, instead of leaving them waiting forever.
- The unread count next to an account counts each message once and only mail
  that is in a folder, so it matches the folder counts.
- An account's "last synced" time updates after every successful sync.
- The pending changes panel shows when a waiting change is retried again.
- **Mail actions work when the web app and the API use different
  addresses.** The API now allows the request headers mail changes send, so
  the browser no longer drops them and reports that UniHub did not answer.
- When UniHub does not answer a mail change, the message says so in plain
  words.
- A message that fails to open is no longer left marked as read.

## 0.19.2

A new, calmer layout for every page, and groundwork in the API for the
planned native app. Database upgrade 15 runs at startup; it only formalises
tables and indexes that existing installations already have.

### Changed

- **One layout for all pages.** On desktop a slim navigation rail replaces the
  sidebar, and each page has an optional panel next to it (mail folders, task
  lists, calendars, contact lists, settings sections). On phones the page's
  own header is the top bar, its panel opens from the button next to the page
  title, and the bottom bar stays.
- **Rows instead of cards.** Mail, tasks, contacts, recordings, music and
  settings show plain rows with one main action each; further actions are in
  the row's menu or appear once the row is opened.
- **One place for things that need you.** Mail changes to review, failed mail
  or calendar syncs and a waiting app update are collected in Attention (rail
  and More) instead of separate banners.
- **Calendar** shows the selected day next to the month or week, dots instead
  of event names on phones, and opens an event only once its calendar is
  known, so the question about repeating server events is always asked.
- **Contacts** open in a detail pane with email addresses and phone numbers
  as links. Deleting a contact or merging duplicates now asks first, and
  views such as Favorites and Possible duplicates are in the panel.
- **Settings** has sections instead of tabs: General, Profile, Security,
  Notifications, Offline reading, Pages and modules, Mail rules, Backup and
  restore, and Delete data. Preferences save as soon as they change. Admins
  find Server settings and Users in the same panel.
- **Today, ToDo, Recordings and Music** use the same rows and panels. The
  command palette can create a task and lists pages in your order.
- Less text on screen, sentence-case labels throughout, and the sign-in page
  shows only the form.

### Fixed

- A mail row no longer shows a stray "0" when the message has no attachment.

### Under the hood

- The API matches routes from its route table instead of hand-written path
  rules, and declares request size limits next to it.
- Requests that sign in with an `Authorization: Bearer` header and no
  session cookie no longer need a CSRF token, so a native client can write.
  Browser requests are checked as before.
- Notification delivery goes through a transport interface (Web Push today),
  ready for a second kind of device.
- All schema setup runs through the numbered upgrade steps (step 15), not
  partly at startup and partly after the server is listening.
- Browser code has one place for device features (`platform.ts`) and typed
  in-app events; each feature owns its API calls and refresh rules. A test
  keeps the browser's and server's module lists in sync.
- framer-motion is no longer a dependency.

## 0.19.1

The remaining tests, fixture generators, development tools and the PostCSS
configuration are now authored in TypeScript. The application runtime,
database schema and backup format are unchanged from 0.19.0.

- API tests and helpers use `.cts` and run directly on Node.js 26. They are
  type-checked against the API modules they load directly and the database
  driver's types;
  deliberate test doubles and malformed inputs are marked as such. The release
  gate still requires every database test to run without skips. Historical
  backup archives and fixture data are unchanged.
- Root development scripts and the PostCSS configuration use `.mts`.
  `npm run typecheck` now also checks API tests, root scripts, Tailwind and
  Vitest configuration. The ESLint configuration stays JavaScript, so editors
  and plain `npx eslint` keep working without extra flags.
- Existing 0.18.2 and 0.19.0 installations use the same database migration
  history and need no additional configuration or schema migration.

## 0.19.0

The API and the two browser workers are now written in TypeScript and
compiled before they run. UniHub works the same as before: the same pages,
routes, database and backup format. No database upgrade runs at startup.

### Changed

- **The API is compiled from TypeScript.** Routes, services, security helpers
  and the `mail-rollout` operator command are checked in strict mode and
  compiled to the same CommonJS layout as before. The image holds only the
  compiled code and the production dependencies. `/app/api/server.js` and
  `/app/api/mail-rollout.js` are where they were. The development scripts
  in `api/scripts/` are type-checked TypeScript that Node runs directly.
- **New databases start from the 0.16.0 schema.** Every installation since
  0.16.0 began with an empty MariaDB database, so the upgrade steps for
  databases from 0.9.x to 0.15.x never ran on existing data. They are
  replaced by one step that creates the same tables and records the same
  upgrade history. A new database is the same as one created by 0.18.2, and
  existing databases are not changed.
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
- A new installation needs an empty database. UniHub no longer adds its
  tables to a database that already holds other tables or data without an
  upgrade history. A first setup by an earlier release that stopped partway
  is refused too: start 0.18.2 once to finish it.

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
