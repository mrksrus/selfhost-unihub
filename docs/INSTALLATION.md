# Install and configure UniHub

[Back to the main page](../README.md) · [Existing installation? Read the upgrade guide](UPGRADING.md)

This guide describes the supplied Compose deployment for **0.10.6**. It separates
settings that stop startup from settings needed for browser access. Examples are
illustrations, not working passwords or addresses. Never replace existing keys or
volumes by following the fresh-install steps on an existing installation.

## 1. Prepare your server and browser address

You need Docker with the Compose plugin, Git, and persistent disk space for mail,
recordings, Notes attachments, backups and the database. The supplied images use
MySQL 8.0; do not substitute MariaDB without separate compatibility testing.

Choose a browser address such as `https://hub.example.com`, with DNS pointing to
your HTTPS reverse proxy and a certificate your devices trust. A LAN-only service
can use private DNS and HTTPS; public Internet exposure is not required.

The proxy forwards to the server's published port **3000**, which reaches port 80
inside UniHub. The API's port 4000 and MySQL's port 3306 stay internal. If the proxy
is itself a container, `localhost` refers to that container, not your NAS.

Production login cookies require HTTPS. Opening `http://NAS-IP:3000` may show the
page but is not a supported normal login setup. Some browsers treat localhost
specially; do not rely on that exception for deployment. Do not switch production
into development mode to work around HTTPS.

## 2. Get the deployment files

On a server where you manage Docker Compose directly:

```bash
git clone https://github.com/mrksrus/selfhost-unihub.git
cd selfhost-unihub
cp .env.example .env
chmod 600 .env
```

Keep `docker-compose.yml`, `.env` and `docker/mysql/conf/custom.cnf` in this layout.
The Compose file mounts the MySQL configuration by relative path. The app image
already contains the application: no build, Node.js installation or Dockerfile
editing is required.

For TrueNAS Apps UI deployment, read [TrueNAS preparation](TRUENAS_INSTALLER.md)
instead of assuming these shell steps create a catalog app.

## 3. Enter the startup values in .env

Edit `.env` beside `docker-compose.yml`. Values on the left are the exact names
used by the supplied Compose file. Compose passes them into the containers using
the runtime names shown below. Do not paste actual secrets into public issues.

| .env field | Container runtime field | Required? | What to enter |
| --- | --- | --- | --- |
| `UNIHUB_MYSQL_PASSWORD` | `MYSQL_PASSWORD` in both containers | Yes | A generated database-user password. Both containers must use the same value. This is not the web login. |
| `UNIHUB_MYSQL_ROOT_PASSWORD` | `MYSQL_ROOT_PASSWORD` in MySQL only | Yes | A different generated password for database administration. UniHub does not log into MySQL as root. |
| `UNIHUB_JWT_SECRET` | `JWT_SECRET` | Yes | An independent random secret used to sign login sessions. |
| `UNIHUB_ENCRYPTION_KEY` | `ENCRYPTION_KEY` | Yes | Another independent random secret protecting saved account credentials, 2FA secrets and the push private key. Preserve it across upgrades. |
| `UNIHUB_BOOTSTRAP_ADMIN_EMAIL` | `BOOTSTRAP_ADMIN_EMAIL` | Yes in supplied Compose | The email address you will use as the first UniHub administrator login. You do not need to connect its mailbox to create the account. |
| `UNIHUB_BOOTSTRAP_ADMIN_PASSWORD` | `BOOTSTRAP_ADMIN_PASSWORD` | Yes in supplied Compose | Your initial web-login password, at least 12 characters. Use a password manager. |
| `UNIHUB_BACKUP_MASTER_KEY` | `BACKUP_MASTER_KEY` | Optional | A separate persistent key for server-side backup unlocking. If blank, the app uses `ENCRYPTION_KEY`. Set it before first use if wanted, then preserve it. |

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
MySQL data volume. Changing only `.env` can break the app's database connection.

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
| MySQL `/var/lib/mysql`, Compose volume `mysql_data` | Users, mail metadata/bodies, contacts, events/tasks, Notes text/revisions, settings and jobs | Yes |
| UniHub `/app/uploads`, Compose volume `uploads_data` | Mail originals/attachments, recordings, Notes attachments, generated backups and restore uploads | Yes |
| MySQL `/etc/mysql/conf.d/custom.cnf` | Read-only configuration from the repository | Keep the source file available |

Use writable storage suitable for each container's actual user/permissions. Do
not mount a new empty dataset over existing data during an upgrade. Keep the same
Compose project/directory or explicit project name, since changing it can select
new named volumes and make the installation appear empty. Do not use
`docker compose down -v` to troubleshoot startup: it deletes named volumes.

The provided deployment sets database host `unihub-mysql`, port `3306`, database
`unihub` and user `unihub`. Leave these internal defaults unchanged for this guide.
The administrator does not need to create database tables manually.

Keep the 300-second authenticated MySQL readiness budget, five-second polling,
two-second Nginx launch delay after starting the API and 360-second health-check grace period. The readiness
wait ends on the first successful connection. If its budget expires, the API still
makes bounded connection retries; five minutes is not a guaranteed total startup
time or a mandatory pause. Do not repeatedly restart a database that is initializing.

For controlled updates, change the app image in your deployment copy from `latest`
to `ghcr.io/mrksrus/selfhost-unihub:0.10.6`. Use release tags, not a mutable `latest`
image, when you need a reproducible version. Do not change the MySQL major version
as part of an ordinary app update.

## 6. Start and check the installation

From the same deployment directory:

```bash
docker compose config --quiet
docker compose up -d
docker compose ps
docker compose logs --tail=100 unihub unihub-mysql
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

## Common problems

| Symptom | Check |
| --- | --- |
| Compose says a variable is required | All six required `.env` fields are populated and `.env` is beside the Compose file. |
| Repeated database connection failures | Matching DB password, correct existing volume, MySQL logs and startup time. Editing initialization variables does not change an existing database password. |
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
