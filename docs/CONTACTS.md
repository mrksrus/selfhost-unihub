# Contacts Technical Documentation

## Overview

Contacts are per-user records stored in MariaDB. The current implementation
supports:

- server-side search and grouping
- favorites, bulk delete and bulk company/job title update
- up to three email addresses and three phone numbers per contact
- vCard 3.0 import/export
- import-time duplicate skipping
- duplicate preview and merge across existing contacts

## Data Model

Primary table: `contacts`

| Column | Notes |
| --- | --- |
| `id` | UUID primary key |
| `user_id` | Owner, cascades when the user is deleted |
| `first_name` | Required for manual create (100 characters); may be empty on edit; imports can derive it from other identity fields |
| `last_name` | Nullable, 100 characters |
| `email`, `email2`, `email3` | Up to three email addresses, 255 characters each, stored as typed (no format check, so contacts from phones and vCards keep syncing) |
| `phone`, `phone2`, `phone3` | Up to three phone numbers, 50 characters each |
| `company`, `job_title`, `notes` | Optional metadata; 255 characters each, `notes` is TEXT (65535 bytes) |
| `avatar_url` | Stored field, currently not populated by vCard import |
| `is_favorite` | Favorite flag |
| `created_at`, `updated_at` | Database timestamps |

Important indexes:

- `idx_contacts_user`
- `idx_contacts_name`
- `idx_contacts_email`
- `idx_contacts_favorite`
- `idx_contacts_user_fav_name`

## API Endpoints

All endpoints require an authenticated session cookie. State-changing requests
require `X-CSRF-Token`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/contacts` | List contacts |
| POST | `/api/contacts` | Create contact |
| PUT | `/api/contacts/:id` | Update contact owned by the current user; 404 when the id is not one of the caller's contacts |
| DELETE | `/api/contacts/:id` | Delete contact owned by the current user |
| PUT | `/api/contacts/:id/favorite` | Set favorite status |
| POST | `/api/contacts/bulk-delete` | Delete multiple contacts by ID |
| POST | `/api/contacts/bulk-update` | Set `company` and/or `job_title` on multiple contacts (`{ ids, contact }`) |
| POST | `/api/contacts/merge-duplicates/preview` | Preview duplicate groups and merge targets |
| POST | `/api/contacts/merge-duplicates` | Merge detected duplicate groups |
| GET | `/api/contacts/export` | Download `contacts.vcf` |
| POST | `/api/contacts/import` | Import vCard payload |

### Input Validation

`POST /api/contacts` and `PUT /api/contacts/:id` run the body through
`normalizeContactInput` (`api/src/services/contacts.ts`): every field must be
text or absent, is trimmed, an empty value becomes `NULL`, a value longer than
its column is refused with 400 naming the limit. Email fields are not checked
for a format. A first name is required to create a contact; an edit may leave
it empty, as a vCard imported without a name has none. The route ids come from
the matcher (`req.params.id`), so a query string on the URL does not become
part of the id.

### List Query Parameters

`GET /api/contacts?q=alice&group=all&limit=200&offset=0`

| Parameter | Behavior |
| --- | --- |
| `q` | Search first name, last name, all email fields, all phone fields, and company; `%`, `_` and `\` match literally |
| `group` | `all`, `name_only`, or `number_or_email_only` |
| `limit` | 1-2000, default 2000 |
| `offset` | Starting row offset, default 0 |

The response contains `contacts`, `has_more`, and `offset`. Results are ordered
by favorite status, then first name, last name, and ID for stable page ordering.
Fetch the next offset while `has_more` is true to retrieve the full result set.

## vCard Import

`POST /api/contacts/import` accepts JSON:

```json
{
  "vcf_data": "BEGIN:VCARD..."
}
```

The request body limit for this route is 500 KB.

Import behavior:

1. vCard continuation lines are unfolded.
2. `N`, `FN`, `EMAIL`, `TEL`, `ORG`, `TITLE`, and `NOTE` are parsed.
3. Quoted-printable values and escaped vCard text are decoded.
4. The first three unique email values and first three unique phone values are kept.
5. Contacts with no useful identity field are skipped.
6. Duplicate identity keys are skipped within the uploaded file.
7. Existing contacts with the same normalized email or phone are skipped.
8. A field longer than its column (for example a 300-character `ORG`) is cut
   to the column size; the card is imported rather than reported as failed.

Property mapping:

| vCard property | Contact fields |
| --- | --- |
| `N` | `last_name`, `first_name` |
| `FN` | fallback name when `N` is absent |
| `EMAIL` | `email`, `email2`, `email3` |
| `TEL` | `phone`, `phone2`, `phone3` |
| `ORG` | `company` |
| `TITLE` | `job_title` |
| `NOTE` | `notes` |

## vCard Export

`GET /api/contacts/export` returns vCard 3.0 with:

- one card per contact
- all non-empty email and phone fields
- `ORG`, `TITLE`, and `NOTE` when present
- `Content-Type: text/vcard`
- `Content-Disposition` for `contacts.vcf`

The endpoint returns 404 when the current user has no contacts.

## Duplicate Merge

Duplicate detection groups contacts by normalized email and phone identity keys.
The merge process:

1. ranks contacts by completeness score and age
2. keeps the highest-ranked contact as the primary row
3. combines unique emails and phones up to the three-field limit
4. preserves favorite status if any duplicate was favorited
5. concatenates unique notes
6. deletes the duplicate rows after updating the primary row

Each group's update and deletions run in one transaction
(`mergeDuplicateGroups` in `api/src/services/contacts.ts`), so an interruption
leaves a group either merged or untouched. A group whose primary row no longer
exists is skipped and not counted.

Use the preview endpoint before applying merge in UI flows.

## Frontend Behavior

The contacts page provides:

- debounced search
- group tabs
- create/edit dialog
- favorite toggle
- bulk selection (avatar tap, Ctrl/Cmd+click, Shift+click range), bulk delete and set company/job title
- vCard import/export
- duplicate merge actions
- clickable `mailto:` and `tel:` links

The shared contact loader follows every API page, so lists above 2,000 contacts
are not truncated. Group tabs, search and duplicate previews operate on the
complete loaded list. The mail composer reuses the same account-scoped contact
cache when address suggestions are needed. Offline snapshots also contain all
contacts within the device snapshot size limit.

The user preference `email_link_behavior` controls whether email links open the
system mail client (`mailto`) or UniHub mail composition (`internal`) where the
frontend supports it.

## Security Notes

- All reads and writes are scoped by `user_id`.
- SQL queries are parameterized.
- State-changing routes require CSRF validation.
- Import size is capped by the request handler.

## Backup and Restore (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Contact backups preserve all supported contact fields, including secondary
emails/phones, company, job title, notes, avatar URL, and favorite state.

Restore matches contacts by ID, normalized email, then normalized name with
phone/email fallback. Keep existing avoids duplicate creation by default;
Replace matching updates matched rows; Keep both creates a new contact ID.

The contact section is read-only only while a restore containing contacts is
queued/running.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Limitations

- vCard 3.0 is the primary supported format.
- Only the first three emails and first three phone numbers are stored.
- Photos and postal addresses are not imported/exported.
- Duplicate detection is based on normalized email/phone identity, not fuzzy name matching.
