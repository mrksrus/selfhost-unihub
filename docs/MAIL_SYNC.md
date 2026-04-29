# Mail Sync - Technical Documentation

## Overview

UniHub synchronises email using the IMAP protocol to fetch messages from external providers (Gmail, iCloud, Yahoo, Outlook, or any standard IMAP server) and stores them locally in MySQL. Outbound mail is sent via SMTP.

## Components

| Component | Library / Module | Role |
|-----------|-----------------|------|
| IMAP client | `imap-simple` | Connect, authenticate, search, fetch |
| Email parser | `mailparser` | Parse RFC 822 messages into structured data |
| SMTP sender | `nodemailer` | Send composed/reply/forwarded emails |
| Encryption | Node.js `crypto` (AES-256-GCM) | Encrypt/decrypt stored mail account passwords |
| TLS inspector | Node.js `tls` | Fetch certificate metadata during host/certificate verification |
| DNS resolver | Node.js `dns.promises` | Resolve mail hosts to detect private/local addresses |

## Database Tables

- `mail_accounts` -- credentials (encrypted), IMAP/SMTP settings, last-sync timestamp, user association
- `mail_accounts.sync_fetch_limit` -- initial import mode (`all`)
- `emails` -- message metadata, plain-text body, HTML body, folder, read/starred status
- `email_attachments` -- attachment metadata, filesystem path, Content-ID for inline images
- `mail_folders` -- app-owned folder catalog per user (system folders + custom UI targets)
- `mail_sender_rules` -- active sender/domain-to-folder routing rules (global + account-scoped precedence)
- `mail_email_scores` -- future scam/spam scoring snapshots per email (schema ready, logic not active yet)

## Account Creation Flow

### 1. Preflight host assessment

Before an account is saved or its server settings are changed, the backend verifies the IMAP and SMTP host/port. The backend:

1. Classifies each host as **known provider** (Gmail, iCloud, Yahoo, Outlook, Hotmail, Live) or **unknown**.
2. Checks whether the host appears in the `TRUSTED_MAIL_HOSTS` env allowlist.
3. Resolves the hostname via DNS and checks whether any resolved address is private or local (RFC 1918, loopback, link-local, IPv6 ULA/link-local).
4. If the host resolves to a private/local address and is not allowlisted, the request is **blocked** (HTTP 400).
5. If the host is unknown or a TLS certificate cannot be fully verified, the backend returns warnings plus certificate metadata (subject, issuer, validity, fingerprint).

The frontend displays a "Confirm Mail Server Authenticity" dialog with the warnings and certificate details. The user must explicitly continue before the account is created or updated.

### 2. Connection test

After host/certificate verification passes (or the user confirms), the backend:

1. Encrypts the password with AES-256-GCM and creates a temporary account object.
2. Opens a test IMAP connection to verify credentials (`testImapConnection`).
3. If authentication fails, returns an error immediately without saving.

### 3. Account persistence and initial sync

On success:

1. The account is inserted into `mail_accounts`.
2. A background sync (`syncMailAccount`) is started immediately (non-blocking).
3. The API returns `{ authSuccess: true, syncInProgress: true }`.

## Sync Process

### Trigger points

- **Automatic**: every 10 minutes for active accounts when no mail sync is already running
- **Manual**: user clicks Sync in the UI (`POST /api/mail/sync`)
- **Initial**: immediately after account creation

### Fetch strategy

1. Connect to IMAP server (TLS on port 993, STARTTLS on port 143).
2. Discover supported mail folders and open each selected folder sequentially.
3. If last-sync timestamp exists, search with `SINCE` (minus 1-day safety margin). Otherwise search `ALL` for the first full import.
4. Remove UIDs that are already stored locally before downloading message bodies.
5. For each remaining UID, fetch the full RFC 822 message individually.
6. Parse with `mailparser`.
7. Check for duplicates by `message_id`.
8. Resolve destination folder using `mail_sender_rules` and sender normalization before insert (fallback: `inbox`).
9. Insert into `emails`; process attachments; replace inline `cid:` references with `/api/mail/attachments/{id}` URLs.
10. Update `last_synced_at` on the account.

### Sync limit behavior

- Initial sync imports all available messages.
- Later syncs are incremental and use `last_synced_at` plus local UID filtering so already-imported messages are not downloaded again.
- If the provider returns malformed or inconsistent UID search results, sync aborts with a clear error instead of importing partial/corrupt placeholders.
- No dummy/empty emails are created when counts mismatch.

### App-owned folders

System folders currently available in UI/API:

- `inbox`, `sent`, `archive`, `trash`
- `important`, `marketing`, `scam`, `unknown`, `twofactor_notifications`

### Active sender/domain routing behavior

Inbound sync resolves the destination folder at write-time using the sender rule resolver.

Resolution flow:

1. Normalize sender email to lowercase and trim spaces.
2. Derive sender domain from normalized email.
3. Load active user rules where scope is global (`mail_account_id IS NULL`) or matches the syncing account.
4. Deterministically sort candidates:
   - account-scoped rules before global rules
   - email match rules before domain match rules
   - lower `priority` value first
   - earlier `created_at` first (stable tie-break)
5. First matching rule wins. If no valid match exists, folder falls back to `inbox`.

Rule CRUD endpoints:

- `GET /api/mail/sender-rules`
- `POST /api/mail/sender-rules`
- `PUT /api/mail/sender-rules/:id`
- `DELETE /api/mail/sender-rules/:id`

Backfill endpoint:

- `POST /api/mail/sender-rules/backfill`
  - Dry-run by default (`mode` omitted)
  - Apply updates with `{ "mode": "apply" }`
  - Optional `account_id` filter and `limit` cap

### Why one-by-one fetching?

- A single malformed email does not break the entire sync.
- Progress is visible in real time via server logs.
- Memory usage stays bounded (no large batch buffers).

## TLS and Transport Security

All IMAP and SMTP connections use **strict TLS certificate verification** (`rejectUnauthorized: true`). This means:

- Self-signed certificates are rejected by default.
- The `servername` option is set for proper SNI.
- To use a self-hosted mail server that resolves to a private/local address, add its hostname to the `TRUSTED_MAIL_HOSTS` env var. If its certificate is self-signed or otherwise untrusted, the user will still see the confirmation dialog with certificate details.

Connection timeouts: 60 s connect, 30 s auth, 60 s socket.

## SMTP Sending

`POST /api/mail/send` accepts to, subject, body, and optional attachments (base64-encoded, max 20 files, 25 MB total). The backend:

1. Loads the sender's account and decrypts the password.
2. Creates a `nodemailer` transport with strict TLS.
3. Sends the message.
4. Saves a copy in the `emails` table with `folder = 'sent'`.

## Password Encryption

- Algorithm: AES-256-GCM
- Key derivation: SHA-256 hash of `ENCRYPTION_KEY` env var
- Format stored in DB: `iv_hex:auth_tag_hex:ciphertext_hex`
- Passwords are decrypted only at the moment of IMAP/SMTP connection.

## Error Handling

- Individual email failures during sync are logged and skipped; the sync continues.
- Connection errors (timeout, auth failure, DNS) return user-friendly messages.
- SMTP errors during send return the error to the client (without internal stack traces).

## Limitations

1. Draft folder sync is not implemented.
2. No server-side deletion sync (deletes are local only).
3. One-by-one fetching can be slow for large first imports.
