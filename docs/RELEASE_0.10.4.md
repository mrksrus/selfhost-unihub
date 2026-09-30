# UniHub 0.10.4 — Account folders and backup suspension

## Folders

- New custom folders belong to one mail account. Select that account before
  creating a folder; creation no longer affects every connected account.
- Existing custom folders remain under a collapsible **Legacy shared** section.
  Their contents, IDs, slugs and provider mappings are preserved.
- Provider special-use markers recognize localized Sent, Drafts, Archive, Trash,
  Important and Junk folders. Existing mappings take precedence, so improved
  icons do not silently reorganize old mail.
- Account-specific folders are filtered by the selected account and labelled
  with their account in All Accounts. Mixed-account moves into an account folder
  are rejected completely. Sender rules follow the same account boundary.
- Moves remain local grouping changes. No IMAP MOVE or automatic folder deletion
  is introduced. Source account identity stays intact.

## Backups — temporarily unavailable

**Backup creation, import/validation and restore are disabled in the UI and API.**
They return HTTP 503 while the data model evolves. This also blocks old cached
clients. Existing completed backups and their recovery passwords remain
available for download. Interrupted jobs are marked failed with an explanation;
archives are retained and automatic restore-upload expiry is paused.

Use an infrastructure backup of MySQL, uploads and deployment configuration.
Contact vCard import/export and individual mail/recording downloads are unchanged.

## Updating

Update an existing 0.10.3 installation using the same database, volumes and keys.
The folder schema migration adds nullable columns; it does not reassign existing
folders or emails. The populated v0.9.23.0 upgrade regression also remains part
of verification; earlier 0.9.x variants have not all been tested individually.
No Dockerfile or YAML changes are needed. The five-minute MySQL readiness limit
is unchanged and exits immediately when the authenticated connection succeeds.
Finish any running backup/restore before updating. An older app does not
understand new folder scopes: rollback requires a matching pre-upgrade
infrastructure snapshot. See [Upgrading](UPGRADING.md).

## Notifications

No notification-code change is included. Vanadium on GrapheneOS can depend on
sandboxed Google Play services for background Web Push. Notification permission
alone does not establish that delivery is configured correctly. See the
[GrapheneOS usage guide](https://grapheneos.org/usage#sandboxed-google-play) and
[Vanadium PWA discussion](https://discuss.grapheneos.org/d/7043-forum-notifications-any-way-to-enable-push).
