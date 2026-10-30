# Release contract

A UniHub release promises four things: existing data survives, supported
clients keep working, an open app updates without losing work, and a failed
update has a recovery path. Each promise below names its required evidence.
A release is published only by `.github/workflows/docker-image.yml`, after
the required automated checks and the manual acceptance checks below pass.
A green workflow is necessary but does not establish checks it cannot run.
A missing required check blocks release; it never counts as passed.

The checks run on the pull request, before merging: a release is prepared
there (version, changelog, support window) so that the tested content is the
released content. A run builds the image once and pushes it under a tag of
that run only (`candidate-run-<run>-<attempt>`); every check below that needs
the image pulls exactly that digest, in jobs that run side by side. Only when
every one of them passed does the `publish` job tag the digest
`candidate-<tree>` (the git tree of the tested merge), and the push to `main`
and the release tag publish that image unchanged under `latest`, the version
and the commit, without building or testing again. When no tested image has
exactly the released content (a direct push, or `main` moved after the
pull request's run), the release run builds and runs every check itself
before publishing. The release run's summary names the published digest and the run
that tested it (the image's `io.github.mrksrus.unihub.tested-run` label);
that run holds the release evidence (`unihub-release-evidence`, kept 30 days,
and the emulator logs). Record what the release needs from it with the
release.

The workflows name every third-party action by its full commit SHA (the
version in a comment), so a moved or compromised tag cannot change what a
release runs. `node scripts/check-action-pins.mts` checks that each SHA is the
commit its version comment names upstream; run it when a pull request changes
a pin (including Dependabot's). Dependabot (`.github/dependabot.yml`) proposes updates to the
actions, both npm packages, the interface check, the Docker base images and
the Android build as ordinary pull requests that pass the same checks. Each
run reports `npm audit` findings for shipped dependencies without blocking.
`prune-candidates.yml` deletes, monthly, `candidate-*` images (run tags
included) older than 30 days that no release adopted; it needs the package to grant this repository
the Admin role, and a manual run lists without deleting by default.

Feature details stay in their own documents; this page lists what must be
shown before publishing and how.

## How CI runs the checks

A run uses only standard `ubuntu-latest` runners of the free plan and takes
about 25 minutes. `api-tests`, `frontend`, `build` and `android-window` start
together; once `build` has pushed the image, `container`, `android-10`,
`android-16` (one job per script), `android-16-servers` (the real-server
pairings over four emulators, `--part k/4`) and `e2e` (one job per target)
start together. `publish` needs every one of them and re-tags the tested
digest without building; `evidence` gathers the evidence into one artifact,
also after a failure. Between jobs only small artifacts travel (the Android
app and the support window's earlier apps, kept a day; the release-signed app
is also kept 14 days for trying it on a phone); the image travels only through
the registry. A pull request from a fork cannot push, so its test jobs build
the same commit themselves; nothing from it is kept or published.

## Required for every release

| Promise | Check (CI step) | Run it locally |
| --- | --- | --- |
| API, database and recovery tests pass with no skipped test | `npm --prefix api run test:ci` (`api-tests`; this CI step is the promise, PROJECT-PREFERENCES P-34) | focused files with `scripts/local-db.sh test <file>`; the whole suite with `npm run test:db` ([development](DEVELOPMENT.md)) |
| Frontend tests, lint and production build | Run frontend checks | `npm test -- --run && npm run lint && npm run build` |
| Pinned interface reference pictures and browser behavior | Verify the pinned interface | `npm --prefix tools/ui-regression run verify` ([setup](UI_BASELINES.md#commands)) |
| The image starts as in production, serves the app and the Android download, isolates users, and survives a stop and an API crash | `scripts/container-smoke.sh` | needs Docker and a disposable `_test` database |
| A full backup moves to a fresh, independent installation | `scripts/recovery-fresh-install.mts --image unihub:ci` | `npm --prefix api run build && node scripts/recovery-fresh-install.mts --local` |
| An open web app updates without losing work, and earlier releases in the support window update to this one | `scripts/pwa-update-check.mts` | `npm run build && node scripts/pwa-update-check.mts --local` |
| The Android apps of the support window behave as recorded on Android 10, 16 and 17 (17 on a real phone while its emulator image is broken, see [Android compatibility](ANDROID_COMPATIBILITY.md)), and updating keeps the saved server | `scripts/android-support-window.mts`, then `android/scripts/window-test.sh` on each emulator | an emulator and `adb` ([Android compatibility](ANDROID_COMPATIBILITY.md)) |
| The candidate app's contacts sync both ways with the server (added, edited, joined and deleted on either side, many deletions held for an answer), survive the update from the previous release's app, and follow a session end and a server change | `android/scripts/contacts-test.sh` on each emulator | an emulator and `adb` ([Android](ANDROID.md#contacts-on-the-phone)) |
| The candidate app receives, shows, acknowledges and opens notifications over its own connection, survives an app update and stops on sign-out | `android/scripts/notifications-test.sh` on each emulator | an emulator and `adb` ([Android](ANDROID.md#notifications)) |
| The Android apps work against real servers: the candidate app against this image and each earlier server release in the window, and each earlier app against this image. Connecting, signing in with and without a two-factor code, staying signed in after the app is ended, an upload through Android's document picker, a byte-identical download, the microphone permission and a recording, Open with, Share and Save to Downloads for a mailed file (app and server from 0.25.0), and signing out, each confirmed on the server (Android 16) | `scripts/android-server-check.mts --part k/4` on four Android 16 emulators (`android-16-servers`; each part's table is in its log and the run summary) | an emulator and `adb`; `--local <url> --apk <apk>` against `tools/e2e/stack.sh` ([below](#what-the-android-server-check-proves)) |
| A published image carries the release-signed Android app | Check and keep the Android app | — |
| Every user flow covered by the end-to-end suite works through the image (its nginx and API, production settings), MariaDB and synthetic mail and CalDAV providers, on desktop, phone and Android-app targets | `e2e` job, one per target: `tools/e2e/stack.sh up` with `UNIHUB_E2E_IMAGE`, then `npx e2e run --exclude-tag providers --target <target>` | `tools/e2e/stack.sh up`, then `npm test` in `tools/e2e` ([e2e](../tools/e2e/README.md)); real providers (`npm run test:providers`) only locally |
| The candidate Android app's debug build passes the flows under `tools/e2e/android/` against the candidate server (attachments in the phone composer) | not in CI yet: run locally on the candidate | `tools/e2e/android.sh up`, then `npm run android` in `tools/e2e` |

`scripts/pwa-update-check.mts` exits with 75 when headless Chrome itself stops
answering (a browser-level DevTools command times out), which says nothing
about the app; CI then runs that check once more. Any other failure, or a
second 75, fails the step.

## Required acceptance beyond the current CI

Until these scenarios are automated, the release owner must record their
results for the exact candidate and artifacts. Missing evidence blocks release.
This is a workflow requirement; the present CI does not enforce these manual
rows. Do not describe a green CI run as full release acceptance.

- **Android/server pairings, every release.** CI runs the pairings (the
  candidate app against the candidate server and the three previous server
  releases, each supported earlier app in the window against the candidate
  server) on the Android 16 emulator for sign-in, two-factor sign-in, session
  reload, upload/download bytes, file picker, microphone and logout. The
  release owner still records deep links and theme chrome for those pairings,
  and the candidate app against the candidate server on a real phone, with
  app version/hash, server version/image digest and OS/WebView. An
  explicitly known-broken historical app uses its documented installation
  upgrade path instead, and is reported as an exception, never as compatible.
  Next release's candidate supplies the forward pairing; unknown future
  server versions cannot be tested today.
- **Upgrade and recovery across versions, for persisted-data or format changes.**
  Start each of the previous three server releases with synthetic supported
  data, retain its volumes and keys, update to the candidate image and verify
  migration completion, core reads/writes and a new backup. Separately import
  that earlier release's export into a fresh candidate installation. Preserve
  an independent snapshot before upgrading; an older container cannot undo a
  database migration. Include the source versions and archive hashes.
- **Pinned interface behavior, for UI changes.** Run the relevant scenarios
  in [UI acceptance](UI_ACCEPTANCE.md), including desktop/phone and dark/light.
  A source check or launch stub cannot substitute for those results.

`--local` runs use the built API from `api/dist`, MariaDB from the tarball that
`scripts/local-db.sh` uses (`UNIHUB_DB_HOME`) and `bwrap` to give each
installation its own `/app/uploads`. They create and delete their own
databases and directories and never touch `unihub_dev` or a live server.

## What the recovery check proves

`scripts/recovery-fresh-install.mts` starts two installations, each with its
own MariaDB server, uploads, `ENCRYPTION_KEY`, `BACKUP_MASTER_KEY` and
`JWT_SECRET`.

1. The source gets synthetic data in every recovery section: through the API
   (profile, preferences, contacts, an uploaded recording, a ToDo made from an
   email with subtasks, a local event) and on the server
   (`api/tests/helpers/fresh-install-seed.cts`: synced mail with raw files and
   attachments, two mail accounts and a CalDAV account with passwords, folder
   history, an unsent provider change, completed and failed transcripts,
   settings and scores from removed modules).
2. The sections offered by `GET /api/backup/capabilities` must be exactly the
   ones the check knows, and every recovery table except a short, named list
   of rare provider-evidence tables must hold source rows. A new section or
   table fails the check until it is seeded and compared.
3. A full encrypted backup is made, revealed and downloaded as in the browser.
   It must not contain a plain password. The source installation, its database
   and keys are then deleted.
4. Another user of the destination imports the file with the recovery password.
   Everything the API shows (texts, dates, links between sections, folders,
   rules, file bytes) must equal the source, under new IDs. On the server
   (`fresh-install-inspect.cts`): row counts per table, every reference owned by
   the user, files inside the user's directories with the recorded bytes (and
   owned by the API user in the image), no leftover upload or staging file,
   credentials re-encrypted with the destination key, no provider job, worker
   lease or runnable provider change, server deletion off, mail accounts paused.
5. A second destination user sees none of it.
6. The destination restarts (app and database); all of step 4 is checked again
   with the session from before the restart.
7. Test peers start: an IMAP server and a CalDAV server with certificates from a
   test CA that only the installations trust. Reconnecting each restored mail
   account must log in with its restored password; a calendar sync must
   authenticate with the restored calendar password. The peers then report a
   temporary outage; no restored mail or event may disappear, and no
   destructive IMAP command (STORE, MOVE, COPY, EXPUNGE, DELETE, APPEND) may
   arrive.

With `UNIHUB_RECOVERY_EVIDENCE=<file>` it writes the image ID, archive hash,
restored row counts and the commands the peers saw. CI keeps it as the
`unihub-release-evidence` artifact.

The frozen old-archive tests in `api/tests/` (0.9.23 and 0.10.3 exports) stay
part of `test:ci`. When the stored data or backup format changes, also restore
an archive exported by the previous release (start that release's image as the
source); this check does not do that yet.

## What the update check proves

`scripts/pwa-update-check.mts` serves one web build, deploys another the way
Nginx would, and forwards `/api` to a disposable installation. In Chromium:
tab A (signed in, controlled by the old service worker) has a server request
that never finishes; tab B has a new contact typed but not saved and a
recording upload in flight. After the deployment tab A must show
"UniHub update ready", and its **Refresh now** must load the new version. Tab B
must not reload, must keep the typed contact, must hear about the update, must
finish its upload, and must save the contact.

- Without options the old build is this release's `dist/` and the new one is
  the same build with a changed page, which is what the next release deploys.
  This tests the update path this release ships.
- `--old <version> --new dist` starts from an earlier release's published web
  build. Builds up to 0.21.2 route API requests through their worker, so the
  hanging request blocks their update; for those the check expects the failure
  notice and then that closing the tabs, as the notice says, opens the new
  version still signed in. Identical builds are reported as not run.

## What the Android server check proves

`scripts/android-server-check.mts` runs on Android 16 emulators of its own,
the pairings split over four jobs (`--part k/4`: every fourth pairing from
the k-th on); together they run each pairing once. For each pairing it starts a
server from scratch: the image on the host network as in the container smoke
test (production settings, Secure cookies), with an empty `_test` database,
its own uploads volume and `ALLOWED_ORIGINS` naming the app's address, as an
installation behind a proxy would. Through the API it creates two synthetic
people, one of them with two-factor sign-in. The earlier server releases are
their published images; the earlier apps are the ones the support window
collected and checked.

The app is installed fresh and reaches the server as `http://127.0.0.1:8098`
through `adb reverse`: the app allows plain HTTP only for development hosts,
and `127.0.0.1` is a secure context, so cookies, service workers and the
microphone behave as over HTTPS. The release-built app cannot be inspected
from outside, so the check reads and taps Android's accessibility tree
(uiautomator), WebView content included, as a person would. Each step is
confirmed on the server, not on the screen alone:

1. **Install and connect:** the "Open in app" link, Android's question, the
   server's sign-in page.
2. **Sign in:** email and password; the server lists a session with the app's
   user agent. The app's own questions about contacts and notifications are
   answered Not now.
3. **Reopen:** the app is left with Home, ended and started again, and is still
   signed in.
4. **Upload:** a synthetic WAV file is picked in Android's document picker on
   the Recordings page; the server holds exactly its bytes.
5. **Microphone:** Record asks for Android's microphone permission, which is
   granted; the recording reaches the server with content.
6. **Download:** that recording's Download saves the server's bytes in
   Downloads.
7. **Files for other apps** (an app and a server from 0.25.0; otherwise shown
   as `·`, not offered): a message with a synthetic PDF and photo is planted
   on the server (CI has no mail provider), as `fresh-install-seed.cts` plants
   mail. In the attachment viewer, **Open with…** on the PDF and **Share** on
   the photo bring Android's sheet over the app, handed `application/pdf` and
   `image/jpeg` (the app logs the type, never the name); **Save to
   Downloads** saves the photo under its name with the server's bytes.
8. **Sign out:** the app shows the sign-in page, and the server no longer
   lists the app's session.
9. **Two-factor sign-in:** password, then a current authentication code; the
   server lists the app's session.

Connecting, signing in and signing out end a pairing when they fail; after
another failed step the app is started again and the next step runs. A
failure that is known is recorded in the script's `KNOWN` list (step, Android
level, app versions, symptom), as broken apps are recorded in the support
window: the step must still fail with exactly that symptom and shows as `k`,
the pairing as `known`, never as passing; a listed step that passes, or fails
otherwise, fails the check until the record is updated.

It prints a table (one row per pairing, one mark per step), adds it to the
run's summary and keeps it, with a screenshot of any failed step, under
`release-evidence/android-server/` (`android-36-part<k>of4.json` per part). Any failed pairing fails the step. With
`--local <url> --apk <apk>` and `UNIHUB_ANDROID_ADMIN=<email>:<password>` it
runs one app against a server that is already running, such as
`tools/e2e/stack.sh` (sign-ups are rate-limited per address, so restart its
API after a few runs).

## Android

The support window and its checks are described in
[Android compatibility](ANDROID_COMPATIBILITY.md). An app in the window that is
known to be broken on some Android versions stays listed with its symptom and
upgrade path; the emulators confirm the recorded failure instead of counting it
as working.

## Evidence for a release

Report, for the exact commit and image:

- the CI run and its result for each step above, the image digest and the
  `unihub-release-evidence` artifact;
- the Android table printed by each emulator job, and the real-server
  tables of the four `android-16-servers` parts;
- anything verified outside CI (a real phone, a real mail provider), named as
  such and kept separate from CI results;
- every check that did not run, as not run.

A source review without findings, or a passing focused test, does not replace
any of these.

## Known gaps

These are not covered yet; do not report them as passing.

- **Android with a real server.** On the Android 16 emulator (WebView 133) a
  file picked in the 0.24.x apps reaches the page empty, from Downloads and
  from the device's storage alike, so their upload step is recorded as a
  known failure there (it works on Android 15 with WebView 124); 0.25.0's app
  copies the picked file first and must upload it. Whether phones with a
  current WebView were affected is checked on a real Android 16 phone. The
  real-server check runs on Android 16
  only: the Android 10 emulator image's WebView (74) cannot run the web app,
  which needs a current WebView, as on any phone that updates it, and the
  Android 17 image does not boot. Android 10 and 17 with a real server rely on
  real phones. Deep links into pages and the theme colours of the system bars
  are checked against a stub page only. The app's contacts and notifications
  are checked against stub servers on the emulators and the real server's
  side by `android-notifications-mysql-integration.test.cts`, not the app and
  the real server together, nor battery-saving behaviour of real phones
  (Doze, manufacturer task killers).
- **Server upgrades.** Starting an earlier release with data, then updating its
  image and checking migrations, reads, writes and a backup, is not automated.
- **Restores across versions.** Only frozen 0.9.23/0.10.3 archives and
  same-version backups are restored by the checks.
- **Real devices and providers.** Manufacturer-specific Android behaviour and
  live mail or calendar providers stay manual ([live mail testing](LIVE_MAIL_TESTING.md)).
