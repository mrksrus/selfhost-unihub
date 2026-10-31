# Android app

The Android app is a thin shell around the UniHub web pages. It opens the
user's own server in a WebView, so its screens always match the server's
version and every feature is written once in `src/`. Native code only covers
what a browser tab cannot do. Each server image carries the matching app and
offers it for download; there is no app store.

Status (0.22.1): the app connects to a server, shows UniHub, can put the
user's contacts on the phone and shows UniHub's notifications, received over
its own connection to the server (no push service; see
[Notifications](#notifications)). Apps before 0.22.1 have no notifications.

## Getting the app

- **Install card.** On an Android phone, UniHub's install card offers the
  **Android app** next to the **Web app** (where the browser can install it).
  Choosing the Android app shows **Download** and three steps: open the file,
  allow the browser to install apps if Android asks, then come back and tap
  **Open in app**. The app needs Android 10 or newer; phones that report an
  older version are not offered it. On a computer the card offers only the web
  app, as before.
- **Settings → General → Install** offers the same at any time. On a computer it
  links the download and says to open UniHub on the phone.
- Downloading counts as installing: the card stops appearing in that browser.
  **Later**, **No** and the once-a-day rule work as described in
  [PWA](PWA.md#install-prompt).

## Connecting to a server

- **Open in app** opens `unihub://connect?server=<this server>`. Because any
  website could send such a link, the app asks before switching to a server it
  is not already using. The question stays until it is answered, also when
  Android recreates the activity (for a change an app cannot take itself,
  such as the theme overlays a phone applies a minute or two after it starts,
  or after ending the app in the background); an answered link is not asked
  again (B-33, from the 0.27.1 app). Without the app installed, the link downloads it.
- Opening the app directly shows a connect screen. The address is checked
  against `GET /api/version` (below) before it is saved: from 0.23.0 a server
  speaking another handshake `protocol`, or whose `minApp` is newer than the
  app, is refused with a hint to install the app from that server. HTTPS is required;
  plain HTTP only works for `localhost`, `127.0.0.1` and the emulator's
  `10.0.2.2` (development).
- You sign in inside the app as in the browser, including two-factor codes.
  The app has its own session, separate from the phone's browser, which lasts
  like any device's: 21 days from the last use.
- If the server cannot be reached, the app offers **Retry** and **Change
  server**. Inside the app, Settings → General → App shows the app version,
  the server, an update when the server carries a newer app, and **Change
  server**.

## What the app does natively

`src/lib/platform.ts` is the only place in the web code that knows about the
app. The app adds `UniHubAndroid/<version> (<code>) UniHubBridge/<level>` to the
user agent and gives
the server's own top-level page (not other sites, not frames such as displayed
email) a `UniHubAndroid` object that takes JSON messages:

| Message | What the app does |
| --- | --- |
| `saveFileStart`, `saveFileChunk`, `saveFileEnd`, `saveFileAbort` | Saves a file the page made (an attachment, an export, a recording) to Downloads, in pieces of 1.5 MB that the app confirms one by one. A WebView cannot download `blob:` links. |
| `download` | Downloads a file the server streams (backups, the app update) with Android's download manager and the app's session. Only the server's own addresses. For the app update (`/downloads/unihub.apk`) the app opens Android's installer itself when the download completes, at once while it is on screen, otherwise from its "UniHub update downloaded" notification or when it is next opened (`AppUpdate.kt`). Opened from the download manager's own notification, Android would count the download manager as the source and refuse it. Android asks once to allow UniHub to install apps (`REQUEST_INSTALL_PACKAGES`). The installer gets only a copy in the app's cache that is this app, signed with the installed app's key, in a version not older than the installed one (`UpdateCheck.kt`); anything else is deleted, also from Downloads, and the app says that nothing was installed. |
| `fileAction` (`action`: `open`, `save`, `share`; `url`, `name`, `mime`, with an `id`) | "Open with…", "Save to Downloads" and "Share" for a server file, by a [download ticket](#files-for-other-apps) URL; answers with the same `id` and `ok` or an `error` once Android has the file. From bridge level 2 (0.25.0). |
| `changeServer` | Forgets the server and shows the connect screen. |
| `theme` | Colours the status and navigation bars like the page (UniHub's own light/dark setting, not the phone's). |
| `notifications` (`action`: `status`, `enable`, `disable`, `background`; with an `id`) | Settings → Notifications: reads or changes this phone's notifications and answers with the same `id`, `ok`, an `error` or the `state` (`enabled`, `endpoint`, `permission`, `background`, `connected`). From 0.22.1; the page sends it only to apps with version code 22001 or later. |

The bridge level says which messages the app understands: apps up to 0.24
send none and count as level 1 (everything above except `fileAction`), 0.25.0
is level 2. The page offers a feature only to apps whose level has it, so a
development build needs no version number of its own.

Links to other sites, `mailto:` and `tel:` open in the matching phone app. File
inputs open Android's file picker; from 0.25.0 the app gives the page its own
copy of each picked file (WebView 133 on Android 16 reads the picker's
addresses as empty files), kept and deleted like the copies for other apps
below. A pick is copied up to 3.9 GB in all (the largest upload the server
accepts, a backup import) and only while the phone keeps 256 MB free; a file
over that, or one that cannot be read, is left out, and the app names it and
the reason in a dialog. Copies still being made when the session ends stop
and are deleted, and the page gets none of them. Recordings ask for the
microphone through Android's permission prompt.

### Files for other apps

From 0.25.0 the attachment viewer in the app offers **Open with…**, **Save to
Downloads** and **Share** instead of Download and Open in new tab. The page
asks the server for a download ticket (`POST /api/files/tickets`, see
[architecture](ARCHITECTURE.md#download-tickets)) and passes its URL to the
app, which:

- fetches the file with the ticket alone, no cookie: the app's session never
  goes to another app or to Android's download manager;
- for Open with and Share, keeps a copy in its own cache and gives the app
  chosen in Android's sheet read access to that copy only (a FileProvider
  `content://` address), with the type the server named, or the extension's
  when the server only said "binary";
- for Save, writes it to Downloads (MediaStore), like a saved export.

Copies for other apps are deleted six hours after they were made (an app
may read a shared file some time later, a mail app when it sends; the app
cleans up whenever it is opened or comes back to the front, and refuses an
older copy at once) and all at once whenever the page shows the sign-in page
(signing out, a session ended elsewhere) or the app leaves the server. A ticket works once, so a download
that breaks off is started again from the page.

### Keyboard

The app draws behind the status and navigation bars on every Android version
and makes room for them, a display cutout and the on-screen keyboard itself.
The WebView therefore ends exactly at the top of the keyboard, as a browser
page does when it resizes for it, and the page's own keyboard handling
(`visualViewport`) finds nothing covered. Before 0.25.0 this was so only from
Android 15; older versions resized the window themselves.

## Contacts on the phone

From 0.22.0 the app can keep the signed-in user's UniHub contacts in the
phone's own contacts, so the Phone app's caller name, WhatsApp, Messages and
other apps find them. From 0.22.3 this works both ways. From 0.26.0 the app
syncs every field both sides have with a server that lists `contacts-vcard`
in `GET /api/version` (0.26.0 and newer). With an older server it syncs the
3+3 fields of the apps up to 0.25.1 (below), and it switches by itself when
that server is updated.

- **Turning it on.** Once signed in, with at least one contact, the app asks
  once per server: **Show contacts** or **Not now**. Android then asks for
  access to contacts. Later, Android's Settings → Accounts (Passwords &
  accounts on some phones) → Add account → UniHub asks again.
- **What is shared (0.26.0 servers).** The name with all its parts (prefix,
  given, middle, family, suffix), every phone number, email address, postal
  address, web address, messaging and SIP address, relation and nickname with
  its label, the organisation, department and job title, the birthday and
  anniversary (also without a year), the favourite star and the photo.
  Android's types are UniHub's labels, as in Android's own vCard export: all
  twenty phone types, custom labels as custom labels, and relations Android
  has no type for ("Colleague") as a custom label that comes back as that
  label. Messaging addresses are IMPP addresses (`xmpp:`, `skype:`, `sip:`
  for SIP addresses, a custom protocol's name otherwise). A value UniHub has
  no label for gets the phone's default (mobile for numbers). A name UniHub
  knows only as a display name ("Example Labs Reception") is the given name
  on the phone.
- **What is shared (older servers).** Each contact's first and last name,
  three phone numbers, three email addresses, company and job title. New
  numbers from UniHub are labelled mobile, like the vCard export of those
  versions.
- **What stays in UniHub.** Notes (every app allowed to read the phone's
  contacts could read them), categories and the details kept from imports. A write from the phone sends them back unchanged. A UniHub contact
  with nothing to show (no name, organisation, email or number) is left off
  the phone.
- **What stays on the phone.** Phonetic names, the organisation's job
  description, symbol, office and phonetic name, a second organisation, events
  other than the birthday and anniversary, the phone's own notes, group
  memberships and ringtones, and a value too long for UniHub (a number over 64
  characters, for example). With an older server also everything beyond the
  3+3 fields: a fourth number, labels, addresses, birthdays, a middle name or a
  photo. Removing the UniHub account removes these with it (see Removal). A
  contact added on the phone with only a postal address, say, stays the
  phone's own until it gets a name, organisation, email or number.
- **Both ways.** The contacts belong to a "UniHub" account on the phone, named
  after the server. Contacts apps can add, edit and delete contacts there; the
  next sync does the same in UniHub, and UniHub's changes come to the phone.
  Contacts that Android moves into the account count as added, for example
  when the phone offers to move its own contacts after you pick UniHub as the
  place to save them. A contact added on the phone that has the same email
  address or phone number as one in UniHub is joined to it instead of being
  added twice. Each side then fills in what the other lacks. A field changed
  on both sides since the last sync takes UniHub's value; the name counts as
  one field. Lists (numbers, addresses, ...) are merged value by value, so
  adding one on each side keeps both; a value is the same when UniHub's key
  for it is ("+1 555 0100" and "+15550100"), and a number written
  differently on the phone is no change. A changed label or preferred value
  counts as a change of the value.
- **Photos.** A photo set or removed on one side follows on the other (UniHub's
  when both changed). UniHub converts a photo from the phone and Android
  scales one from UniHub; neither counts as a change, so a photo never goes
  back and forth. At most 200 photos move in one sync, and none on a metered
  network (mobile data, a metered Wi-Fi); the rest follow at later syncs. With
  an older server photos stay where they are.
- **Merges in UniHub.** A contact merged into another in UniHub (also "Merge
  all") leaves the phone, and the contact it was merged into brings every
  value. If the phone had changed the merged-away contact since the last
  sync, that change goes to the contact it was merged into first. These are
  UniHub's deletions, so they never ask "Too many deletions". Undoing a merge
  brings the contact back to the phone. The apps up to 0.25.1 see a merged
  contact as deleted, and one they had changed comes back as a new contact,
  which then shows as a duplicate in UniHub.
- **Deleting.** A contact deleted on the phone is deleted in UniHub, unless
  UniHub changed it since the last sync, even only its note; then it comes
  back with the change.
  Deleting ten or more contacts at once (and at least a quarter of them) is
  not passed on unasked. Android shows its "Too many deletions" notification
  instead, where they can be deleted in UniHub or brought back on the phone.
  A contact deleted in UniHub disappears from the phone, unless it was changed
  on the phone since; then it is added to UniHub again.
- **Keeping up.** Android syncs the account about every six hours and shortly
  after a contacts app changes it. The app also asks for a sync each time it is
  left (the moment edits or a sign-out most likely happened). Turning off sync
  for the account in Android's settings stops all of these and keeps the
  phone's copy as it is. A sync that fails or gets an incomplete listing
  changes nothing; a contact UniHub refuses is tried again at the next sync.
  A sync never writes over a contact that was edited on the phone while it
  ran; that edit goes with the next sync. With a 0.26.0 server a change is
  written with the contact's version: if it changed in UniHub meanwhile,
  UniHub refuses the write and the next sync merges both. Deletions, and
  every write to an older server, go to UniHub only if the contact is still as
  UniHub listed it a few seconds before; otherwise the next sync merges the
  newer version first. Those have no conditional write, so an edit made in
  UniHub in that very moment can still be overwritten, as between two open
  web pages.
- **Session.** The sync asks `GET /api/auth/me?background=1`,
  `GET /api/version` and `GET /api/contacts` (with `include=merged` on a
  0.26.0 server), and writes with `POST /api/contacts`, `PUT` and
  `DELETE /api/contacts/<id>` and the photo routes
  (`GET`, `PUT ?source=android` and `DELETE /api/contacts/<id>/photo`) like the
  contacts page, using the app's own WebView session cookie and its CSRF token.
  It needs no password of its own. A sync uses the session like the open app
  does, so while syncing is on the app's session keeps being renewed (21 days
  from the last use, see [authentication](AUTH_ADMIN_SETTINGS.md)). The app
  passes a renewed cookie on to its pages, except while a page is signing in
  (the `/auth` page and five minutes after), so it never replaces a new
  session.
- **Removal.** Signing out in the app, a session that ended (for example
  signed out on every device), or the Contacts module turned off removes
  UniHub's contacts from the phone at the next sync; signing in again brings
  them back. A contact the phone had not sent yet, or one holding something
  UniHub does not keep (see above), stays and syncs again when the same user
  signs in. Another
  user signing in replaces the contacts with theirs; what stayed of the
  previous user is never sent to the other user. Contacts saved on the phone
  belong to the user who last used the app (recorded when contacts are turned
  on). Contacts saved while no user was known (an app from 0.22.0 or 0.22.1
  that was signed out when it was updated) stay on the phone and are sent to
  no one. Connecting the app to another server,
  removing the UniHub account in Android's settings, or uninstalling the app
  removes the account and Android deletes its contacts, including what only
  the phone kept.
- **Updating to 0.26.0.** Contacts the earlier app synced stay linked; nothing
  is added again. At the first sync with a 0.26.0 server, what that app kept
  as the phone's own (a fourth number, labels, addresses, birthdays, a middle
  name, the photo) goes to UniHub, and what UniHub has beyond the 3+3 fields
  comes to the phone. A number UniHub already has (from a merge, say) is not
  added twice, and where both sides have the same value UniHub's label wins
  unless it has none. The app's state of each contact moves from format "2"
  to "3" then.
- **Updating from 0.22.0 or 0.22.1.** The read-only copies those versions
  wrote become ordinary synced contacts at the first sync after the update.
  Nothing is sent to UniHub for them until they are edited on the phone.

Android keeps the contacts on the phone and other apps with the contacts
permission can read them (WhatsApp, for example, uploads phone numbers to find
its users). That is the reason it is a question, not a default. Those apps can
also change or delete the UniHub contacts on the phone, and such changes sync
to UniHub like your own; the deletion guard above still holds many deletions
for an answer.

## Notifications

From 0.22.1 the app shows UniHub's notifications (new mail, new events and
tasks, reminders, recording and sign-in notices) like any phone app, also
while it is closed. The server is the app's own push server: the app keeps one
connection to it, and no Google, Apple or other push service sees anything.

- **Turning them on.** Once signed in, the app asks once per server: **Turn
  on** or **Not now**. Settings → Notifications turns them on and off at any
  time and shows the state, as in a browser. Android then asks to allow
  notifications (Android 13 and newer) and whether UniHub may run in the
  background. Without the second, Android may pause the connection while the
  phone sleeps and notifications arrive late; Settings shows **Allow in
  background** until it is allowed.
- **The connection.** A foreground service holds
  `GET /api/notifications/android/stream`. Android requires it to show an
  ongoing notification, "Connected to <server>", in a silent channel; it can be
  hidden in Android's notification settings, and its **Turn off** action turns
  notifications off. The server sends a heartbeat every 45 seconds. The app
  replaces a connection that is silent for two minutes or changes network,
  reconnects with a growing pause after failures (at most five minutes), and
  at least every twelve hours. It starts again after the phone restarts and
  after an app update; a check every 15 minutes starts it if the phone ended
  it, which Android only allows to an app that may run in the background.
- **Encrypted for this phone.** Turning them on makes a key pair on the phone
  and registers its public half with the server (`POST
  /api/notifications/android/devices`), bound to the app's session like a
  browser's push subscription. The server encrypts every notification for it
  exactly as Web Push does (RFC 8291), so the same message could later travel
  through another route, such as a UnifiedPush distributor, without anything
  in it being readable on the way. The private key never leaves the phone.
- **Delivery.** The app shows a notification and acknowledges it (`POST
  /api/notifications/android/ack`); one not acknowledged within two minutes is
  sent again, and the app shows each one once. While the phone is offline its
  notifications wait on the server until they expire (a day for mail, two hours
  after a reminder was due) and are sent as soon as it connects, up to 200 at a
  time every 30 seconds. They are marked private: when the phone is set to
  hide sensitive content on the lock screen (Android's setting, not UniHub's),
  it shows only "New notification" there until unlocked. Channels
  for mail, reminders and events, recordings, and account notices can each be
  silenced in Android's settings. Tapping one opens its page in the app.
- **Session.** The connection uses the app's WebView session cookie, like
  [contacts](#contacts-on-the-phone), and its requests keep that session in use,
  so the app stays signed in while notifications are on. Signing out in the
  app, signing out every device, or an ended session closes the connection
  within a heartbeat, removes the shown notifications and stops the service;
  signing in again as the same user resumes it. Another user on the same phone
  gets them only after turning them on.
- **Another server.** Notifications belong to a server: connecting the app
  to another server stops them, and connecting back resumes them.

## Version handshake

`GET /api/version` is public, so the app can recognize a server before signing
in:

```json
{ "app": "unihub", "server": "0.21.0", "protocol": 1, "minApp": "0.21.0", "features": [],
  "android": { "url": "/downloads/unihub.apk", "versionName": "0.21.0", "versionCode": 21000, "size": 117323, "sha256": "…" } }
```

`android` is `null` when the image was built without the app. Rules for
changing the handshake are in `api/src/services/app-version.ts`: add features
instead of raising the protocol, and remove something only after `minApp` has
moved past every app that uses it. The app's version follows the server's:
0.21.0 is version code 21000.

## Building

The Dockerfile's `android-1` stage builds the APK with the Android SDK
and Gradle (`android/scripts/build-apk.sh`) and copies it to
`/app/downloads/unihub.apk`; Nginx serves it at `/downloads/unihub.apk`. Build
an image without the app with `--build-arg UNIHUB_ANDROID=0`; the page then
offers only the web app.

Android's build tools run only on x86-64 Linux, so this stage always builds as
`linux/amd64`. On an ARM machine (Apple silicon, a Raspberry Pi) Docker needs
x86-64 emulation: Docker Desktop has it; on Linux install it once with
`docker run --privileged --rm tonistiigi/binfmt --install amd64`. Images built
without the app need no emulation.

### Signing key

Android installs an update only when it is signed with the same key as the
installed app. Losing the key means every user must uninstall the app, and lose
its local data, to get the next version. Back it up like the database
encryption key.

- **Official images** are signed with the key in the repository secrets
  `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. CI refuses to
  publish an image without them. Create the key once:

  ```sh
  keytool -genkeypair -keystore unihub-release.jks -alias unihub \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=UniHub"
  base64 -w0 unihub-release.jks   # the value of ANDROID_KEYSTORE_BASE64
  ```

  Use one password for the keystore and the key; it is
  `ANDROID_KEYSTORE_PASSWORD`. A PKCS12 file works as well
  (`openssl pkcs12 -export -name unihub`, alias `unihub`). Keep the key file
  out of the repository.
- **Images built without a key** (pull requests from forks, local builds) get a
  throwaway key. Such an app cannot be updated from another image: uninstall
  it first.
- **Self-built images** can use their own key:

  ```sh
  base64 -w0 my-key.jks > /tmp/keystore.b64
  docker build --secret id=android_keystore,src=/tmp/keystore.b64 \
    --secret id=android_keystore_password,src=/tmp/keystore-password \
    --build-arg UNIHUB_ANDROID_SIGNER=my-key .
  ```

  `UNIHUB_ANDROID_SIGNER` is any name for the key; the build stops without it.
  Docker's build cache does not notice a changed secret, so use a new name
  whenever the key changes, or a cached app signed with the old key ends up in
  the image.

## Development

Develop features in the browser as usual. To try the app:

1. Open `android/` in Android Studio, or build with `cd android && ./gradlew assembleDebug`
   (needs JDK 17 and the Android SDK).
2. Start the API and `npm run dev`, then `adb reverse tcp:8080 tcp:8080` so
   the phone reaches the dev server as `localhost`, which keeps service workers
   and cookies working without certificates.
3. Connect the app to `http://localhost:8080`. In the emulator,
   `http://10.0.2.2:8080` reaches the computer as well.

CI starts the built app on Android emulators (`android/scripts/launch-test.sh`):
a first start, "Open in app" with the app closed, and a start with a saved
server whose page reported a theme. For the candidate app (`--candidate`) the
question to connect must also come back after a font size change recreates
the activity. It fails on any crash. To run it locally, start an emulator and
pass the APK. `tools/e2e/android/connect-link.test.mjs` cold-starts the debug
app from the link ten times (`UNIHUB_E2E_CONNECT_STARTS`), with and without a
saved server, and recreates it while the question is open.

`android/scripts/notifications-test.sh` checks notifications against a stub
server that encrypts like UniHub with its own implementation: the question
after signing in, turning them on from the page (or from the question where
the WebView has no message bridge, as on the Android 10 emulator), a
notification shown with its text, a locked phone set to hide sensitive content
showing only "New notification" (Android 11 and newer; the Android 10 image
cannot unlock again after a PIN),
acknowledged, opened by a tap, not shown twice, received with the app in the
background, a reconnect after an app update, sign-out removing them, signing in
again, and turning off from the page and from the ongoing notification.

`android/scripts/contacts-test.sh` checks contacts on the phone against a
stub server with synthetic contacts that also takes writes like the contacts
API: accepting the question, the phone's number lookup (what the Phone app
uses) finding the names, notes staying off the phone, changes and deletions
on the server, contacts added, edited and deleted on the phone reaching the
server with its notes kept, a phone contact joined to the same person in
UniHub, many deletions waiting for an answer (undone, then confirmed), a
contact not yet sent surviving a sign-out, a sync started by Android with the
app closed, another user, a session that ended, signing in again and moving
to another server. Then the stub server takes the full model (`contacts-vcard`)
under contacts the 3+3 sync linked: the phone's own address, birthday, middle
name, web address and fourth number reach it without duplicates (also a number
it already had, written differently), every kind and label goes both ways,
a photo comes to the phone and goes again, an edit in UniHub during a write is
not overwritten (409), "Merge all" of twelve groups leaves the phone without
"Too many deletions", a merged-away contact changed on the phone gives that
change to the survivor, and an undone merge comes back. Given the previous
release's app, both parts start there and update to the candidate. CI runs it
on every emulator after the support window.

`tools/e2e/android/contacts.test.mjs` runs the debug app against a real
server (the e2e stack): the update from the 0.25.1 app (given as
`UNIHUB_E2E_PREVIOUS_APK`, signed like the installed app) with that app's 3+3
writes keeping a fifth number and its labels, a contact with five numbers and
four emails shown with its labels and every kind going both ways, photos both
ways (the debug build's `TestContactPhoto` sets a phone photo, which adb
cannot), and "Merge all" of twelve groups plus an undo.

`scripts/android-server-check.mts` runs the release-built apps against real
servers on the Android 16 emulator: the image the run built and the earlier
releases' images, each with an empty database and synthetic people. It drives
the app through Android's accessibility tree, since a release build's WebView
cannot be inspected, and confirms each step through the API: connecting,
signing in with and without a two-factor code, reopening, an upload from the
document picker, a recording after the microphone permission, the download of
that recording's bytes, and signing out. To run it against a local
`tools/e2e/stack.sh` with an emulator:
`UNIHUB_ANDROID_ADMIN=admin@example.com:<password> node scripts/android-server-check.mts --local <stack url> --apk <apk>`.

Every CI run keeps the app it built under **Artifacts** (`unihub-android-app`)
for trying it on a phone without publishing an image. Runs from this
repository are signed with the release key, so that app updates an installed
one.

Debug builds allow inspecting the WebView from `chrome://inspect`. To see the
install offer in development, point `UNIHUB_DOWNLOADS_DIR` at a folder with
`unihub.apk` and `unihub-android.json` before starting the API (the Vite dev
server does not serve the file itself).

Test on real phones (at least two brands) before a release that changes the
app.
