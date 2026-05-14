# Contacts Technical Documentation

## Overview

Contacts are per-user records stored in MySQL. The current implementation
supports:

- server-side search and grouping
- favorites and bulk delete
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
| `first_name` | Required for manual create; imports can derive it from other identity fields |
| `last_name` | Nullable |
| `email`, `email2`, `email3` | Up to three email addresses |
| `phone`, `phone2`, `phone3` | Up to three phone numbers |
| `company`, `job_title`, `notes` | Optional metadata |
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
| PUT | `/api/contacts/:id` | Update contact owned by the current user |
| DELETE | `/api/contacts/:id` | Delete contact owned by the current user |
| PUT | `/api/contacts/:id/favorite` | Set favorite status |
| POST | `/api/contacts/bulk-delete` | Delete multiple contacts by ID |
| POST | `/api/contacts/merge-duplicates/preview` | Preview duplicate groups and merge targets |
| POST | `/api/contacts/merge-duplicates` | Merge detected duplicate groups |
| GET | `/api/contacts/export` | Download `contacts.vcf` |
| POST | `/api/contacts/import` | Import vCard payload |

### List Query Parameters

`GET /api/contacts?q=alice&group=all&limit=200`

| Parameter | Behavior |
| --- | --- |
| `q` | Search first name, last name, all email fields, all phone fields, and company |
| `group` | `all`, `name_only`, or `number_or_email_only` |
| `limit` | 1-2000, default 2000 |

Results are ordered by favorite status, then first name, then last name.

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

Use the preview endpoint before applying merge in UI flows.

## Frontend Behavior

The contacts page provides:

- debounced search
- group tabs
- create/edit dialog
- favorite toggle
- bulk selection and delete
- vCard import/export
- duplicate merge actions
- clickable `mailto:` and `tel:` links

The user preference `email_link_behavior` controls whether email links open the
system mail client (`mailto`) or UniHub mail composition (`internal`) where the
frontend supports it.

## Security Notes

- All reads and writes are scoped by `user_id`.
- SQL queries are parameterized.
- State-changing routes require CSRF validation.
- Import size is capped by the request handler.

## Limitations

- vCard 3.0 is the primary supported format.
- Only the first three emails and first three phone numbers are stored.
- Photos and postal addresses are not imported/exported.
- Duplicate detection is based on normalized email/phone identity, not fuzzy name matching.
