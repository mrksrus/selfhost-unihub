# Email Attachments Technical Documentation

## Overview

UniHub stores email attachments on disk and metadata in MySQL. Attachments come
from two paths:

- IMAP sync, including regular attachments and inline `cid:` images
- SMTP compose, where sent attachments are saved with the sent-mail copy

## Storage

### Filesystem

Attachment root:

```text
/app/uploads/attachments/<userId>/
```

Filename pattern during mail sync and send:

```text
<emailId>-<attachmentId>-<sanitized_filename>
```

The `uploads_data` Docker volume persists this path in the default Compose
deployment.

### Database

Table: `email_attachments`

| Column | Purpose |
| --- | --- |
| `id` | UUID primary key |
| `email_id` | Parent email |
| `user_id` | Owner, used for direct attachment authorization |
| `filename` | Original filename |
| `content_type` | MIME type from parser/send payload |
| `size_bytes` | Stored file size |
| `storage_path` | Absolute path under attachment root |
| `content_id` | CID for inline attachments, null for regular files |
| `created_at` | Insert timestamp |

## IMAP Sync Processing

An import stages the raw message and all parsed attachments before committing
the message metadata. Each attachment receives an ID and sanitized storage
filename. Inline `cid:` references are rewritten to authenticated attachment
URLs in the stored HTML.

The message, attachment rows, import-complete flag and eligible queue entries
commit in one database transaction. A failed attachment write leaves the import
incomplete and retryable; it is not silently accepted as a complete message.
Rollback removes newly staged files. An uncertain commit preserves the files
because their metadata may already have committed. See [Mail sync](MAIL_SYNC.md).

## Download Endpoint

`GET /api/mail/attachments/:id`

Behavior:

1. Requires authenticated session.
2. Selects the attachment by `id` and `user_id`.
3. Resolves the stored path.
4. Rejects paths outside `/app/uploads/attachments`.
5. Checks the file and streams it from disk; disconnects close the stream.
6. Normalizes common MIME types from filename when stored content type is generic.

The request handler sets `Content-Disposition: attachment` for raw attachment
responses. Inline images still load through the authenticated endpoint because
their `cid:` references are replaced before rendering.

## Frontend Rendering

HTML email content is rendered by
`src/components/mail/SafeEmailContent.tsx` inside:

```tsx
<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html} />
```

The sandbox blocks scripts, forms and same-origin access while allowing links
to open separate windows. Remote image loading requires approval scoped to the
selected email. Dark mode first offers a plain-text reading view extracted in
an inert template; the original HTML view is an explicit option. When HTML is
unavailable, the component renders the plain-text body.

Regular attachments are listed below the email body. Clicking one calls
`api.getBlob('/mail/attachments/<id>')` with cookie credentials.

## Compose Attachments

`POST /api/mail/send` accepts base64-encoded attachment objects:

```json
{
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "dataBase64": "..."
}
```

Limits enforced by the backend:

- max 20 attachments
- max 15 MB per attachment after base64 decode
- max 25 MB total decoded attachment bytes
- route request body cap: 40 MB (allows for base64 expansion and message text)

Sent attachments are written to the same attachment root and linked to the local
sent-mail copy.

## Cleanup Behavior

Attachment files are deleted when:

- a mail account is deleted through `DELETE /api/mail/accounts/:id`
- all mail accounts are cleared through `POST /api/settings/clear-mail-accounts`
- the user account is deleted through `DELETE /api/settings/account`

There is no age-based attachment cleanup job.

## Security Notes

- Download authorization uses the attachment `user_id`.
- File serving has a path traversal guard.
- Email HTML is isolated in a sandboxed iframe.
- Attachment paths are not exposed as direct static files.
- State-changing mail routes require CSRF validation.

## Related Raw Email Storage

The mail sync service also stores raw imported email source below:

```text
/app/uploads/mail-raw/<userId>/
```

Those `.eml` files are used by backup/restore workflows and are cleaned up during
account deletion where applicable.

## Backup and Restore

Mail backups include:

- each `email_attachments` metadata row
- each present attachment file
- each present raw `.eml` archive
- SHA-256 metadata used during validation and copy

Restore writes files into a job-specific directory below the appropriate user
storage root, verifies checksums while copying, and stores the new path in the
restored database row. Failed or cancelled restores remove files created by that
job.

An attachment or raw archive that was already missing when the backup was
created is reported as a warning. A file declared present in the backup but
missing or checksum-invalid causes validation to fail.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Limitations

- No inline preview UI for regular attachments.
- No antivirus or malware scanning.
- No per-user attachment quota.
- No automatic cleanup for orphaned files outside explicit delete flows.
