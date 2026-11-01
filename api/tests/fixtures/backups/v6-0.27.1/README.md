# Frozen schema 6 full archive (encrypted)

`full.unihub-backup` was created by the unmodified production export job of
`v0.27.1` (commit `ba80ca202adb250cb3ea4e50c6f0a44b17a798ac`), the last release
writing data schema 6, from a disposable MariaDB 11.8 test database with
invented data, every section, encrypted as 0.27.1 encrypts by default:

- a contact
- local lists with tasks, one done with a subtask
- a CalDAV account with a done task (two subtasks, a source email), an open
  task and an event with an attendee; their server copies are not archived
- a Sync-mode account with one message linked to its server copy (raw file,
  attachment, provider evidence) and one sent copy without a server copy
- a Download-mode account that deletes mail at the provider, with one message
- a recording

Only reserved example domains are used; the keys and passwords are fixture
values. `expected.json` records the archive hash, its recovery password (a
synthetic value, needed to open the archive), hashes of the exporter's source
files and the row counts.

`backup-v6-0.27.1-mysql-integration.test.cts` imports it through the current
reader and class filter. Do not regenerate it to make a reader change pass.

`generate.cts` is the maintenance tool. It needs an untouched
`git archive v0.27.1 api package.json` extraction built with its own
`node scripts/build.cts` (dependencies from a current `api/node_modules` work),
an empty `MYSQL_TEST_DATABASE` ending in `_test` and the `MYSQL_TEST_*`
connection variables; pass the extraction directory as its first argument.
Remove that database afterwards.
