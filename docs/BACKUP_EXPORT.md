# Backup and Export Documentation

## Overview

UniHub has two separate data portability paths:

1. JSON backup/import API for application-state restore.
2. Asynchronous ZIP export jobs for user-friendly downloads of selected data.

Neither path replaces infrastructure backups. You still need to back up the
MySQL volume and the uploads volume.

## JSON Backup API

`GET /api/backup/export` builds a JSON object for the current user.

Included data:

- user profile metadata
- contacts
- calendar accounts/calendars/events/subtasks/attendees/external refs
- mail folders
- mail sender rules
- mail accounts with encrypted credentials
- emails
- email attachment metadata
- embedded base64 file entries for attachments and raw emails when files exist

The backup includes:

- `app: "unihub"`
- `version: 1`
- `exported_at`
- warnings
- `data`
- `files`
- `manifest_sha256`

Warnings are important: encrypted credentials only restore correctly when the
target deployment uses the same `ENCRYPTION_KEY`.

## JSON Import API

`POST /api/backup/import` accepts either the backup object directly or:

```json
{
  "mode": "dry-run",
  "backup": {}
}
```

Modes:

| Mode | Behavior |
| --- | --- |
| omitted / `dry-run` | Validate payload, checksums, and counts without writing |
| `apply` | Restore rows and files for the current user |

Validation checks:

- backup object shape
- `app === "unihub"`
- supported version
- file base64/checksum integrity
- manifest checksum when present

Import behavior:

- every imported row is assigned to the current user
- mail accounts are matched by email when possible
- restored files are written under the current user's upload roots
- inserts use upsert behavior for known IDs
- file checksum mismatch aborts restore

## Async ZIP Export Jobs

The ZIP export path creates a downloadable archive under
`/app/uploads/backups/<userId>/`.

Supported sections:

- `contacts`
- `calendar`
- `todo`
- `mail`
- `recordings`
- `settings`

Starting a job:

```json
{
  "sections": ["contacts", "mail"]
}
```

If `sections` or `scope` is omitted, a full export is created.

Jobs are stored in `data_export_jobs` and run in-process. Queued/running jobs are
resumed on API startup.

## ZIP Contents

Every ZIP contains:

- `manifest.json`
- `checksums.json`

Section contents:

| Section | Files |
| --- | --- |
| `settings` | `settings/profile.json`, `settings/preferences.json` |
| `contacts` | `contacts/contacts.vcf`, `contacts/contacts.json` |
| `calendar` | `calendar/events.ics`, `calendar/calendar-data.json` |
| `todo` | `todo/todos.ics`, `calendar/calendar-data.json` |
| `mail` | `mail/mail-metadata.json`, `mail/eml/*.eml`, `mail/attachments/...` |
| `recordings` | `recordings/recordings.json`, `recordings/files/...` |

Mail export prefers raw `.eml` snapshots from `/app/uploads/mail-raw`. If a raw
file is missing, it writes a basic RFC 822 fallback from stored email fields.

## API Endpoints

All endpoints require authentication. State-changing endpoints require CSRF.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/backup/jobs` | List latest 25 export jobs |
| POST | `/api/backup/jobs` | Start ZIP export job |
| GET | `/api/backup/jobs/:id` | Get job status |
| GET | `/api/backup/jobs/:id/download` | Download ready ZIP and mark `downloaded_at` |
| DELETE | `/api/backup/jobs/:id` | Delete job and generated ZIP |
| GET | `/api/backup/export` | Download JSON backup |
| POST | `/api/backup/import` | Dry-run or apply JSON restore |

Job status values:

- `queued`
- `running`
- `ready`
- `failed`

## Security Notes

- All backup/export routes are scoped by current `user_id`.
- Download paths are checked to stay under `/app/uploads/backups`.
- JSON backup files can contain private mail content and encrypted credentials.
- ZIP exports can contain private mail, recordings, and attachments.
- Store exports securely and delete old jobs when no longer needed.

## Limitations

- Export jobs are in-process, not distributed.
- There is no scheduled export or automatic retention policy.
- JSON import is designed for same-app restore, not arbitrary migration across
  incompatible schema versions.
- Encrypted mail/calendar credentials require the same `ENCRYPTION_KEY` after restore.
- ZIP export is a download/export format, not an import format.
