# UniHub

Your mail, contacts, calendar, tasks, notes and recordings in one self-hosted web app.
UniHub has a black-and-blue interface, works on desktop and mobile, and can be
installed as a PWA. Your server stores the application data.

**[Install UniHub](docs/INSTALLATION.md)** · **[Upgrade an existing installation](docs/UPGRADING.md)** · **[Releases](https://github.com/mrksrus/selfhost-unihub/releases)** · **[Report a problem](https://github.com/mrksrus/selfhost-unihub/issues)**

Free for private noncommercial self-hosting, including multi-user home labs.
Company/business use, including internal operations, requires a separate paid licence;
contact [smrus@rus.family](mailto:smrus@rus.family). The public licence also permits
the nonprofit/public-institution uses it expressly lists. See [Licensing](LICENSING.md).

## What you can do

| Feature | What to expect |
| --- | --- |
| Mail | Read and send mail, attachments, folders, search and bulk actions. Download mode can optionally delete downloaded mail from the provider. Sync mode follows server read/star/folder changes and retains missing messages locally. Sync also sends new read/star/move actions back, with visible pending/failure status and server-authoritative conflict handling. |
| Contacts | Search, favourites, vCard import/export and duplicate merging. |
| Calendar and tasks | Plan events and work through tasks using shared calendar data, reminders and subtasks. CalDAV imports supported non-recurring events; it does not send edits back. |
| Notes | Text/Markdown editing, revision history, links, attachments and Trash. Currently online-only. |
| Recordings | Record in the browser or import audio, then organise, play and download it. |
| Optional modules | Hide features or disable their access/background work. Disabling a module keeps its data and full-backup coverage. |
| Backups / imports (ALPHA) | Experimental encrypted account exports and imports. Do not use them as your only backup. |
| Mobile and offline | Installable PWA and opt-in read-only snapshots of up to 100 non-draft emails, contacts and calendar/tasks, subject to a 32 MiB limit. Notifications depend on browser and OS support. |
| Games | Nine browser games. Some progress stays only in the browser and is not included in account backups. |

## Install: start here

The published deployment uses **two containers: UniHub and MySQL 8.0**. You need
Docker with Compose, persistent storage for both containers, and an HTTPS reverse
proxy for normal browser access. A reverse proxy is the service that accepts your
HTTPS address and forwards requests to UniHub's internal HTTP port.

For a **new installation**, first collect:

| You supply | Why it is needed |
| --- | --- |
| First administrator email and password | Creates your first UniHub login. The password must have at least 12 characters. This is not your email-provider password. |
| Two database passwords | One for UniHub's database user and a different one for MySQL administration. |
| Two independently generated secrets | One signs login sessions; the other encrypts stored credentials. Keep both with your deployment records. |
| Your browser address | For example, `https://hub.example.com`. It must be entered as an allowed origin. |
| Your HTTPS proxy's address | Identifies the proxy allowed to report visitor IPs. It is not a list of permitted visitors. |
| Persistent storage | Keep the database and `/app/uploads` across updates and restarts. |

**Follow the [installation guide](docs/INSTALLATION.md) before starting the containers.**
It gives the exact field names, where to enter them, examples, first-login checks
and fixes for common startup errors. Do not put passwords into the Dockerfile.

Published image: `ghcr.io/mrksrus/selfhost-unihub:0.10.10`.
The `latest` tag follows successful main-branch and release builds; use a version
tag when you want explicit control of upgrades. The supplied
[Compose file](docker-compose.yml) currently uses `latest`.

**TrueNAS:** a [draft Community catalog installer](https://github.com/truenas/apps/pull/5847)
is under review; it is not yet an approved catalog app. Pasting the
supplied Compose file into a custom-app screen is not a complete installation:
its environment substitutions and relative MySQL configuration mount also need
resolving. See [TrueNAS installation preparation](docs/TRUENAS_INSTALLER.md).

## Keep your data recoverable

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of MySQL, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Keep **both persistent volumes plus your deployment configuration and secrets**.
A consistent server backup is needed to recover the whole installation. A UniHub
account export does not include other users or deployment configuration.

Download important account backups and keep their recovery passwords somewhere
safe. Backups left only on the UniHub server do not protect you if that server or
its storage is lost. There is no built-in scheduled infrastructure backup.

Version 0.10.6 enables backup creation/import again. Its schema-3 archives include
Notes and disabled modules; older schema-1/2 archives are read automatically.
Older applications cannot read schema-3 archives. Downgrading an image does not
undo database changes. Read [Backup and restore (ALPHA)](docs/BACKUP_RESTORE.md) and
[Upgrading](docs/UPGRADING.md) before relying on either operation.

## Help and documentation

| I want to… | Read this |
| --- | --- |
| Install and understand every required setting | [Installation and configuration](docs/INSTALLATION.md) |
| Prepare a TrueNAS catalog installer | [Proposed installer fields and remaining work](docs/TRUENAS_INSTALLER.md) |
| Update without replacing my data | [Upgrade guide](docs/UPGRADING.md) |
| Back up or restore my account | [Backup and restore (ALPHA)](docs/BACKUP_RESTORE.md) |
| Choose Download or Sync | [Mail modes](docs/MAIL_MODES.md) |
| Use Notes or optional features | [Modules and Notes](docs/MODULES_AND_NOTES.md) |
| Configure administrators and trusted proxies | [Authentication and administration](docs/AUTH_ADMIN_SETTINGS.md) |
| Install the PWA or troubleshoot notifications | [PWA guide](docs/PWA.md) |
| Read saved data without a connection | [Offline reading](docs/OFFLINE.md) |
| Develop or inspect the application | [Development](docs/DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md), [recovery contracts](docs/DATA_RECOVERY.md) |

For reproducible bugs, open a [GitHub issue](https://github.com/mrksrus/selfhost-unihub/issues)
with the version and steps to reproduce. Remove passwords, keys and personal mail
from logs. Report security vulnerabilities privately to
[smrus@rus.family](mailto:smrus@rus.family); see [Security](SECURITY.md).

## Project and limits

UniHub is AI-written. Its maintainer, **[mrksrus](https://github.com/mrksrus)**,
is not a developer and has no formal software-development qualifications; prior
coding experience was a tic-tac-toe game and a webpage about 15 years ago.
Code development, maintenance and security/function reviews currently rely solely
on OpenAI/GPT models. Future plans include Fable/Anthropic models for additional
reviews and improvements; they are not part of the current process. Automated tests
and AI reviews do not constitute an independent professional security audit.
UniHub is not affiliated with or endorsed by these providers.

Release CI checks the API, frontend, MySQL recovery and built-container startup,
authentication and recordings. These checks do not guarantee every provider,
device or existing installation behaves identically.

The app currently targets one application container. Login rate limits reset on
restart, signup has no email verification, and audit logging is limited. PWA
notifications are not guaranteed on every browser/OS. See the linked feature
guides for additional limits.

Starting with v0.10.1, project-owned code is source-available under
[PolyForm Noncommercial 1.0.0](LICENSE). Earlier versions retain their original
terms; dependencies retain their own licences. [Licensing details](LICENSING.md).
