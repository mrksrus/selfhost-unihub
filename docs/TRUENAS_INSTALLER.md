# TrueNAS installation preparation

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

[Installation guide](INSTALLATION.md) · [Main page](../README.md)

**Status: draft catalog submission, not an available catalog app.**
[TrueNAS Community PR #5847](https://github.com/truenas/apps/pull/5847) proposes an
installer for UniHub 0.10.8. The separate catalog contribution contains the form,
Compose template and storage test configurations. Checked locally with TrueNAS's
renderer and schema tools on 19 September 2026. A disposable local deployment
exposed and corrected missing Nginx capabilities and a HEAD/GET health-probe
mismatch. HTTPS API sign-in and database/file writes passed locally. Installation
through the actual TrueNAS form and NAS-specific checks remain pending. Account
backup/import/restore are ALPHA and excluded from this catalog validation.
The reference Compose file and release startup check were aligned in 0.10.8;
no application-data or database changes were needed.

## What exists today

The image is `ghcr.io/mrksrus/selfhost-unihub:0.18.0`. The reference deployment is
[our Compose file](../docker-compose.yml), with a separate MariaDB 11.8 container.
Since 0.16.0 the file mounts nothing from the repository: database settings are
command-line options and the schema is created by the app. Its `${…}` values
still come from a `.env` file or the environment, so a TrueNAS custom-app editor
must be given the passwords explicitly.

Existing custom-app users should preserve their working deployment and data. A
future catalog installation must not claim to adopt existing datasets automatically.

## Installer field contract

The following is **our proposed form design**, implemented for review in the draft PR. Required means the installer must
refuse an empty/invalid value, even where the current API only checks presence.
Private means mask the field in the form; it does not mean the value disappears
from administrator-accessible configuration. Never provide shared default secrets.

| User-facing field | Requirement / proposed validation | Container mapping and helper text |
| --- | --- | --- |
| Administrator email | Required; valid email shape | `BOOTSTRAP_ADMIN_EMAIL`. “Your first UniHub login. Creates the initial administrator; does not connect a mailbox or change an existing login.” |
| Administrator password | Required; private; at least 12 characters | `BOOTSTRAP_ADMIN_PASSWORD`. “Initial web-login password. Changing this field later does not reset an existing account.” |
| Database user password | Required; private; recommend a generated 32-byte random value | `MYSQL_PASSWORD` in the app and `MARIADB_PASSWORD` in MariaDB. “Keep this value. Editing it does not change the password inside an existing database.” |
| Database root password | Required; private; independent generated value | `MARIADB_ROOT_PASSWORD` in MariaDB only. “For database administration, not UniHub sign-in.” |
| Session signing secret | Required; private; recommend a generated 32-byte random value; reject known placeholders | `JWT_SECRET`. “Generate once and preserve. Changing it invalidates existing login tokens.” |
| Stored-data encryption key | Required; private; recommend a generated 32-byte random value; reject known placeholders | `ENCRYPTION_KEY`. “Generate once. Losing/changing it makes saved credentials and 2FA secrets unreadable.” |
| Separate backup master key | Optional; private; no generated-on-render default | `BACKUP_MASTER_KEY`, empty means use `ENCRYPTION_KEY`. “Optional separate server backup-unlock key. Preserve it once used.” |
| HTTPS browser address | Required; HTTPS origin only; no path/query/fragment/userinfo | Serialize into `ALLOWED_ORIGINS`. “The exact address you will open, including a nonstandard port if used. Example: https://hub.example.com. This does not create DNS or a certificate.” |
| Additional browser addresses | Optional list; same validation | Append to `ALLOWED_ORIGINS`; deduplicate and serialize with commas. “Only extra addresses you actually use.” |
| Outer HTTPS proxy addresses | Required for the proposed external-proxy installation path; valid IP/CIDR entries | Append to bundled `127.0.0.1/32,::1/128` in `TRUSTED_PROXY_CIDRS`. “The proxy's connecting address seen by UniHub, not your visitors' IPs.” Reject all-address ranges; explain narrow network scope. |
| Private mail/CalDAV hosts | Optional; hostname or literal IP list; no schemes/ports/CIDRs | `TRUSTED_MAIL_HOSTS`, default empty. “Only servers intentionally hosted at private addresses. A hostname also covers its subdomains; use a narrow hostname.” |
| Web port / bind address | Required port with catalog-compliant default; valid available host port | Map selected host port to app port 80. “Your HTTPS proxy forwards here. This port itself serves HTTP.” |
| Database storage | Required persistent storage selection | MariaDB `/var/lib/mysql`. “Contains your accounts and database. Do not replace with an empty location when updating.” |
| Uploaded-file storage | Required persistent storage selection | UniHub `/app/uploads`. “Mail originals/attachments, recordings and account backups.” |

Provide a visible setup note: “HTTPS must already be configured outside this app.
A healthy container does not prove browser login works. Open the HTTPS address
above to sign in.” A public domain or public Internet access is not required.
If a later installer offers bundled TLS instead, design that as a separate mode
before relaxing the proxy requirements.

The installer must use **runtime names directly**, not expect `UNIHUB_*` `.env`
variables from the repository. Keep required fields populated in saved configuration
across upgrades. Optional generation may happen once during initial configuration
only if TrueNAS provides a suitable supported mechanism; never generate secrets
when rendering an update or restarting a container. User-entered generated values
are sufficient for a first version.

## Values the installer should own

Do not make users reconstruct these internal connections:

| Setting | Proposed fixed/default behavior |
| --- | --- |
| App image | Pin the reviewed release tag, initially `0.10.8`; never `latest` for a catalog release. |
| MariaDB image | MariaDB 10.11 or later; the reference uses `mariadb:11.8`. The catalog's MariaDB template helper is suitable. UniHub refuses MySQL servers at startup. |
| App mode / proxy | `NODE_ENV=production`, `TRUST_PROXY_HEADERS=true`; keep bundled loopback trust. |
| Database connection | `MYSQL_HOST` is the installer-defined DB service name; `MYSQL_PORT=3306`, database/user `unihub` in both containers; never expose database port publicly. |
| Startup | `MYSQL_STARTUP_MAX_WAIT_SECONDS=300`, check interval `5`; preserve `UNIHUB_API_START_DELAY_SECONDS=2` and health start period `360s`. The current supervisor starts the API first and delays Nginx by this setting. |
| Health | App check through `/health` on internal port 80. Database readiness must allow slow initialization and verify actual app DB access. |
| MariaDB configuration | Pass the reference command options (utf8mb4, buffer and log sizes, `--skip-name-resolve`, `--local-infile=0`). There is no configuration file to mount. |
| Persistence | Stable database/uploads mappings; never temporary storage for either. |
| Permissions | Inspect actual image execution users and mount access; no unverified UID override. |
| Resources | Use catalog-standard resource controls; establish reasonable defaults during deployment testing, not an invented minimum requirement. |
| Frontend / notifications | Published image already uses `/api`; no `VITE_API_URL` or VAPID setup fields. |

Do not expose an arbitrary `DATABASE_URL` override alongside generated database
fields: the API gives it precedence and it could silently bypass the intended DB.
Do not let additional environment entries override installer-owned paths, ports,
connection settings or security configuration.

The current Dockerfile has **no `USER` directive**. The start script and service
supervisor run as root; since 0.11.1 the supervisor starts the Node API as the
image's `unihub` user (uid/gid 10001) and the start script gives `/app/uploads` to
that user. The Compose setup drops capabilities except `CHOWN`, `DAC_OVERRIDE`,
`NET_BIND_SERVICE`, `SETGID` and `SETUID`, and enables `no-new-privileges`. Nginx
needs these to prepare its owned log/temp paths and drop worker privileges; the
supervisor needs `SETGID`/`SETUID` to start the API as 10001. A host-path uploads
dataset must be writable by uid 10001. Do not describe the container as a fully
non-root deployment or set UID 568 merely to satisfy a form. Nginx paths,
permissions and startup would need checking before any such change. If catalog
review requires non-root operation, stop and propose the exact runtime changes
and tests separately.

## What cannot be delivered with Markdown alone

The [TrueNAS contribution guide](https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md)
describes a Community entry with metadata, `questions.yaml`, image/default values,
a Compose template, a description and test configurations. The form's required and
private attributes live in its schema. Documentation cannot enforce them.

The draft PR now supplies these catalog YAML/template files, including validation,
environment mapping, storage, health checks and MySQL configuration through Compose
configs. It predates 0.16.0 and must move to MariaDB before acceptance. These live in the separate catalog contribution, not the UniHub runtime.
Catalog acceptance, runtime storage permissions and real deployment tests remain
open checks. The proposed image retains its existing root startup behavior.

The catalog submission must state the [licensing model](../LICENSING.md) explicitly:
private noncommercial self-hosting, including multi-user home labs, is free;
company/business use, including internal operations, requires a paid licence.
The public licence's listed nonprofit/public-institution permissions remain.
Disclose the AI-only maintenance model described in the [README](../README.md),
including the maintainer's lack of professional development qualifications.

## Acceptance checks before catalog readiness

- Empty required fields and a short admin password are rejected by the form;
  invalid origins/proxy addresses are caught before deployment. Secrets are masked.
- Fresh install creates one administrator; sign-in, authenticated requests and
  uploads work through the declared HTTPS proxy, not just through an HTTP health probe.
- A real client is identified across the proxy chain; spoofed forwarded addresses
  are not trusted. Private mail-host exceptions remain optional and narrow.
- Slow MariaDB readiness can use five minutes and continues as soon as ready.
- Restart and catalog update preserve secrets, the same storage and existing data;
  bootstrap fields do not reset users. Invalid credentials fail visibly.
- Mail files and recordings survive an app upgrade using disposable data.
  Account backup/import/restore are ALPHA and excluded from this installation
  validation. No recovery validation is claimed.
- The installer renders without repository-relative host files, and storage works
  with the image's actual permissions. Do not change a real user's dataset ACLs for a test.
- Document installing from scratch separately from moving an existing custom app.
  Never run both against the same writable data. Do not promise automatic adoption
  or downgrade recovery before it has been designed and verified.

Local validation passed for metadata/questions schemas, both storage fixture
renders, generated library hashes, template/portal checks, catalog port allocation
and focused environment/storage/security mappings. Thirteen invalid-input cases
were rejected, and a canonical IPv6 browser origin was checked. Full validation in
the official TrueNAS container is recorded in the draft PR, along with the exact
runtime checks completed and the remaining NAS-specific checks. No services were started on a user's
NAS or against live data.
