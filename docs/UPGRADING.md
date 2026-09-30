# Upgrading UniHub

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of MySQL, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

For a new installation, use [Installation](INSTALLATION.md). This page includes
version-specific upgrade guidance. Preserve existing data and keys when upgrading.

## 0.11.1 non-root API

The Node API now runs as the unprivileged `unihub` user (uid/gid **10001**) inside
the container. Nginx and the small process supervisor keep their current model.
No database migration is required.

- **First start changes ownership of uploads.** Volumes created by older images
  are owned by root. On start, the container checks `/app/uploads` and, if any
  entry is not owned by 10001, runs `chown -R` once (symlinks themselves are
  changed, never their targets). This can take a moment on a large volume.
  Later starts only scan and skip the change.
- **Keep the capability list.** The supplied Compose file already grants
  `CHOWN`, `DAC_OVERRIDE`, `SETGID` and `SETUID`; the start script needs `CHOWN`
  and `DAC_OVERRIDE` for the handover and the supervisor needs `SETGID`/`SETUID`
  to start the API as 10001. `no-new-privileges` stays on.
- **Bind mounts must be writable by uid 10001.** If `/app/uploads` is a host
  directory (instead of the `uploads_data` named volume) and the container
  cannot change its ownership, for example on NFS with root squash, prepare it
  on the host: `sudo chown -R 10001:10001 /path/to/uploads`. Otherwise the
  container logs a warning and uploads, recordings, backups and mail archives
  fail with permission errors.
- **Running with `--user`.** If you start the container as a non-root user
  yourself, the supervisor starts the API as that user and skips the handover;
  Nginx then needs its own adjustments and this is not a supported setup.

## 0.10.13 durable mail engine (0.11 preview)

Migrations 6 and 7 add mailbox occurrences, bounded jobs/cursors, operation attempts,
request receipts and explicit raw-archive provenance. Backfill commits progress in
bounded transactions and quarantines ambiguous old identities. It must not reset
existing pending commands, infer remote success from a timeout, or silently merge
independent copies. Historical uncertain operations can remain attention-required.

Before updating, take an independent **consistent** backup of MySQL, uploads and
configuration/keys, preserve the exact old image, and read [mail modes](MAIL_MODES.md).
Do not run old and new provider writers against the same database. Leave a progressing
migration running; an HTTP startup failure while schema initialization is incomplete
is not proof of corruption. Diagnose the actual migration error before restarting.
No additional production volume or credential is required relative to 0.10.12.

Application backups now use data schema 4. Old supported schemas remain readable,
but older application versions cannot read a schema-4 archive. Mail restore retains
intent history and quarantines imported provider evidence; accounts and deletion
remain paused until explicit reconnection/revalidation. Disconnect now retains data
and clears account credentials; permanent local purge is separate and guarded.

**An image-only downgrade is not a safe rollback.** Preserve a matching database,
uploads, configuration and image recovery point. If the new writer has already sent
provider commands, restoring an older database cannot reverse those remote effects.
Preserve the new operation/attempt journal, keep the restored old writer disabled,
and reconcile provider state before enabling writes. Do not blindly restart an old
pending queue or discard the newer journal to manufacture a clean rollback.

### MySQL 8.4 LTS

The bundled `docker-compose.yml` now uses `mysql:8.4` (MySQL 8.0 reached end of
life in April 2026). On first start with an existing 8.0 data volume, MySQL
upgrades the data dictionary in place. **MySQL cannot downgrade that volume back to
8.0**, so take the consistent MySQL backup above before changing the image. Update
the application first and confirm it is healthy on 8.0, then switch the database
image as a separate step. If you keep your own MySQL configuration, replace
`innodb_log_file_size` with `innodb_redo_log_capacity` and remove
`skip-symbolic-links`, which 8.4 deprecates or no longer needs.

### Staged Sync-account cutover

The image includes `/app/api/mail-rollout.js` for an operator-controlled canary.
This is a maintenance procedure, not a second provider writer or a repair of
failed operations. It currently requires **all active mail accounts to be in
Sync mode**; Download-mode server-deletion workers need a separate maintenance
procedure and the command refuses that cohort rather than pretending to hold it.

1. Preserve the consistent recovery point above. Stop the old application/API
   and its provider workers; verify their processes have exited. Keep only its
   database available. Do not run this against a live old writer.
2. Run a one-shot container from the **target image**, with the existing deployment
   database connection, encryption/backup keys and uploads mount, on the same
   private database network. Override its entrypoint with `node`; do not start
   `/app/start.sh`. After independently verifying the writers are stopped, set
   `UNIHUB_MAIL_ROLLOUT_MAINTENANCE=1` and execute:
   `node /app/api/mail-rollout.js prepare CANARY_ACCOUNT_UUID`.
   Use the exact existing mail-account UUID, not a user ID or email address.
3. Prepare runs the normal schema migrations without starting HTTP/provider
   workers, places deployment holds on the other active accounts, and releases
   only the selected canary. It preserves account credentials/modes, existing
   recovery pauses, and all operation, attempt and job records. Check the returned
   per-account status, then start the new application normally. A hold replaces
   a user-liftable module pause (the module setting is still enforced live).
   Account settings changes, reconnects, module toggles and restores keep an
   existing hold; only `release` clears it.
4. Exercise the authorized canary through real API/browser/provider workflows.
   While maintenance is in progress, do not change account connection or module
   settings, add accounts, or permit another operator to resume held accounts.
   Ordinary foreground message operations cannot bypass the deployment hold.
5. After a passing canary, release each next account explicitly using
   `node /app/api/mail-rollout.js release ACCOUNT_UUID` in the running target
   container and verify its progress before releasing another. This does not
   classify pending provider actions as successful; it only re-queues read-only
   sync streams that were paused while the account was held. It will
   not clear a restore/disconnect/module pause or reconnect an inactive account.
   `node /app/api/mail-rollout.js status` is read-only.

If the canary fails, leave the remaining accounts held and stop promotion. A
successful migration or maintenance command is not successful mail acceptance.
Follow the journal-preserving rollback instructions above; never restore an old
pending queue and start its writer blindly.

After upgrading, refresh the browser/PWA and verify provider-confirmed flag changes,
a MOVE out and back, fresh incoming mail, operation settlement and retained message
bytes. Acceptance and provider confirmation are different. Missing COPYUID, changed
UIDVALIDITY or genuinely ambiguous identities can require attention; no native MOVE
means no remote move fallback. See the [0.11.0 release candidate notes](RELEASE_0.11.0.md)
for the current validation boundary.

## 0.10.12 provider writes and independent mail jobs

Corrects the actual conditional IMAP command format, adds bounded per-account
sync jobs and independent writeback retries, and accepts message actions without
waiting for a full provider scan. The UI reports queue/progress/failure honestly
and keeps unrelated actions available. Verified new messages persist even when
a later inventory change prevents safe location/missing-state reconciliation.

No new schema, volumes, secrets, or Compose changes are required relative to
0.10.11. Existing **pending** intents can resume; failed/conflicting operations
and uncertain moves are not force-replayed. Do not clear queues as an upgrade
step. Keep a consistent backup and refresh the browser/PWA after updating.

See [release notes](../CHANGELOG.md#01012) for behavior and limits, and
[live mail testing](LIVE_MAIL_TESTING.md) for provider-confirmed acceptance tests.

## 0.10.11 mail flag and responsiveness fixes

Fixes incorrect read/starred values in mail lists and details caused by MySQL's
string-valued computed flags. Single-message actions keep list and reader state
consistent, prevent duplicate clicks, and roll back the affected flag on failure.
Bulk flag failures are reported without presenting a rejected batch as applied.

An account already syncing now rejects a competing mutation immediately instead
of leaving the request waiting indefinitely: nothing is changed and the action
can be retried. IMAP commands have bounded waits, and cancelling a sync closes
its pending transport before the account lock is released.

No new database migration, volume, secret or Docker configuration is required
relative to 0.10.10. Keep existing data and keys; refresh the browser/PWA after
updating. See the [release notes](../CHANGELOG.md#01011) for scope and validation.

## 0.10.10 pending mail state and retry fix

Read/unread actions update the visible mail list immediately. Accepted read/star
changes remain visible across reloads, filters and unread badges while awaiting
provider confirmation. Failed or conflicting changes fall back to confirmed
state. The provider-change Retry action now reaches its API handler.

No new database migration, volume, secret or Docker configuration is required
relative to 0.10.9. Keep existing volumes and keys. See the
[release notes](../CHANGELOG.md#01010) for the failed build diagnosis and checks.

## 0.10.9 two-way message sync

Migration 5 adds a separate durable `mail_writebacks` table. It does not rewrite
existing mail or change account modes. For accounts already in Sync, only new
read/star/move actions made after upgrading send provider updates; old local state
is never uploaded. Download remains unchanged. Existing storage/configuration and
Docker YAML work without changes. See [mail modes](MAIL_MODES.md) for conflict,
retry, local-copy and provider-capability limits. Account backup/import remain
ALPHA; queued provider commands are never exported or replayed through restore.

## 0.10.8 container startup permissions

Update the `unihub` service's `cap_add` list to match the supplied Compose file:
`CHOWN`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`, `SETGID`, `SETUID`. Keep
`cap_drop: ALL` and `no-new-privileges`. Nginx needs these capabilities to prepare
its owned paths and start workers under its own user/group. A deployment retaining
only `NET_BIND_SERVICE` can fail with Nginx permission errors.

**Pulling a newer image alone does not update your saved custom-app YAML.** Apply
the Compose capability change too, preserving all existing volumes and secrets.
The proposed TrueNAS catalog supplies the corrected capability list itself.
No database, archive-format or application-data changes are introduced.

## 0.10.7 ALPHA labels

Backup creation, import and restore remain available but are explicitly marked
ALPHA in Data Management and the server-deletion setting. This is a wording and
documentation update; no new database migration, archive format, credentials or
storage changes are required. Upgrade from 0.10.6 using the same volumes and keys.
Earlier versions still follow the upgrade requirements below.

## 0.10.6 recovery, account modes and upgrade ledger

Migration 3 adds mail mode and separate current provider identifiers without
rewriting original identity or deleting messages. Migration 4 adds Notes tables
and recovery policies. Module controls default to enabled, preserving access to
existing features. Existing accounts remain in
Download. Mode changes are opt-in; see [mail modes](MAIL_MODES.md).

Read [0.10.6 release notes](../CHANGELOG.md#0106) before upgrading. Direct 0.10.3+
updates preserve the approved folder migration. The new ledger records completed
steps, and an unknown data field or required upgrade failure stops startup.
Backups are re-enabled with schema 3 and automatic readers for 1/2; older apps
cannot import the new format. Incompatible folder ownership during a restore
fails rather than hiding mail. Retain a complete pre-update server snapshot for
rollback. Refresh device offline snapshots after upgrading.


## Compatibility

An existing **0.9.23.0 installation is intended to upgrade in place** to 0.10.x,
using the same MySQL database, uploads volume and deployment keys. A reinstall
or account export/import is not required. The 0.10 schema changes add tables,
columns and indexes; they do not intentionally remove existing mail, contacts,
calendar data or account credentials.

The upgrade regression uses the actual v0.9.23.0 schema, populated with synthetic
user, mail, calendar and related records, and runs the current initializer twice
against MySQL 8. It checks preservation and the new schema. The release notes
record the validation result. This is representative migration coverage, not a
test of every provider or every existing installation.

**Earlier 0.9.x versions have not all been exercised as populated upgrades.**
For an older or locally modified installation, rehearse the upgrade on a copy
of its database and uploads before updating the live instance. Keep that copy
isolated from live mail accounts and provider-deletion jobs. The latest 0.9 tag
is the verified schema baseline; an intermediate upgrade is not a substitute
for checking your own data.

## Before replacing the image

1. Record the running image tag/digest and keep the existing Compose file and
   environment configuration.
2. Take a consistent backup of **both MySQL and uploads**, plus the keys needed
   to recover them. Use your database backup procedure, or stop writers and
   MySQL before a filesystem snapshot. Copying a live MySQL data directory is
   not a consistent backup. A downloaded UniHub account backup is useful too,
   but does not contain all users, sessions or deployment configuration.
3. Retain `ENCRYPTION_KEY`, `JWT_SECRET`, database passwords and any separate
   `BACKUP_MASTER_KEY`. With the supplied Compose file these come from the
   corresponding `UNIHUB_*` environment values. Changing `ENCRYPTION_KEY` makes
   existing stored credentials and 2FA secrets unreadable and affects backup
   unlocking. The new Web Push private key also uses this key.
4. Keep the same Compose project name and existing volume mappings. Running
   Compose from a different project directory/name can create fresh volumes
   that make an existing installation appear empty. Do not use `down -v` as an
   upgrade step.

## Startup settings to merge

Update older explicit settings in the **unihub application service**:

```yaml
environment:
  MYSQL_STARTUP_MAX_WAIT_SECONDS: "300"
  MYSQL_STARTUP_CHECK_INTERVAL_SECONDS: "5"
healthcheck:
  start_period: 360s
```

Merge these into your current configuration, keeping its other environment and
health-check fields. The database can take up to five minutes to become ready;
the wait ends as soon as an authenticated probe succeeds. This is a maximum,
not a fixed startup sleep. The app health grace is six minutes. Pulling the new
image cannot override a timeout explicitly set by an older Compose file.

No new service, port, volume or required secret is needed. The API and image use
Node 24; installations running the API outside Docker need Node 24 or newer.
Keep browser access over HTTPS and preserve your actual `ALLOWED_ORIGINS` and
mail-host trust configuration.

## Replace and verify

For a running Compose deployment, set the app image to the desired version,
for example `ghcr.io/mrksrus/selfhost-unihub:0.10.11`, then run from the existing
deployment directory:

```bash
docker compose pull unihub
docker compose up -d --no-deps unihub
docker compose logs --tail=100 unihub
docker compose ps
```

The database service must already be running for this app-only update. Wait for
authenticated MySQL readiness, schema initialization and a healthy application.
Then verify sign-in, existing mail bodies/attachments, contacts, calendar data,
mail synchronization and a representative backup/restore using disposable data.
Backups are enabled in 0.10.6; they were suspended in 0.10.4 and 0.10.5.

The first upgraded mail sync establishes per-folder UID progress and revalidates
existing imports. It can take longer and read provider history again; subsequent
syncs reuse the checkpoints. First imports, UIDVALIDITY resets and repairs do
not produce a notification for every historical email. Existing calendar colors
and customized system-folder names/order are preserved.

Refresh the browser/PWA after the server is ready and accept its update prompt.
Enable notifications and test them on each device. Enable offline reading
separately and wait for its saved timestamp. Old automatic private API caches
are retired; they are replaced by explicit device snapshots.

## Backups and rollback

The 0.9.23.0 encrypted backup container and restorable ZIP format remain
supported. Keep recovery passwords for downloaded encrypted backups. An account
restore is a merge operation, not a complete server rollback.

There is no automatic down-migration or verified image-only downgrade after
0.10.x has written data. To return to an older version, stop the app and restore
the **matching pre-upgrade database, uploads and configuration**, then start the
recorded old image. Do not point old and new apps at the same writable data.

Version 0.10.1 also introduces the [licensing policy](../LICENSING.md): free
noncommercial use and separately agreed paid commercial use. Earlier releases
retain the permissions supplied with them.

## 0.10.2 security update

Upgrade existing 0.10.x installations in place with the same database, uploads
and keys. This patch adds no database migration and does not rewrite existing
recordings or IDs. The populated 0.9.23.0 upgrade regression remains part of CI.

Configure `UNIHUB_TRUSTED_PROXY_CIDRS` if an extra HTTPS proxy sits in front of
UniHub; see [Authentication](AUTH_ADMIN_SETTINGS.md#trusted-proxies). An image
pull alone does not add a new environment variable to an existing container.
Mail/CalDAV servers resolving to private addresses need the administrator's
existing `TRUSTED_MAIL_HOSTS` exception. Failed DNS lookups now stop a connection.
CalDAV discovery will not send credentials to another origin; providers that
redirect across origins require an explicitly configured final server URL.

Legacy backup formats remain supported. Newly imported rows receive fresh IDs
unless matched to existing data owned by the restoring user. Foreign or
inconsistent parent references are rejected instead of being linked. Restored
mail/calendar settings that cannot pass network policy are kept inactive with
a warning, so a restore does not silently initiate an unsafe connection.

New audio uploads/restores accept recognized WAV, MP3, M4A/MP4 audio, Ogg, WebM,
FLAC, AAC and AIFF signatures; arbitrary file types labeled as audio are rejected.
Existing stored originals are retained. MP3 export is bounded and may ask you to
retry when another conversion is busy. See [0.10.2 release notes](../CHANGELOG.md#0102).

## 0.10.3 backup reliability update

UniHub 0.10.3 adds automatic backup-data version dispatch and
writes **schema-2 backups**. This is a backup-file change, not a database
migration. It does not reorganize existing mail folders, rewrite live mail,
change Docker configuration or change the five-minute MySQL readiness wait.
Keep the same database, uploads and deployment keys when updating.

This reader accepts schema-1 and schema-2 data. **Released 0.10.2 and earlier
readers cannot import new schema-2 backups.** Keep an older backup or your
consistent pre-update MySQL/uploads/configuration copy if you need recovery
onto an older release. New backup files do not make an image-only downgrade a
supported rollback method.

The ZIP format and encrypted container remain version 1. `manifest.json`
identifies the data version and producer; UniHub selects its reader
automatically, verifies original checksums before translation, and rejects
unknown versions instead of guessing.

Schema 2 includes the existing account-specific provider-folder mapping table.
Schema-1 backups never contained those mappings: importing one preserves the
local folders, email account identities and source-folder names it does contain,
leaves any existing provider mappings unchanged and reports that limitation.
No importer can recover data that was omitted from the original archive.

The added regression coverage includes frozen archives produced by the actual
`v0.9.23.0` exporter and production MySQL export/restore jobs with every supported
section. Check the CI result for the commit being installed; representative
fixtures do not verify your own live backup. See [Backup and Restore](BACKUP_RESTORE.md)
for safe testing, file limits and missing-file handling, and
[Backup Format](BACKUP_FORMAT.md) for the version contract.

## 0.10.4 account folders and backup suspension

An in-place upgrade from 0.10.3 is supported. This release adds nullable account
and special-use metadata to `mail_folders`; existing rows are not reassigned.
No Dockerfile, Compose, volume or secret changes are required for this release.
The existing five-minute MySQL readiness wait still ends as soon as a connection succeeds.

Old custom folders appear in **Legacy shared**. Expand that section to find
existing mail, select a specific account to create new folders, and move mail
manually if desired. An email's source account is never inferred from its To address.
There are no automatic provider moves, folder deletions or conversions of legacy folders.

**Breaking availability change:** backup creation, upload/import and restore
return HTTP 503 and are disabled in Settings. Old cached clients cannot bypass
this. Completed generated archives remain downloadable; keep their recovery
passwords. Interrupted jobs are marked failed with a suspension explanation;
archive files are retained and automatic upload expiry is paused. Do not update
while a backup or restore is in progress. Protect the database, uploads volume
and configuration with an infrastructure backup before updating.

Do not downgrade after creating account-scoped folders: older app versions do
not understand their scope. To roll back safely, restore the complete pre-upgrade
infrastructure snapshot together with its matching application version.

## 0.10.3 → 0.10.5 folder reconciliation

Upgrade directly using the same database, uploads and keys; 0.10.4 is not a
prerequisite. On the first successful folder listing for each account, exact
server matches connect, uniquely addressed local-only mail goes to its receiving
Inbox, and uncertain messages retain their folders in the Legacy view. The
migration does not create provider folders. Local Important/Archive filing is
included when no server link exists; Inbox/Sent/Drafts/Trash are excluded.
See [0.10.5 release notes](../CHANGELOG.md#0105) for the rules, manual recovery,
source-account ownership, auditing and rollback limits. Preserve a complete
infrastructure snapshot before updating; application backups remain suspended.
