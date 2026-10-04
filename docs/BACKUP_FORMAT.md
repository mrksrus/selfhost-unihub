# Backup format and compatibility

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

0.10.13 and later write account backups with data schema 4 and retains readers for schemas 1–3.
`manifest.json` is the version file. Users do not select conversion scripts.

## Independent version fields

| Field | Current value | Meaning |
| --- | --- | --- |
| Data `version` | 4 | Meaning and shape of exported records |
| ZIP `format` | `unihub-restorable-backup` | Identifies a restorable archive |
| ZIP `format_version` | 1 | Archive layout |
| Encrypted container | 1 | Authenticated encryption framing |
| `producer` | UniHub name and app version | Build provenance, not reader selection |

Database upgrade IDs in `schema_migrations` are separate from these fields.
Both manifest and data payload must agree on supported format/version values.
The manifest includes selected sections, row counts and file count. Checksums
cover metadata and stored files. Encrypted archives retain streaming AES-256-GCM
framing and a password-wrapped data key.

## Readers and data coverage

| Data schema | Current reader | Notes |
| --- | --- | --- |
| 1 | Automatic | Historical provider-folder mappings were not included |
| 2 | Automatic | Provider mappings included; newer filing/recovery data may be absent |
| 3 | Automatic | Filing/recovery data, transcripts and server scores included |
| 4 | Automatic | Adds durable mail intents, receipts and quarantined provider evidence |
| Unknown version | Rejected before restore | Requires a compatible reader |

Schema 3 preserves account-scoped folder metadata, source and filing identities,
Legacy state, per-account sender-rule overrides, recovery journals and translated
completion markers. Completed recording transcripts
are included. Server-side Tetris scores were included until 0.12.0 removed
Games; they are now skipped on import with a warning. Mail mode, separate current provider bindings and the remote-missing
marker are included. Hidden or disabled modules are included. Module
preferences and module order are archived with settings. Notes data from
archives made before 0.14.0 is skipped on import with a warning. Old archives default to Download; Sync restores as pending.
Automatic deletion is always reset off. Different provider mailbox identities
cannot be merged.

The reader registry is `api/src/services/backup-format.js`, with dedicated readers
in `backup-formats/`. Original archive checksums are validated before converting
historical metadata into the current restore model. Stored files remain
file-backed. Old archives cannot supply data they never contained; defaults and
warnings are explicit. Old inline JSON schema-1 data still uses its historical
internal reader; the upload UI accepts ZIP and encrypted archives.

Current schema-4 validation rejects unknown tables/fields/file kinds and missing
required content. Unknown selected sections are errors, not a request for a full
restore. Conflicting folder scopes and merges that would hide newly restored
mail roll back. The original archive remains the historical record; optional
journal references to deleted accounts become null with a warning. Actual live
account references must resolve to owned records.

Schema 4 adds the durable mail engine. Account-scoped operations and request receipts
are retained and remapped through restore; imported provider attempts, identities and
mapping evidence are quarantined history, not executable commands. Runtime leases
and queued jobs are not restored as authority to write to a provider. Restored mail
accounts remain paused, server deletion stays off, and explicit provider validation
is required before reconnection. Existing accepted work is not silently discarded
or converted into a fresh remote mutation. Restored receipt results include a
recovery warning rather than an unqualified replay of the old HTTP response.

0.13.0 adds three mail account fields to schema 4 without changing its version:
`sync_window_days` and `trash_window_days` (restored as they are; archives
without them restore as all mail and 30 days) and `sync_policy_confirmed_at`
(exported for inspection, never restored: every restore leaves Sync accounts
unconfirmed, so restored local copies are not removed before the user confirms
again). Provider occurrences carry `internal_date` as quarantined evidence. An
account backup started from a mail account (`POST
/api/mail/accounts/:id/backup-export`) is an ordinary mail-section archive
restricted to that account; messages filed in another account restore under
their own account.

Older applications that read only schemas 1–3 cannot import new schema-4 backups.
Downgrading an image is not a database rollback. Preserve a matching full server
snapshot before upgrading. Future changes must retain supported readers and
frozen fixtures; see [Recovery contracts](DATA_RECOVERY.md).

## Account settings backups

Since 0.18.0 a backup can carry `account_only_sections`, a list with `mail`
and/or `calendar`, in both `data/backup.json` and `manifest.json`. Those
sections contain only `mail_accounts`, or `calendar_accounts` with provider
`caldav` or `ics`, and no files. Validation rejects any other rows or files in
them. Schema and backup versions are unchanged.

UniHub 0.18.0 and later restore these accounts as new sign-ins and start sync.
Older versions ignore the field and restore the accounts like a normal mail or
calendar restore: mail accounts stay paused until the Sync policy is confirmed.

## Limits and exclusions

The writer uses stored ZIP32 entries without compression or ZIP64:

| Limit | Maximum |
| --- | --- |
| Uploaded archive, including encryption overhead | 3900 MiB |
| ZIP entry size and ZIP size/offsets | 4 GiB minus one byte |
| ZIP entries, including metadata | 65,534 |
| `manifest.json` | 16 MiB |
| `checksums.json` | 64 MiB |
| `data/backup.json` | 512 MiB |

Export rejects output exceeding import limits. Section backups may fit where a
full archive does not. Splitting within one section is not implemented.

An account archive does not include other users, authentication sessions, server
configuration, temporary uploads/jobs, pending notifications or provider deletion
queues. Completed transcripts are data; pending transcription attempts are not
restored as work. Credential restoration uses existing encrypted portability
rules. Server deletion stays disabled on restored mail accounts.

## Compatibility evidence

Frozen plain/encrypted archives from the actual `v0.9.23.0` exporter live under
`api/tests/fixtures/backups/v1-0.9.23.0`. The frozen plain archive from the actual
`v0.10.3` exporter is under `v2-0.10.3`. Their provenance and hashes are recorded.
They contain invented data, not the owner's mailbox. Do not regenerate them just
to accommodate a changed reader.

Focused MariaDB recovery tests verify current exports, automatic old readers,
relationships and file bytes, restored account/folder meaning, conflicts,
interruption and ownership. They establish the covered cases at the tested
revision, not every old release or every live installation.
