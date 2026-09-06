# Auth, Admin, Settings, and Search Documentation

## Authentication Model

UniHub uses cookie-based sessions backed by the `sessions` table.

Session components:

- `auth-token`: HttpOnly JWT cookie
- `csrf-token`: HttpOnly CSRF cookie
- `sessions.token`: database copy of the JWT
- `sessions.expires_at`: 21-day expiry

Every authenticated request verifies:

1. token signature using `JWT_SECRET`
2. matching row in `sessions`
3. non-expired session
4. active user account

Each new JWT has a random `jti`, so simultaneous logins cannot collide on the
unique stored token. Existing tokens without this field remain valid.
Expired sessions are deleted hourly.

## CSRF Protection

For authenticated `POST`, `PUT`, and `DELETE` requests, the API requires:

- `csrf-token` cookie
- matching `X-CSRF-Token` header

CSRF is skipped for:

- `GET`, `HEAD`, `OPTIONS`
- `POST /api/auth/signin`
- `POST /api/auth/signup`
- `POST /api/mail/sync/background` when `X-Background-Sync: 1` is present

The frontend stores the CSRF token in memory via `src/lib/api.ts`; it does not
store auth tokens in localStorage.

The background-sync exception remains for older clients. The current service
worker does not poll mail; the server schedules mail discovery and sends Web
Push notifications.

## Browser Session State

Private React Query data belongs to the current account. Sign-in, sign-out and
account changes notify other tabs; the previous account's query cache is
unmounted and pending requests are cancelled before another account renders.
Provisional authentication checks do not erase the service worker's notification
deduplication state. Sign-out revokes the device subscription while the current
session is still available, then clears local identity and offline data.

An explicitly saved offline snapshot can reopen a read-only local viewing
identity after a network failure. It is not a cached `/auth/me` response or a
server session. Confirmed invalid sessions clear it; reconnection requires
server validation before writes resume. See [Offline reading](OFFLINE.md).

## Rate Limiting

Authentication uses bounded in-memory attempt budgets, consumed before expensive verification:

| Budget | Limit |
| --- | --- |
| All public authentication requests per resolved client IP | 60 per minute |
| Password checks per existing user ID | 10 per 10 minutes |
| Second-factor checks per user ID | 10 per 10 minutes |
| Signup requests per client IP | 10 per hour |

Success does not clear any budget. Password and second-factor budgets are
separate; a fresh password login cannot reset second-factor guesses. Account
budgets follow the database user ID, including email case variants. A limited
request returns HTTP 429 with `Retry-After` in seconds. The previous five-hour
blanket IP lockout is removed. Shared-IP users keep separate account budgets;
a high-volume network burst can still hit the short one-minute IP budget.
Counters reset on app restart; this release targets a single app container.

### Trusted proxies

`TRUST_PROXY_HEADERS=true` enables a right-to-left walk of `X-Forwarded-For`,
starting at the actual socket peer. Only hops listed in `TRUSTED_PROXY_CIDRS`
are trusted. The first untrusted address is the client; earlier supplied values
are ignored. `X-Real-IP` is not used. IPv4-mapped and equivalent IPv6 spellings
are normalized. Invalid proxy configuration prevents startup.

The default trusts `127.0.0.1/32,::1/128`, covering nginx bundled in this image.
If an additional HTTPS proxy connects from `172.20.0.8`, set the following in
the Compose `.env`, retaining the loopback entries:

```dotenv
UNIHUB_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,172.20.0.8/32
```

Replace that example with the actual proxy address or tightly scoped proxy
network you control. Compose maps this to the runtime `TRUSTED_PROXY_CIDRS`.
Do not trust all private networks or `0.0.0.0/0`. The outer proxy must append or
replace forwarded headers with the real connecting client, and direct access
to the backend should be restricted to that proxy where appropriate. Without
an explicitly trusted outer proxy, its IP remains the network-budget identity;
account limits still remain separate.

## Signup Flow

Signup mode is stored in `system_settings.signup_mode`.

| Mode | Behavior |
| --- | --- |
| `open` | New users are active immediately |
| `approval` | New users are created inactive and require admin approval |
| `disabled` | Signup is rejected |

The secure default is `disabled`. Startup also migrates older installs that had
the old implicit open default.

Public endpoint:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/signup-mode` | Return current signup mode |
| POST | `/api/auth/signup` | Create account according to signup mode |

## Sign-In Flow

`POST /api/auth/signin`:

1. checks rate limit
2. loads user by email
3. verifies bcrypt password
4. rejects inactive users
5. if 2FA is enabled, returns `requires2fa` and a challenge token
6. otherwise creates a session and sets auth/CSRF cookies

`POST /api/auth/2fa/login` consumes the challenge token and accepts either a
TOTP code or a recovery code. Challenge consumption, recovery-code removal and
session insertion commit together; errors roll them back. Concurrent reuse of
one challenge creates at most one session. Cookies are sent only after commit.

## Two-Factor Authentication

2FA data is stored on the `users` row:

- `two_factor_enabled`
- `encrypted_two_factor_secret`
- `two_factor_recovery_codes`

The secret is encrypted with the same encryption helper used for credentials.

Endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/2fa/status` | Current 2FA status and recovery-code count |
| POST | `/api/auth/2fa/setup/start` | Generate secret and `otpauth_uri` |
| POST | `/api/auth/2fa/setup/confirm` | Verify code, enable 2FA, return recovery codes |
| POST | `/api/auth/2fa/disable` | Require current password and second factor |
| POST | `/api/auth/2fa/recovery-codes/regenerate` | Require second factor and return new recovery codes |
| POST | `/api/auth/2fa/login` | Complete sign-in challenge |

Disabling 2FA deletes all other sessions for the user.

## Auth and Profile Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/signin` | Sign in |
| POST | `/api/auth/signout` | Delete current session and clear cookies |
| GET | `/api/auth/me` | Return current user and refresh CSRF token |
| PUT | `/api/auth/password` | Change password, delete all sessions, clear cookies |
| PUT | `/api/auth/profile` | Update full name and timezone |

Passwords must be at least 12 characters.

## Admin Endpoints

Admin routes require an authenticated user whose `users.role` is `admin`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/users` | List users |
| PUT | `/api/admin/users/:id/password` | Reset a user's password and delete their sessions |
| DELETE | `/api/admin/users/:id` | Delete user |
| PUT | `/api/admin/users/:id/role` | Set role to `user` or `admin` |
| PUT | `/api/admin/users/:id/activate` | Activate/deactivate user |
| GET | `/api/admin/storage` | Aggregate server storage counts and byte usage |
| GET | `/api/admin/settings/signup-mode` | Read signup mode |
| PUT | `/api/admin/settings/signup-mode` | Set signup mode |

Safety checks:

- admins cannot delete their own account through the admin delete endpoint
- the last active admin cannot be deleted
- the last active admin cannot be demoted
- the last active admin cannot be deactivated
- deactivating a user deletes their sessions

The storage overview returns aggregate counts and byte totals for mail
attachments, raw mail archives, recordings, and generated backup archives. It also
splits those byte totals per user account. It does not return message subjects,
filenames, contact records, or backup contents.

## User Preferences

Preferences are stored in `user_settings`.

Endpoint:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/settings/preferences` | Load current preferences |
| PUT | `/api/settings/preferences` | Update allowed preferences |

Supported preferences:

| Key | Allowed values | Default |
| --- | --- | --- |
| `email_link_behavior` | `mailto`, `internal` | `mailto` |
| `default_start_page` | `mail`, `calendar`, `todo`, `contacts`, `recordings`, `dashboard` | `mail` |

Unknown preference keys are ignored. Invalid values are rejected.

General Settings also contains browser/device preferences: **Appearance**
(Dark by default, Light or System), **Offline reading**, and **Notifications**.
Theme selection and offline copies belong to the browser profile; notification
permission and the subscription belong to the device/browser and signed-in
account. These are separate from the account preferences stored in
`user_settings`.

## User Data Management Endpoints

These routes are for the current user and require CSRF:

| Method | Path | Purpose |
| --- | --- | --- |
| DELETE | `/api/settings/account` | Delete current user and associated uploaded files |
| POST | `/api/settings/clear-contacts` | Delete all contacts |
| POST | `/api/settings/clear-calendar` | Delete calendar/to-do data and recreate default local calendar |
| POST | `/api/settings/clear-mail-accounts` | Delete all mail accounts and attachment files |
| POST | `/api/settings/clear-recordings` | Delete all recordings and files |
| GET | `/api/settings/mail-sender-candidates` | Suggest sender/domain rule candidates from local mail |

Account deletion clears auth and CSRF cookies after deleting the user.

During an active background restore, writes to affected sections return
`409 Restore in progress`. Reads and unaffected sections remain available.
Account deletion is blocked while any restore section is active.

## Backup Data Management

The Data Management tab also exposes generated backup and durable restore jobs:

- encrypted-by-default full and section backups
- background progress with start/end times
- cooperative Stop controls
- direct restore from a retained generated backup
- upload-once validation for `.zip` and `.unihub-backup`
- recovery-password input for portable encrypted uploads
- retry and deletion for retained restore jobs

Backup and restore job ownership is scoped to the signed-in user. Generated
archives remain until manually deleted. Uploaded archives expire after seven
days and are deleted after a successful restore.

Data Management loads its backup/restore view when first opened. Status polling
runs only while that Settings tab is active and a job is queued, running,
validating or cancelling. It stops for completed jobs and jobs waiting for a
password or restore confirmation.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Global Search

`GET /api/search?q=<query>&limit=<n>` searches across:

- contacts
- mail
- calendar events and to-dos
- recordings

Behavior:

- queries shorter than 2 characters return no results
- `limit` applies per result type, clamped to 1-20, default 8
- result objects include `type`, `title`, `subtitle`, `href`, and `entity_id`

## Stats Endpoint

`GET /api/stats` returns dashboard counts for the current user:

- contact count
- upcoming non-cancelled, non-done calendar events
- unread email count

## Security Notes

- Session cookies are HttpOnly and SameSite=Strict.
- In production, cookies are also marked Secure.
- Auth tokens are accepted from the cookie or `Authorization: Bearer`, but the
  frontend uses cookies.
- All admin actions are server-side role checked.
- Account/user destructive actions also remove related files where the service
  owns those paths.
- Recovery passwords and uploaded backups must be transferred over HTTPS.
- `BACKUP_MASTER_KEY`, when configured, is separate from JWT signing and protects
  server-side automatic backup unlocking.

## Limitations

- Rate limits are in-memory and reset on restart.
- There is no email verification workflow.
- There is no audit log of admin actions.
- 2FA uses TOTP/recovery codes only; WebAuthn/passkeys are not implemented.
