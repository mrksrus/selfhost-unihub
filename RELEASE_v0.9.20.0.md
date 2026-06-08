# UniHub v0.9.20.0

This release replaces the previous foreground backup import flow with a durable,
encrypted backup and restore system designed for large mail archives and
long-running restores.

## Highlights

### Encrypted, Portable Backups

- Backup encryption is enabled by default.
- Encrypted backups use the `.unihub-backup` extension.
- Each encrypted backup receives a unique recovery password.
- Recovery passwords can be revealed only once. Save the password before
  downloading the backup.
- Encrypted backups can restore mail and calendar credentials on another UniHub
  installation, even when the destination uses a different `ENCRYPTION_KEY`.
- Unencrypted `.zip` backups remain available and existing restorable UniHub ZIP
  backups are still supported.

### Background Backup and Restore Jobs

- Backup creation, validation, and restore now continue without an open browser
  connection.
- Closing the page or hitting a reverse-proxy timeout no longer stops a running
  restore.
- Interrupted jobs are recovered after an application restart.
- Data Management now shows job status, phase, progress, start/end times, file
  size, warnings, errors, and restored counts.
- Running backup and restore jobs can be stopped before their final commit.
- Failed retained uploads can be retried without uploading the archive again.

### Server-Retained Restore Points

- Completed backups remain available on the server until manually deleted.
- A retained backup can be validated and restored directly without downloading
  and uploading it again.
- Uploaded backup archives expire after seven days.
- Successfully restored uploaded archives are removed, while restore history is
  retained until manually deleted.
- Server-retained backups are a convenience feature, not a replacement for
  off-server backups.

### Safer Restore Behavior

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

## Backup Contents

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

## Fixes

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

## Upgrade Notes

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

## Compatibility and Limits

- Existing restorable UniHub `.zip` backups remain accepted.
- Encrypted `.unihub-backup` files are portable using their recovery password.
- The upload request limit is 3900 MiB.
- The inner archive currently uses ZIP32. ZIP64 is not yet supported, so very
  large backups may still exceed archive size, offset, or entry-count limits.
- Only one restore is processed globally at a time.

## Documentation

See the [Backup and Restore Guide](docs/BACKUP_RESTORE.md) for backup contents,
encryption details, recovery-password handling, restore merge rules, retention,
API endpoints, and troubleshooting.
