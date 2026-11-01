# Data recovery contracts

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

## Adding or changing saved data

`api/src/services/backup-catalog.ts` declares recovery sections, explicit archive
columns, key ownership and field treatment. `data-inventory.ts` declares remaining
security-only, temporary, rebuilt or deliberately excluded fields with reasons.
Every database column must be accounted for. Do not rely on `SELECT *` or add a
new field without deciding its import, ownership and file behavior.

`api/tests/data-inventory.test.cts` compares these declarations with production
DDL. Startup checks the actual MariaDB inventory after the upgrades have run.
An undeclared column fails instead of being silently omitted. Catalog coverage
proves accounting, not correct behavior: extend representative restore assertions
when changing relationships, files or field meaning.

Sections drive export, import, restore locks and the Backup and restore choices
through `GET /api/backup/capabilities`. New routes and background writers must also
participate in their section's write protection. Feature visibility is separate
from data ownership: hiding a feature must never remove its data from recovery.
This is an internal catalog, not a dynamically installable plugin system.

The catalog also declares parent references, file kinds, HTTP write paths and
background writers. Startup and tests reject a table missing from its section,
unhandled file fields or remapped IDs without parent declarations. Actual MariaDB
foreign keys are compared with the restore parent mapping. HTTP write protection
uses the catalog's paths, including section-specific destructive settings actions.
Background-writer declarations are an audit inventory; developers must still
verify that each worker observes restore locks and respects in-flight operations.

## Database upgrades

`database-migrations.ts` serializes upgrades with a database advisory lock and
records completed IDs/names in `schema_migrations`. `database.ts` lists the
steps. Every installation since 0.16.0 started with an empty MariaDB database,
so steps 1 to 11 never upgrade existing data: `database-baseline.ts` creates
their result in one step and records the same eleven IDs/names, the history of
every database created earlier. Never change the baseline. Completed steps are
skipped. Unknown/out-of-order history and required failures
stop startup. MariaDB DDL can commit independently; each new step must tolerate
partial completion and verify its result before recording success.

Append a new ID; never change a completed step's meaning. Declare future fields'
`introducedIn` migration IDs so baseline verification does not require a later
step's columns. Keep bootstrap/runtime work distinct from historical repairs.
The authenticated MariaDB readiness wait remains 300 seconds maximum and ends as
soon as a connection succeeds.

## Instance backup

The instance backup (0.28.0) copies the whole installation: the database and
every stored file, encrypted, to a destination the administrator mounts. It is
the disaster-recovery copy; the account backups below move one person's data.
`api/src/services/instance-backup.ts` runs it, `instance-backup-format.ts`
defines the file, `instance-restore.ts` restores it.

**Configuration, from the environment only** (`api/src/config.ts`). The admin
page (Settings > Server settings > Instance backup) shows it and can start a
run; it cannot change it, and no backup file is ever offered for download, so
a stolen admin session can neither redirect the backups nor read them.

| Variable | Meaning |
| --- | --- |
| `INSTANCE_BACKUP_DIR` | An absolute directory inside the container on a volume or mount of its own (another disk, a NAS share). Unset: the backup is off. Inside `/app/uploads` or a stored-file root: startup refuses it. It must exist and be writable by uid 10001; UniHub never creates it, so a missing mount fails the run instead of filling the container. Nothing else writes there: it is UniHub's alone. |
| `INSTANCE_BACKUP_KEY` or `INSTANCE_BACKUP_KEY_FILE` | At least 32 random bytes as hex or base64 (`openssl rand -base64 48`). Unset: the backup is off. Shorter, or the value of `JWT_SECRET`, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS` or `BACKUP_MASTER_KEY`: startup refuses it. Never derived from another key. |
| `INSTANCE_BACKUP_TIME` | The daily run, `HH:MM` in UTC; default `03:30`. |
| `INSTANCE_BACKUP_KEEP` | How many succeeded backups stay, 1 to 1000; default 14. |

Without a destination and a key the server runs normally and the admin page
says what is missing. The defaults are `INSTANCE_BACKUP_DEFAULT_TIME_UTC` and
`INSTANCE_BACKUP_DEFAULT_KEEP` in `config.ts`.

**A run.** The worker owner runs one at a time: daily, once the set time has
passed without a scheduled run (so a server that was down at that time catches
up when it starts), and on "Back up now" (`POST /api/admin/instance-backup/run`,
permission `server.settings`, activity-log entry `admin.instance_backup_started`).
Each run is a row of `instance_backups`.

1. It checks the destination and its free space (about the last backup's size,
   or the database's before the first, plus 64 MiB), and again the start's
   checks of the secret files (see what is in the file).
2. It closes the file removal gate (`file-removal-gate.ts`), then streams
   `mariadb-dump --single-transaction --routines --triggers --hex-blob` (one
   consistent snapshot) and then the stored files into
   `unihub-instance-<UTC time>-<version>-<run id>.uhib.partial`, encrypted as
   it is written. Nothing is staged in `/tmp` or elsewhere.
3. It opens the gate again, writes the manifest and seals the file.
4. It reads the whole file back with the key and checks every hash, and
   checks that no configured secret file changed during the run. Only then
   is it published as `.uhib`, with a link that never replaces a file already
   there (a run that finds one fails and leaves it alone). On a destination
   without hard links (the link fails with `EOPNOTSUPP`, `EPERM` or `ENOSYS`,
   as on some NAS shares, FUSE mounts and FAT) it checks that the name is
   free and then renames the file to it. The name holds the run id, so no
   other run uses it; the check and the rename are two steps, so this relies
   on the destination being UniHub's alone (anything else that writes there
   could create the name in between, and could change the backups anyway).
5. In one transaction it records the run as succeeded with the next
   completion number (`completion_seq`) and marks the oldest succeeded
   backups beyond `INSTANCE_BACKUP_KEEP` removed (`removed_at`), then removes
   their files. Newest means the higher completion number, never a time, so
   a clock set back does not make retention remove the latest backup. The run
   counts as running until those files are gone.

A failed run (no space, a missing mount, a dump error, a stop) removes its
partial file and records the reason; it never counts, and nothing is removed
for it. A run that a stopped process left running is recorded as failed, and
its partial file removed, when the next worker owner starts. A run is stopped
after 12 hours. A failed scheduled run is not tried again until the next
day's time; "Back up now" runs one at once.

**Consistency.** The dump is one snapshot; the files are copied after it. A
file whose row is deleted after the dump is still needed by the backup, so
file removals pass through the gate: while it is closed, removals by user
deletion, removing a mail account with its mail, Sync-mode pruning and folder
deletion, contact photos, mail attachments and the raw file a re-import
replaces are queued and run, in order, when the copy ends, and the contact
sweeps skip their turn. A removal never waits at the gate (its caller may hold
a lock a queued removal needs): until the queue has drained, a new one joins
it. The queue lives in the server's memory. If the server stops while a
backup runs, the removals queued so far never run, and their files stay on
the disk as orphans, never a row without its file: the files of a deleted
person or a removed mail account, mail files Sync-mode pruning or a folder
deletion gave up, deleted attachments, the raw file a re-import replaced and
released contact photos. The contact-photo sweep removes those photos later;
the others stay in their storage roots, with no row referring to them, and
are copied by later backups. Files added during the copy may be in the backup without a row;
they are harmless. A file that changes while it is read (stored files are
written once, so this is rare) is marked in the index and left out by a
restore. For a very large installation a volume snapshot stays the faster
copy.

**What is in the file.** Every table, including users, policies, the
activity log, the push identity and the runs of `instance_backups`, and the
stored files: mail attachments and originals, recordings, contact photos and
the account backups kept on the server, under any name a person gave them
(an attachment called `report.tmp` is data). Not in it: the app's own work in
progress, by the exact names its writers use (a raw message being written,
a recording being converted or uploaded in chunks, a contact photo being
written, an unfinished export, backup uploads being received and uploaded
restore archives), and **no key**. A configured secret file (`NAME_FILE`)
inside `/app/uploads` or a stored-file root stops the start, also through a
symbolic link or an aliased path. Compose `.env` files are left out. Beyond
that the server remembers, by size and SHA-256 and never the bytes, every
version of each secret file it has read: at its start, and at the start
and end of each run, also of a run that fails (a file larger than 64 KiB is
no secret and is not read past that), until it stops. A stored file with the same bytes (a hard
link, a copy, a second mount of a secret, also of a version rotated away
since) is left out, and the log names the setting. A run that cannot read a
configured secret file at its start (it was removed) does not run and says
which. A run during which a secret file changed (another file or other bytes
at the end than at the start) does not count and says which; the next run
knows the new version and leaves it out.

This is a second line of defence for the versions UniHub has seen, not a
guarantee. A version that comes and goes within one run is never seen: a
secret rotated to a new version and back again while a backup runs, with a
hard link of the new version among the stored files, can end up in that
backup. Whoever can arrange that can read the secret anyway. The setup that
keeps secrets out:

- keep every `*_FILE` secret outside `/app/uploads` and outside the backup
  destination; startup refuses the first;
- Docker and Compose secrets and secrets given as environment variables are
  fine as they are;
- on Kubernetes, give UniHub's own secrets a projected volume of their own.
  A projection shared with something that changes on its own (a rotating
  service-account token, a certificate) replaces every file in it when that
  changes, so a long backup sees its secret files change and fails again and
  again.
`ENCRYPTION_KEY`,
`ENCRYPTION_KEY_PREVIOUS`, `BACKUP_MASTER_KEY`, `JWT_SECRET` and the instance
key stay outside, so no single key opens everything (F10). Keep them in a
password manager: without `ENCRYPTION_KEY` a restored installation cannot read
stored mail and calendar passwords or two-step sign-in, without
`BACKUP_MASTER_KEY` (or `ENCRYPTION_KEY` when it is unset) not the account
backups' server unlock.

**The file** (`instance-backup-format.ts`): the magic `UNIHUBIB1`, a JSON
header (backup id, time, app version, upgrade step, key fingerprint, salt),
then AES-256-GCM frames of 1 MiB under a key derived with HKDF-SHA256 from the
instance key and the header's random salt. Each frame's nonce and additional
data carry its index, the header's hash and whether it is the last, so a
changed byte, reordered frames, a cut-off file or bytes after the end are
refused. The key fingerprint is the key version: a file names the key that
opens it. The plaintext is a POSIX tar: `db/NNNNNN.sql` (the dump in 8 MiB
parts), `files/<root>/<path>` with `index/NNNNNN.ndjson` parts (size and
SHA-256 of each file), and `manifest.json` (versions, table row counts at the
dump's start, file counts and the hashes of the dump and the index).

**Restore** is a command in the image, never the web. Into an empty
installation: the same image version or a newer one, its own new database
volume and uploads volume, the old installation's `ENCRYPTION_KEY` and
`BACKUP_MASTER_KEY`, and the destination mounted to read the file.

```bash
docker compose up -d unihub-db          # the database only, not the app
docker compose run --rm --no-deps unihub \
  node /app/api/src/instance-restore.js \
  --file /backup/unihub-instance-20261101T033000Z-0.28.0-019a3d6e-1f40-7000-8000-000000000000.uhib \
  --key-file /run/secrets/unihub_instance_backup_key
docker compose up -d                    # the app migrates an older backup on start
```

The command checks the whole file with the key first and writes nothing on
a mismatch. It refuses a database with tables and storage with files. It loads
the dump with the `mariadb` client and writes the files (owned by the API
user), then changes what belonged to the old installation's running life, as
listed in [After an instance restore](#after-an-instance-restore). A failure
during the load drops the tables and removes the files it wrote, leaving the
installation empty for another try. `--verify-only` only checks a backup with
the key. From a checkout, `node api/scripts/instance-restore.cts` runs the
same code after `npm --prefix api run build`, with `MYSQL_*` and the storage
roots pointing at the empty installation.

### After an instance restore

The restore changes these rows in the same transaction, after the load
(`services/instance-restore.ts`). Everything else comes back as the dump had
it: users, their data, policies, the activity log and the push identity, so
phones keep receiving notifications.

The old installation's sessions and credentials of the moment:

- **Sessions** are deleted: everyone signs in again.
- **Download tickets** and **two-step sign-in challenges** are deleted.
- **Mail worker leases** (`mail_engine_accounts`, `mail_engine_jobs`) are
  cleared.
- **Account restores** that had not finished fail: their archives are not in
  an instance backup.
- **Instance backup runs**: the run that wrote this backup shows as
  succeeded with this file; any other run still marked running shows as
  failed.

Provider work the old installation had accepted is never replayed: it may
have been done, changed or cancelled after the backup. The restore applies
the account restore's policy (`pauseMailRestore` in
`services/backup-mail-engine.ts`) to every person with a mail account, and
retires the queues an account restore never brings back:

- **Mail accounts are paused.** Each is inactive (`is_active` off), deletion
  at the provider is off (`delete_emails_on_server` off, its enable time and
  grace period cleared), and the confirmation of its mail policy
  (`sync_policy_confirmed_at`) is cleared. Its owner reconnects it and
  confirms the policy again before UniHub talks to the provider.
- **Mail engine work is paused.** The account's engine generation moves on
  with a pause reason; queued, running and failed engine jobs are paused and
  cancelled.
- **Accepted mail operations need attention.** Moves and read or star
  changes not yet done are taken off the queue (`needs_attention`, not current) with
  evidence that the provider must be checked. Only a read-only check of the
  provider follows; nothing is sent again by itself.
- **Pending calendar moves are cleared.** The journal of moves between
  calendars (`calendar_event_moves`) is deleted. A copy a move left at a
  server shows with the next sync as an event of its own; nothing is deleted
  at a server.
- **Scheduled sends are cancelled.** A scheduled send is removed, so its
  draft comes back unscheduled; a send that had started is marked `unknown`
  and is never sent again.
- **Queued deletions at the provider are dropped**
  (`mail_server_messages` still pending). Once deletion is on again, the next
  pass queues afresh.

**The drill.** Restore a recent backup on a spare machine or a second Compose
project now and then, and sign in. The release gate runs the same restore:
`api/tests/instance-backup-mysql-integration.test.cts` restores into an
emptied test database and empty storage and compares every table and file.

## Backup versions and restore behavior

New exports write data schema 6. Readers for schemas 1 to 5 remain; the manifest
selects automatically. ZIP layout and encrypted framing remain version 1.
Database upgrade IDs, data schema and application release are separate numbers.
Preserve historical readers and frozen fixtures when evolving the format. Starting
with 1.0, retain imports for every released stable backup format throughout 1.x.
A later major release must retain old readers or provide a maintained conversion
path before retiring one. Do not silently omit unsupported modules from a full restore.

0.27.0 writes data schema 6: the calendar section adds `task_order`, the hand
order of tasks, an overlay keyed by the item's identity (event id for a task
UniHub holds; calendar, UID and recurrence id for a synced one), and the
settings section the calendar references `default_task_list_id` and
`default_calendar_id`, remapped with the calendar id map (never the mail
account map). The move journal `calendar_event_moves` is installation state
and never archived. Older archives restore without an order.

A calendar restore settles the destination's unfinished moves of tasks in
its own transaction, which holds the person's moves from its start (none
commits or starts meanwhile). A move whose task the restore writes over
(Replace) while its new copy is still being created ends as a cancel does:
the task is as archived, nothing is deleted at any server, and a copy a
server took after all shows once with the next sync, as that calendar's own
item. Keep existing and Keep both leave the task, and its move goes on. A move
only removing an old copy had already moved the task: the restore matches it
where it now is, so the removal goes on, and a row an older archive brings
back in the old calendar goes with the removed copy. A move whose calendar
(old or new) the restore points elsewhere ends without deleting anything,
whatever its state: the restore compares where and as whom each move writes,
before and after it writes accounts and calendars, derived as the move's
requests derive it: the new copy's address and the old copy's address, each
resolved against its account's server (so an absolute collection address does
not hide a changed server), the collection the new copy is to be in, the kind
of account, the login name as the requests choose it (a linked mail
account's login, else the username, else the account's address; never the
password), what would make the requests choose another login (the link to a
mail account, the marks that make an account look for its mail account by
address, and that address), and where the password may be sent (the
credential scope). An account restored to another server, login or mail link
counts too.
A change holding a task when a calendar restore begins
writes nothing more (`409 RESTORE_IN_PROGRESS`).

A synced task's order is removed only on evidence that the provider deleted
it: a verified deletion of its server object. An object or occurrence that
leaves the sync window (the expansion is bounded) keeps its order and gets
its place back when it returns. Nothing expires by date: an occurrence's
recurrence id is its original date, not where it shows now. The rank of a
hand-placed occurrence that has passed, or that its series no longer has (an
EXDATE, a shorter rule, a new series time), stays until its object is
deleted at the server or its calendar or account is removed; only
hand-placed occurrences have such a row.

0.26.0 writes data schema 5 for the contacts model; the readers for schemas 1
to 4 convert older contacts as upgrade step 22 does (see
[Backup format](BACKUP_FORMAT.md)). Validation holds each archive to the
fields of its own schema (`ARCHIVE_FIRST_STEPS` in `backup-format.ts` names
the first upgrade step each schema carries), so a field an archive of that
version never wrote is refused rather than imported. Content-addressed files
(`CONTENT_FILE_POLICIES` in the catalog, today the contact photos) are written
under their SHA-256 name before the restore's transaction and verified on the
way; the photo rows may only name a file that was written. Their writes, the
commit and the release of files nothing references any more run under the
per-user photo lock; a known rollback releases the files the restore added, a
lost commit outcome keeps them all, and the daily sweep skips users with a
running contacts restore. Child rows of contacts are restored only with their
contact from the same archive and get the restored contact's id.

Mail restoration remaps both provider-source and local filing account IDs,
folder ownership, routing overrides and recovery journals. It records translated
completion state in the same transaction, preventing migration replay on the
next provider listing. A kept target message keeps its own journal. Missing
optional historical account references produce a warning and null; live account
and folder references must remain valid. Incompatible folder scopes and final
destinations that would hide new messages fail and roll back.

Migration 5 adds `mail_writebacks`, an explicitly excluded durable command queue.
Applying a mail restore clears destination commands transactionally; mail workers
including outbound commands are paused before restore.

Provider deletion is disabled on restored mail accounts. Restore must not replay
source-server deletion queues, sessions or notification delivery attempts.
Completed recording transcripts are preserved; pending/failed transcription jobs
are excluded. Tetris scores from the removed Games module are neither exported
nor restored.

Strict schema-3 validation rejects unknown sections/tables/fields/file kinds and
missing or corrupt required files before writes. Historical readers retain their
older missing-file warnings because absent bytes cannot be invented. Files are
staged, IDs are owner-checked, and the result is committed with the restore job.
Ambiguous commit outcomes retain staged files until the durable result is known.

Uploaded restore archives have automatic expiry paused. Completed restores and
explicit deletions still clean uploads. Keep important backups and passwords off
this server. User-data recovery does not replace a consistent MariaDB/uploads/config
snapshot for whole-server recovery or rollback.

## Focused verification

Every release also runs the [fresh-install recovery gate](RELEASE_CONTRACT.md#what-the-recovery-check-proves):
`node scripts/recovery-fresh-install.mts --image unihub:ci` in CI, or
`npm --prefix api run build && node scripts/recovery-fresh-install.mts --local`
locally. It exports all supported sections, destroys the source installation,
imports into a separate database/storage/key set, restarts, compares restored
files and ownership, and reconnects credentials to controlled provider peers.
The integration tests below remain required; they do not substitute for that gate.

Run `npm --prefix api run test:recovery` before releasing a data/recovery change.
This gate checks connectivity, MariaDB and an empty disposable `_test` database,
forces historical upgrade checks on, runs backup/inventory/migration tests
sequentially, and fails if any check is skipped. It refuses non-empty schemas.
The command does not provision MariaDB or start the app. Keep test credentials
restricted to disposable data and stop the temporary server afterward.
GitHub's API-test step uses `test:ci`, which applies the same preflight and
no-skipped-checks gate to the existing full API suite in one pass.

Use an empty disposable MariaDB database whose name ends in `_test`. Set
`MYSQL_TEST_HOST`, `MYSQL_TEST_PORT`, `MYSQL_TEST_DATABASE`, `MYSQL_TEST_USER` and
`MYSQL_TEST_PASSWORD`. Use separate databases for parallel test processes.

- `data-inventory.test.cts`, `database-migrations.test.cts`: missing policies,
  ordered completion, interrupted DDL and invalid history.
- `database-startup-mysql-integration.test.cts`, with `MYSQL_TEST_SCHEMA_SMOKE=1`:
  fresh-install inventory and repeated startup.
- `backup-roundtrip-mysql-integration.test.cts`: real export/encryption/restore,
  module relationships/files, conflicts and migration replay protection.
- `backup-v2-mysql-integration.test.cts`: frozen actual 0.10.3 exporter archive.
- `backup-contacts-mysql-integration.test.cts`: frozen actual 0.25.1 contacts
  archive, the schema 5 contacts section with photo files between two people,
  restoring twice, Replace matching, Keep both, damaged photo files, an
  interrupted restore and a lost commit outcome.
  The existing round-trip also imports frozen plain/encrypted 0.9.23 fixtures.
- `backup-restore-cancellation-mysql-integration.test.cts` and
  `backup-ownership-mysql-integration.test.cts`: interruption and cross-user safety.
- Mail filing/offline tests when identity or destination behavior changes.

Normal CI already discovers these test files. The restored container smoke test
exercises encrypted HTTP creation, download, upload, validation and restoration.
Never regenerate a historical fixture merely to make a changed reader pass.


## Built-in modules

`module-catalog.ts` binds optional modules to their recovery sections and request
paths; `module-settings.ts` reads archived per-user preferences and module order.
Visibility and feature/background pause do not narrow full exports.
Settings/recovery remain available. Search and offline snapshots filter disabled
modules separately.

## Removing a module

Removing a module must not break older archives or databases. Notes (0.14.0) is
the reference:

- A new migration drops the tables and files. Earlier migrations stay frozen.
  (Notes was created in step 4 and removed in step 11; since 0.19.0 both are
  part of the 0.16.0 baseline, which never creates the Notes tables.)
- The data inventory keeps the removed tables with `removedIn` set to that
  migration and marks them `deliberately_excluded`.
- `RETIRED_MODULE_IDS`, `RETIRED_SECTIONS` and `RETIRED_FILE_KINDS` make the
  readers skip the removed data with a warning and import everything else.
- Saved preferences, saved module order and the start page ignore the removed ID.

`module-settings.test.cts`, `module-search.test.cts`, `backup-schema3.test.cts`
(older archives that contain Notes) and the HTTP/full roundtrip and startup MariaDB
tests cover these contracts. Updating module preference validation also requires
checking archived settings and legacy offline defaults.
