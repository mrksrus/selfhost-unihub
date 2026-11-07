# Backup Documentation Moved

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**


The canonical backup and restore documentation is now:

[Backup and Restore Guide](BACKUP_RESTORE.md)

For automatic backup-version detection, historical readers and format limits,
see [Backup Format and Compatibility](BACKUP_FORMAT.md).

UniHub 0.10.6 writes data schema 3 and reads schemas 1, 2 and 3.
Older releases cannot import schema-3 archives. Since 0.28 the ZIP layout is
format 2 inside an AES-encrypted ZIP; see [Backup Format](BACKUP_FORMAT.md).

This compatibility file remains so older links to `BACKUP_EXPORT.md` continue
to work.
