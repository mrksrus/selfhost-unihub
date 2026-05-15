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

## Rate Limiting

Sign-in, signup, and 2FA login failures use an in-memory per-IP limiter:

- 5 failed attempts
- 300 minute block
- successful auth resets the IP entry

When `TRUST_PROXY_HEADERS=true`, client IP is taken from `X-Real-IP` or
`X-Forwarded-For`. Only enable that behind a trusted reverse proxy.

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
TOTP code or a recovery code.

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
attachments, raw mail archives, recordings, and generated exports. It also
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

## Limitations

- Rate limits are in-memory and reset on restart.
- There is no email verification workflow.
- There is no audit log of admin actions.
- 2FA uses TOTP/recovery codes only; WebAuthn/passkeys are not implemented.
