# Release contract

A UniHub release promises four things: existing data survives, supported
clients keep working, an open app updates without losing work, and a failed
update has a recovery path. Each promise below names its required evidence.
A release is published only by `.github/workflows/docker-image.yml`, after
the required automated checks and the manual acceptance checks below pass.
A green workflow is necessary but does not establish checks it cannot run.
A missing required check blocks release; it never counts as passed.

Feature details stay in their own documents; this page lists what must be
shown before publishing and how.

## Required for every release

| Promise | Check (CI step) | Run it locally |
| --- | --- | --- |
| API, database and recovery tests pass with no skipped test | `npm --prefix api run test:ci` (Run API tests) | `npm run test:db` ([development](DEVELOPMENT.md)) |
| Frontend tests, lint and production build | Run frontend checks | `npm test -- --run && npm run lint && npm run build` |
| Pinned interface reference pictures and browser behavior | Verify the pinned interface | `npm --prefix tools/ui-regression run verify` ([setup](UI_BASELINES.md#commands)) |
| The image starts as in production, serves the app and the Android download, isolates users, and survives a stop and an API crash | `scripts/container-smoke.sh` | needs Docker and a disposable `_test` database |
| A full backup moves to a fresh, independent installation | `scripts/recovery-fresh-install.mts --image unihub:ci` | `npm --prefix api run build && node scripts/recovery-fresh-install.mts --local` |
| An open web app updates without losing work, and earlier releases in the support window update to this one | `scripts/pwa-update-check.mts` | `npm run build && node scripts/pwa-update-check.mts --local` |
| The Android apps of the support window behave as recorded on Android 10, 16 and 17 (17 on a real phone while its emulator image is broken, see [Android compatibility](ANDROID_COMPATIBILITY.md)), and updating keeps the saved server | `scripts/android-support-window.mts`, then `android/scripts/window-test.sh` on each emulator | an emulator and `adb` ([Android compatibility](ANDROID_COMPATIBILITY.md)) |
| The candidate app's contacts reach the phone and follow the server, a session end and a server change | `android/scripts/contacts-test.sh` on each emulator | an emulator and `adb` ([Android](ANDROID.md#contacts-on-the-phone)) |
| A published image carries the release-signed Android app | Check and keep the Android app | — |

## Required acceptance beyond the current CI

Until these scenarios are automated, the release owner must record their
results for the exact candidate and artifacts. Missing evidence blocks release.
This is a workflow requirement; the present CI does not enforce these manual
rows. Do not describe a green CI run as full release acceptance.

- **Android/server pairings, every release.** Test the candidate app against
  the candidate server and the three previous server releases, and each
  supported earlier app in the window against the candidate server. Record
  app version/hash, server version/image digest, OS/WebView and outcomes for
  login, two-factor login, session reload, deep links, upload/download bytes,
  file picker, microphone permission/recording, theme chrome and logout.
  An explicitly known-broken historical app uses its documented installation
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
- the Android table printed by each emulator step;
- anything verified outside CI (a real phone, a real mail provider), named as
  such and kept separate from CI results;
- every check that did not run, as not run.

A source review without findings, or a passing focused test, does not replace
any of these.

## Known gaps

These are not covered yet; do not report them as passing.

- **Android with a real server.** The emulator runs load a stub page. Signing
  in, two-factor codes, downloads and uploads, the file picker, the microphone
  and logout in the app are not tested, nor are older apps against the real
  candidate server or the candidate app against older servers. The app does
  not read the handshake's `protocol`, `minApp` or `features` yet.
- **Server upgrades.** Starting an earlier release with data, then updating its
  image and checking migrations, reads, writes and a backup, is not automated.
- **Restores across versions.** Only frozen 0.9.23/0.10.3 archives and
  same-version backups are restored by the checks.
- **Real devices and providers.** Manufacturer-specific Android behaviour and
  live mail or calendar providers stay manual ([live mail testing](LIVE_MAIL_TESTING.md)).
