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
  is not already using. Without the app installed, the link downloads it.
- Opening the app directly shows a connect screen. The address is checked
  against `GET /api/version` (below) before it is saved. HTTPS is required;
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
app. The app adds `UniHubAndroid/<version> (<code>)` to the user agent and gives
the server's own top-level page (not other sites, not frames such as displayed
email) a `UniHubAndroid` object that takes JSON messages:

| Message | What the app does |
| --- | --- |
| `saveFileStart`, `saveFileChunk`, `saveFileEnd`, `saveFileAbort` | Saves a file the page made (an attachment, an export, a recording) to Downloads, in pieces of 1.5 MB that the app confirms one by one. A WebView cannot download `blob:` links. |
| `download` | Downloads a file the server streams (backups, attachments, the app update) with Android's download manager and the app's session. Only the server's own addresses. |
| `changeServer` | Forgets the server and shows the connect screen. |
| `theme` | Colours the status and navigation bars like the page (UniHub's own light/dark setting, not the phone's). |
| `notifications` (`action`: `status`, `enable`, `disable`, `background`; with an `id`) | Settings → Notifications: reads or changes this phone's notifications and answers with the same `id`, `ok`, an `error` or the `state` (`enabled`, `endpoint`, `permission`, `background`, `connected`). From 0.22.1; the page sends it only to apps with version code 22001 or later. |

Links to other sites, `mailto:` and `tel:` open in the matching phone app. File
inputs open Android's file picker. Recordings ask for the microphone through
Android's permission prompt.

## Contacts on the phone

From 0.22.0 the app can show the signed-in user's UniHub contacts in the
phone's own contacts, so the Phone app's caller name, WhatsApp, Messages and
other apps find them. It is entirely in the app: the server and the web pages
are unchanged, and it works with any server the app supports.

- **Turning it on.** Once signed in, with at least one contact, the app asks
  once per server: **Show contacts** or **Not now**. Android then asks for
  access to contacts. Later, Android's Settings → Accounts (Passwords &
  accounts on some phones) → Add account → UniHub asks again.
- **What the phone gets.** Each contact's first and last name, its phone
  numbers (as mobile, like the vCard export), email addresses, company and job
  title. Notes stay in UniHub: every app allowed to read the phone's contacts
  could read them. A contact with none of these is left out.
- **One direction.** The contacts belong to a "UniHub" account on the phone,
  named after the server, and contacts apps show them as read-only. Edit them
  in UniHub; the phone follows. Android merges a UniHub contact with the same
  person from another account (Google, the SIM) into one entry as usual.
- **Keeping up.** Android syncs the account about every six hours, and the app
  asks for a sync each time it is left (the moment edits or a sign-out most
  likely happened). Turning off sync for the account in Android's settings
  stops both and keeps the last copy. A sync that fails or gets an incomplete
  answer changes nothing; only a complete listing adds, changes and removes.
- **Session.** The sync asks `GET /api/auth/me?background=1` and
  `GET /api/contacts` with the app's own WebView session cookie, so it needs no
  password of its own. A sync uses the session like the open app does, so
  while syncing is on the app's session keeps being renewed (21 days from the
  last use, see [authentication](AUTH_ADMIN_SETTINGS.md)). The app passes a
  renewed cookie on to its pages, except while a page is signing in (the
  `/auth` page and five minutes after), so it never replaces a new session.
- **Removal.** Signing out in the app, a session that ended (for example
  signed out on every device), or the Contacts module turned off empties the
  account at the next sync; signing in again fills it. Another user signing in
  replaces the contacts with theirs. Connecting the app to another server,
  removing the UniHub account in Android's settings, or uninstalling the app
  removes the account and Android deletes its contacts.

Android keeps the copy on the phone and other apps with the contacts
permission can read it (WhatsApp, for example, uploads phone numbers to find
its users). That is the reason it is a question, not a default.

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
server whose page reported a theme. It fails on any crash. To run it locally,
start an emulator and pass the APK.

`android/scripts/notifications-test.sh` checks notifications against a stub
server that encrypts like UniHub with its own implementation: the question
after signing in, turning them on from the page (or from the question where
the WebView has no message bridge, as on the Android 10 emulator), a
notification shown with its text and a content-free version for the lock screen,
acknowledged, opened by a tap, not shown twice, received with the app in the
background, a reconnect after an app update, sign-out removing them, signing in
again, and turning off from the page and from the ongoing notification.

`android/scripts/contacts-test.sh` checks contacts on the phone against a
stub server with synthetic contacts: accepting the question, the phone's
number lookup (what the Phone app uses) finding the names, notes staying off
the phone, changes and deletions on the server, a sync started by Android with
the app closed, another user, a session that ended, signing in again and
moving to another server. CI runs it on every emulator after the support
window.

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
