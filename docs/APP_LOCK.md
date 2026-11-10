# App lock

From 0.29.0, UniHub can ask for a fingerprint, a face, the phone's PIN or a
UniHub PIN before it shows what you chose to lock. The lock belongs to the
device: each browser profile, installed web app and Android app installation
has its own, set in **Settings → App lock**. An administrator can require it.

The lock stops someone who picks up an unlocked phone or an open laptop. It is
not encryption and does not protect the server: read [Limits](#limits) before
relying on it.

## Choosing what locks

- **Lock:** Off, **Whole app** (everything, Today and Settings included) or
  **Chosen modules** (Mail, Contacts, Calendar and ToDo, Recordings and Music;
  Calendar and ToDo lock together, as do Recordings and Music).
- **Unlock with:** in the Android app, a fingerprint or face (Android's
  BiometricPrompt) with the phone's PIN, pattern or password as the
  alternative. In a browser or the installed web app, a **UniHub PIN** of 6 to
  12 digits. A phone without a screen lock uses a UniHub PIN in the app too,
  and Settings says how to set a screen lock instead.
- **Ask again:** every time UniHub opens, or after 1, 5 or 15 minutes in the
  background.
- **Also when the phone is locked** (Android app): UniHub locks as soon as the
  screen turns off, whatever the time above.

Turning the lock on asks for the chosen unlock once, so a PIN or finger that
does not work is noticed at once. Weakening it (Off, fewer modules, a longer
time) asks for the unlock first. Turning it off removes this browser's UniHub
PIN.

While a module is locked, everything that shows its data asks first: its
page, its sections on Today, its rows in the search (one row offers the
unlock), its counts in the navigation, and the Settings sections that reach
it. One unlock opens everything that is locked on the device. Contacts synced
to the phone's Contacts app stay there: the phone's own lock protects them,
and the Settings row says so.

## While UniHub is locked

- **Notifications carry no content.** The server sends each device the
  least of the person's notification detail and that device's lock: a device
  whose lock covers a notification's module and that has not been unlocked
  recently gets the generic text ("New Email", "Event reminder"), decided
  again at every send. The service worker and the Android app check the lock
  once more before they show a notification. Tapping one asks for the unlock
  before its page opens.
- **The recent-apps picture is hidden** in the Android app: the app covers
  the page with the UniHub mark whenever it goes to the background with the
  lock on, and from Android 13 it also turns the recents screenshot off.
- **Screenshots** can be blocked by the administrator: the Android app's window
  is then secure (FLAG_SECURE), also with the lock off. Browsers cannot block
  screenshots.
- **The offline copy is locked too.** Starting UniHub without a connection
  asks for the unlock before any saved view shows; the lock's settings and the
  PIN are kept in this browser, so it works offline.

## Wrong PINs and a forgotten PIN

The first five wrong UniHub PINs cost nothing. Each further one makes the next
try wait longer (30 seconds, 1, 2 and 4 minutes), and from the seventh the
lock screen says how many tries are left. The tenth wrong PIN signs the device
out. **Forgot PIN? Sign out** on the lock screen does the same at any time.

Signing out this way ends the session on the server and removes the UniHub
PIN and the offline copy from the device. **Recordings not uploaded yet stay
on the device.** Sign in with your password to set a new PIN. The Android app's lock is the phone's own: Android decides
how many tries a finger or the phone's PIN gets.

## Required by the administrator

**Server settings → Policies → App lock** sets three rules for the whole
installation (groups follow in a later version):

| Policy | Values (default first) | Effect |
| --- | --- | --- |
| `app_lock.required` | nothing, the whole app, or chosen modules | the least each device must lock |
| `app_lock.max_background` | no limit, 15, 5 or 1 minutes, every time | the longest **Ask again** a device may choose |
| `app_lock.screenshots` | allowed, forbidden | screenshots in the Android app |

The first two are floors of each device's own choice: Settings shows the
required modules checked and greyed with the administrator's reason, and the
longer times greyed out. Everyone confirms a changed rule in the rules notice
first; a device that does not lock enough then sees **Your administrator
requires the app lock**, with **Turn on the app lock** and **Sign out**.

**The server refuses** what a device short of the requirement asks for: `403`
with code `APP_LOCK_REQUIRED` and `details` holding `required`,
`max_background` and `reason`, before the request body is read and before any
side effect. A device is short when the lock it reported does not cover every
required area, or asks again later than allowed. The page shows the prompt on
any such answer.

- A module's routes are refused while that module or the whole app is
  required. Routes of no module (Today's counts, the search, the offline copy,
  backups, the bin, the administrators' pages) can show several modules'
  data, so they are refused while anything is required.
- A route that shows another module's data than its address names counts for
  that module too: a mail account's linked calendar is Calendar's. An email's
  details leave out the tasks made from it while Calendar is locked.
- Administrators are held to the policy on their own devices like everyone
  else; their way out is changing the policy, which asks for their password.
- **Open without the lock** are the routes a device needs to comply and to
  stay safe: who is signed in, signing out, the password, the profile and
  two-factor sign-in; the device list and signing a lost device out; this
  device's lock report and settings; the person's settings and preferences
  (no module data); the rules and their notice; which modules exist; the live
  update stream (ids and counts only); notification set-up (the content rule
  above applies); and uploading a recording that exists only on the device.
  The list is pinned with a reason per route in
  `api/tests/routes-policy.test.cts`.
- The Android app's **contacts sync** keeps working while the device is short,
  and only it: the contacts routes are open to requests with the header
  `X-Background-Sync: 1`, which the app's sync sends and the page never does.
  Apps before 0.29 would otherwise skip a refused contact rather than wait.

## Devices

Each browser profile and app installation is a device record (`devices`).
Signing in names the device by a random key the page keeps in local storage
(the server stores only its hash), so a new sign-in in the same browser joins
its device. **Settings → Security → Devices** lists the person's devices with
a live session: the kind, browser or app version, last use, the lock it
reports and whether it gets notifications. **Sign out** on another device ends
its sessions and push channels and removes it; the activity log records it.
A device without a session that was last used more than 30 days ago is
removed.

Devices are installation state. They are not in personal backups, and an
instance restore deletes them together with the sessions. The upgrade to
0.29.0 gives every existing session a device of its own, so nobody is signed
out.

## Limits

- **The device enforces the lock; the server takes its word.** Each device
  reports what it locks. The stock UniHub page and app report the truth; a
  modified app or page, or a script with a session cookie, can report a lock it
  does not have. There is no attestation. The required lock raises the bar for
  a lost or borrowed device, not for a person who controls their own.
- **The web PIN is client-side only.** It is a PBKDF2 hash in this browser's
  IndexedDB; the server never sees it and counts no tries. Someone with access
  to the browser's storage or developer tools can get past it. In the Android
  app, the phone's own lock is checked by Android.
- **The lock is not encryption.** The offline copy, the PIN and the lock's
  records sit in the browser's storage as before; encryption at rest is the
  device's job (a phone or disk encrypted by its own lock).
- **Contacts synced to the phone** and notifications already shown before the
  lock took effect are outside UniHub's lock.
- **Making a task from an email** while Mail is locked on a device that is
  short of a required Mail lock can still copy that email's subject into the
  task, because the task route is Calendar's. It shows nothing else of the
  email.
- **The Android cover** shows the launcher mark on the page's background; the
  page's own lock screen shows the mark in the account's accent, so the mark
  changes when the page takes over.

## Implementation

| Part | Where |
| --- | --- |
| Device records, binding, the lock report and the gate's check | `api/src/services/devices.ts`, `api/src/routes/devices.ts`, `api/src/contracts/devices.ts` |
| The gate at the request boundary | `api/src/request-handler.ts`, the route spec fields `appLock` and `appLockModules` (`api/src/http/route.ts`) |
| Device settings and the three policies | `api/src/services/settings-registry.ts` (device scope, floors) |
| Notification content per device | `api/src/services/notifications.ts`, `workers/sw-custom.ts` |
| The web lock: PIN, timing, controller | `src/lib/app-lock/`, `src/hooks/use-app-lock.ts`, `src/contexts/AppLockProvider.tsx` |
| The screens | `src/components/app-lock/`, `src/components/settings/AppLockSettings.tsx`, `src/components/settings/Devices.tsx` |
| The Android side (bridge level 3) | `src/lib/platform.ts` `deviceLock()`, `android/.../AppLock.kt`, `BiometricAuth.kt`; see [Android](ANDROID.md#app-lock) |
| Upgrade step 26 | `api/src/services/devices-migration.ts` |
