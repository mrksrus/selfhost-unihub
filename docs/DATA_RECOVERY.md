# Data recovery contracts

## Adding or changing saved data

`api/src/services/backup-catalog.js` declares recovery sections, explicit archive
columns, key ownership and field treatment. `data-inventory.js` declares remaining
security-only, temporary, rebuilt or deliberately excluded fields with reasons.
Every database column must be accounted for. Do not rely on `SELECT *` or add a
new field without deciding its import, ownership and file behavior.

`api/tests/data-inventory.test.js` compares these declarations with production
DDL. Startup checks the actual MySQL inventory after notification schema setup.
An undeclared column fails instead of being silently omitted. Catalog coverage
proves accounting, not correct behavior: extend representative restore assertions
when changing relationships, files or field meaning.

Sections drive export, import, restore locks and the Data Management choices
through `GET /api/backup/capabilities`. New routes and background writers must also
participate in their section's write protection. Feature visibility is separate
from data ownership: hiding a feature must never remove its data from recovery.
This is an internal catalog, not a dynamically installable plugin system.

The catalog also declares parent references, file kinds, HTTP write paths and
background writers. Startup and tests reject a table missing from its section,
unhandled file fields or remapped IDs without parent declarations. Actual MySQL
foreign keys are compared with the restore parent mapping. HTTP write protection
uses the catalog's paths, including section-specific destructive settings actions.
Background-writer declarations are an audit inventory; developers must still
verify that each worker observes restore locks and respects in-flight operations.

## Database upgrades

`database-migrations.js` serializes upgrades with a database advisory lock and
records completed IDs/names in `schema_migrations`. `database.js` defines step 1,
the verified historical baseline, and step 2, the one-time Sent/Draft read repair.
Completed steps are skipped. Unknown/out-of-order history and required failures
stop startup. MySQL DDL can commit independently; each new step must tolerate
partial completion and verify its result before recording success.

Append a new ID; never change a completed step's meaning. Declare future fields'
`introducedIn` migration IDs so baseline verification does not require a later
step's columns. Keep bootstrap/runtime work distinct from historical repairs.
The authenticated MySQL readiness wait remains 300 seconds maximum and ends as
soon as a connection succeeds.

## Backup versions and restore behavior

New exports write data schema 3. Readers for schemas 1 and 2 remain; the manifest
selects automatically. ZIP layout and encrypted framing remain version 1.
Database upgrade IDs, data schema and application release are separate numbers.
Preserve historical readers and frozen fixtures when evolving the format. Starting
with 1.0, retain imports for every released stable backup format throughout 1.x.
A later major release must retain old readers or provide a maintained conversion
path before retiring one. Do not silently omit unsupported modules from a full restore.

Mail restoration remaps both provider-source and local filing account IDs,
folder ownership, routing overrides and recovery journals. It records translated
completion state in the same transaction, preventing migration replay on the
next provider listing. A kept target message keeps its own journal. Missing
optional historical account references produce a warning and null; live account
and folder references must remain valid. Incompatible folder scopes and final
destinations that would hide new messages fail and roll back.

Provider deletion is disabled on restored mail accounts. Restore must not replay
source-server deletion queues, sessions or notification delivery attempts.
Completed recording transcripts are preserved; pending/failed transcription jobs
are excluded. Server Tetris scores are included; browser-only saves are not.

Strict schema-3 validation rejects unknown sections/tables/fields/file kinds and
missing or corrupt required files before writes. Historical readers retain their
older missing-file warnings because absent bytes cannot be invented. Files are
staged, IDs are owner-checked, and the result is committed with the restore job.
Ambiguous commit outcomes retain staged files until the durable result is known.

Uploaded restore archives have automatic expiry paused. Completed restores and
explicit deletions still clean uploads. Keep important backups and passwords off
this server. User-data recovery does not replace a consistent MySQL/uploads/config
snapshot for whole-server recovery or rollback.

## Focused verification

Run `npm --prefix api run test:recovery` before releasing a data/recovery change.
This gate checks connectivity, MySQL 8 and an empty disposable `_test` database,
forces historical upgrade checks on, runs backup/inventory/migration tests
sequentially, and fails if any check is skipped. It refuses non-empty schemas.
The command does not provision MySQL or start the app. Keep test credentials
restricted to disposable data and stop the temporary server afterward.
GitHub's API-test step uses `test:ci`, which applies the same preflight and
no-skipped-checks gate to the existing full API suite in one pass.

Use an empty disposable MySQL database whose name ends in `_test`. Set
`MYSQL_TEST_HOST`, `MYSQL_TEST_PORT`, `MYSQL_TEST_DATABASE`, `MYSQL_TEST_USER` and
`MYSQL_TEST_PASSWORD`. Use separate databases for parallel test processes.

- `data-inventory.test.js`, `database-migrations.test.js`: missing policies,
  ordered completion, interrupted DDL and invalid history.
- `database-startup-mysql-integration.test.js`, with `MYSQL_TEST_SCHEMA_SMOKE=1`:
  historical populated upgrades, actual inventory and repeated startup.
- `backup-roundtrip-mysql-integration.test.js`: real export/encryption/restore,
  module relationships/files, conflicts and migration replay protection.
- `backup-v2-mysql-integration.test.js`: frozen actual 0.10.3 exporter archive.
  The existing round-trip also imports frozen plain/encrypted 0.9.23 fixtures.
- `backup-restore-cancellation-mysql-integration.test.js` and
  `backup-ownership-mysql-integration.test.js`: interruption and cross-user safety.
- Mail filing/offline tests when identity or destination behavior changes.

Normal CI already discovers these test files. The restored container smoke test
exercises encrypted HTTP creation, download, upload, validation and restoration.
Never regenerate a historical fixture merely to make a changed reader pass.


## Built-in modules and Notes

`module-catalog.js` binds optional modules to their recovery sections and request
paths; `module-settings.js` reads archived per-user preferences. Visibility and
feature/background pause do not narrow full exports. Settings/recovery remain
available. Search and offline snapshots filter disabled modules separately.

Migration 4 adds Notes with all fields classified at introducedIn 4. Notes owns
its editing and restore rules in `notes.js` and `notes-recovery.js`; the common
backup service owns file staging/transaction outcomes. Restore maps note links,
revisions and attachments together, preserves distinct copies and uses origin
lineage only within the destination user. A revision restore changes title/text,
not the current attachment/link set. Removed or replaced attachment bytes remain
until separate safe cleanup; a concurrent archive may still be reading them.

`notes.test.js`, `module-settings.test.js`, `module-search.test.js` and the extended
HTTP/full roundtrip tests cover these contracts. Updating module preference
validation also requires checking archived settings and legacy offline defaults.
