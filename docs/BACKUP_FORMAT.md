# Backup Format and Compatibility

> **0.10.4 availability:** Backup creation, upload/import, validation and restore
> are temporarily disabled in the UI and API. Existing completed archives and
> recovery-password downloads remain available. Pending jobs do not resume on
> startup; their files are retained, and automatic restore-upload expiry is paused.
> The format and workflow below document 0.10.3 and retained implementation,
> not an enabled feature in 0.10.4. Use infrastructure backups of MySQL, uploads
> and configuration in the meantime. Contact vCard import/export is unaffected.

This document describes the backup format introduced in **UniHub 0.10.3**. Creating a backup writes data schema 2; importing selects
the schema-1 or schema-2 reader automatically. Users do not choose an import
script or convert files manually.

## Independent Version Fields

UniHub distinguishes the backup's data schema from its packaging and the
application release that produced it:

| Layer | Current value | Meaning |
| --- | --- | --- |
| Data `version` | `2` | Shape and meaning of exported application records |
| ZIP `format` | `unihub-restorable-backup` | Identifies a restorable UniHub ZIP |
| ZIP `format_version` | `1` | Layout of metadata and files within that ZIP |
| Encrypted container | `1` | Authenticated encryption framing around the ZIP |
| `producer` | UniHub name and application version | Identifies the producing build; does not select the reader |

Both `manifest.json` and `data/backup.json` contain `app`, `version`, `format`
and `format_version`. New exports also include `producer` in both. The manifest
already is the archive's version file; a second `version.txt` would duplicate
that information. The manifest additionally records export time, selected
sections, row counts and file count.

Backup schema changes do not require database schema changes. This update adds
no database migration, folder reorganization or Docker configuration change.

## Reader Compatibility

| Backup | UniHub 0.10.3 reader | Released 0.10.2 reader |
| --- | --- | --- |
| Data schema 1, ZIP format 1 | Accepted automatically | Accepted |
| Data schema 2, ZIP format 1 | Accepted automatically | Rejected as unsupported |
| Unknown data schema or packaging version | Rejected before restore | No forward-compatibility guarantee |

Encrypted backups use the same container version for either supported data
schema. Unlocking an encrypted container does not make an unsupported inner
schema readable by an older application.

Historical inline JSON payloads without ZIP-format fields retain their
schema-1 reader path. The Data Management upload flow accepts restorable ZIPs
and encrypted `.unihub-backup` files; this does not add a JSON upload option.

## Validation and Translation

The reader registry is in
[`backup-format.js`](../api/src/services/backup-format.js), with dedicated
[`v1.js`](../api/src/services/backup-formats/v1.js) and
[`v2.js`](../api/src/services/backup-formats/v2.js) readers.

The import sequence is:

1. Authenticate/decrypt an encrypted container, if present.
2. Read the ZIP metadata and require matching, supported version fields.
3. Validate structure and original checksums, including file hashes.
4. Clone record metadata and translate the supported source schema into the
   current in-memory shape. Stored file bytes remain file-backed.
5. Apply section selection, ownership checks and the chosen conflict rules.
6. Stage files and restore database rows with the transaction protections in
   the [Backup and Restore Guide](BACKUP_RESTORE.md#background-restore-and-safety).

Translation never rewrites the uploaded archive. An original checksum describes
the original payload, so it is verified before translation and is not reused
to certify the translated shape. Unknown versions produce an upgrade error;
UniHub does not attempt to interpret them as the nearest known version.

Future schema changes should add an explicit reader/translation step, retain
supported historical readers and extend the compatibility fixtures. Packaging
or encryption changes need their own version change only when those layers
actually change. An application release number alone is not a reliable backup
schema identifier.

## What Schema 2 Adds

Schema 2 exports `mail_folder_remote_boxes`, the existing relationship between
a local folder, a mail account and that account's provider-folder name. During
restore both parent IDs are remapped and checked for ownership. Existing
provider mappings are not silently reassigned to a different local folder.

Schema-1 archives omitted that table. Their reader preserves the local folder
records, each email's mail-account identity and source-folder name, supplies no
guessed mappings and warns about the omission. Existing destination mappings
remain in place. A fresh destination cannot recover mappings absent from the
old archive.

Separate source emails, attachments and recordings remain separate even when
their matching metadata repeats. Attachment URLs stored in email HTML are
rewritten to restored attachment IDs. Raw `.eml`, attachment and recording bytes
are preserved. These are restore correctness changes; they do not change the
mail application's current folder behavior.

## Integrity and Size Limits

The exporter reads related database rows from one consistent read-only MySQL
snapshot. It then verifies selected files during archive creation. Missing,
unreadable or changed selected files fail a new export rather than producing a
ready but incomplete archive. Legacy missing-file entries remain readable with
warnings; their unavailable bytes cannot be reconstructed.

The current writer uses stored ZIP32 entries, without compression or ZIP64:

| Limit | Maximum |
| --- | --- |
| Final uploaded archive, including encryption overhead | 3900 MiB |
| ZIP entry size and ZIP size/offsets | 4 GiB minus one byte |
| ZIP entries, including metadata | 65,534 |
| `manifest.json` | 16 MiB |
| `checksums.json` | 64 MiB |
| `data/backup.json` | 512 MiB |

The final upload cap is usually stricter than ZIP32's size limit. Export rejects
output that the current deployment cannot import. Section backups may fit when
a full backup does not; splitting within one section is not implemented.
Retain consistent database and uploads backups for datasets exceeding these
limits.

## Compatibility Evidence

The suite includes frozen plain and encrypted archives made by the actual
exporter at tag `v0.9.23.0`, immutable commit
`e8813669c75ada5bad870d0f9c380083934ed291`. The fixtures use invented data and
record the source hashes, generated archive hashes, expected rows, file bytes
and test credentials. See their
[provenance](../api/tests/fixtures/backups/v1-0.9.23.0/README.md).

MySQL integration coverage exercises production export and restore jobs,
relationships in every section, duplicate records, portable encrypted
credentials on another deployment key, legacy credentials, repeated restores
and failure recovery. The suite operates on disposable test databases and
uploads directories. CI determines the result for a particular commit; these
fixtures do not claim that every historical version or every live installation
has been tested.

An account archive contains one user's selected application data. It omits
other users, authentication state and deployment configuration. A full server
rollback still requires matching MySQL, uploads and configuration backups; see
[Upgrading](UPGRADING.md#backups-and-rollback).
