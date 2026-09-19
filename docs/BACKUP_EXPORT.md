# Backup Documentation Moved


The canonical backup and restore documentation is now:

[Backup and Restore Guide](BACKUP_RESTORE.md)

For automatic backup-version detection, historical readers and format limits,
see [Backup Format and Compatibility](BACKUP_FORMAT.md).

UniHub 0.10.6 writes data schema 3 and reads schemas 1, 2 and 3.
Older releases cannot import schema-3 archives. The ZIP layout and encrypted container remain version 1.

This compatibility file remains so older links to `BACKUP_EXPORT.md` continue
to work.
