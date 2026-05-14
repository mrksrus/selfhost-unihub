# Mail Sync Technical Documentation

## Overview

UniHub stores mail locally after fetching it from IMAP providers and sends
outbound mail through SMTP. The mail system includes:

- encrypted mail credentials
- strict TLS by default
- host policy checks for unknown/private mail hosts
- multi-folder IMAP import for common provider folders
- app-owned folders and sender/domain routing rules
- raw `.eml` archiving
- attachment storage and inline `cid:` rewriting
- manual, periodic, and service-worker background sync triggers

## Components

| Component | Module/library | Role |
| --- | --- | --- |
| IMAP client | `imap-simple` | Connect, search, fetch messages |
| Parser | `mailparser` | Parse RFC 822 messages |
| SMTP sender | `nodemailer` | Send composed mail |
| Encryption | `api/src/security/encryption.js` | AES-256-GCM encryption for stored credentials |
| Host policy | `api/src/services/mail.js` | DNS/private-IP checks and known-provider classification |
| Raw archive | filesystem | Stores imported `.eml` source below `/app/uploads/mail-raw` |
| Attachments | filesystem + DB | Stores regular and inline attachments below `/app/uploads/attachments` |

## Database Tables

| Table | Purpose |
| --- | --- |
| `mail_accounts` | IMAP/SMTP settings, encrypted password, sync metadata, TLS trust state |
| `mail_folders` | Per-user app folder catalog |
| `mail_sender_rules` | Sender/domain routing rules |
| `emails` | Local email metadata, bodies, folder, read/star state, raw archive path |
| `email_attachments` | Attachment metadata and storage path |
| `mail_email_scores` | Reserved schema for future scam/spam scoring |

## Account Creation Flow

`POST /api/mail/accounts` accepts account details, validates the mail host, tests
IMAP credentials, saves the account, optionally attempts CalDAV import, then
starts mail sync in the background.

Main payload fields:

| Field | Notes |
| --- | --- |
| `email_address` | Required |
| `encrypted_password` | Required; despite the name, this is the plaintext password from the client and is encrypted server-side |
| `provider` | Stored provider label |
| `username` | Optional IMAP/SMTP username; defaults to email address |
| `imap_host`, `imap_port` | Required host, port defaults to 993 |
| `smtp_host`, `smtp_port` | Required host, port defaults to 587 |
| `sync_fetch_limit` | Currently normalized to `all` |
| `accept_host_trust` | Allows a user-confirmed TLS trust exception |
| `try_calendar_sync`, `caldav_url` | Optional one-time CalDAV discovery/import after mail account creation |

### Host Policy

Before saving an account, the backend:

1. normalizes IMAP and SMTP hosts
2. classifies known provider suffixes such as Gmail, iCloud, Yahoo, Outlook, and Office 365
3. checks `TRUSTED_MAIL_HOSTS`
4. resolves DNS and detects private/local addresses
5. blocks private/local hosts unless allowlisted
6. returns warnings for unknown hosts
7. requires explicit user confirmation for TLS trust failures

Self-hosted mail servers that resolve to private/local addresses must be listed
in `TRUSTED_MAIL_HOSTS`.

## Sync Triggers

| Trigger | Endpoint/process | Behavior |
| --- | --- | --- |
| Initial account add | account creation route | starts non-blocking sync when no other sync is running |
| Periodic server sync | `api/src/app.js` interval | every 10 minutes for active accounts |
| Manual sync | `POST /api/mail/sync` | waits for sync result for one account |
| Service worker sync | `POST /api/mail/sync/background` | starts at most one sync if data is stale |

Only one mail sync runs at a time. A second request returns an already-running
result or skips starting a new sync.

## IMAP Folder Strategy

The sync service lists provider folders and selects common folder names:

| UniHub folder | IMAP names checked |
| --- | --- |
| `inbox` | `INBOX` |
| `sent` | `Sent`, `Sent Items`, `Sent Mail`, Gmail sent folders |
| `archive` | `Archive`, `Archives`, Gmail all-mail folders |
| `trash` | `Trash`, `Deleted Items`, `Deleted Messages`, Gmail trash folders |

If no inbox candidate is found, `INBOX` is still tried.

System app folders created per user:

- `inbox`
- `sent`
- `archive`
- `trash`
- `important`
- `marketing`
- `scam`
- `unknown`
- `twofactor_notifications`

Users can create additional app-owned folders. These folders are local
classification targets; UniHub does not create corresponding provider folders.

## Fetch Strategy

For each selected folder:

1. Open the IMAP folder.
2. Read current `UIDVALIDITY` when available.
3. Search all messages on first sync, or `SINCE last_synced_at - 1 day` after that.
4. Extract numeric UIDs and abort cleanly if the provider returns malformed UID data.
5. Remove UIDs already stored locally for that account/folder.
6. Fetch each remaining message one at a time.
7. Build raw RFC 822 source from IMAP parts.
8. Parse with `mailparser`.
9. Detect existing imports by `message_id` or `(account, source_folder, imap_uid)`.
10. Repair older incomplete rows when possible.
11. Store the raw `.eml`, metadata, text body, HTML body, and attachment metadata.
12. Apply sender routing rules before insert.
13. Update `last_synced_at` after successful folder processing.

Fetching one UID at a time is slower, but it limits memory use and lets one bad
message fail without losing the whole sync.

## Sender Routing Rules

Rules route new inbound messages into app folders during sync.

| Rule field | Notes |
| --- | --- |
| `match_type` | `email` or `domain` |
| `match_value` | normalized sender email or domain |
| `target_folder` | existing mail folder slug |
| `mail_account_id` | optional account scope; null means global |
| `priority` | lower number wins |
| `is_active` | inactive rules are ignored |

Resolution order:

1. account-scoped rules before global rules
2. email rules before domain rules
3. lower priority first
4. older creation time first
5. ID tie-breaker

Rule endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/sender-rules` | List rules |
| POST | `/api/mail/sender-rules` | Create rule |
| PUT | `/api/mail/sender-rules/:id` | Update rule |
| DELETE | `/api/mail/sender-rules/:id` | Delete rule |
| POST | `/api/mail/sender-rules/backfill` | Dry-run or apply routing to existing inbox mail |

`POST /api/mail/sender-rules/backfill` is dry-run by default. Use
`{ "mode": "apply" }` to move matched existing messages.

## Mail API Endpoints

### Folders

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/folders` | List folders with total/unread counts |
| POST | `/api/mail/folders` | Create app-owned folder |
| PUT | `/api/mail/folders/:slug` | Rename/reposition folder |
| DELETE | `/api/mail/folders/:slug` | Delete custom folder; messages/rules move to inbox |

System folders cannot be deleted.

### Accounts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/accounts` | List accounts with unread counts |
| POST | `/api/mail/accounts` | Add account and start initial sync |
| PUT | `/api/mail/accounts/:id` | Update account settings and retest IMAP when needed |
| DELETE | `/api/mail/accounts/:id` | Delete account and attachment files for that account |

### Messages

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mail/emails` | List/paginate emails |
| GET | `/api/mail/emails/:id` | Load full email and regular attachment list |
| PUT | `/api/mail/emails/:id/read` | Set read state |
| PUT | `/api/mail/emails/:id/star` | Set starred state |
| POST | `/api/mail/emails/bulk-delete` | Move selected messages to `trash` |
| POST | `/api/mail/emails/bulk-move` | Move selected messages to another app folder |
| POST | `/api/mail/emails/bulk-update` | Bulk read/star updates |
| GET | `/api/mail/unread-counts` | Unread counts by folder and optionally account |
| GET | `/api/mail/attachments/:id` | Authenticated attachment download |
| POST | `/api/mail/sync` | Manual sync for one account |
| POST | `/api/mail/sync/background` | Non-blocking background sync trigger |
| POST | `/api/mail/send` | Send mail through SMTP |

`GET /api/mail/emails` supports `folder`, `account_id`, `is_read`,
`is_starred`, `search`, `limit`, `offset`, and `include_count`.

## SMTP Sending

`POST /api/mail/send` sends with strict TLS by default and saves a local copy in
the `sent` folder.

Compose attachment limits:

- maximum 20 attachments
- maximum 15 MB per attachment
- maximum 25 MB total attachment bytes
- request body cap is 30 MB to allow base64 JSON overhead

SMTP port behavior:

- port 465 uses implicit TLS
- other ports require STARTTLS

## Password Encryption

Stored mail passwords use AES-256-GCM through `api/src/security/encryption.js`.
The encryption key is derived from `ENCRYPTION_KEY` with SHA-256. Stored format:

```text
iv_hex:auth_tag_hex:ciphertext_hex
```

The password is decrypted only when opening IMAP/SMTP connections or optional
CalDAV import connections.

## Security Notes

- Mail account rows are scoped by `user_id`.
- State-changing endpoints require CSRF validation.
- CORS is controlled by `ALLOWED_ORIGINS`.
- Private/local mail hosts are blocked unless allowlisted.
- TLS certificate verification is strict unless the user explicitly accepts a trust exception.
- Email HTML is rendered by the frontend inside a sandboxed iframe.
- Attachments are served only through authenticated API routes with path guards.

## Limitations

- Provider-side delete sync is not implemented.
- Draft sync is not implemented.
- App folder moves are local and are not propagated to provider folders.
- First full imports can be slow for large mailboxes.
- There is no malware scanning for downloaded or uploaded attachments.
