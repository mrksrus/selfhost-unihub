# Backup format and compatibility

0.10.6 enables account backup creation/import/restore with data schema 3.
`manifest.json` is the version file. Users do not select conversion scripts.

## Independent version fields

| Field | Current value | Meaning |
| --- | --- | --- |
| Data `version` | 3 | Meaning and shape of exported records |
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
| 3 | Automatic | Current filing/recovery data, transcripts and server scores included |
| Unknown version | Rejected before restore | Requires a compatible reader |

Schema 3 preserves account-scoped folder metadata, source and filing identities,
Legacy state, per-account sender-rule overrides, recovery journals and translated
completion markers. Completed recording transcripts and server-side Tetris scores
are included. Mail mode, separate current provider bindings and the remote-missing
marker are included. Notes text, all revisions, Trash state, owned note links and
attachment bytes are included, even when Notes is hidden or disabled. Module
preferences are archived with settings. Old archives default to Download; Sync restores as pending.
Automatic deletion is always reset off. Different provider mailbox identities
cannot be merged. Browser-only game saves are outside server recovery.

The reader registry is `api/src/services/backup-format.js`, with dedicated readers
in `backup-formats/`. Original archive checksums are validated before converting
historical metadata into the current restore model. Stored files remain
file-backed. Old archives cannot supply data they never contained; defaults and
warnings are explicit. Old inline JSON schema-1 data still uses its historical
internal reader; the upload UI accepts ZIP and encrypted archives.

Current schema-3 validation rejects unknown tables/fields/file kinds and missing
required content. Unknown selected sections are errors, not a request for a full
restore. Conflicting folder scopes and merges that would hide newly restored
mail roll back. The original archive remains the historical record; optional
journal references to deleted accounts become null with a warning. Actual live
account references must resolve to owned records.

Older applications that read only schemas 1/2 cannot import new schema-3 backups.
Downgrading an image is not a database rollback. Preserve a matching full server
snapshot before upgrading. Future changes must retain supported readers and
frozen fixtures; see [Recovery contracts](DATA_RECOVERY.md).

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

Focused MySQL recovery tests verify current exports, automatic old readers,
relationships and file bytes, restored account/folder meaning, conflicts,
interruption and ownership. They establish the covered cases at the tested
revision, not every old release or every live installation.
