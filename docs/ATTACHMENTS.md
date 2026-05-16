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

For each parsed attachment:

1. Generate an attachment UUID.
2. Sanitize the filename for filesystem use.
3. Write the content to `/app/uploads/attachments/<userId>/`.
4. Insert an `email_attachments` row.
5. If the attachment has `contentId`/`cid`, replace matching `cid:` URLs in the
   email HTML body with `/api/mail/attachments/<attachmentId>`.
6. If inline replacements changed the HTML, update `emails.body_html`.

Individual attachment write failures are logged and skipped. The parent email
sync continues.

## Download Endpoint

`GET /api/mail/attachments/:id`

Behavior:

1. Requires authenticated session.
2. Selects the attachment by `id` and `user_id`.
3. Resolves the stored path.
4. Rejects paths outside `/app/uploads/attachments`.
5. Reads the file and returns it as a raw response.
6. Normalizes common MIME types from filename when stored content type is generic.

The request handler sets `Content-Disposition: attachment` for raw attachment
responses. Inline images still load through the authenticated endpoint because
their `cid:` references are replaced before rendering.

## Frontend Rendering

HTML email content is rendered by
`src/components/mail/SafeEmailContent.tsx` inside:

```tsx
<iframe sandbox="" srcDoc={html} />
```

An empty sandbox blocks scripts, forms, popups, and same-origin access. When
HTML is unavailable, the component renders plain text in a preformatted block.

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
- route request body cap: 30 MB

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

## Limitations

- No inline preview UI for regular attachments.
- No antivirus or malware scanning.
- No per-user attachment quota.
- No automatic cleanup for orphaned files outside explicit delete flows.
