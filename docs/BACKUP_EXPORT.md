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
- user preferences
- contacts
- calendar accounts/calendars/events/subtasks/attendees/external refs
- mail folders
- mail sender rules
- mail accounts with encrypted credentials
- mail account connection settings such as provider, username, IMAP/SMTP hosts,
  ports, TLS trust metadata, sync limit, active state, and `last_synced_at`
- server-deletion account metadata may appear in backups, but restore always
  disables provider-side deletion for safety
- emails
- email sync identity metadata: `message_id`, `source_folder`, `imap_uid`, and
  `imap_uidvalidity`
- email attachment metadata
- mail email score metadata when present
- embedded base64 file entries for attachments and raw emails when files exist
- recordings, recording tags, tag links, and embedded recording files

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
  "sections": "full",
  "backup": {}
}
```

Modes:

| Mode | Behavior |
| --- | --- |
| omitted / `dry-run` | Validate payload, checksums, and counts without writing |
| `apply` | Restore rows and files for the current user |

`sections` can be `"full"` or an array containing any of:

- `settings`
- `contacts`
- `calendar` / `todo` (both map to the shared calendar/to-do tables)
- `mail`
- `recordings`

Validation checks:

- backup object shape
- `app === "unihub"`
- supported version
- file base64/checksum integrity
- manifest checksum when present

Import behavior:

- every imported row is assigned to the current user
- settings import restores profile display metadata and user preferences for the
  current account, but not role or active-state privileges
- mail accounts are matched by email when possible
- restored mail accounts always set `delete_emails_on_server` to false and clear
  server-deletion timing fields, even when restoring over an existing account
- imported email rows are matched to existing local mail by row ID, then
  `(mail_account_id, message_id)`, then
  `(mail_account_id, source_folder, imap_uid, imap_uidvalidity)` to avoid
  duplicate rows when restoring into an already-synced account
- mail sync metadata is restored so the next IMAP sync can skip already-imported
  messages instead of downloading them again
- server-deletion queue rows are not restored; if the user later enables
  provider-side deletion, UniHub regenerates the queue from safe imported mail
- restored files are written under the current user's upload roots
- inserts use upsert behavior for known IDs
- file checksum mismatch aborts restore
- recordings with missing embedded audio files are skipped during apply

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
- There is no scheduled export or automatic retention policy. Manual backup and
  export is intentional.
- JSON import is designed for same-app restore, not arbitrary migration across
  incompatible schema versions.
- Encrypted mail/calendar credentials require the same `ENCRYPTION_KEY` after restore.
- ZIP export is a download/export format, not an import format.
