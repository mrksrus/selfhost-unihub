# Modules and Notes

Settings has separate controls for each built-in module:

- **Navigation:** show or hide its shortcuts. A hidden module can still be opened directly.
- **Features:** allow or pause its pages and API operations. Pausing keeps its data.
- **Background work:** allow or pause automatic mail sync/deletion and calendar reminders. Manual actions remain available when the module itself is enabled.

Calendar and ToDo share one module because they are two views of the same planning
data. Contacts, recordings, games and Notes have no automatic provider worker to
pause. Temporary-upload housekeeping continues to remove expired incomplete uploads.

Core account settings and Data Management remain available. Full backups include
all saved modules, including hidden or paused ones. Restoring settings also restores
module choices. Search, dashboard counts and new offline snapshots omit paused
modules. Module controls are personal preferences, not a replacement for user
ownership or access permissions.

Already-issued network operations may finish after a pause. Active mail scans are
asked to stop; remote deletion checks settings again immediately before sending a
command. Notifications waiting to be delivered retain their attempts while paused,
but expired notifications are not replayed on resume.

Turning off a module clears the current browser's offline snapshot. Refresh or
clear snapshots on other devices too; a server setting cannot erase an offline
copy remotely. New snapshots include the module choices used to create them.
Older snapshots retain their original offline behavior until refreshed.

## Notes

Notes supports plain text/Markdown source, explicit saving, linked notes, file
attachments, Trash and text revision history. It is online-only in this version.

Each successful change advances a revision. If another device has changed the
note, saving returns a conflict instead of overwriting that newer copy. Reload the
latest version and preserve your draft before deciding how to combine the edits.
Unsaved drafts stay in the current browser session during navigation; they are not
server backups and do not survive closing or reloading the app.

Moving a note to Trash keeps its text, revisions, links and attachments. Restore it
before editing. Restoring an earlier revision restores its title and text, creates
a new revision, and leaves its current attachments and links in place. There is no
permanent note deletion action in this initial version.

Note text is limited to 512 KiB, and each attachment to 2 MiB. Attachments are
served as downloads rather than active HTML. Removing an attachment removes it
from the note; its stored bytes are retained to avoid breaking an export already
reading them. Whole-account deletion removes that user's note files.

**Download Markdown** produces readable text with application links to related
notes and attachments. Download needed attachments separately. For a complete
recoverable copy, use Data Management: schema-3 backups preserve text revisions,
Trash, attachments and links, with IDs translated when restoring to another user.

## Implementation contract

The built-in module catalog defines page/API membership and worker capabilities.
The recovery catalog declares durable data and remains independent of visibility.
Settings are archived under `user_settings.module_preferences`.

Migration 4 creates `notes`, `note_revisions`, `note_attachments` and `note_links`.
`notes.js` owns editing and file access; `notes-recovery.js` owns validation and
restore semantics. Backup services still own consistent reads, packaging, staged
files and durable commit handling. Original archive IDs never grant access to a
destination user's note. A preserved origin key identifies repeated imports while
user ownership is checked independently.
