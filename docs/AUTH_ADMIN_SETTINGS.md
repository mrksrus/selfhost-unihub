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
5. a session younger than the person's longest session lifetime
   (`auth.session_max_days`, counted from its sign-in; see
   [Sign-in policies](#sign-in-policies)), else the session is ended and the
   request answers `401`

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

Authentication uses attempt budgets stored in the database (`login_attempts`,
since 0.30), consumed before expensive verification, so restarting the API
does not reset them:

| Budget | Limit |
| --- | --- |
| All public authentication requests per resolved client IP | 60 per minute |
| Password checks per existing user ID | 10 per 10 minutes |
| Second-factor checks per user ID | 10 per 10 minutes |
| Signup and setup-link requests per client IP | 10 per hour |
| Wrong passwords confirming an admin action, per admin | 10 per 10 minutes |

Success does not clear any budget. The admin confirmation budget is separate
from sign-in and counts only wrong passwords: each confirmation holds an
attempt while it is checked and a right password gives it back, so parallel
requests cannot get past the limit, so failed sign-ins cannot lock an
admin out of admin actions, nor the other way round. Password and second-factor budgets are
separate; a fresh password login cannot reset second-factor guesses. Account
budgets follow the database user ID, including email case variants. A limited
request returns HTTP 429 with `Retry-After` in seconds. The previous five-hour
blanket IP lockout is removed. Shared-IP users keep separate account budgets;
a high-volume network burst can still hit the short one-minute IP budget.

Each budget is one row per scope and identity. The identity (an address or
an account id) is stored only as a keyed hash (HMAC with `JWT_SECRET`), as
addresses and ids are personal data. Taking an attempt is one atomic update,
so parallel requests never get more than the budget, and the hourly cleanup
deletes rows whose window has ended. When the database cannot answer, the
request fails, as the sign-in would anyway. The rows belong to the
installation: backups never carry them and an instance restore deletes them.

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
| GET | `/api/auth/signup-mode` | Return current signup mode, `data_rules`: the [data-safety rules](#data-safety-policies) in force, in plain words, so the form can list them, and `rules_revision`, their revision |
| POST | `/api/auth/signup` | Create account according to signup mode; `rules_revision` is the revision of the rules the form listed |

A person who signs up has seen the rules listed on the form: their account
starts with the `rules_revision` the form sends back confirmed. Rules saved
after the form loaded, or a form that sends no revision, leave the notice due
after the first sign-in.

An administrator can add a person in every sign-up mode, `disabled`
included ([Add person](#add-person-and-setup-links)).

## Sign-In Flow

`POST /api/auth/signin`:

1. checks rate limit
2. loads user by email
3. verifies bcrypt password; a person who has no password yet (added with a
   setup link they have not used) cannot sign in
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
| POST | `/api/auth/2fa/disable` | Require current password and second factor; refused with `403 POLICY_FORBIDS` while `auth.two_factor` requires it |
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

The authenticator secret is encrypted with `ENCRYPTION_KEY`. A key change with
the old key in `ENCRYPTION_KEY_PREVIOUS` keeps it readable
([Installation](INSTALLATION.md#changing-the-encryption-key)). Without the old
key the secret can no longer be read, so authenticator codes stop working.
Recovery codes are bcrypt hashes and keep working:

- sign-in with a recovery code still succeeds
- `GET /api/auth/2fa/status` returns `secretReadable: false` and Settings shows
  a warning instead of **New Recovery Codes**
- regenerating recovery codes returns `409` before checking the code, so no
  recovery code is used up
- the fix is to disable 2FA with a recovery code and set it up again

Without recovery codes, an admin resets 2FA for the user (below).

### Admin confirmation

Changing another person's password, role or 2FA, deactivating them or deleting
them takes the admin's own password again (`current_password`, in the body of
`DELETE /api/admin/users/:id` too), so an unattended or stolen admin session
cannot take over or remove an account. Activating an account needs no
password. The same rule applies to all of them: a missing password is `400`
(`ADMIN_PASSWORD_REQUIRED`), a wrong one `403` (`ADMIN_PASSWORD_INCORRECT`, not
`401`, which the browser treats as an expired session), and after 10 wrong
passwords in 10 minutes an admin gets `429` with `Retry-After`. In **Server >
People** each of these actions asks for it, as do adding a person, a setup
link, signing a person's devices out, handing on ownership, deleting a group
and saving a group's rules. The same holds for every change on
the [administrator's path for a person](#the-administrators-path-for-a-person),
for saving the [policies](#data-safety-policies) and for the instance backup's
schedule (`api/src/security/reauthentication.ts`).

Deleting one's own account asks for one's own password the same way
(`DELETE /api/settings/account` with `{ "current_password": "..." }`): `400
PASSWORD_REQUIRED`, `403 PASSWORD_INCORRECT`, `429` after too many wrong ones.

### Admin reset

`POST /api/admin/users/:id/2fa/reset` with `{ "current_password": "..." }` is
for a user who lost both the authenticator and the recovery codes. In **Server >
People**, accounts with 2FA show a **2FA** badge and a **Reset 2FA** action.

- the admin confirms with their own password; a wrong one returns `403` (not
  `401`, which the browser treats as an expired session); after 10 wrong
  passwords in 10 minutes the admin gets `429` with `Retry-After`
- the admin's own row and session are locked and rechecked with the target, so
  a request from an admin session that was signed out or deactivated meanwhile,
  or whose password changed after it was checked, returns `401` and changes
  nothing
- admins cannot reset their own 2FA here (`400`); they turn it off in Settings,
  which needs a code, so a stolen admin session cannot remove it
- nobody but the owner resets the owner's 2FA (`400 OWNER_PROTECTED`; see
  [Roles and the owner](#roles-and-the-owner))
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
| GET | `/api/auth/me` | Return current user (with `permissions`, the permissions of their role, and `manages_groups`) and existing CSRF token, issuing one if missing or malformed |
| PUT | `/api/auth/password` | Change password, delete all sessions, clear cookies |
| PUT | `/api/auth/profile` | Update full name and timezone |
| GET | `/api/auth/sessions` | List the user's live sessions (device, address, last use, which one is current) |
| DELETE | `/api/auth/sessions/:id` | Sign out one other session and close its live connections; `404 SESSION_NOT_FOUND` for an unknown or foreign id, `400 SESSION_CURRENT` for the calling session (use sign-out) |
| POST | `/api/auth/invite/check` | Public: the person, the rules that will apply to them (their groups' included) and the rules revision of a setup link; `404 INVITE_INVALID` for any link that cannot be used |
| POST | `/api/auth/invite/accept` | Public: set the password of a setup link (`password`, optional `full_name`, `device`, `rules_revision`) and sign in |

A session stores the address and user agent it signed in from, for Settings >
Security > Signed-in devices. It renews at most once a day, so "last active" is
known to the day.

Passwords must be at least 12 characters, or the longer minimum of the
person's `auth.password_min_length` policy: sign-up, a password change, an
administrator's reset, Add person and a setup link all check it (`400`).
Existing passwords keep working.

## Admin Endpoints

Admin routes require an authenticated user whose role grants the route's
permission. `api/src/security/permissions.ts` maps roles to permissions
(`users.read`, `users.manage`, `server.settings`, `storage.read`,
`audit.read`, `groups.manage`, `admins.manage`, `owner.transfer`,
`contacts.books.manage`, `calendars.manage`, `chat.manage`): the owner
has all of them, an `admin` all but `admins.manage` and `owner.transfer`, and
a member (`user`) none. Every route declared with `auth: 'admin'` must name
its permission, and the request boundary checks it before the handler runs.
Rights are checked by permission, never by role name; the pages ask the
same map through the `permissions` of `/api/auth/me`. `chat.manage` guards no
route: in Chat it lets its holder add anyone to a group chat, make a chat
that follows any group or everyone, and manage a followed chat they are in
([Chat](CHAT.md#group-chats)); it gives no access to anyone's messages.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/users` | People, newest first, with role, status (`active`, `inactive`, `invited`, `not_set_up`), groups, 2FA (and the end of a running grace) and last use (`users.read`) |
| POST | `/api/admin/users` | Add a person: email, name, role (`user`, or `admin` with `admins.manage`), groups, optionally an initial password; answers with the person and, without a password, a setup link; needs the admin's password (`users.manage`) |
| POST | `/api/admin/users/:id/setup-link` | A new setup link for a person who has no password yet; replaces a live one (`users.manage`, admin's password) |
| DELETE | `/api/admin/users/:id/setup-link` | Revoke the person's live setup link (`users.manage`) |
| PUT | `/api/admin/users/:id/password` | Reset a user's password and delete their sessions; needs the admin's password (`current_password`) |
| DELETE | `/api/admin/users/:id` | Delete user, their data and their uploaded files |
| PUT | `/api/admin/users/:id/role` | Set role to `user` or `admin` (`admins.manage`: the owner only, else `403 ADMINS_MANAGE_REQUIRED`); needs the admin's password (`current_password`) |
| PUT | `/api/admin/users/:id/activate` | Activate/deactivate user; deactivating needs the admin's password |
| POST | `/api/admin/users/:id/2fa/reset` | Turn off another user's 2FA and delete their sessions; needs the admin's password |
| POST | `/api/admin/owner/transfer` | `{ "user_id", "current_password" }`: hand ownership to an active administrator (`owner.transfer`) |
| GET | `/api/admin/users/:id/devices` | The person's devices, as Settings > Security > Devices lists one's own (`users.read`) |
| DELETE | `/api/admin/users/:id/devices/:deviceId`, `/api/admin/users/:id/devices` | Sign one of the person's devices out, or all of them; admin's password (`users.manage`) |
| GET, POST | `/api/admin/groups` | Every group with its counts and whether it sets rules (`users.read`); create one (`groups.manage`) |
| DELETE | `/api/admin/groups/:id` | Delete a group, its memberships and its rules; admin's password (`groups.manage`) |
| PUT | `/api/admin/groups/:id/managers/:userId` | `{ "manager": true \| false }`: name or remove a manager, adding them as a member if needed (`groups.manage`) |
| GET | `/api/admin/storage` | Aggregate server storage counts and byte usage |
| GET | `/api/admin/settings/signup-mode` | Read signup mode, and `calls_relay`: whether the relay for calls is configured. The Server page shows it as "Relay for calls: configured" or "not configured", with a link to [Calls and the relay](INSTALLATION.md#calls-and-the-relay) |
| PUT | `/api/admin/settings/signup-mode` | Set signup mode |
| GET | `/api/admin/audit` | Activity log, newest first; `?before=<cursor>` for the next page |
| GET | `/api/admin/instance-backup` | Instance backup: on or off (and what is missing), the read-only destination, the key's fingerprint, the schedule in force (`time_utc`, `keep`, `schedule_source`, `schedule_defaults`), next run, kept count and size, the latest runs and the restore command (`server.settings`) |
| POST | `/api/admin/instance-backup/run` | "Back up now": `202` with the started run; `409 INSTANCE_BACKUP_OFF` or `INSTANCE_BACKUP_RUNNING`, `503 INSTANCE_BACKUP_NOT_READY` while the process does not run the background work yet (`server.settings`) |
| PUT | `/api/admin/instance-backup/settings` | The time of the daily run (`HH:MM`, UTC) and how many backups are kept (1 to 1000), with the admin's password (`server.settings`) |
| GET | `/api/admin/policies` | Everyone's policies (the installation): each with its value, source, default, values, what it means for existing data and the groups that set it, the bin's minimum and the rules revision (`server.settings`) |
| PUT | `/api/admin/policies` | Save changed policies with the admin's password (`server.settings`) |
| GET, PUT | `/api/admin/groups/:id/policies` | The same for one group: only values at least as strict as Everyone's, and `clear` to give a key back to Everyone (`server.settings`; `404 GROUP_NOT_FOUND`) |
| POST | `/api/admin/policies/preview` | `{ "group_id" }` or none for Everyone: before requiring 2FA, how many people it covers have none and who of them is already in a grace; changes nothing (`server.settings`) |
| GET | `/api/admin/users/:id/accounts`, `/backups`, `/bin` | A person's mail and calendar accounts (no credentials), the shared books they manage (`managed_books`) and their calendars shared with someone (`shared_calendars`: name, share and event counts), backups and bin (`users.read`) |
| GET, PUT | `/api/admin/users/:id/directory` | Read or correct the person's company directory entry (`users.manage`) |
| GET | `/api/admin/address-books` | Every shared address book, deleted ones too, with its creator (`contacts.books.manage`) |
| POST | `/api/admin/address-books/:id/restore` | Restore a deleted book with its contacts and shares (`contacts.books.manage`) |
| GET | `/api/admin/calendars` | Server › Calendars: every calendar no person owns, deleted ones too, and every person's calendar shared with someone, by name and counts (`calendars.manage`) |
| POST | `/api/admin/calendars/:id/restore` | Restore a deleted group or organisation calendar with its events and shares (`calendars.manage`) |
| POST | `/api/admin/calendars/:id/hand-over` | Hand a calendar over at once to a person, the organisation or its owner's bin; admin's password (`calendars.manage`) |
| PUT | `/api/admin/calendars/:id/archive` | Archive or unarchive a calendar; admin's password (`calendars.manage`) |
| GET | `/api/admin/chat/retention-preview?days=&group_id=` | Before a shorter `chat.retention_days` is saved: the messages, files and chats it would delete, and how many chats wait to start deleting and from when; changes nothing (`server.settings`) |
| POST | `/api/admin/chat/retention/apply-now` | The owner ends every chat's 24-hour wait, with the password (`server.settings`; anyone but the owner gets `403 OWNER_REQUIRED`) |
| POST, PUT, DELETE | `/api/admin/users/:id/mail-accounts[/:accountId]` | Add, change, disconnect (`?purge=true`: and delete UniHub's copy of its mail) a person's mail account (`users.manage`) |
| POST, PUT, DELETE | `/api/admin/users/:id/calendar-accounts[/:accountId]` | Add, change, remove a person's calendar account (`users.manage`) |
| DELETE | `/api/admin/users/:id/backups/:jobId` | Delete a person's backup (`users.manage`) |
| POST, DELETE | `/api/admin/users/:id/bin/empty`, `/api/admin/users/:id/bin/:itemId` | Empty a person's bin (optionally one module) or delete one item for good (`users.manage`) |
| POST | `/api/admin/users/:id/clear/:module` | Settings > Delete data for a person: `contacts`, `calendar`, `mail-accounts` or `recordings` (`users.manage`); their bin is not touched (`/bin/empty` is) |

The instance backup's destination and key come only from the environment (or
`*_FILE`). Its schedule is an installation setting the admin changes on the
page; the daily run is off until the admin turns it on there. Until the admin sets a time and a count, `INSTANCE_BACKUP_TIME` and `INSTANCE_BACKUP_KEEP`, or daily
03:30 UTC and 14 kept, apply. The schedule reads it every minute and a run
reads the kept count when it succeeds, so a change needs no restart; a lower
count removes the oldest backups at the next verified success, as the count
always does.

### Activity log

`audit_log` (upgrade step 19) records sign-ins and failed sign-ins, password,
2FA and recovery-code changes, signing out another device, account deletion,
every admin action on a user or on sign-up, starting an instance backup
(`admin.instance_backup_started`) and changing its schedule
(`admin.instance_backup_settings_changed`), each changed policy
(`admin.policy_changed` with the key and its old and new value) and the
owner ending the wait of a shorter chat retention
(`admin.chat_retention_applied`, with the number of chats), everything
done on the administrator's path for a person (`admin.mail_account_added`,
`_changed`, `_removed`, `_reset`; `admin.calendar_account_added`, `_changed`,
`_removed`; `admin.backup_deleted`, `admin.bin_emptied`,
`admin.bin_item_deleted`, `admin.data_cleared`, with the person as the
account concerned), people and groups (`admin.user_created`,
`admin.setup_link_created`, `admin.setup_link_revoked`,
`auth.setup_completed`, `owner.transferred`, `admin.device_removed`,
`admin.devices_ended`, `admin.group_created`, `admin.group_deleted`,
`admin.group_manager_set`, `admin.directory_changed` with the fields
changed, and a manager's `group.renamed`,
`group.member_added`, `group.member_removed`; a policy change names its
target, the installation or the group), a calendar's change of owner
(`admin.calendar_handed_over`, `admin.calendar_binned`,
`admin.calendar_archived`, `admin.calendar_unarchived`, and a group
manager's hand-over at once, `calendar.handed_over`, each with the
calendar's id and the person whose calendar it was), and the removal of a person's mail
data: disconnecting a mail account (`mail.account_disconnected`) and deleting
it with UniHub's copy of its mail (`mail.account_purged`). Each entry names
the actor, the account concerned, the address and the request id; details hold
only a role or mode, or for mail the account's id and the numbers of messages
and calendar events removed, never a password, code, token or mail address. Entries about an account that later
got deleted stay, without its address. An entry written for a change that runs
in a transaction commits or rolls back with it. An administrator's change for a
person always has its entry: in the change's transaction where there is one
(removing a calendar or mail account, deleting a backup, the bin, Delete
data), else written first with `outcome: "pending"` and then set to `done`,
or to `unknown` with the `status` and `code` of an error answer (adding or
changing an account). An entry that cannot be written stops the change; one
left `pending` or `unknown` means the change may have happened, as an error
answer does not prove nothing was written before it.
Entries older than 365 days are deleted by the hourly session cleanup. The
log is server-local: backups and restores do not carry it. Admins read it in
Settings > Server settings > Activity.

Safety checks:

- admins cannot delete their own account through the admin delete endpoint
- the owner cannot be deleted (also not through Settings > Delete account),
  demoted or deactivated, and only the owner changes the owner's password,
  2FA or setup link (`400 OWNER_PROTECTED`; [Roles and the
  owner](#roles-and-the-owner))
- only the owner deactivates, activates or deletes another administrator or
  changes their password, 2FA or setup link (`403 ADMINS_OWNER_ONLY`)
- the last active admin cannot be deleted (also not through Settings > Delete
  account), demoted or deactivated (`400 LAST_ADMIN`). The check locks every
  active admin's row (the owner's included) in the transaction of the change;
  since only the owner removes administrators and nobody removes the owner,
  two admins cannot remove each other
- changing a person's password, role or status and deleting a person ask
  again, in the transaction that writes, that the admin is still an active
  admin, signed in with this session and with the password entered
  (`services/caller-proof.ts`): `401 SESSION_ENDED`, `403 ADMIN_REQUIRED` or
  `403 PASSWORD_CHANGED`, and nothing changes
- admins cannot reset their own 2FA through the admin endpoint
- deactivating a user deletes their sessions, so every device of theirs is
  signed out; their data, groups and manager roles stay, and activating them
  gives everything back
- deleting a user removes their rows and their files (mail attachments, raw
  mail, recordings, generated backup archives) through the same
  `services/user-lifecycle.ts` as self-deletion; it is refused with
  `409 RESTORE_IN_PROGRESS` while a restore runs for that user

The storage overview returns aggregate counts and byte totals for mail
attachments, raw mail archives, recordings, generated backup archives and
chat files. It also splits those byte totals per user account; chat files
count toward the person who sent them, and those of deleted people are one
"former colleagues" total on the Chat files row. It does not return message
subjects, filenames, contact records, or backup contents.

## Roles and the owner

Every person has one role: the **owner**, an **admin** or a **member**
(stored as `user`; the pages say Member). The permission map above says what
each may do. An installation has exactly one owner: `users.owner_marker`, a
generated column with a unique key, lets the database itself refuse a
second. A new installation's bootstrap administrator is the owner; upgrading
to 0.30 makes the earliest-created active administrator the owner
([Upgrading](UPGRADING.md)).

Only the owner makes or removes administrators (`admins.manage`): giving or
taking the admin role, adding a person as an admin, and deactivating,
activating or deleting another administrator. The same holds for another
administrator's sign-in: their password, 2FA reset and setup link. An
administrator who is not the owner gets `403 ADMINS_OWNER_ONLY` for these,
checked in the transaction that writes with the administrator's row locked,
so one administrator can neither remove another nor sign in as them. Every
administrator may still sign another administrator's devices out, act on
members and change their own account as before. The owner hands
ownership on with `POST /api/admin/owner/transfer` and their password; the
new owner must be an active administrator who has a password, and the former
owner becomes an administrator, in one transaction. Until then nobody,
the owner included, can demote, deactivate or delete the owner
(`400 OWNER_PROTECTED`).

Only the owner changes the owner's sign-in: an administrator's password
reset, 2FA reset or setup link for the owner is refused with `400
OWNER_PROTECTED`, checked in the transaction that writes with the owner's row
locked. Otherwise an administrator could sign in as the owner and so make or
remove administrators. An administrator may still sign the owner's devices
out: that ends sessions only, and the owner signs in again with their own
password and second factor. In Server > People the owner's row greys those
actions out with the reason, and for an administrator who is not the owner
so do the other administrators' rows.

## People

Server > People lists everyone with their role, status, groups, 2FA and last
use, and filters by group. A person's page holds their profile and role,
their groups, their company directory entry, their devices, deactivate and
delete, and the [administrator's path](#the-administrators-path-for-a-person).

### Add person and setup links

**Add person** (`POST /api/admin/users`, with the admin's password) creates
the account at once, in the chosen groups, so the administrator can add it to
groups or set up mail accounts before the person arrives. The person then
sets their own password through a **setup link** (the default), or signs in
with an **initial password** the administrator types, which they may change
later; no change is forced. Adding a person works whatever the sign-up mode.

- The link is `/invite#<token>`: 32 random bytes in the fragment, so the
  token never reaches a server or proxy log, and the page sends no referrer.
  Only the token's SHA-256 is stored (`invites`).
- It is shown once to copy, works once and ends after 7 days. A person has
  one live link at most: a new one replaces it, revoking deletes it. A
  person who has set their password gets no link (their password is reset
  instead, `400 ALREADY_SET_UP`).
- An unknown, used, expired or revoked link gets the same answer, `404
  INVITE_INVALID`.
- Opening the link lists the person's rules (their groups' included) before
  the password; setting it signs them in with that revision of the rules
  confirmed, as sign-up does. It counts against the sign-up budgets.
- Until then the person has no password (`password_hash` is empty) and
  cannot sign in. Server > People shows them as **Invited** while a link is
  live and **Not set up** without one.
- Links belong to the installation: backups never carry them and an instance
  restore deletes them, so a restore never brings back a way in; the
  administrator makes a new link.

### Deactivate, delete and devices

Deactivating keeps the person's data, groups and manager roles and ends all
their sessions; activating them gives everything back. Deleting removes them
and their data ([Admin Endpoints](#admin-endpoints)). Both dialogs first name
the shared address books the person manages: the books stay, and
administrators keep managing them.

Both dialogs then list the person's calendars that are shared with someone
(`shared_calendars`) and ask what happens to each:

| Choice | Deactivate | Delete |
| --- | --- | --- |
| Leave it as it is: the shares keep working while the person is away | default | not offered |
| Hand it to a colleague (an active person) | yes | yes |
| Make it an organisation calendar | yes | default |
| Delete it: to the person's bin when deactivating; with the person when deleting | yes | yes |

Each choice other than "leave", and other than deleting it with the person,
is one call of the administrator's hand-over
(`POST /api/admin/calendars/:id/hand-over`), made before the person is
deactivated or deleted ([Calendar](CALENDAR.md#change-of-owner-and-archive)).
Deactivating withdraws the pending offers to the person, by them and of
their calendars. Deleting a person also removes every share of their
calendars that go with them.

An administrator sees a person's devices (`GET /api/admin/users/:id/devices`)
and signs one or all of them out with their password. Live connections
close, the Android app finds itself signed out at its next request, and the
person's data stays. The activity log records `admin.device_removed` or
`admin.devices_ended`.

## Groups and managers

Groups are flat: a person can be in several, as a member or a manager.
**Everyone** is the built-in group of every active person; it has no row, and
its rules are the installation's (Server > Policies, Everyone). Groups and
their members are `services/groups.ts`'s; who may read or manage a group is
answered by the access service (`services/access.ts`), checked before any
change and again in the transaction that writes it.

Administrators with `groups.manage` create and delete groups, add and remove
members and name managers. Deleting a group removes its memberships and its
rules in one transaction; nobody's data changes, but its members may get
looser rules, which the page says before the password.

A **manager** is no role, only a membership: they manage their own groups
from Settings > Your groups (`/api/groups`). They may:

- rename the group and change its description
- add active people, found by name or email (`GET /api/groups/:id/candidates?q=`,
  at most 20, name and email only), up to 200 at once
- remove members
- see the members and the rules the group adds, read-only

For calendars a manager also creates their group's calendars and manages
them (name and colour, sharing, delete) on the group's page, and hands over a
person's calendar on which their group holds `read` or more to a member of
that group, as an offer or at once
([Calendar](CALENDAR.md#change-of-owner-and-archive)).

They cannot create or delete groups, name or remove managers, change rules,
restore a deleted group calendar or open the Server pages. A member sees their groups and each group's managers.
A group someone cannot see is `404 GROUP_NOT_FOUND`; one they may see but
not manage is `403 GROUP_FORBIDDEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/groups` | The person's groups and their role in each |
| GET | `/api/groups/:id` | One group; members and the group's own rules only for those who manage it |
| PUT | `/api/groups/:id` | Name and description (manage) |
| GET | `/api/groups/:id/candidates?q=` | Active people not in the group (manage) |
| POST | `/api/groups/:id/members` | `{ "user_ids": [...] }` (manage) |
| DELETE | `/api/groups/:id/members/:userId` | Remove a member (manage); a manager only with `groups.manage` |

A membership change takes the rules lock, is checked for policy combinations
that cannot hold for each person it changes (`400 POLICY_CONFLICT`), and
then reaches the person's modules, workers and live connections as a policy
save does ([Data-safety policies](#data-safety-policies)).

## Shared books and the directory

**Server › Shared books** lists every shared address book with its creator,
also books nobody shared with the administrator, and under **Deleted** the
deleted ones with **Restore**. It needs `contacts.books.manage` (the owner
and administrators), which also lets them open and manage any book. A book
keeps working when its creator is deactivated or deleted. Who may do what
in a book, its bin and the routes are in
[Contacts](CONTACTS.md#shared-address-books).

**The directory correction.** A person fills in their phone, job title and
department under Settings › Profile. An administrator with `users.manage`
corrects them on the person's page under Server › People; only the changed
fields are sent, and the activity log records `admin.directory_changed`.
Members cannot change another person's entry.

## Shared calendars

**Server › Calendars** lists the organisation's and the groups' calendars
(New calendar for the organisation or a group, name and colour, Share, Hand
over, Archive or Unarchive, Delete), every person's calendar that is shared
with someone by its name and numbers only (Hand over, Archive or
Unarchive), and under **Deleted** the deleted group and organisation
calendars with **Restore**. It needs `calendars.manage` (the owner and
administrators); Hand over and Archive ask for the administrator's password.
A person's calendar nobody shares is not listed, and an administrator's
calendar is the installation owner's alone to hand over or archive. Who may
do what in a calendar, its bin and the routes are in
[Calendar](CALENDAR.md#shared-group-and-organisation-calendars).

## User settings

Settings follow the account (every device sees them) and live in one registry
(`api/src/services/settings-registry.ts`, F1): each key has a scope, a type,
its allowed values and a default. The service in `api/src/services/settings.ts`
stores, resolves and checks the values; routes and workers call it rather than
reading tables of their own.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/settings/values` | The user-scoped settings, each resolved |
| PUT | `/api/settings/values` | Save changed user-scoped values; answers with every setting as now resolved |
| GET | `/api/settings/values/mail-accounts` | The settings of each of the user's mail accounts, by account id |
| PUT | `/api/settings/values/mail-accounts/:id` | Save changed values of one mail account |
| GET | `/api/settings/values/calendars` | The settings of each of the user's calendars, by calendar id |
| PUT | `/api/settings/values/calendars/:id` | Save changed values of one calendar |
| GET, PUT | `/api/settings/preferences` | The pre-0.24 form of the user-scoped keys that existed then, for older clients |

A PUT carries only the changed keys (`{ "values": { ... } }`); an unknown key
is ignored, an invalid value is rejected and a request with one invalid value
changes nothing. Every setting comes back resolved:

```json
{ "value": "sender", "source": "policy", "locked": false, "floor": "sender" }
```

`source` says where the value comes from (`user`, `policy` or `default`).
`locked` means an administrator fixed it. `floor` is the least private value
a policy still allows for a key with privacy levels. The server enforces
both; Settings only reflects them: a locked setting is greyed out with "Set by
your administrator", never hidden, and under a floor the less private choices
are greyed out the same way. The shared types are in
`api/src/contracts/settings.ts`.

Data-safety policies (F13) are rules on actions, not settings of a person:
`policy.<key>` rows of the installation in `setting_policies`, with their keys,
defaults and plain reasons in `settings-registry.ts` (`POLICIES`) and their
shapes in `api/src/contracts/policies.ts`. Every default allows what UniHub
does today. Policies are set for the installation (Everyone) and for groups
(`target_kind` `installation` or `group`). A route names the policies of its action on its spec
(`destructive`, `requires`; [Request Handling](ARCHITECTURE.md#request-handling)),
and the request boundary refuses a forbidden action with 403 `POLICY_FORBIDS`
and `details: { policy, reason }` before anything changes, for every person,
administrators included on their own data. A locked policy stands; a policy
of a key with an order is a floor that a group's policy can only make
stricter. See [Data-safety policies](#data-safety-policies).

### User scope

| Key | Allowed values | Default | Settings page |
| --- | --- | --- | --- |
| `email_link_behavior` | `mailto`, `internal` | `mailto` | General |
| `default_start_page` | `mail`, `calendar`, `todo`, `contacts`, `recordings`, `music`, `chat`, `dashboard` | `mail` | General |
| `accent_color` | `blue`, `indigo`, `violet`, `pink`, `teal`, `green` (src/lib/accent.ts) | `blue` | Appearance |
| `week_start` | `monday`, `sunday`, `saturday` | `monday` | General, Calendar |
| `default_event_reminder` | minutes before a new event: `0`, `5`, `15`, `30`, `60`, `120`, `1440`, or `null` for none | `0` | General, Calendar |
| `default_task_list_id` | the id of one of the user's own UniHub lists (a local calendar) with ToDo on and not read-only; empty means UniHub's choice: the oldest such list (remapped on restore with the calendars) | empty | General, ToDo |
| `default_calendar_id` | the id of one of the user's calendars that can take new events: not read-only, not a subscription, its account's sync not paused; server calendars included; empty means UniHub's choice: the first such calendar in list order (remapped on restore with the calendars) | empty | General, Calendar |
| `reminder_notification_detail` | `full` (title and time), `none` (only "Event reminder"); may carry a floor | `full` | Notifications |
| `default_mail_account_id` | the id of one of the user's active, connected mail accounts; empty means the first account (remapped on restore) | empty | Mail |
| `compose_format` | `rich`, `plain` | `rich` | Mail |
| `compose_templates`, `compose_scheduled_send`, `compose_format_switch` | `true`, `false`: the optional compose features, whose button the composer shows only while on | `false` | Mail |
| `reading_format` | `theme` (the dark theme's reading view, the original in light), `simplified`, `original`, `auto` (decided from the message) | `theme` | Mail |
| `mail_threaded_view` | `true`, `false` | `false` | Mail |
| `mail_preview_lines` | `0` to `5` | `1` | Mail |
| `snooze_choices` | a list from `1h`, `3h`, `tomorrow`, `1d`, `2d`, `next_week`, `1w`, `2w`, `1mo`, each at most once | `1h`, `1d`, `1w` | Mail |
| `snoozed_messages` | `hide` (out of the lists until due), `keep` (stays in its folder, marked); a view rule applied at once ([Snooze](MAIL_SYNC.md#snooze)) | `hide` | Mail |
| `bin_retention` | how long the bin keeps a deleted item: `7`, `30`, `90` days or `forever`; while deleting from the bin for good is forbidden, never below the administrator's minimum (its `floor`) | `30` | Bin |
| `contacts_phone_books_off` | a list of shared book ids and `company` that stay off the person's phones ("On my phones" on each book, [Contacts](CONTACTS.md#where-shared-books-appear)); unknown ids are ignored | empty | Contacts |
| `chat_presence` | `true`, `false`: others see a dot while a UniHub page of the person is open, and the person sees theirs; locked by `chat.presence` | `true` | Chat |
| `chat_read_receipts` | `true`, `false`: "Read" under messages, shown only while both people have it on; locked by `chat.read_receipts` | `true` | Chat |
| `chat_notification_detail` | `full` (the sender and the message), `sender`, `none` (only "New message"); floored by `notifications.detail` ([Chat](CHAT.md#notifications)) | `full` | Chat |

A reference (`default_mail_account_id`, `default_task_list_id`,
`default_calendar_id`) is checked against its own kind of record when it is
written; a value naming something that no longer qualifies (deleted,
read-only, paused) is kept but reads as UniHub's choice where it is used.
`GET /api/calendar/calendars` marks the list and calendar in effect
(`default_for_tasks`, `default_for_events`) together with what each calendar
can take (`write_block`, `takes_undated_tasks`), so no client repeats the
fallback (`api/src/contracts/tasks.ts`). A reference names one person's
record, so it cannot be an installation policy: such a policy row is ignored.
A restore remaps each reference with the id map of its own section (mail
accounts or calendars); one whose record is neither restored nor still the
person's becomes empty.

### Mail account scope

| Key | Allowed values | Default |
| --- | --- | --- |
| `notify_enabled` | `true`, `false` | `true` |
| `notify_folder_mode` | `except` (all folders except the listed ones), `only` (only the listed ones) | `except` |
| `notify_folders` | up to 100 folder references: `role:<inbox\|sent\|drafts\|junk\|trash\|archive>` for a system folder, so the choice covers the account's own folder of that role, or `folder:<id>` for another folder | `role:junk`, `role:sent`, `role:drafts`, `role:trash`, `role:archive` |
| `notify_detail` | `full` (sender and subject), `sender`, `none` (only "New email"); may carry a floor | `full` |

Settings → Notifications shows these per mail account, with the account's
folders as a picker (`GET /api/mail/folders?account_id=` lists each folder's
roles). The server applies the switch, the folder filter and the detail level
before a notification leaves it ([notifications](PWA.md)).

### Calendar scope

| Key | Allowed values | Default |
| --- | --- | --- |
| `notify_enabled` | `true`, `false`: reminders and new items from this calendar | `true` |

### Signatures and templates

A mail account's signature is a column of the account, not a setting:
`PUT /api/mail/accounts/:id/signature` with `{ "html", "text" }` stores the
formatted version and its plain-text version (Settings → Mail → Signatures
derives the text from the formatted editor). Mail templates are rows of their
own under `/api/mail/templates` (`api/src/routes/mail-essentials.ts`).

### Device scope

From 0.29.0 the app lock's settings belong to a device record (see
[Devices](#devices)), stored in `device_settings` and read with `GET` and
`PUT /api/settings/values/device` for the device of the request:
`app_lock_scope` (empty, `["app"]` or a list of modules; `app` stands alone),
`app_lock_relock_after` (`0`, `60`, `300`, `900` seconds) and
`app_lock_on_device_lock`. The policies `app_lock.required` and
`app_lock.max_background` are their floors: lists resolve as a union, so a
device locks at least what is required. The UniHub PIN itself never reaches
the server.

### Devices

Each browser profile, installed web app and Android app installation is a
row in `devices`, and every session and push channel belongs to one
(`sessions.device_id`, `push_subscriptions.device_id`; nullable in 0.29, so
older pages keep working). Sign-in, sign-up and two-factor sign-in take an
optional `device: {key, kind}`; the key is 32 random bytes the page keeps,
stored only as a hash and matched per person, and a session from before 0.29
binds with `POST /api/devices/current/key`. `services/devices.ts` owns the
table (a lint fence keeps its SQL there).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/devices` | The person's devices with a live session, the current one first |
| GET | `/api/devices/current` | This device, its app lock settings, whether it meets the required lock, and the screenshot policy |
| PUT | `/api/devices/current/lock` | What the device locks now and what it can do (`applied`, `capabilities`) |
| POST | `/api/devices/current/lock-state` | `open`, `background` or `locked`, for notification content |
| DELETE | `/api/devices/:id` | Sign another device out: its sessions and push channels go with it |

Removing a device needs no policy key: it deletes no data, only a sign-in.
The activity log records it as `device.removed`. A device without a session
that was last used more than 30 days ago is removed by the hourly cleanup.
Devices are never in a personal backup and an instance restore deletes them.
Settings → Security → Devices shows the list in place of the signed-in
sessions; `GET /api/auth/sessions` stays for pages from before 0.29. A device
that holds chat keys carries `chat: true` and the mark "Chat"; signing it out
also removes it from the person's chats ([Chat](CHAT.md#devices)).

### On this device

The Settings page also holds choices that stay in the browser or on the
device and are never sent to the server: **Appearance** (Dark by default,
Light or System, and a look per theme such as OLED black or High contrast),
**Offline reading**, and the device part of **Notifications** (permission and
the subscription of this browser or phone). They say "Saved on this device".

## Data-safety policies

Administrators set them in Settings > Server > Policies, for Everyone (the
installation) or for one group. They are rules on actions (F13 on F1),
resolved by `services/settings.ts` (`resolvePolicy`, `assertAllowed`) from the
installation's `policy.<key>` rows and those of the person's groups, else the
key's default, which always allows what UniHub did before. Changing a policy
deletes nothing: the services read the rules when they act. The one
exception is `chat.retention_days`, whose purpose is to delete (below).

**Groups only make rules stricter.** Everyone's value is the most anyone
gets. A group's page offers only the values at least as strict as
Everyone's (else `400 POLICY_INVALID`), and among a person's groups the
strictest value wins. Four keys have no order of strictness,
`mail.mode.new_accounts`, `mail.provider_delete`, `chat.presence` and
`chat.read_receipts`: there a group value that refuses the action wins, else
the value the person's groups agree on;
when they disagree, Everyone's value holds for that person and Everyone's
page flags the key. Everyone's page names the groups that set each key. A
request resolves the person's levels once, in one query, and every gate of
that request reads them.

| Key | Values (default first) | What it stops |
| --- | --- | --- |
| `mail.mode.download`, `mail.mode.sync` | `allowed`, `forbidden` | adding an account in that mode, switching one to it; existing accounts keep working |
| `mail.mode.new_accounts` | `user_choice`, `download`, `download_delete`, `sync` | a new account in another mode: the dialog preselects and locks it, the server fills it in or refuses another |
| `mail.provider_delete` | `user_choice`, `forbidden`, `required` | `forbidden`: turning deletion at the provider on, and the deletion worker queues and deletes nothing more for anyone; `required`: a new Download account deletes at the provider |
| `backup.download_mail` | `user_choice`, `always` | leaving downloaded mail out of a backup |
| `backup.create`, `backup.restore` | `forbidden`, `allowed` | creating and restoring one's backups: personal backups are experimental and off until an administrator allows them (an installation that existed before shows everyone the rules notice once); completed backups stay downloadable |
| `backup.delete` | `allowed`, `forbidden` | deleting one's backups |
| `backup.server_retention_days` | none, `30`, `90`, `365` | deleting a finished backup younger than that; nothing is deleted automatically |
| `accounts.add`, `accounts.remove`, `accounts.reset` | `allowed`, `forbidden` | adding, removing mail and calendar accounts (also turning a linked calendar on or off), deleting UniHub's copy of an account's mail |
| `account.delete` | `allowed`, `forbidden` | deleting one's own UniHub account |
| `data.clear` | `allowed`, `forbidden`; also forbidden while `bin.delete` is | Settings > Delete data |
| `bin.delete` | `allowed`, `forbidden` | deleting from the bin for good and emptying it, and deleting messages in a Download mail account's Trash for good; the automatic purge then keeps items for the bin's minimum |
| `accounts.admin_manage` | `available` | nothing: the administrator's path is always there |
| `app_lock.required` | nothing, `app`, or a list of modules (`mail`, `contacts`, `calendar`, `recordings`, `chat`) | using the listed parts on a device that does not lock them ([App lock](APP_LOCK.md#required-by-the-administrator)); a floor of the device setting `app_lock_scope` |
| `app_lock.max_background` | `none`, `900`, `300`, `60`, `0` (seconds) | a longer **Ask again** (`app_lock_relock_after`) while a lock is required |
| `app_lock.screenshots` | `allowed`, `forbidden` | screenshots in the Android app (a secure window); Chat blocks them in any case |
| `auth.two_factor` | `optional`, `required` | using UniHub without 2FA after a 7-day grace, and turning 2FA off ([Sign-in policies](#sign-in-policies)) |
| `auth.password_min_length` | `12`, `14`, `16`, `20` | a shorter new password; existing passwords keep working |
| `auth.session_max_days` | `none`, `30`, `14`, `7`, `1` | a session older than that since its sign-in |
| `modules.mail`, `modules.calendar`, `modules.contacts`, `modules.recordings`, `modules.chat` | `allowed`, `forbidden` | using the module at all: it is off and locked for the person and its data stays ([Modules](MODULES.md#administrator-policies)) |
| `chat.presence`, `chat.read_receipts` | `user_choice`, `on`, `off` | nothing: `on` and `off` lock the person's `chat_presence` or `chat_read_receipts` switch ([Chat](CHAT.md#presence-and-read-receipts)) |
| `chat.retention_days` | none, `365`, `180`, `90`, `30` | nothing: chat messages older than that are deleted, also while `bin.delete` is forbidden; a chat follows the shortest among its active members, starting 24 hours after its time got shorter; `GET /api/admin/chat/retention-preview` counts what a value would delete, and only the owner ends the wait early ([Chat](CHAT.md#retention)) |
| `chat.attachment_max_mb` | `100`, `50`, `25`, `10` | sending a larger file in a chat; default `50` |
| `chat.reach` | `organisation`, `own_groups` | adding someone to a group chat who shares no organisation group with the member (`own_groups`, the default); administrators add anyone; a 1:1 chat stays open between any two people ([Chat](CHAT.md#group-chats)) |
| `chat.calls` | `allowed`, `forbidden` | starting a call to or from the person; a call going on is not ended ([Chat](CHAT.md#calls)). Server › Policies has it as "Calls" in the Chat group, for Everyone and for a group. The person's "Call" buttons stay, greyed, with the reason; someone who calls them is refused with "Calls are off for <name>.", and their button for that person is greyed with it until the page is loaded again |
| `pages.music` | `allowed`, `forbidden` | the Music page alone; recordings keep working |
| `notifications.detail` | `full`, `sender`, `none` | more detail than that in notifications: the floor of each mail account's `notify_detail` and of `chat_notification_detail`; `none` also floors reminders (a reminder has no sender, so `sender` leaves them full) |
| `contacts.phone_sync` | `allowed`, `forbidden` | UniHub contacts in the Android app's phone contacts: the app's contacts sync is told Contacts is off (`403 MODULE_DISABLED` with the policy), so the phone removes them at its next sync; they stay in UniHub, and changes made on the phone since its last sync are lost |
| `offline.copies` | `allowed`, `forbidden` | new offline copies (`GET /api/offline/snapshot`); each browser and app deletes its own copy when it next reads the rules online, and one that never comes online keeps it |

A route names the policies of its action on its spec and the request boundary
refuses before anything happens. A rule that depends on the body is checked
by the service that takes it, with the same `403 POLICY_FORBIDS` and its
reason: the mode and the provider-deletion switch of a new or changed mail
account (`services/mail-account-mode.ts`), and turning a mail account's linked
calendar on or off, which decides from a read that changes nothing. A backup
younger than `backup.server_retention_days`, or one still being made, is
refused with the date from which it can be deleted
(`services/backup-policy.ts`); a failed or cancelled one can go at once.

**A shorter chat retention on the Policies page.** `chat.retention_days` is
the one rule whose purpose is to delete; [Chat](CHAT.md#retention) has the
whole rule, the 24-hour wait and its warnings. When a save makes it shorter
for Everyone or a group, the save dialog first shows the server's count of
the messages and files older than the new time and in how many chats, says
that deleting starts 24 hours later, that a device that is switched off
deletes its copies when it is next opened, that an earlier instance backup
still holds the encrypted messages and that this deletes even where people
may not delete for good, and asks for the typed word DELETE besides the
password. The word is the page's own safeguard; the server checks the
password. Under the rule the page then shows the change that waits. Right
after the save it offers "Undo", which saves the value the page had loaded,
because the server does not keep the earlier value. On a later visit it
shows the server's date and how many chats wait. "Apply now…" is offered to
the owner alone.

**The final check.** The boundary's answer, and a service's early checks, can
be older than what holds when the step acts: an administrator's save, a module
switched off, a restore admitted while the step waited. So every destructive
step asks once more in the transaction that deletes, after its own row locks
and on that transaction's connection, with locking (current) reads held until
it commits (`services/final-step.ts`): the policies of its route (an
administrator's actor passes them), and the switch and restore lock of every
module it writes. A refusal is the same `403 POLICY_FORBIDS`, `403
MODULE_DISABLED` or `409 RESTORE_IN_PROGRESS` as at the boundary, and nothing
is deleted. A provider command (erasing a message, deleting a folder at the
provider, deleting one date of a repeating server event, which is gone for
good and so needs `bin.delete`) runs on a connection of its own that holds
the check's locks while the command is sent, so nothing it checked changes
before the provider answered; the erase worker skips a refused message and
stops. Linking a restored calendar to its mail account, which drops the
calendar's own password, and connecting a calendar account, together with
removing the one a new address replaces, each commit in one transaction
after Calendar's switch and restore lock (and, for a mail account's
calendar, its policies) are asked again: a refusal changes neither account.
A person's account management runs one change at a time
(`services/person-lock.ts`, in process: one API process owns this work).
Adding, changing, disconnecting, purging or removing a mail or calendar
account (an administrator's too), a mail account's calendar (connect,
replace, off, resume), confirming a Sync account's policy, deleting a
folder at the provider or one date of a repeating server event, clearing a
module's data, deleting the person and admitting one of their restores each
hold the person's lock from the first
read that decides anything, through discovery and login tests, to the
commit and the provider command it guards; a restore's admission holds it
only for the admission. The sync takes it around its own account writes
(linking a restored calendar, dropping a link to deleted mail, noting a
missing login) and reads the account again under it: an account paused
meanwhile is not linked or unlinked, keeps its password, and its sync stops
without writing (a pause also stops the account's running work); a
password saved meanwhile is not noted missing, the calendar syncs again
with it. The erase worker asks for the lock without waiting and stops for
now when a change runs. The lock is keyed by the person's id as the
database compares it (without case); an administrator's routes take the
person's id only as a UUID (`400 INVALID_USER_ID` otherwise) and use its
stored spelling. An account's id is resolved to its stored spelling the
same way before a change takes its locks, and the mail account's lock and
a calendar account's work (its running sync) fold case, so a pause through
another spelling still stops it. Two of a
person's changes therefore never interleave: the later one starts from
what the earlier one left. The final check still covers what others commit
meanwhile: rules, module switches, restores.

Who asked is checked again there too (`services/caller-proof.ts`). Deleting
one's own account, an administrator's change for a person
(`/api/admin/users/:id/...` accounts, backups, bin, clears), saving the
rules and saving the instance backup's schedule each carry what their route
proved: the session, the administrator role where needed and the password
entered again. The final check, and those two saves after their own row
locks, read the person's row and session again with shared locks: a session
signed out or ended meanwhile (a password reset, a deactivation) answers
`401 SESSION_ENDED`, another stored password `403 PASSWORD_CHANGED`, a lost
administrator role `403 ADMIN_REQUIRED`, and nothing changes. Background
work a request starts does not carry it.

Such a change also acts only on the accounts it saw. It carries a snapshot
of each account it chose (`services/account-identity.ts`: provider, server,
address, login and stored password; for a calendar account also whether it
is paused and its name; for a mail account its servers, mode, provider
deletion and connection, and for a linked calendar the mail account its
login comes from) and compares it under the row's lock in the transaction
that writes. An account written meanwhile by anything else makes it answer
`409 ACCOUNT_CHANGED`, "This account changed in the meantime. Try again.",
and write nothing. The mail account's set of linked calendars, and the
link of the one it turns off, are checked the same way and answer `409
MAIL_CALENDAR_CHANGED`. A folder on several mail accounts is deleted at the
provider only after every one of them was connected and checked, under one
final check held until the last server answered; a refusal sends no
DELETE. Deleting it names the copies the person was shown, each with its
generation (UIDVALIDITY, MAILBOXID where the server has OBJECTID), and
STATUS reads every copy again before the first DELETE: a copy created
again under the name anywhere answers `409 FOLDER_CHANGED` and nothing is
sent to any server (docs/MAIL_SYNC.md). What the servers answered counts
even when the check's own end fails. A server that fails after others
succeeded stops the rest, the deleted copies are settled locally at once
and this attempt sends nothing again, and the answer is `409
FOLDER_PARTLY_DELETED` with `details.deleted_on`, `details.remaining_on`
(addresses), `details.settled` and `details.copies` (each account's
outcome: `deleted`, `changed`, `failed`, `unknown` for a DELETE whose answer
never came, or `not_tried`), which the folders dialog lists; a `502` whose
DELETE went unanswered carries `details.copies` too. UniHub sends no DELETE again by itself and keeps no record
across attempts: deleting the folder again starts from the folder list,
and a copy already deleted answers `NONEXISTENT` to its STATUS. A server's
refusal, or a DELETE without an answer, with nothing deleted is `502
MAIL_SERVER_ERROR` in UniHub's words; the server's own text goes only to
the log. Reading a mail
account's calendar writes nothing (a restored one shows `link_pending`).
The sync's login drops a link to a deleted mail account, and notes a
missing login, only under Calendar's check; refused, the sync pauses and
the row stays. Saving a mail or calendar account's password or settings,
and adding a mail or remote calendar account, ask again for the module
(and for mail, its mode's policies, and `accounts.add` when an account is
added, the optional calendar of a new mail account included) in the
transaction that writes them. A new account's mode and provider deletion
are checked against the policies read there: a mode forced, or provider
deletion required, while its login was tested refuses it with `403
POLICY_FORBIDS` naming that policy, and sending it again gets the values
filled in; a policy relaxed meanwhile refuses nothing. A change that stops
an account's mail work first (saving settings, disconnecting, purging,
clearing mail, deleting the person) pauses it with a reason of its own for
the change's whole life; refused, or failed before its commit (a lost
connection included), it puts back exactly what it replaced, only while its
own pause is still there, so a restore or module switch since keeps its
pause, and the change's error (for example `409 RESTORE_IN_PROGRESS`) stays
the answer. What it puts back: the earlier pause (not a Mail switched-off
one once Mail is on again), and the jobs it stopped as they were, each
accepted provider change's job with its own foreground turn included (also
one it stopped while running, however long it had run). A turn belongs to
the job its change queued, so two changes keep two turns and no other job of
the account, such as a background retry, can take one. One it stopped while running
resumes as a check of its outcome when the operation was dispatched, never
sent again, and as the operation itself when it was not: the pause moved
the account's generation on, so the stopped worker can dispatch nothing
after it.
A settings change that went through ends its own pause as after a
reconnect.
The bin's purge skips a module that is off or being restored. Emptying the bin is refused
between batches with `403 POLICY_FORBIDS` and the number already deleted as
`details.deleted`. A backup younger than its minimum is refused under the
backup's row, its file goes after the commit.

**Lock order.** Every destructive step, and everything that changes what it
checks, takes its locks in this order:

0. the person's lock (`services/person-lock.ts`), then a mail account's
   in-process lock (`services/mail-account-lock.ts`); work that already
   holds a mail account's lock (the erase worker) asks for the person's
   without waiting. A calendar sync and a change of an event take it inside
   their calendar sync and event locks, which no holder of the person's
   lock waits for;
1. the step's own rows (accounts carried as snapshots: mail accounts before
   calendar accounts, by id) where it locks them before it changes them (the
   backup, the bin items, the accounts, their messages and linked
   calendars, the calendar accounts a connection takes over or replaces,
   the person's row), in the step's order; a bulk clear of contacts or
   calendars and the purge of merge records lock their rows with the
   DELETE or UPDATE that follows the check, which holds its locks to
   commit all the same;
2. the rules revision row (`system_settings` `policy_revision`), shared, then
   the installation's and the groups' policies and the memberships; an
   administrator's save and a membership change lock it first, exclusively;
3. the person's module switches row (`user_settings` `module_preferences`),
   shared; a switch writes it;
4. the person's restore jobs, every row and the gap for a new one, shared.

A step or a save that waits longer than the database allows (MariaDB's lock
wait timeout) is rolled back and answers `503 CHANGE_IN_PROGRESS`, "Another
change is in progress. Try again in a moment."; nothing is retried for it,
least of all a provider command, which is never sent before its check holds.

Admitting a restore (an upload, creating one from a backup, unlocking,
starting or retrying it) takes the person's lock first, for the admission
only. Then it locks the backup's row when it is made from one (shared), then
its own job row. Starting and unlocking then answer an upload past its
seven-day deadline with `410` and the re-upload sentence, compared in
statements that run after the job's row lock, so a wait for the lock cannot
carry an earlier clock past it. Then an upload, creating one from a backup,
starting and retrying ask `backup.restore` again under the rules lock (the
final check, `403 POLICY_FORBIDS`; so an expired upload still says to upload
it again), and the last three read the person's other jobs as current rows
before the job moves. Unlocking an upload, which only sends it to
validation, locks its job row. The restore itself asks `backup.restore`
again before it starts and in its own transaction before it commits, so a
queued restore a later rule forbids fails with the rule's reason and applies
nothing.
Deleting a backup takes the backup's row, then reads the restores made from it
as current rows and answers `409` while one is in use. Each therefore either
commits before the step reads it or waits until the step has committed.

**The bin's minimum.** While `bin.delete` is forbidden, the bin keeps items at
least as long as the administrator's minimum (`30`, `90` days or `forever`,
by default `forever`; `bin_min_retention` on the policies routes, stored as
`policy.bin.min_retention`). It is the floor of the person's `bin_retention`:
a shorter choice reads as the minimum and saving one is refused with `403
POLICY_FLOOR`; a longer one stays. The purge asks again, under its locks,
before it deletes anything, and the bin shows when each item can go at the
earliest.

**Saving.** `PUT /api/admin/policies` takes `{ "values": { ... },
"bin_min_retention"?: ..., "current_password": "..." }` with only the changed
keys; a value equal to the default removes the policy. One transaction holds
the values and an `admin.policy_changed` entry per changed key. A key or value
the server does not know is `400 POLICY_UNKNOWN` or `POLICY_INVALID`; a
combination that cannot hold (new accounts in a mode that is not allowed, new
accounts deleting at the provider while that is forbidden, both mail modes
forbidden) is `400 POLICY_CONFLICT`, and nothing is saved.

A group's rules are saved the same way with `PUT
/api/admin/groups/:id/policies`; `clear` lists the keys (`bin.min_retention`
for the bin's minimum) whose group policy goes, so Everyone's value holds
again, and a value equal to Everyone's on the page does the same. A save is
checked for the group with Everyone's rules and for each of its members
(`400 POLICY_CONFLICT` naming the group or the person). After a save or a
membership change commits, each person it reached gets their new rules at
once: a module turned off stops its background work and leaves their open
event streams, and a 2FA grace starts or ends. A session older than a new
longest lifetime ends at its next request.

**Telling people.** The rules in force are listed in plain words: every
key not at its default or refusing its action, and the bin's minimum while it
holds. When anyone's list changes, the rules revision (`system_settings`
`policy_revision`) goes up and the administrator who saved it has seen it.
The revision is one for the installation, but the notice is per person: a
confirmation stores the SHA-256 of the person's list (`policy_notices.rules_hash`),
and the notice shows only while their list differs from the one they
confirmed. A group's rule or a membership change therefore shows it only to
the people whose own rules changed.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/policies/effective` | Every key as it applies to the person (`value`, `source`, `allowed`, `reason`), the `rules`, the current `revision` and the person's `acknowledged_revision`, all from one consistent read, so the rules are those of the revision |
| POST | `/api/policies/acknowledge` | `{ "revision": n }`: the person confirmed the rules of that revision (`policy_notices`, never restored); a revision that does not exist yet is `400 POLICY_REVISION_INVALID` |

While `acknowledged_revision` is below `revision`, the app shows the rules once
and records the confirmation; Settings > Profile lists them; the sign-up form
lists them from `GET /api/auth/signup-mode`.

### Sign-in policies

`services/sign-in-policies.ts` enforces the three sign-in rules for one
person.

**Two-factor authentication required** (`auth.two_factor`). A person without
2FA gets 7 days from the first time the rule applies to them
(`users.two_factor_required_since`, set by a policy save or membership
change, or by the request gate for someone added later; only while empty, so
it counts from the first time). Turning 2FA on clears it. The grace runs
once: the start stays when the rule stops applying, and a later application
(a new rule, rejoining a group) resumes it. During the
grace nothing is refused: `GET /api/policies/effective` carries `two_factor:
{ required, grace_ends_at }` and the app shows a reminder. After it, every
route that is not exempt (below) answers `403 TWO_FACTOR_REQUIRED` with
`details: { grace_ended_at, reason }`, administrators included, and the app
guides the person through the setup; their notifications carry no content
until then, as on a device without a required app lock. Turning 2FA off is refused at once while
the rule applies, grace or not. Before saving the rule the Policies page asks
`POST /api/admin/policies/preview` how many people it covers have no 2FA and
who of them is already in a grace, with its end. Backups of a person never
carry the grace start; the instance backup keeps it with `users`.

**Shortest password** (`auth.password_min_length`): every password set from
then on, by the person or an administrator, needs at least that many
characters; sign-up uses Everyone's value.

**Longest session** (`auth.session_max_days`): counted from the session's
sign-in, on top of the 21-day idle expiry. It applies to existing sessions
too: an older one ends at its next request (`401`).

**Exempt routes.** The app lock gate ([App
lock](APP_LOCK.md#required-by-the-administrator)) and the 2FA gate share one
list, `gates: 'exempt'` on the route spec, pinned by `routes-policy.test.cts`:
what a person needs to set the lock or 2FA up (`/api/auth/2fa/*`, the device
routes, settings values, password and profile), sign out, read the rules
and their modules, keep notifications and live events, and finish work that
exists only on the device (the recording upload routes). The Android app's
contacts sync (`gates: 'background-sync'`, only with `X-Background-Sync: 1`)
stays open too, because older apps read any other `403` as a refused change.

### The administrator's path for a person

A rule that forbids a person something never makes it impossible: an
administrator does it for them on Server > People > the person, with their own
password, and the activity log records it with the person as the account
concerned (routes in [Admin Endpoints](#admin-endpoints)). Each route calls the
service of the person's own route with the person's id and the administrator
as actor, so the person's policies do not stop it; the request boundary checks
the administrator, so the service checks the person's module switch (`403
MODULE_DISABLED`) and restore lock (`409 RESTORE_IN_PROGRESS`) before any
change, and an id of anyone else's record is `404`. The administrator's
password stands for the typed address a person enters to delete an account's
mail. Deleting the mail is still refused while a provider change of the
account has an unresolved outcome, and a backup can be deleted before its
minimum age. Accounts are listed without credentials. Every change on this
path to the owner or another administrator is the owner's alone (`403
ADMINS_OWNER_ONLY`); the page greys those controls for other administrators.

## User Data Management Endpoints

These routes are for the current user and require CSRF:

| Method | Path | Purpose |
| --- | --- | --- |
| DELETE | `/api/settings/account` | Delete current user and associated uploaded files; needs `{ "current_password": "..." }` (`account.delete`) |
| POST | `/api/settings/clear-contacts` | Delete all contacts in the list; contacts in the bin stay until it is emptied (`data.clear`) |
| POST | `/api/settings/clear-calendar` | Delete calendar/to-do data and recreate default local calendar; events and tasks in the bin stay until it is emptied (`data.clear`, `accounts.remove`) |
| POST | `/api/settings/clear-mail-accounts` | Delete all mail accounts with their attachment files and stored raw messages (`data.clear`, `accounts.remove`, `accounts.reset`); `409 MAIL_OPERATIONS_UNRESOLVED` while a provider change has an unresolved outcome; with calendars connected from mail, also Calendar's module switch and restore lock |
| POST | `/api/settings/clear-recordings` | Delete all recordings in the library and their files; recordings in the bin, and their files, stay until it is emptied (`data.clear`) |
| GET | `/api/settings/mail-sender-candidates` | Suggest sender/domain rule candidates from local mail |

The four clears are `services/data-clear.ts`, shared with the administrator's
path. Clearing mail accounts refuses, as purging one account does, while a
provider change has an unresolved outcome: it stops the accounts' work, then
checks again under the locks of the accounts and their messages, so a change
accepted meanwhile cannot slip past. It unlinks the calendars connected from
the accounts, so while there are any it is also a change to Calendar: refused
while Calendar is off (`403 MODULE_DISABLED`) or being restored (`409
RESTORE_IN_PROGRESS`), before any work stops and again under the locks.
Mail's own switch and restore lock are checked again under those locks too,
so a Mail restore that starts while the work stops is not passed by.

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
- upload-once validation for `.zip` (encrypted since 0.28) and `.unihub-backup` (0.27)
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
- All admin actions are checked on the server by permission; group managers
  by the access service.
- Account/user destructive actions also remove related files where the service
  owns those paths.
- Recovery passwords and uploaded backups must be transferred over HTTPS.
- `BACKUP_MASTER_KEY`, when configured, is separate from JWT signing and protects
  server-side automatic backup unlocking.

## Limitations

- There is no email verification workflow.
- 2FA uses TOTP/recovery codes only; WebAuthn/passkeys are not implemented.
