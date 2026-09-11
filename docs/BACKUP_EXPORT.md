# Backup Documentation Moved

> **0.10.4 availability:** Backup creation, upload/import, validation and restore
> are temporarily disabled in the UI and API. Existing completed archives and
> recovery-password downloads remain available. Pending jobs do not resume on
> startup; their files are retained, and automatic restore-upload expiry is paused.
> The format and workflow below document 0.10.3 and retained implementation,
> not an enabled feature in 0.10.4. Use infrastructure backups of MySQL, uploads
> and configuration in the meantime. Contact vCard import/export is unaffected.

The canonical backup and restore documentation is now:

[Backup and Restore Guide](BACKUP_RESTORE.md)

For automatic backup-version detection, historical readers and format limits,
see [Backup Format and Compatibility](BACKUP_FORMAT.md).

UniHub 0.10.3 writes data schema 2 and reads schemas 1 and 2.
UniHub 0.10.2 cannot import schema-2 archives. The ZIP layout and encrypted container remain version 1.

This compatibility file remains so older links to `BACKUP_EXPORT.md` continue
to work.
