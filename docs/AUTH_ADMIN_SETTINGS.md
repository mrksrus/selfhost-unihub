# Auth, Admin, Settings, and Search Documentation

For first-run values, HTTPS and the difference between browser origins, proxy
addresses and private mail hosts, start with [Installation](INSTALLATION.md).

## Authentication Model

UniHub uses cookie-based sessions backed by the `sessions` table.

Session components:

- `auth-token`: HttpOnly JWT cookie
- `csrf-token`: HttpOnly CSRF cookie
- `sessions.token`: the SHA-256 of the JWT, never the JWT itself, so a copy of
  the table (a database dump, a volume backup) signs no one in. Every query that
  names a session by its token goes through `api/src/services/sessions.ts`,
  which hashes it; upgrade step 18 hashed the tokens of existing sessions, which
  stay signed in.
- `sessions.expires_at`: 21 days from last use (renewed at most once a day; the session row, not the JWT `exp`, decides expiry)

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
- routes whose spec declares `csrf: 'none'`: `POST /api/auth/signin` and
  `POST /api/auth/signup`, which issue the token
- routes whose spec declares `csrf: 'background-header'` when
  `X-Background-Sync: 1` is present: `POST /api/mail/sync/background` and the
  recording upload routes (the service worker finishing an upload)
- requests whose session was verified from an `Authorization: Bearer` header
  and that carry no `auth-token` cookie at all

The exemptions are read from the matched route's spec
([Request Handling](ARCHITECTURE.md#request-handling)), not from the URL;
`routes-policy.test.cts` pins which routes declare them.

The last rule is what lets a native client write without cookies. No client
uses it today: the Android app runs the pages in a WebView with the ordinary
session cookie and CSRF token ([Android](ANDROID.md)); the rule stays, tested,
for a client that holds a bearer token. It is safe because a browser never attaches an `Authorization`
header on its own, and cross-origin script cannot add one without a preflight
that the API refuses for foreign origins, so such a request cannot be a forged
form or image load. `verifyToken` records which credential it accepted in
`req.authCredential`; the CSRF check reads that record instead of looking at the
headers again. When an auth cookie is present next to the bearer header, the
cookie could have carried the request, so the cookie/header token check still
applies; the tokens are compared in constant time. Tests:
`api/tests/request-csrf.test.cts`.

The frontend stores the CSRF token in memory via `src/lib/api.ts`; it does not
store auth tokens in localStorage.

Tabs share the browser's CSRF cookie. `/api/auth/me` returns that existing
token, issuing one only when it is missing or malformed, so opening or
reloading a tab does not invalidate another tab's unsaved work. Sign-in,
sign-up and completed two-factor login issue a new token. Sign-out, password
change and account deletion clear it. Writes still require the matching
cookie and header.

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
| GET | `/api/auth/2fa/status` | Current 2FA status, recovery-code count and `secretReadable` |
| POST | `/api/auth/2fa/setup/start` | Generate secret and `otpauth_uri` |
| POST | `/api/auth/2fa/setup/confirm` | Require current password and authenticator code, enable 2FA, return recovery codes |
| POST | `/api/auth/2fa/disable` | Require current password and second factor |
| POST | `/api/auth/2fa/recovery-codes/regenerate` | Require second factor and return new recovery codes |
| POST | `/api/auth/2fa/login` | Complete sign-in challenge |

Setup in **Settings > Security** shows a QR code, the setup key and an **Open
in authenticator app** link (the `otpauth://` URI, for an authenticator on the
same device). The QR code is drawn in the browser, so the secret is not sent to
any other service. Enabling and disabling 2FA both delete all other sessions of
the user: sessions opened with the password alone end when 2FA is turned on.
Confirming setup therefore needs the current password (`401` when wrong), so
someone holding only a signed-in session cannot turn 2FA on with their own
authenticator and sign the owner out. Turning 2FA on and deleting those
sessions commit together, under a lock on the user row that the admin reset
also takes. A confirmation from a session that a reset deleted meanwhile fails
with `401` instead of turning 2FA back on, as does one whose password changed
or whose account was deactivated after the password was checked. Confirming
setup counts against the second-factor limit (10 per 10 minutes per user),
which also limits password guesses there, and each accepted request hashes ten
recovery codes.

Regenerating recovery codes accepts an authenticator code or a recovery code.
It returns `409` if 2FA was turned off while the request ran.

### When ENCRYPTION_KEY changed

The authenticator secret is encrypted with `ENCRYPTION_KEY`. After that key
changes, the secret can no longer be read, so authenticator codes stop working.
Recovery codes are bcrypt hashes and keep working:

- sign-in with a recovery code still succeeds
- `GET /api/auth/2fa/status` returns `secretReadable: false` and Settings shows
  a warning instead of **New Recovery Codes**
- regenerating recovery codes returns `409` before checking the code, so no
  recovery code is used up
- the fix is to disable 2FA with a recovery code and set it up again

Without recovery codes, an admin resets 2FA for the user (below).

### Admin confirmation

Changing another person's password, role or 2FA takes the admin's own password
again (`current_password`), so an unattended or stolen admin session cannot take
over an account. The same rule applies to all three: a missing password is `400`
(`ADMIN_PASSWORD_REQUIRED`), a wrong one `403` (`ADMIN_PASSWORD_INCORRECT`, not
`401`, which the browser treats as an expired session), and each admin has 10
attempts per 10 minutes (`429` with `Retry-After`). In **Admin > Users** the
password dialog and the role change ask for it.

### Admin reset

`POST /api/admin/users/:id/2fa/reset` with `{ "current_password": "..." }` is
for a user who lost both the authenticator and the recovery codes. In **Admin >
Users**, accounts with 2FA show a **2FA** badge and a **Reset 2FA** button.

- the admin confirms with their own password; a wrong one returns `403` (not
  `401`, which the browser treats as an expired session); each admin gets 10
  attempts per 10 minutes (`429` with `Retry-After` after that)
- the admin's own row and session are locked and rechecked with the target, so
  a request from an admin session that was signed out or deactivated meanwhile,
  or whose password changed after it was checked, returns `401` and changes
  nothing
- admins cannot reset their own 2FA here (`400`); they turn it off in Settings,
  which needs a code, so a stolen admin session cannot remove it
- the reset clears the secret and recovery codes, deletes the user's pending
  sign-in challenges and all their sessions, and closes their live connections
- the user then signs in with their password and can set up 2FA again

Check that the request really comes from the user before resetting.

If the only admin has lost both the authenticator and the recovery codes, turn
2FA off in the database. With the bundled MariaDB container:

```sh
docker exec -it unihub-db mariadb -u unihub -p unihub
```

```sql
UPDATE users
SET two_factor_enabled = FALSE, encrypted_two_factor_secret = NULL, two_factor_recovery_codes = NULL
WHERE email = 'admin@example.com';
```

Then sign in with the password and set up 2FA again.

## Auth and Profile Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/signin` | Sign in |
| POST | `/api/auth/signout` | Delete current session and clear cookies |
| GET | `/api/auth/me` | Return current user and existing CSRF token, issuing one if missing or malformed |
| PUT | `/api/auth/password` | Change password, delete all sessions, clear cookies |
| PUT | `/api/auth/profile` | Update full name and timezone |
| GET | `/api/auth/sessions` | List the user's live sessions (device, address, last use, which one is current) |
| DELETE | `/api/auth/sessions/:id` | Sign out one other session and close its live connections; `404 SESSION_NOT_FOUND` for an unknown or foreign id, `400 SESSION_CURRENT` for the calling session (use sign-out) |

A session stores the address and user agent it signed in from, for Settings >
Security > Signed-in devices. It renews at most once a day, so "last active" is
known to the day.

Passwords must be at least 12 characters.

## Admin Endpoints

Admin routes require an authenticated user whose role grants the route's
permission. `api/src/security/permissions.ts` maps roles to permissions
(`users.read`, `users.manage`, `server.settings`, `storage.read`,
`audit.read`); today `admin` has all of them and `user` none. Every route
declared with `auth: 'admin'` must name its permission, and the request
boundary checks it before the handler runs.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/users` | List users |
| PUT | `/api/admin/users/:id/password` | Reset a user's password and delete their sessions; needs the admin's password (`current_password`) |
| DELETE | `/api/admin/users/:id` | Delete user, their data and their uploaded files |
| PUT | `/api/admin/users/:id/role` | Set role to `user` or `admin`; needs the admin's password (`current_password`) |
| PUT | `/api/admin/users/:id/activate` | Activate/deactivate user |
| POST | `/api/admin/users/:id/2fa/reset` | Turn off another user's 2FA and delete their sessions; needs the admin's password |
| GET | `/api/admin/storage` | Aggregate server storage counts and byte usage |
| GET | `/api/admin/settings/signup-mode` | Read signup mode |
| PUT | `/api/admin/settings/signup-mode` | Set signup mode |
| GET | `/api/admin/audit` | Activity log, newest first; `?before=<cursor>` for the next page |

### Activity log

`audit_log` (upgrade step 19) records sign-ins and failed sign-ins, password,
2FA and recovery-code changes, signing out another device, account deletion,
and every admin action on a user or on sign-up. Each entry names the actor, the
account concerned, the address and the request id; details hold only a role or
mode, never a password, code or token. Entries about an account that later
got deleted stay, without its address. An entry written for a change that runs
in a transaction commits or rolls back with it. Entries older than 365 days are
deleted by the hourly session cleanup. The log is server-local: backups and
restores do not carry it. Admins read it in Settings > Server settings >
Activity.

Safety checks:

- admins cannot delete their own account through the admin delete endpoint
- the last active admin cannot be deleted
- the last active admin cannot be demoted
- the last active admin cannot be deactivated
- admins cannot reset their own 2FA through the admin endpoint
- deactivating a user deletes their sessions
- deleting a user removes their rows and their files (mail attachments, raw
  mail, recordings, generated backup archives) through the same
  `services/user-lifecycle.ts` as self-deletion; it is refused with
  `409 RESTORE_IN_PROGRESS` while a restore runs for that user

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
| `default_start_page` | `mail`, `calendar`, `todo`, `contacts`, `recordings`, `music`, `dashboard` | `mail` |
| `default_mail_account_id` | the id of one of the user's active, connected mail accounts; empty means the first account | empty |
| `accent_color` | `blue`, `indigo`, `violet`, `pink`, `teal`, `green` (src/lib/accent.ts) | `blue` |

Unknown preference keys are ignored. Invalid values are rejected.

General Settings also contains browser/device preferences: **Appearance**
(Dark by default, Light or System, and a look per theme such as OLED black or
High contrast), **Offline reading**, and **Notifications**.
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

Account deletion (`services/user-lifecycle.ts`, shared with the admin route)
stops the user's mail work, deletes the `users` row (every table cascades from
it) and then removes the user's files under the configured roots: mail
attachments, raw mail, recordings and generated backup archives, including the
user's directory under each root. A file that cannot be removed is logged and
stays visible as orphaned in the admin storage overview. The cookies are
cleared after the user is deleted.

During an active background restore, writes to affected sections return
`409 Restore in progress`. Reads and unaffected sections remain available.
Account deletion is blocked while any restore section is active, also when
an administrator requests it (`409 RESTORE_IN_PROGRESS`).

## Backup and restore in Settings

The Backup and restore section in Settings also exposes generated backup and durable restore jobs:

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

Backup and restore loads its backup/restore view when first opened. Status polling
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

`GET /api/stats` returns counts for the current user (the Today page no longer shows them):

- contact count
- upcoming non-cancelled, non-done calendar events
- unread email count

## Security Notes

- Session cookies are HttpOnly and SameSite=Strict.
- In production, cookies are also marked Secure.
- Auth tokens are accepted from the cookie or `Authorization: Bearer`; the
  frontend uses cookies. A bearer-only request is exempt from CSRF (see
  [CSRF Protection](#csrf-protection)).
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
