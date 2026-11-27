# UniHub as a TrueNAS app

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

[Installation guide](INSTALLATION.md) · [Main page](../README.md)

UniHub is in the TrueNAS Community catalog
([added here](https://github.com/truenas/apps/pull/5975)): install it from
the Apps page of TrueNAS. TrueNAS can also run UniHub as a custom app from
the [Compose file](../docker-compose.yml).

The app is the same image as every other installation, with a separate MariaDB
container: the catalog's MariaDB 13, which UniHub's releases are tested on
from 0.28.4. The container runs as the user and
group chosen in the form (568, `apps`, unless changed), without root and
without Linux capabilities, and listens on the port chosen in the form.

## Before you install

**Sign-in needs HTTPS.** UniHub's login cookies are only sent over HTTPS, so
the page opened as `http://NAS-IP:port` loads but cannot keep you signed in.
Put an HTTPS reverse proxy in front of the app's port (Nginx Proxy Manager,
Caddy, Traefik, a tunnel) with a certificate your devices trust. A public
domain or Internet access is not required; private DNS works. The proxy
must let chat uploads of 101 MB through, and pass WebSockets for calls
between networks ([what each proxy needs](UPGRADING.md#0351-calls-between-networks)). See
[Prepare your server and browser address](INSTALLATION.md#1-prepare-your-server-and-browser-address).

## The form

| Field | What it sets |
| --- | --- |
| Initial Admin Email, Initial Admin Password | `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`: the first administrator, created once on an empty database. Fixed at installation; change the account in UniHub afterwards. |
| Database Password, Root Database Password | The MariaDB container's `unihub` and `root` passwords. Do not change them after the first start: the database keeps the old ones, and the app no longer starts. |
| JWT Secret | `JWT_SECRET`, which signs the login sessions. Changing it signs everyone out. |
| Encryption Key | `ENCRYPTION_KEY`, which encrypts saved mail and calendar passwords and authenticator keys. Losing it makes them unreadable; keep a copy outside the NAS. |
| Origins | `ALLOWED_ORIGINS`: every address people open UniHub at, as in the browser (`https://hub.example.com`, with the port when it is not 443). Each must be HTTPS; the installation refuses any other address. While the port's bind mode is Publish, the app's Web UI button opens the first one. |
| User ID, Group ID | The user everything in the UniHub container runs as and that owns the uploads. Changing it later does not change the owner of existing files. |
| WebUI Port | `UNIHUB_HTTP_PORT` and the published port. It serves plain HTTP for your reverse proxy. |
| Uploads Storage | `/app/uploads`: mail originals, attachments, recordings and account backups. |
| Database Storage | MariaDB's data. |

Everything else goes into **Additional Environment Variables**, described in the
[installation guide](INSTALLATION.md):

- `TRUSTED_PROXY_CIDRS`: your reverse proxy's address as UniHub sees it, after
  the two loopback entries (`127.0.0.1/32,::1/128,172.16.0.5/32`), so the
  sign-in limits count each visitor and not the proxy
  ([proxy trust](INSTALLATION.md#4-configure-browser-access-and-proxy-trust)).
- `TRUSTED_MAIL_HOSTS`: mail or CalDAV servers at private addresses.
- `ENCRYPTION_KEY_PREVIOUS` and `BACKUP_MASTER_KEY`:
  [changing the encryption key](INSTALLATION.md#changing-the-encryption-key).
- `INSTANCE_BACKUP_DIR` and `INSTANCE_BACKUP_KEY`, with an Additional Storage
  mounted at that folder: the [instance backup](DATA_RECOVERY.md#instance-backup).

The form has no fields or ports for the relay for calls. Calls between
networks go through UniHub instead, through the reverse proxy
([Calls and the relay](INSTALLATION.md#calls-and-the-relay)).

## Keep your data recoverable

Back up the two storage datasets together with the form's secrets; a snapshot
of one without the other, or either without the encryption key, is not a
usable backup. Take one before every app update: a database upgrade runs at
the first start of a new version and cannot be undone by rolling the app back
([upgrade guide](UPGRADING.md)). The catalog also updates MariaDB, which
cannot return to an older version either.

An installation that ran as a custom app is not adopted automatically, and
moving one into the catalog app has not been tested. Never run both against
the same storage.
