# Install and configure UniHub

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

[Back to the main page](../README.md) · [Existing installation? Read the upgrade guide](UPGRADING.md)

This guide describes the supplied Compose deployment for **0.18.2**. It separates
settings that stop startup from settings needed for browser access. Examples are
illustrations, not working passwords or addresses. Never replace existing keys or
volumes by following the fresh-install steps on an existing installation.

## 1. Prepare your server and browser address

You need Docker with the Compose plugin, Git, and persistent disk space for mail,
recordings, backups and the database. UniHub 0.16.0 and later use
**MariaDB 11.8 LTS** (MariaDB 10.11 or later is required; releases are tested
on 11.8 and, from 0.28.4, on 13.0). MySQL is no longer
supported; an existing MySQL installation needs the steps in the
[upgrade guide](UPGRADING.md#0160-mariadb). With your own database server, give
UniHub an empty database of its own.

Choose a browser address such as `https://hub.example.com`, with DNS pointing to
your HTTPS reverse proxy and a certificate your devices trust. A LAN-only service
can use private DNS and HTTPS; public Internet exposure is not required.

The proxy forwards to the server's published port **3000**, which reaches port 80
inside UniHub. The API's port 4000 and MariaDB's port 3306 stay internal. If the proxy
is itself a container, `localhost` refers to that container, not your NAS.

Production login cookies require HTTPS. Opening `http://NAS-IP:3000` may show the
page but is not a supported normal login setup. Some browsers treat localhost
specially; do not rely on that exception for deployment. Do not switch production
into development mode to work around HTTPS. The image runs in production mode
by itself (`NODE_ENV=production` is set in the image), so the login cookies are
`Secure` however the container is started; a `NODE_ENV` entry in your Compose
file or installer form is no longer needed and stays harmless.

The proxy must send `X-Forwarded-Proto: https` (most do by default; in Nginx
Proxy Manager and Traefik it is automatic). UniHub then answers with
`Strict-Transport-Security: max-age=31536000`, so browsers that once reached it
over HTTPS refuse to downgrade to plain HTTP for a year. Plain-HTTP requests
never get the header. If your proxy also adds HSTS, browsers use the first
header they receive.

## 2. Get the deployment files

`docker-compose.yml` is the only file you need. It pulls the published UniHub
and MariaDB images and carries all database settings itself; there are no
configuration files to download or mount. Create a folder with that file and a
private `.env` next to it:

```bash
mkdir unihub && cd unihub
curl -fsSLO https://raw.githubusercontent.com/mrksrus/selfhost-unihub/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/mrksrus/selfhost-unihub/main/.env.example
chmod 600 .env
```

Cloning the repository works too (`git clone https://github.com/mrksrus/selfhost-unihub.git`,
then `cp .env.example .env`). Tools that take a Compose file in a web form, such
as Portainer stacks or Dockge, can use the contents of `docker-compose.yml` with
the values below entered as environment variables instead of a `.env` file. The
app image already contains the application: no build, Node.js installation or
Dockerfile editing is required.

For a TrueNAS app, read [UniHub as a TrueNAS app](TRUENAS_INSTALLER.md)
instead of assuming these shell steps create a catalog app.

## 3. Enter the startup values in .env

Edit `.env` beside `docker-compose.yml`. Values on the left are the exact names
used by the supplied Compose file. Compose passes them into the containers using
the runtime names shown below. Do not paste actual secrets into public issues.

| .env field | Container runtime field | Required? | What to enter |
| --- | --- | --- | --- |
| `UNIHUB_DB_PASSWORD` | `MYSQL_PASSWORD` in UniHub, `MARIADB_PASSWORD` in MariaDB | Yes | A generated database-user password. Compose passes the same value to both containers. This is not the web login. |
| `UNIHUB_DB_ROOT_PASSWORD` | `MARIADB_ROOT_PASSWORD` in MariaDB only | Yes | A different generated password for database administration. UniHub does not log into MariaDB as root. |
| `UNIHUB_JWT_SECRET` | `JWT_SECRET` | Yes | An independent random secret used to sign login sessions. |
| `UNIHUB_ENCRYPTION_KEY` | `ENCRYPTION_KEY` | Yes | Another independent random secret protecting saved account credentials, 2FA secrets and the push private key. Preserve it across upgrades. |
| `UNIHUB_BOOTSTRAP_ADMIN_EMAIL` | `BOOTSTRAP_ADMIN_EMAIL` | Yes in supplied Compose | The email address you will use as the first UniHub administrator login. You do not need to connect its mailbox to create the account. |
| `UNIHUB_BOOTSTRAP_ADMIN_PASSWORD` | `BOOTSTRAP_ADMIN_PASSWORD` | Yes in supplied Compose | Your initial web-login password, at least 12 characters. Use a password manager. |
| `UNIHUB_ENCRYPTION_KEY_PREVIOUS` | `ENCRYPTION_KEY_PREVIOUS` | Only after a key change | The encryption key before the last change; values stored with it stay readable. See [Changing the encryption key](#changing-the-encryption-key). |
| `UNIHUB_BACKUP_MASTER_KEY` | `BACKUP_MASTER_KEY` | Optional | A separate persistent key for server-side backup unlocking. If blank, the app uses `ENCRYPTION_KEY`. Set it before first use if wanted, then preserve it. |
| `UNIHUB_INSTANCE_BACKUP_DIR` | `INSTANCE_BACKUP_DIR` | Optional | Where the instance backup writes, inside the container, for example `/backup`; mount a disk or share of its own there (see [section 5](#5-keep-storage-and-startup-defaults)). Blank: no instance backup. |
| `UNIHUB_INSTANCE_BACKUP_KEY` | `INSTANCE_BACKUP_KEY` | Optional | The instance backup's own key, at least 32 random bytes (`openssl rand -base64 48`), never one of the keys above. Blank: no instance backup. |
| `UNIHUB_INSTANCE_BACKUP_TIME`, `UNIHUB_INSTANCE_BACKUP_KEEP` | `INSTANCE_BACKUP_TIME`, `INSTANCE_BACKUP_KEEP` | Optional | The daily time (`HH:MM`, UTC) and how many backups are kept, until an administrator sets them in Server settings > Instance backup; blank keeps 03:30 and 14. |

Generate each database password/key separately. This produces a single-line value
without shell interpolation characters such as `$`:

```bash
openssl rand -hex 32
```

Paste each generated value after its field's `=`. Do not reuse one secret for all
fields. For a password containing `$` or `#`, use a single-quoted value in Compose
`.env`, for example `UNIHUB_BOOTSTRAP_ADMIN_PASSWORD='your chosen password'`.
The example text is not a suggested password. Avoid embedded quotes/newlines when
using this simple format. `.env` is ignored by Git but still needs private storage.

**Secrets as files.** Every secret can be given as a file instead: the
container variable with `_FILE` appended names the file, for example
`JWT_SECRET_FILE=/run/secrets/unihub_jwt_secret`. This works for
`JWT_SECRET`, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS`, `BACKUP_MASTER_KEY`,
`MYSQL_PASSWORD`, `DATABASE_URL`, `BOOTSTRAP_ADMIN_PASSWORD` and
`INSTANCE_BACKUP_KEY`; MariaDB's image reads `MARIADB_PASSWORD_FILE` and
`MARIADB_ROOT_PASSWORD_FILE` the same way. `docker-compose.yml` shows the
`secrets:` form, which keeps the values out of `docker inspect` and the
environment. A file holds the value alone; one trailing line break is ignored.
It must be readable by uid 10001, which runs the API unless you set `user:` (`chown 10001` and
`chmod 400` on the host). Keep secret files outside `/app/uploads`: a secret
file inside the stored files stops the start, since backups copy them. When a variable and its file are both set and differ,
or the file is missing, empty or unreadable, UniHub does not start and its log
names the setting, never the value.

**What startup checks actually enforce:** Compose refuses empty required values.
The API also rejects empty/known placeholder JWT, encryption and database secrets,
and rejects an initial admin password shorter than 12 characters. It does not
measure secret randomness or enforce our recommended generated-key length.

**First startup versus later restarts:** bootstrap credentials create the first
admin during initial schema setup when the users table is empty. They do not reset
an existing administrator. The supplied Compose file still requires both values
on every invocation, even after setup. Keep them populated; change an existing
user's password through the app, not by editing these fields.

Database image initialization variables also do not reset passwords in an existing
MariaDB data volume. Changing only `.env` can break the app's database connection.

## 4. Configure browser access and proxy trust

These settings have different purposes. None is a visitor-IP firewall.

| Setting | Where you currently edit it | What it means |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `services.unihub.environment` in `docker-compose.yml` | The exact browser addresses allowed to call the API. Include scheme and any nonstandard port, with no path or trailing slash. |
| `UNIHUB_TRUSTED_PROXY_CIDRS` | `.env` | Addresses of proxies you control that may report the visitor's IP. Compose passes this as `TRUSTED_PROXY_CIDRS`. |
| `TRUST_PROXY_HEADERS` | App environment in Compose | Keep `"true"` for the bundled Nginx proxy and configured outer proxy. |
| `TRUSTED_MAIL_HOSTS` | App environment in Compose | Optional exceptions allowing outgoing mail/CalDAV connections to private addresses. Not an inbound access list. |

Replace the placeholder origins in the app's Compose environment. For example:

```yaml
ALLOWED_ORIGINS: "https://hub.example.com"
TRUSTED_MAIL_HOSTS: ""
```

If you really use two browser addresses, list both separated by commas. An IP-based
origin also needs its scheme, for example `https://192.168.1.20:8443`, and a trusted
certificate appropriate to that address. Do not use `*`, `/api`, or a whole subnet
as an origin. A wrong origin can leave the page visible while API requests fail
with `403 Origin not allowed`.

**Adding `ALLOWED_ORIGINS` or `TRUSTED_MAIL_HOSTS` to `.env` alone does nothing in the
current Compose file.** Those two values are written directly in its YAML. The
Dockerfile is not the place to configure them either.

Retain the bundled loopback proxies and add the outer proxy's actual connecting
address, as seen by UniHub's Nginx. Example, only if your proxy connects from
`172.20.0.8`:

```dotenv
UNIHUB_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,172.20.0.8/32
```

`/32` means one IPv4 address; `/128` means one IPv6 address. Do not enter your own
phone/laptop IP, a domain name, all private networks, or `0.0.0.0/0`. A Docker
network can change the proxy address seen by the app; verify it rather than
copying this example. The outer proxy must preserve the browser Host and set or
append `X-Forwarded-For` using the actual client connection. Without the correct
trusted outer address, multiple visitors can share the proxy's IP rate limit.
Malformed proxy addresses prevent startup. See [proxy details](AUTH_ADMIN_SETTINGS.md#trusted-proxies).

Restrict the published app port to the intended proxy/network with your host
firewall or network configuration. `ALLOWED_ORIGINS` does not block non-browser
clients and proxy trust does not grant/restrict login access. This app has no
installation field implementing a general visitor-IP allowlist.

Leave `TRUSTED_MAIL_HOSTS` empty for normal public providers. If a mail or CalDAV
server resolves to a private address, list only its intended hostname or literal
IP, without a URL scheme, port or CIDR. A hostname entry also permits its
subdomains, so use the narrowest hostname. This exception does not disable TLS
certificate verification. It is not required to start UniHub.

## 5. Keep storage and startup defaults

| Container/mount | Contents | Must persist? |
| --- | --- | --- |
| MariaDB `/var/lib/mysql`, Compose volume `mariadb_data` | Users, mail metadata/bodies, contacts, events/tasks, settings and jobs | Yes |
| UniHub `/app/uploads`, Compose volume `uploads_data` | Mail originals/attachments, recordings, generated backups and restore uploads | Yes |
| UniHub instance backup destination, for example `/backup` (optional) | The encrypted instance backups | Yes, on other storage than the two above |

**What the installation itself must provide.** UniHub encrypts saved
passwords and its backups, but the database and uploads volumes hold
everything else in readable form. Encrypting those volumes (an encrypted
disk, dataset or volume driver) is the installation's job; UniHub does not
do it and cannot check it. Keep `ENCRYPTION_KEY`, `BACKUP_MASTER_KEY`,
`JWT_SECRET` and the instance backup key in a password manager, apart from the
server: no backup holds them, and a backup cannot be read or used without
them.

**The instance backup** copies the database and every stored file, encrypted
with its own key, to a destination you mount, daily and on "Back up now" in
Settings > Server settings > Instance backup. Give it a disk or share of its
own that nothing else writes to, writable by uid 10001 (or your `user:`), and set
`UNIHUB_INSTANCE_BACKUP_DIR` to where it is mounted in the container, together
with `UNIHUB_INSTANCE_BACKUP_KEY` (or its file):

```yaml
    volumes:
      - uploads_data:/app/uploads
      - /srv/backups/unihub:/backup
```

```bash
sudo install -d -o 10001 -g 10001 -m 700 /srv/backups/unihub
```

Without both settings the instance backup is off, the admin page says so, and
everything else works. How it runs and how to restore it:
[Data recovery, Instance backup](DATA_RECOVERY.md#instance-backup).

The MariaDB settings (character set, memory and log sizes, connection limit) are
command-line options of the `unihub-db` service in `docker-compose.yml`. There is
no separate configuration file to keep.

**Another user or port.** The Compose file starts the container as root: the
API then runs as uid 10001, Nginx keeps a root master process, and the
`cap_add` list is what that needs. To run everything as one unprivileged user
instead, give the `unihub` service `user: "<uid>:<gid>"` and remove `cap_add`.
The container then cannot change ownership itself: `/app/uploads`, an
instance backup folder and secret files must already be usable by that user.
`UNIHUB_HTTP_PORT` sets the port Nginx listens on inside the container (80
unless set). A user other than root is not allowed to open port 80
everywhere, so set a port above 1023 together with `user:` and map the
published port to it, for example `"3000:8080"`. Any port works: given 4000,
the API's own port inside the container, the API moves to 4001.

Use writable storage suitable for each container's actual user/permissions. Do
not mount a new empty dataset over existing data during an upgrade. Keep the same
Compose project/directory or explicit project name, since changing it can select
new named volumes and make the installation appear empty. Do not use
`docker compose down -v` to troubleshoot startup: it deletes named volumes.

The provided deployment sets database host `unihub-db`, port `3306`, database
`unihub` and user `unihub`. Leave these internal defaults unchanged for this guide.
The administrator does not need to create database tables manually.

Keep the 300-second authenticated MariaDB readiness budget, five-second polling,
two-second Nginx launch delay after starting the API and 360-second health-check grace period. The readiness
wait ends on the first successful connection. If its budget expires, the API still
makes bounded connection retries; five minutes is not a guaranteed total startup
time or a mandatory pause. Do not repeatedly restart a database that is initializing.

For controlled updates, change the app image in your deployment copy from `latest`
to `ghcr.io/mrksrus/selfhost-unihub:0.18.2`. Use release tags, not a mutable `latest`
image, when you need a reproducible version. Do not change the MariaDB version
(`mariadb:11.8`) as part of an ordinary app update; MariaDB cannot move a data
directory back to an older version.

## 6. Start and check the installation

From the same deployment directory:

```bash
docker compose config --quiet
docker compose up -d
docker compose ps
docker compose logs --tail=100 unihub unihub-db
```

The quiet configuration check catches missing substitutions/YAML errors; it does
not verify password correctness, HTTPS or whether storage permissions work. Avoid
sharing ordinary `docker compose config` output: it expands secrets.

Wait for a database connection, schema readiness and a healthy app. Open your
configured **HTTPS** address and sign in with the bootstrap credentials. Check
Settings/Admin before enabling signups; new installations default to disabled
signup. Then add mail accounts using their separate IMAP/SMTP credentials inside
the app. Mail-provider credentials are not installation secrets.

Choose Download or server-following Sync deliberately; read [mail modes](MAIL_MODES.md).
Test a small backup/download and restore into a disposable account before relying
on recovery. Set up a separate consistent backup of database, uploads and secrets.
Configure notifications and offline reading separately on each device. Push keys
are generated by the app; you do not need to supply VAPID keys at installation.
`VITE_API_URL` is a frontend build setting; changing it in `.env` does not rebuild
the published image. That image already uses its bundled `/api` proxy.

The API's log lines read `[AREA] message key=value …`. A line written while a
request was handled ends with its `requestId`; a request that failed with a
server error returns the same id in its response (`requestId`, and the
`X-Request-Id` header on every response), so `docker compose logs unihub | grep
<id>` finds what happened. `UNIHUB_LOG_FORMAT=json` in `.env` writes one JSON
object per line instead, for a log collector.

## Common problems

| Symptom | Check |
| --- | --- |
| Compose says a variable is required | All six required `.env` fields are populated and `.env` is beside the Compose file. |
| `UniHub needs MariaDB … but the database server reports …` | The app was pointed at a MySQL database. Since 0.16.0 UniHub needs MariaDB; see the [upgrade guide](UPGRADING.md#0160-mariadb). |
| Repeated database connection failures | Matching DB password, correct existing volume, MariaDB logs and startup time. Editing initialization variables does not change an existing database password. |
| `The database has tables or data but no upgrade history` | The database is not empty and either was not set up by UniHub or has lost its `schema_migrations` table (restore it from a backup of that database). Otherwise use an empty database. |
| Missing/placeholder secret or short bootstrap password | Supply real generated keys and a bootstrap password of at least 12 characters. |
| Invalid `TRUSTED_PROXY_CIDRS` | Use IPs/CIDRs only, not hostnames or URLs. Keep the loopback entries. |
| Page loads but API returns `Origin not allowed` | Exact HTTPS scheme, hostname and port in Compose's `ALLOWED_ORIGINS`; restart/recreate the app after changing its environment. |
| Sign-in seems successful but session disappears | Use HTTPS with a trusted certificate; production cookies are secure. |
| Private mail server is blocked | Check its intended DNS/IP, then configure a narrow `TRUSTED_MAIL_HOSTS` exception. |
| Existing installation looks empty | Stop and inspect project name and volume mappings. Do not delete volumes or reinitialize data. |
| Uploads fail | Check `/app/uploads` permissions/free space and outer proxy request limits. The outer proxy must allow the payload sizes/timeouts you intend to use, including backups. |

For ordinary configuration edits to an existing deployment, keep keys/data and use
`docker compose up -d` to apply changed container settings. A plain container
restart does not apply edited environment definitions. For version changes, follow
the [upgrade guide](UPGRADING.md).

## Changing the encryption key

Saved mail and calendar passwords, authenticator keys, subscription addresses
and the push private key are encrypted with `ENCRYPTION_KEY`. To replace the key
(for example after it was exposed):

1. Make a backup and keep it with the current key.
2. If `UNIHUB_BACKUP_MASTER_KEY` is blank, set it to the current
   `UNIHUB_ENCRYPTION_KEY`; backup archives are sealed with that key and stay
   unlockable only while it stays the same.
3. Set `UNIHUB_ENCRYPTION_KEY_PREVIOUS` to the current key and
   `UNIHUB_ENCRYPTION_KEY` to a new random value, then restart UniHub.

Stored values are read with the new key and then with the previous one, so
nothing has to be entered again; everything saved from then on uses the new
key. Values are not rewritten in bulk yet: keep the previous key set as long as
any value stored before the change remains.

