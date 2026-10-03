# 0.14.0: Notes removed, modules can be reordered

**This release permanently deletes all Notes.** Export any note you want to keep
before updating (open the note and use **Download Markdown**, or keep a 0.13.x
backup that includes Notes). Database upgrade 11 removes them on first start.

### Removed

- **Notes.** The Notes page, its API, search results, command palette entries and
  backup section are gone. Database upgrade 11 drops the `notes`,
  `note_revisions`, `note_attachments` and `note_links` tables and deletes the
  attachment files under `/app/uploads/notes`. If that folder cannot be deleted
  (for example because it is a separate mount), UniHub logs a warning and starts
  normally; delete the folder by hand.
- A Notes start page falls back to the default start page.
- Older backups that contain Notes still import. Notes are skipped with a
  warning and everything else is restored.

### New

- **Module order.** Settings → Modules has up and down buttons for each module.
  The sidebar, the mobile bar and the More page follow this order. The mobile
  bar shows the first four pages (Calendar and ToDo count as two); the rest are
  on More. The order is saved per user and included in settings backups.

### Changed

- The default mobile bar is now Mail, Calendar, ToDo and Contacts. Recordings
  moved to More. Move Recordings up in Settings → Modules to bring it back.

### After updating

Check the log for `[DB] Could not remove old note attachments` and delete the
named folder if it appears. See [Upgrading](UPGRADING.md#0140-notes-removed).
