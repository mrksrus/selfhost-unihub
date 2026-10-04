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

- **Turning Mail back on resumes a Sync you asked for.** A Sync that was
  waiting while Mail was turned off now continues when Mail is turned on, also
  with background sync off. Background sync work still waits for the next Sync.
- **Clearer backup names.** Saved backups and restore reviews show section
  names, such as "Settings, Account settings backup", instead of internal IDs.

### Fixed

- **A new calendar account's first sync is not lost.** If UniHub restarted
  right after a calendar account was connected or restored, or Calendar was
  off, its first sync waited for background sync. It now runs once Calendar is
  on, also with background sync off.
- **Several calendar subscriptions in one restore.** Restoring a backup with
  more than one calendar subscription (ICS feed) without an email address kept
  only the first; with **Replace matching** the others overwrote it.
  Subscriptions are now matched by their feed address.
- **Saved backup buttons on phones.** Download, Review for restore and Delete
  no longer overflow the backup card on narrow screens.
