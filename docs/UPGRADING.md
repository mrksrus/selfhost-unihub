# Upgrading from 0.9.x to 0.10.x

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
for example `ghcr.io/mrksrus/selfhost-unihub:0.10.2`, then run from the existing
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
mail synchronization and a sample backup validation.

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
retry when another conversion is busy. See [0.10.2 release notes](RELEASE_0.10.2.md).

## Unreleased backup reliability changes

The current development branch adds automatic backup-data version dispatch and
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
