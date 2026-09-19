# 0.10.6: durable recovery, mail sync and privacy

## Updating an existing installation

Direct updates from 0.10.3, 0.10.4 and 0.10.5 use the existing additive folder
migration plus a new upgrade ledger. The source mail accounts, provider UIDs,
messages and files are preserved. Completed database repairs no longer repeat
on every restart. Required upgrade failures stop startup with the failed step
rather than continuing with an incomplete schema. The MySQL wait still allows
five minutes and continues on the first successful authenticated connection.

Retain a consistent database/uploads/configuration snapshot before updating.
Changing back to an older image is not a database rollback. New schema-3 backups
cannot be read by releases that only understand schemas 1 or 2.

## Mail and navigation

Recovered mail uses the same local filing account in list, detail, sender rules,
unread counts and new offline snapshots. Original provider identity is retained.
Rules no longer file recovered messages into another account's hidden folder,
and concurrent manual filing is protected. Refresh an existing offline snapshot
to obtain the new identity metadata; missing historical snapshot fields cannot
be reconstructed offline.

Folder navigation is searchable, custom folders can collapse, and selected
account context remains visible. Virtual views cannot supply a sending/sync
account. Collapsed navigation has accessible labels, the shell uses dynamic
viewport height, and navigation respects the user's reduced-motion setting.

## Account modes and email privacy

Accounts now offer Download or Sync from email server. Existing installations stay
in Download and keep their deletion preference. Switching to Sync requires
confirmation, follows provider read/star/folder changes, and disables automatic
server deletion. Missing server messages remain as labeled local copies. Switching
back leaves deletion off until explicitly enabled again. Local UniHub changes do
not write back to the provider in this release. See [mail modes](MAIL_MODES.md)
for matching, label support, cancellation and account-identity limits.

Remote images remain blocked even in original appearance. A default-on filter can
block suspected tracking pixels after other images are allowed. Re-blocking and
navigation reset are supported. Resource loading through CSS, SVG, srcset and
embedded content is removed. This can simplify sender formatting. Detection is
imperfect; explicitly loaded images still expose the requesting IP and open time.
Stored originals are unchanged. No proxy or automatic prefetching is introduced.

## Backups and imports

Creation and restore are enabled again. Schema 3 preserves account-scoped folder
metadata, filing/Legacy state, rule overrides, translated recovery journals and
completion markers, completed transcripts and server-side Tetris scores. The UI
gets its section list from the server's shared recovery catalog. Section exports
read selected data instead of loading all mail for a contacts-only backup.

Schema-1 and schema-2 archives select their readers automatically. Older archives
cannot provide fields or bytes they never contained; warnings explain defaults.
Unknown data and incomplete schema-3 files are rejected. Conflicting folder
ownership or a merge that would make restored mail invisible fails and rolls
back. Optional deleted historical account references are reported and cleared;
live references remain required. This can reject an unsafe merge that previously
appeared successful. Use a clean destination account when scopes conflict.

Browser-only game progress, other users, sessions and deployment configuration
are not included. Uploaded archives remain retained while automatic expiry is
paused; successful restores and explicit deletion still remove their upload.
Generated backups remain until deleted. No installation Dockerfile or Compose
changes are required.

Recovery hardening also preserves separate calendar events with matching titles
and times, and separate contacts sharing an email address. Repeated imports
prefer matching content and keep distinct destination rows. Events with distinct
content retain their own subtasks and attendees. Fully indistinguishable duplicate
parents cannot provide historical identity that the archive never recorded.

Schema-3 ZIP readers now require valid SHA-256 metadata in `checksums.json`;
archives missing it are rejected. Older readers' compatibility behavior remains.
Recovery declarations are checked for section membership, file handling and parent
mappings against actual MySQL foreign keys. CI now requires database tests to run
and pass before image publication; no installation Compose change is needed.

## Validation scope

Focused checks cover populated historical upgrades, repeated startup, actual
MySQL field coverage, current encrypted recovery, frozen historical archives,
folder conflicts, cancellation, ownership, mail consistency and navigation.
Synthetic MySQL fixtures are not a restoration of a particular live deployment.
See [Recovery contracts](DATA_RECOVERY.md) for the check locations and maintenance
rules. Release publication is separate from preparing these source changes.
