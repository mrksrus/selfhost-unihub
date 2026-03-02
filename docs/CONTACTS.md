# Contacts - Technical Documentation

## Overview

UniHub provides contact management with vCard 3.0 import/export, search, group filtering, favorites, and bulk operations.

## Database Schema (`contacts` table)

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `user_id` | UUID | FK to `users` |
| `first_name` | VARCHAR(255) | Required |
| `last_name` | VARCHAR(255) | Nullable |
| `email` | VARCHAR(255) | Nullable |
| `phone` | VARCHAR(50) | Nullable |
| `company` | VARCHAR(255) | Nullable |
| `job_title` | VARCHAR(255) | Nullable |
| `notes` | TEXT | Nullable |
| `is_favorite` | BOOLEAN | Default false |
| `created_at` | TIMESTAMP | Auto-set |
| `updated_at` | TIMESTAMP | Auto-updated |

Indexes: `idx_contacts_user`, `idx_contacts_email`, `idx_contacts_favorite`.

## API Endpoints

All endpoints require authentication via session cookie. State-changing requests require a valid `X-CSRF-Token` header.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/contacts` | List contacts (supports `?q=` search and `?group=` filter) |
| POST | `/api/contacts` | Create a contact |
| PUT | `/api/contacts/:id` | Update a contact (ownership enforced) |
| DELETE | `/api/contacts/:id` | Delete a contact (ownership enforced) |
| PUT | `/api/contacts/:id/favorite` | Toggle favorite status |
| POST | `/api/contacts/import` | Import contacts from vCard file |
| GET | `/api/contacts/export` | Export all contacts as a `.vcf` download |
| POST | `/api/contacts/bulk-delete` | Delete multiple contacts by ID |

### Search and group filtering

`GET /api/contacts?q=alice&group=name_only`

- `q`: full-text search across first name, last name, email, phone, company.
- `group`: `all` (default), `name_only` (contacts with only a name), `number_or_email_only` (contacts that have a phone or email).

## vCard Import

### Process

1. User uploads a `.vcf` file via the frontend file picker.
2. File content is sent as a JSON string to `POST /api/contacts/import` (max 500 KB).
3. The backend splits the file into individual `BEGIN:VCARD` ... `END:VCARD` blocks.
4. Each block is parsed: `N`, `FN`, `EMAIL`, `TEL`, `ORG`, `TITLE`, `NOTE` properties are extracted.
5. Encoding is handled automatically (quoted-printable decoding, vCard character escaping).
6. Contacts are inserted into the database; the response reports how many were imported.

### Property mapping

| vCard property | Database field | Notes |
|----------------|---------------|-------|
| `N` | `first_name`, `last_name` | Format: `Last;First` |
| `FN` | `first_name`, `last_name` | Fallback when `N` is absent |
| `EMAIL` | `email` | First email used |
| `TEL` | `phone` | First phone used |
| `ORG` | `company` | |
| `TITLE` | `job_title` | |
| `NOTE` | `notes` | |

### Compatibility

Tested with exports from Google Contacts, Apple Contacts, and Microsoft Outlook (vCard 3.0). Quoted-printable encoding from Apple is handled automatically.

## vCard Export

1. User clicks Export in the UI.
2. Frontend calls `api.getBlob('/contacts/export')` -- this uses the cookie-based session (no manual bearer token needed).
3. The backend generates a vCard 3.0 string for each contact, concatenates them, and returns the file with `Content-Type: text/vcard` and `Content-Disposition: attachment; filename="contacts.vcf"`.

## Frontend Features

- Contact list with real-time debounced search (300 ms)
- Group tabs: All, Name only, Number/email only
- Create/edit dialog with form validation
- Favorite toggle (star icon)
- Bulk selection with checkboxes and bulk delete
- Import (file picker for `.vcf` files)
- Export (downloads `contacts.vcf`)
- Clickable `mailto:` and `tel:` links on contact cards

## Security

- All endpoints enforce `user_id` ownership via parameterised SQL queries.
- CSRF token required on all state-changing operations.
- Export uses cookie auth (`credentials: 'include'`) -- no token in localStorage or URL.
- Import body size capped at 500 KB.

## Limitations

- Only vCard 3.0 supported (not 2.1 or 4.0).
- Single email and phone per contact (first value used on import).
- No photo/avatar support.
- No address fields.
- No automatic duplicate detection on import.
