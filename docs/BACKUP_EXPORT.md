# Backup and Restore Documentation

## Overview

UniHub backups are restorable ZIP archives. A backup ZIP contains structured
application data plus the stored files needed to restore mail attachments, raw
mail archives, and recordings.

Backups do not replace infrastructure backups. You should still back up the
MySQL volume and uploads volume.

## Backup ZIP Format

Every backup ZIP contains:

- `manifest.json`: app/version, format, selected sections, counts, warnings
- `data/backup.json`: canonical restore metadata for selected sections
- `checksums.json`: SHA-256 checksums for restore data and stored files
- `files/mail-raw/...`: raw `.eml` files when available
- `files/mail-attachments/...`: email attachment files
- `files/recordings/...`: recording files

The restore engine uses `data/backup.json` plus `files/`. Readable extras may be
added later, but they are not the authoritative restore format.

## Included Data

Supported sections:

- `settings`: user display metadata and user settings
- `contacts`: all contact fields, including secondary emails and phones
- `calendar`: accounts, calendars, events, todos, subtasks, attendees, external refs
- `mail`: accounts, folders, sender rules, emails, attachments, scores, raw `.eml`
- `recordings`: recordings, tags, tag links, audio files

Mail account credentials and calendar credentials are stored only as encrypted
database metadata. They restore only when the target deployment uses the same
`ENCRYPTION_KEY`.

## Restore Behavior

Imports validate the ZIP before writing:

- ZIP shape and UniHub format
- `manifest.json`, `data/backup.json`, and `checksums.json`
- app/version compatibility
- selected sections
- file checksums
- row counts and conflict summary

Restore is merge-based and never deletes unrelated current data.

Conflict modes:

- `keep_existing`: default; existing matching rows stay unchanged, missing rows are added
- `replace`: matching rows are updated from the backup
- `keep_both`: matching rows are restored as new rows where the schema allows it

Calendar mode:

- `merge_same_name`: default; same-name local calendars, including `Local`, are merged
- `copy`: creates restored calendar copies when possible

Credential mode:

- `keep_existing`: default; existing matched accounts keep current credentials
- `restore`: backup credentials replace matched account credentials

For safety, restored mail accounts always set `delete_emails_on_server` to false
and clear server-deletion timestamps. The server-deletion queue is never restored;
it is regenerated only if the user later enables server deletion.

## API Endpoints

All endpoints require authentication. State-changing endpoints require CSRF.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/backup/jobs` | List latest 25 backup jobs |
| POST | `/api/backup/jobs` | Start a ZIP backup job |
| GET | `/api/backup/jobs/:id` | Get backup job status |
| GET | `/api/backup/jobs/:id/download` | Download a ready backup ZIP |
| DELETE | `/api/backup/jobs/:id` | Delete job and generated ZIP |
| POST | `/api/backup/import` | Dry-run or apply ZIP restore |

`POST /api/backup/import` accepts `application/zip` or
`application/octet-stream` bodies. Restore options are passed as query params:

- `mode=dry-run|apply`
- `sections=full|mail,calendar,...`
- `conflict_mode=keep_existing|replace|keep_both`
- `calendar_mode=merge_same_name|copy`
- `credentials_mode=keep_existing|restore`

`GET /api/backup/export` is deprecated and returns `410 Gone`.

## Limitations

- Backup jobs are in-process and stored in the existing `data_export_jobs` table
  for compatibility.
- ZIP import currently supports UniHub-created stored ZIP entries.
- There is no scheduled backup or automatic retention policy.
- Backups can contain private mail, attachments, recordings, and encrypted
  credentials; store them securely.
