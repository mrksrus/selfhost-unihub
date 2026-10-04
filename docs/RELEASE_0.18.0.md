# 0.18.0: Selective backups

Backups can now include any mix of sections, and a new **Account settings**
backup sets up mail and calendar accounts again without importing their content.
No database upgrade. See [Account Settings Backup](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/BACKUP_RESTORE.md#account-settings-backup).

### Added

- **Choose what to back up.** In **Settings > Data Management > Create a
  backup**, the section buttons (Settings, Contacts, Calendar/ToDo, Mail,
  Recordings) are now selectors. Pick one or more and press **Backup** to create
  one backup with all of them. **Create full backup** works as before.
- **Account settings backup.** The new **Account settings** selector backs up
  only your mail and calendar account connections: servers, logins, Sync or
  Archive mode, and the sync and trash windows. Restoring it signs in to each
  account as if you had just added it, then downloads mail and calendars from
  the provider according to those settings. No emails, events or files are in
  the backup. Accounts that are already connected are left unchanged. Local
  calendars are calendar content and are not included.

### Changed

- **Clearer backup names.** Saved backups and restore reviews show section
  names, such as "Settings, Account settings backup", instead of internal IDs.

### Fixed

- **Saved backup buttons on phones.** Download, Review for restore and Delete
  no longer overflow the backup card on narrow screens.
