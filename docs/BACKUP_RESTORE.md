# Backup and Restore Guide

## Purpose

UniHub backups are application-level, restorable archives. They preserve the
selected UniHub data and stored files so they can be merged into the same or a
different UniHub installation.

They are not a replacement for infrastructure backups. A complete recovery
strategy should include:

1. Downloaded UniHub backups stored away from the UniHub server.
2. A backup of the MySQL volume.
3. A backup of the uploads volume.
4. Copies of the deployment configuration and required secrets.

A backup retained only inside `/app/uploads/backups` is convenient for rollback,
but it is lost if that server or volume is lost.

## Supported Backup Types

The Data Management page can create:

- Full backup
- Mail backup
- Calendar/ToDo backup
- Contacts backup
- Recordings backup
- Settings backup

Every backup uses the same canonical restore structure. Section backups include
only the selected rows and files.

Encryption is enabled by default:

| Mode | Extension | Credentials | Portability |
| --- | --- | --- | --- |
| Encrypted | `.unihub-backup` | Portable protected credential bundle | Any UniHub server with the recovery password |
| Unencrypted | `.zip` | Existing server-encrypted values only | Data/files are portable; credentials may require the original `ENCRYPTION_KEY` |

Existing restorable UniHub `.zip` backups remain supported.

## What Is Included

### Full Backup

A full backup includes all supported sections for the current user:

- profile display metadata and user settings
- contacts and all supported contact fields
- calendar accounts, calendars, events, ToDos, subtasks, attendees, and external references
- mail accounts, folders, sender rules, emails, scores, attachments, and raw `.eml` archives
- recordings, tags, tag links, and recording files

It does not restore:

- password hashes
- roles or admin privileges
- active/inactive user state
- sessions, JWTs, or CSRF tokens
- 2FA secrets or recovery codes
- mail server-deletion queue rows
- unrelated users
- infrastructure configuration or Docker volumes

### Files

The inner ZIP payload contains:

```text
manifest.json
data/backup.json
checksums.json
files/mail-raw/...
files/mail-attachments/...
files/recordings/...
```

`data/backup.json` and the stored files are the authoritative restore data.
`checksums.json` contains SHA-256 checksums for validation.

Missing source files are recorded as warnings when the backup is created.
Checksum-invalid or structurally invalid files fail restore validation.

## Encryption Model

Encrypted backups use a versioned `.unihub-backup` container around the normal
ZIP payload:

- random 256-bit data-encryption key per backup
- AES-256-GCM authenticated encryption
- independent 4 MiB encrypted chunks
- unique nonce per chunk
- generated 256-bit base64url recovery password
- `scrypt` password derivation with a random salt

The recovery password wraps the backup data key inside the file. This makes the
backup self-contained and portable: another UniHub installation can unlock it
using only the file and recovery password.

### Server Automatic Unlock

The source server also stores a separately wrapped copy of the data key. This
allows a retained server backup to be validated or restored without entering
the recovery password.

The server-side key is protected by:

```text
BACKUP_MASTER_KEY
```

If `BACKUP_MASTER_KEY` is unset, UniHub falls back to `ENCRYPTION_KEY`.
`JWT_SECRET` is never used for backup encryption.

Deleting the generated backup also deletes its server-wrapped key. After that,
the downloaded file requires its recovery password.

### Recovery Password

The generated password is shown once, before the first encrypted download:

1. Select Download.
2. Read the unrecoverable-password warning.
3. Reveal the password.
4. Copy it or download the password text file.
5. Confirm that it was saved.
6. Start the backup download.

The recoverable server copy is deleted immediately when revealed. It cannot be
shown again.

If the password is lost:

- a retained backup can still be restored automatically on its source server
  while its backup record and server-wrapped key exist
- a downloaded backup cannot be restored elsewhere
- deleting the source backup record removes the remaining automatic-unlock key

Store the backup and password separately where practical.

### Portable Account Credentials

For encrypted backups, UniHub decrypts stored mail and calendar credentials only
in process while building the protected payload. It places them in a credential
bundle encrypted with the backup data key.

During restore on another server:

1. The backup is unlocked with its recovery password.
2. The credential bundle is decrypted in memory.
3. Credentials are encrypted again with the destination server's
   `ENCRYPTION_KEY`.
4. Plaintext credentials are not written to a persistent intermediate file or
   returned to the browser.

Legacy or unencrypted ZIP backups contain only source-server ciphertext. If the
destination server cannot decrypt it, affected newly restored accounts are
created inactive and require credentials to be entered again.

## Creating and Managing Backups

Backup creation runs as a background job. The browser may navigate away after
the job starts.

Job states include:

- `queued`
- `running`
- `cancelling`
- `cancelled`
- `ready`
- `failed`

The Data Management page shows the phase, progress, file size, encryption state,
start time, finish time, and errors.

Backup-job API responses expose `recovery_password_available`,
`recovery_password_revealed`, and `server_unlock_available` separately so clients
do not infer one-time password state from a missing ciphertext value.

Stop requests are cooperative. UniHub checks cancellation while collecting
files, hashing, writing the ZIP, and encrypting chunks. Partial output is
removed.

Generated backups remain on the server until manually deleted. A ready backup
can be:

- downloaded
- validated and restored directly from server storage
- deleted

The app resumes interrupted queued/running backup jobs after restart.

## Upload and Validation

Import accepts:

- `.unihub-backup`
- UniHub-created restorable `.zip`

The upload happens once. UniHub retains the archive, creates a restore job, and
validates it in the background.

For encrypted uploads:

- the same user on the source server may be auto-unlocked while the matching
  retained key record exists
- all other uploads require the recovery password
- the entered password is used in memory and is not stored
- after unlock, UniHub retains only a server-wrapped data key for that restore
  job

Validation checks:

- container authentication for encrypted backups
- ZIP structure and safe paths
- supported UniHub app/format versions
- required manifest and data files
- JSON shape
- file sizes
- SHA-256 checksums
- selected-section row counts
- likely conflicts
- protected credential-bundle integrity

An invalid upload is removed when the failure establishes that the archive
itself is malformed or corrupted.

## Restore Options

Options are fixed when the archive is uploaded or a retained backup is selected
for validation. Changing them requires a new validation job.

### Conflicts

| Mode | Behavior |
| --- | --- |
| Keep existing | Default. Leave matched rows unchanged and add missing rows/files |
| Replace matching | Update matched rows from the backup without deleting unrelated data |
| Keep both | Create new IDs and remap children where the schema allows copies |

### Local Calendars

| Mode | Behavior |
| --- | --- |
| Merge same name | Default. Merge same-name local calendars, including `Local` |
| Create restored copies | Create renamed restored calendars where possible |

### Account Credentials

| Mode | Behavior |
| --- | --- |
| Keep current | Default. Matched existing accounts keep their current credentials |
| Use backup | Replace matched account credentials with available backup credentials |

New accounts use portable backup credentials when available.

## Matching and Merge Rules

### Settings and Profile

- settings match by `setting_key`
- profile restore is limited to display metadata
- role, password, active state, and 2FA data are never restored
- duplicate setting keys are not created

### Contacts

Contacts match by:

1. ID
2. normalized email
3. normalized name with phone/email fallback

All supported names, emails, phones, company, job title, notes, avatar URL, and
favorite state are included.

### Calendar and ToDo

- local accounts match by provider `local`
- external accounts match by provider plus account identity
- calendars match by external ID or same-name local calendar rules
- events match by ID, then local event identity
- subtasks, attendees, and external references are remapped to restored events
- ToDo fields and completion timestamps are preserved

### Mail

- accounts match by email address, then ID
- folders match by slug
- rules match by account, match type/value, and target folder
- emails match by ID, Message-ID, or IMAP folder/UID/UIDVALIDITY identity
- attachments match by ID, content ID, or email/filename/size
- attachment and raw-email paths are rewritten to restored files

For safety, every restored mail account has:

```text
delete_emails_on_server = false
server_delete_enabled_at = null
server_delete_grace_until = null
server_delete_last_run_at = null
```

`mail_server_messages` is never restored. If server deletion is enabled later,
the queue is regenerated only from messages with reliable IMAP identity and a
present raw archive.

### Recordings

- recordings match by ID, file checksum, or normalized metadata
- tags match by normalized name
- tag links are remapped
- recording files must exist and pass checksum validation

## Background Restore and Safety

Restore starts with a short API request and continues independently of the
browser or reverse-proxy connection.

Restore jobs are processed one at a time globally. A user can have only one
queued/running restore.

Job phases include:

- decrypting
- hashing
- validating
- waiting for active mail work
- files
- settings
- contacts
- calendar
- mail
- recordings
- commit

Database rows are restored inside one transaction. Job completion is written in
the same transaction as restored rows. A crash cannot leave committed rows with
the job still marked as retryable.

Restored files are written under deterministic job-specific directories.
Failures or cancellation before commit roll back database changes and remove
files created by that job.

Cancellation is unavailable once the final commit phase begins.

On startup UniHub:

- returns interrupted validation jobs to the validation queue
- returns interrupted restore jobs to the restore queue
- cleans incomplete temporary and restored-file directories
- resumes processing automatically

## Read-Only Behavior During Restore

Only affected sections become read-only for that user:

- mail
- calendar/ToDo
- contacts
- recordings
- settings

Reads and unaffected sections remain available. Affected writes return:

```text
409 Restore in progress
```

Account deletion is blocked during any active restore.

During mail restore:

- automatic mail sync is paused
- manual mail writes/sync are rejected
- mail server-deletion processing is paused
- restore waits for already-running mail sync/deletion work to finish

## Retention and Cleanup

| Archive type | Retention |
| --- | --- |
| Generated backup | Until manually deleted |
| Uploaded, validated/failed backup | Seven days |
| Successful uploaded restore | Archive deleted after completion |
| Restore-job history | Retained until manually deleted |

Deleting a restore job removes its retained uploaded archive and any
restore-specific unlock key. Running jobs must be stopped before deletion.

## API Reference

All endpoints require authentication. State-changing endpoints require CSRF.

### Backup Jobs

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/backup/jobs` | List generated backup jobs |
| `POST` | `/api/backup/jobs` | Start a full/section backup; encryption defaults on |
| `GET` | `/api/backup/jobs/:id` | Get backup status |
| `GET` | `/api/backup/jobs/:id/download` | Stream a ready backup with range support |
| `POST` | `/api/backup/jobs/:id/recovery-password/reveal` | Reveal the generated password once |
| `POST` | `/api/backup/jobs/:id/restore` | Create a validation job from a retained backup |
| `POST` | `/api/backup/jobs/:id/cancel` | Request cooperative cancellation |
| `DELETE` | `/api/backup/jobs/:id` | Delete backup file, row, and server unlock key |

### Restore Jobs

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/backup/import` | Upload a backup once and create a validation job |
| `GET` | `/api/backup/restore-jobs` | List restore jobs |
| `GET` | `/api/backup/restore-jobs/:id` | Get durable status, progress, and results |
| `POST` | `/api/backup/restore-jobs/:id/unlock` | Submit a recovery password |
| `POST` | `/api/backup/restore-jobs/:id/start` | Start restore or retry retained validation/restore |
| `POST` | `/api/backup/restore-jobs/:id/cancel` | Request cancellation |
| `DELETE` | `/api/backup/restore-jobs/:id` | Delete a non-running job and retained upload |

Uploads use `application/zip`, `application/octet-stream`, or
`application/vnd.unihub.backup`.

## Storage and Database

Filesystem:

```text
/app/uploads/backups/<userId>/              generated backups
/app/uploads/backups/restores/<userId>/     retained uploads
/app/uploads/backups/restores/work/<jobId>/ temporary decrypted ZIPs
```

Important tables:

| Table | Purpose |
| --- | --- |
| `data_export_jobs` | Generated backup state and file metadata |
| `backup_restore_jobs` | Upload, validation, restore, progress, result, and retention state |
| `backup_archive_keys` | Server-wrapped data keys and temporary one-time password ciphertext |

Uploaded/generated archive files are created with owner-only filesystem
permissions where the host filesystem honors POSIX modes.

## Operational Guidance

- Use HTTPS. Recovery passwords and backup uploads pass through the authenticated
  web connection.
- Set a dedicated `UNIHUB_BACKUP_MASTER_KEY` for new deployments.
- Do not change `UNIHUB_BACKUP_MASTER_KEY` while relying on server-retained
  automatic restore. Downloaded encrypted backups remain recoverable with their
  passwords.
- Keep recovery passwords outside UniHub.
- Periodically test validation and restore on a separate installation.
- Download important backups off-server.
- Back up MySQL and `/app/uploads` independently.

The upload request cap is 3900 MiB. The current inner archive is a stored ZIP32
format. Backup creation rejects per-file size, archive size/offset, and
entry-count overflow before writing invalid ZIP metadata. ZIP64 is not currently
supported.

## Troubleshooting

### Recovery password is rejected

The password is wrong or the encrypted container was damaged. UniHub deliberately
uses the same error for both cases.

### Recovery password cannot be shown again

This is intentional. The server deletes its recoverable copy when it is first
revealed. Use the saved password or restore the retained backup directly on the
source server while its unlock key still exists.

### Restore appears to stop after closing the browser

Reload Data Management and inspect the durable restore job. Browser and proxy
connections are not required after a job starts.

### Restore is waiting for mail

An IMAP sync or provider-side deletion command was already running. UniHub waits
for it to finish before restoring mail rows.

### Account restores inactive

The backup did not contain portable credentials, or legacy ciphertext could not
be decrypted with the destination `ENCRYPTION_KEY`. Enter the account
credentials again.

### Existing data was not overwritten

The default conflict mode is Keep existing. Validate again using Replace
matching if backup values should update matched rows.

### A server backup is not disaster recovery

Generated backups and their automatic-unlock keys live in UniHub's database and
uploads volume. Download important backups and store them independently.
