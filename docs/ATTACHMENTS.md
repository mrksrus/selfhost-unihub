# Email Attachments - Technical Documentation

## Overview

UniHub handles two kinds of email attachments during IMAP sync: **regular attachments** (downloadable files) and **inline attachments** (images embedded in HTML email bodies).

## Types

| Type | Stored where | Shown how |
|------|-------------|-----------|
| Regular | Filesystem + DB metadata | Listed below the email body with download links |
| Inline | Filesystem + DB metadata; `cid:` URLs replaced in HTML | Rendered inside the sandboxed email iframe |

## Storage

### Filesystem

- Location: `/app/uploads/attachments/`
- Naming convention: `{emailId}-{attachmentId}-{sanitised_filename}`
- Files are written as raw binary; no transcoding.

### Database (`email_attachments` table)

| Column | Purpose |
|--------|---------|
| `id` | UUID primary key |
| `email_id` | FK to `emails` |
| `user_id` | FK to `users` (for ownership checks) |
| `filename` | Original filename |
| `content_type` | MIME type |
| `size_bytes` | File size |
| `storage_path` | Absolute filesystem path |
| `content_id` | CID value for inline attachments (null for regular) |

## Processing During Sync

For each attachment found by `mailparser`:

1. Generate a UUID attachment ID.
2. Sanitise the filename (strip non-alphanumeric characters except `.`, `-`, `_`).
3. Write content to disk (handles Buffer, string, and stream inputs).
4. Insert metadata row into `email_attachments`.
5. If the attachment is inline (has a `contentId` / `cid`):
   - Replace all `cid:{value}` references in the email's HTML body with `/api/mail/attachments/{id}`.
   - Update the `body_html` column in `emails` with the rewritten HTML.

Individual attachment failures are logged and skipped; the rest of the email sync continues.

## Download Endpoint

### `GET /api/mail/attachments/:id`

1. Authenticate via session cookie.
2. Look up the attachment and verify the requesting user owns it (`user_id` check).
3. Resolve the filesystem path and apply a **path-traversal guard**: `path.resolve(storage_path)` must start with the uploads root (`/app/uploads/attachments`). Requests that escape this root are rejected.
4. Read the file and return it with the correct `Content-Type` and `Content-Disposition: attachment` headers.

Common MIME types (PDF, JPEG, PNG, plain text) are normalised from the filename extension if the stored `content_type` is generic.

## Frontend Rendering

### Email HTML (inline images)

Email HTML is rendered inside a **sandboxed iframe** (`<iframe sandbox="" srcDoc={html}>`). The empty `sandbox` attribute blocks all script execution, form submission, and popups. Inline images load via the attachment endpoint because the `cid:` URLs were already replaced during sync.

The `SafeEmailContent` component (`src/components/mail/SafeEmailContent.tsx`) encapsulates this:

- If `body_html` is available: render in sandboxed iframe.
- Otherwise: render `body_text` as preformatted plain text.

### Regular attachments

Displayed below the email body as a list showing filename, MIME type, and size. Each item is a button that triggers `api.getBlob('/mail/attachments/{id}')` and initiates a browser download.

## Compose Attachments

When composing/replying/forwarding, users can attach files from their device:

- Files are read client-side, base64-encoded, and sent in the `POST /api/mail/send` payload.
- Limits: max 20 attachments, each up to 15 MB, total up to 25 MB.
- The backend passes them to `nodemailer` for SMTP delivery.

## Security

- **Ownership check**: every download verifies the requesting user owns the attachment.
- **Path-traversal guard**: resolved path must stay within `/app/uploads/attachments`.
- **Sandboxed rendering**: inline images display inside a script-free iframe, preventing XSS from email HTML.
- **No direct filesystem access**: attachments are only served through the authenticated API endpoint.

## Limitations

1. No in-browser file preview (download only).
2. No virus/malware scanning.
3. No automatic cleanup of old attachments.
4. No server-enforced per-attachment size limit during sync (only during compose).
