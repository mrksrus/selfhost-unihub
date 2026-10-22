# Android compatibility

Which Android apps a release supports, how that is checked, and what happens
with an app that is too old or known to be broken. How the app works is in
[Android](ANDROID.md).

## Support window

A release supports its own Android app and the apps of the three releases
published before it. Phones update the app only when the user installs a
newer one, so an older app can stay in use for a while.

[`android/support-window.json`](../android/support-window.json) lists exactly
these releases, newest first:

| Field | Meaning |
| --- | --- |
| `version` | The release; the first entry is the version in `package.json`. |
| `apk` | Version code, SHA-256 and signing of the app published in that release's image. The current release's hash is recorded once it is published. |
| `shell` | `supported`; `broken` with `fromApi`, `symptom`, `fixedIn` and `upgrade`; or `unavailable` with the reason no app was published. |
| `emulators` | The Android versions every app is started on, with the system image name. |
| `handshake.shellReads` | Which fields of `GET /api/version` the apps in the window read. |

App version, server release and handshake `protocol` are separate numbers. The
apps in today's window read `app` from the handshake, and the 0.22.1 app also
`features` (it offers notifications only while they list
`android-notifications`), so the server must keep answering `app: "unihub"`,
keep listing that feature while such an app is in the window, and `minApp`
must not refuse the oldest app in the window. Removing support for an app is a product decision: change the
window and `minApp` together, on purpose.

## Checks

`node scripts/android-support-window.mts --candidate <dir> --out <dir>` (needs
`npm --prefix api run build` and the release tags):

- fails unless the window lists this version and the three releases tagged
  before it, so a release cannot forget to move the window;
- reads every earlier app from its published image
  (`ghcr.io/mrksrus/selfhost-unihub:<version>`, `/app/downloads`), without
  Docker, and fails if it differs from its own metadata, from the recorded hash
  or is not release-signed;
- fails if the built server's handshake would refuse an app in the window;
- writes the apps and `plan.tsv`, the expected result of each app on each
  emulator.

`android/scripts/window-test.sh <dir> <candidate.apk> <candidate metadata>`
runs on a booted emulator and prints a table:

- `launch`: the full [launch test](../android/scripts/launch-test.sh) with that
  app: first start, "Open in app" asking before it connects, and a start with
  the saved server whose page reports a theme. The server is a stub page.
- `crash`: an app recorded as broken from this Android version must still close
  on start. If it does not, the record is wrong and the check fails.
- update: the previous release's app is installed and, where it starts,
  connected to a server; installing the candidate over it must be accepted and
  start with the saved server. A candidate signed with a throwaway key (pull
  requests from forks) cannot update a release-signed app; the table shows this
  row as not run.

CI runs both for Android 10 (API 29), 16 (API 36) and 17 (API 37, system image
`android-37.0`). Any unexpected row fails the build before an image is
published.

## Current window

As recorded in `android/support-window.json` for 0.23.3. The CI table is the
evidence; this table is what it is checked against.

| App | Android 10 | Android 16 | Android 17 |
| --- | --- | --- | --- |
| 0.23.3 | starts and connects | starts and connects | starts and connects |
| 0.23.2 | starts and connects | starts and connects | starts and connects |
| 0.23.1 | starts and connects | starts and connects | starts and connects |
| 0.23.0 | starts and connects | starts and connects | starts and connects |

All four apps put contacts on the phone and sync them both ways.
From 0.23.0 the app also reads the handshake `protocol` and `minApp` when
connecting to a server.
`android/scripts/contacts-test.sh` checks that on each emulator against a stub
server, starting from the previous release's app and updating to the
candidate. The apps from 0.22.1 on also show notifications;
`android/scripts/notifications-test.sh` checks that the same way. Older apps
have neither; Settings → Notifications tells someone in an older app to update
it.

**Android 17 emulator: not run.** The current Android 17 system image
(`android-37.0`, google_apis x86_64, revision 6) crashes its own
surfaceflinger right after boot with every GPU mode, so the system restarts
and no app can be installed or started. The CI step runs only when the
repository variable `UNIHUB_ANDROID17` is `true` (to try a new image) and does
not block a release; until a working image ships, the Android 17 column above
is confirmed on a real Android 17 phone and recorded with the release, not by
the emulator.

0.21.1 to 0.21.3 close on Android 12 (API 31) and newer: the app set the status
bar icon colour before its window existed (CHANGELOG 0.21.4; the emulators
confirm it on 16 and 17, not on 12 to 15). Users of those apps install the
current app from the install card or Settings → General → Install in the
browser; it installs over the old one, and a server saved on Android 10 or 11
is kept. Releases before 0.21.0 have no app.

## Releasing

1. Move the window: the new version first, then the three releases before it.
   Copy each earlier app's `versionCode` and `sha256` from its published
   `unihub-android.json` (the check prints the hash it found).
2. Keep a broken app's entry until it leaves the window, with its upgrade path.
3. If an app starts reading more of the handshake, record that in
   `handshake.shellReads` and extend the check before raising `protocol` or
   `minApp`.

## Not covered

- Real server flows in the app: signing in with two-factor codes, reload,
  deep links into pages, downloads and uploads, the file picker, the microphone,
  theme colours and logout. Older apps against the candidate server and the
  candidate app against older servers are therefore not shown.
- Native handling of `protocol` and `minApp` before 0.23.0: older apps do not
  read them, so an unsupported server is not reported in those apps.
- Physical phones and manufacturer changes, and WebView versions other than the
  emulator images'. Record real-phone checks separately from CI.
