# Backup Documentation Moved

The canonical backup and restore documentation is now:

[Backup and Restore Guide](BACKUP_RESTORE.md)

For automatic backup-version detection, historical readers and format limits,
see [Backup Format and Compatibility](BACKUP_FORMAT.md).

The current development branch writes data schema 2 and reads schemas 1 and 2.
These backup changes are unreleased; released 0.10.2 cannot import schema-2
archives. The ZIP layout and encrypted container remain version 1.

This compatibility file remains so older links to `BACKUP_EXPORT.md` continue
to work.
