# UniHub

Your mail, contacts, calendar, tasks and recordings in one self-hosted web app.
UniHub has a black-and-blue interface, works on desktop and mobile, and can be
installed as a PWA. Your server stores the application data.

**[Install UniHub](docs/INSTALLATION.md)** · **[Upgrade an existing installation](docs/UPGRADING.md)** · **[Changelog](CHANGELOG.md)** · **[Road to 1.0](docs/ROADMAP.md)** · **[Releases](https://github.com/mrksrus/selfhost-unihub/releases)** · **[Report a problem](https://github.com/mrksrus/selfhost-unihub/issues)**

Free for private noncommercial self-hosting, including multi-user home labs.
Company/business use, including internal operations, requires a separate paid licence;
see [Licensing](LICENSING.md) for how to ask. The public licence also permits
the nonprofit/public-institution uses it expressly lists. See [Licensing](LICENSING.md).

## Who is this for?

UniHub is meant to become a complete, self-hosted system for communicating and
organising: mail, contacts, calendar and ToDo, voice and music recordings,
end-to-end encrypted chat and voice calls, with notifications that are
delivered independently as well. There is still a lot to do, but it is intended as a fully independent
service. That is also why the app is for Android only right now: on Android,
UniHub can deliver its own notifications. An iOS app will probably come, but I
am still working out the best way to do it there.

- **Hosted by YOU.** UniHub runs on your server (presumably your own).
- **Your data is in YOUR control.** Mail, contacts, calendars, recordings and
  backups live in your database and your storage.
- **Notifications are INDEPENDENT** (on Android). The Android app receives them
  over its own connection to your server; no Google, Apple or other push
  service is involved.
- **Management is INCLUDED.** People, groups, roles, rules (policies) and an
  activity log for administrators.
- **It is MODULAR.** You see what you want and do not see what you do not want.
- **Calls are INCLUDED.** Voice calls between UniHub users, with video and
  group calls next on the [road to 1.0](docs/ROADMAP.md); calls to ordinary
  phone numbers are not.

So UniHub is for people who care about privacy and are not happy about having
to use WhatsApp, Outlook, Gmail and other proprietary apps for all of this and
more.

The goal is for UniHub to be both capable and safe enough for organisations
that want communication infrastructure of their own, with everything under
their control, administration tools included, and everything in one place they
can trust: full control, and full transparency of the code, which you can
inspect, change, and add functions to or remove them from. UniHub is not there
yet: it is pre-1.0 and has had no independent security audit (see the
[honest self-rating](#encryption-honestly)), and business use needs a
[licence](LICENSING.md).

It just so happens that it is also really cool for self-hosting nerds like me
who care about their privacy and do not want to hand their data to Gmail,
Outlook, Apple, WhatsApp and the rest.

## What you can do

Built and released today (0.35):

| Feature | What to expect |
| --- | --- |
| Mail | Read and send mail with attachments, folders, search, conversations, templates, snooze, scheduled send and a signature per account. Download mode can optionally delete downloaded mail from the provider. Sync mode follows the server's read, star and folder changes, sends yours back with visible pending and failure states, and keeps messages that vanish from the server. [Mail modes](docs/MAIL_MODES.md) |
| Contacts | Contacts with every vCard field, vCard and Google/Outlook CSV import and export, and duplicate merging that can be undone. The **company directory** lists everyone in the organisation; **shared address books** are shared with people or groups for reading or editing. [Contacts](docs/CONTACTS.md) |
| Calendar and ToDo | Local calendars inside UniHub, shared with people or groups, group and organisation calendars, repeating events, plus two-way sync with CalDAV servers such as Stalwart, Nextcloud, iCloud and Fastmail, including recurring events; Google and Microsoft calendars as read-only subscriptions. Tasks with subtasks, reminders, your own order and default lists. [Calendar](docs/CALENDAR.md) |
| Chat | 1:1 and group chats with colleagues on the web and in the Android app, always end-to-end encrypted, files and voice messages included: replies, edits, deleting for everyone, mentions, delivery and read state, presence, and search on the device. A group chat can follow an organisation group and change with it. A chat passphrase brings the history to a new phone or browser; nobody else can read or restore a chat. A new device joins Chat only with the passphrase or your approval from another device. An administrator can have chat messages deleted after a set time. [Chat](docs/CHAT.md) |
| Calls | Voice calls between two colleagues in the browser and in the Android app, encrypted between the two devices. On Android they ring like phone calls, with the app closed and over the lock screen. An optional relay, built into the image, connects calls between different networks. [Calls](docs/CHAT.md#calls) |
| Recordings and Music | Record in the browser or import audio, then organise, play and download it; Music keeps chords and lyrics with a recording. |
| People, groups and rules | Add people with a one-time setup link, put them in groups with managers, and set rules for everyone or a group: required two-factor authentication, password length, session lifetime, modules, notification detail, app lock, phone contacts, offline copies, data safety and chat (who members may add, the largest file, how long messages are kept, calls). One owner manages the administrators; an activity log records sign-ins and administrative actions. [Administration](docs/AUTH_ADMIN_SETTINGS.md) |
| Optional modules | Reorder, hide or disable modules and their background work. Disabling a module keeps its data. [Modules](docs/MODULES.md) |
| Bin, backups and imports (ALPHA) | Deleted items wait in a bin for as long as each person chooses, within the administrator's rules. Password-protected account backups that also open outside UniHub (off until an administrator allows them), and an encrypted whole-server backup for administrators. Backup and restore are experimental: do not use them as your only backup. |
| App lock | Lock the whole app or chosen modules on a device with a fingerprint, face or the phone's PIN in the Android app, or a UniHub PIN in a browser; administrators can require it. It protects an unlocked device, not the server. [App lock](docs/APP_LOCK.md) |
| Android app | UniHub's own notifications without Google's push service, your contacts and shared address books in the phone's contacts, attachments opened, saved and shared like any app's, and UniHub as the phone's email app. The server offers the app for download; there is no app store. [Android app](docs/ANDROID.md) |
| Web app and offline | Works in the browser on desktop and mobile and installs as a PWA with Web Push notifications. Opt-in read-only offline copies of up to 100 recent emails, contacts and calendar/tasks (32 MiB). [PWA](docs/PWA.md), [offline reading](docs/OFFLINE.md) |

Planned, one theme per version ([Road to 1.0](docs/ROADMAP.md); nothing below is built yet):

| Version | Planned |
| --- | --- |
| 0.36 | Video, screen sharing in the browser and group calls through an optional self-hosted media server. |
| 1.0 | Stabilisation, a security review and a documented threat model; stable formats for the whole 1.x line. |

Not planned before 1.0: iOS, calls to ordinary phone numbers or SMS, chat
between different UniHub servers, and the other ideas in the
[parking lot](docs/ROADMAP.md#parking-lot).

## How it compares

UniHub aims to put mail, calendars, tasks, contacts, chat and calls in one
place you run. This is how the tools people use today handle the same
questions. It describes the usual setup; each of them has plans and add-ons
that change details.

| | Who runs the server | End-to-end encrypted | Notifications travel through | Administration | Source code |
| --- | --- | --- | --- | --- | --- |
| **UniHub today** | You | Chat messages and files, and calls between the two devices (not against a server changed to attack its users, see [Chat](docs/CHAT.md#what-the-encryption-protects)) | Android app: its own connection to your server. Browser: the browser's push service, encrypted for the device | People, groups, roles, rules, activity log | Source-available ([PolyForm Noncommercial](LICENSE)) |
| WhatsApp-style messengers | The company (Meta for WhatsApp) | Messages and calls | Google's or Apple's push service | None for most users | Closed |
| Signal | Signal Foundation | Messages and calls | Google's or Apple's push service; on Android without Google services, Signal's own connection | None | Open source |
| Slack or Teams-style team chat | The vendor | Not for messages | Google's or Apple's push service | Yes | Closed |
| Mattermost-style self-hosted team chat | You | Not built in | Phones: a push proxy, then Google's or Apple's push service | Yes | Open source core |
| Phone calls and SMS | Your mobile carrier | No | The phone network | None | — |
| Gmail, Outlook.com, Microsoft 365 | Google or Microsoft | Not by default (S/MIME or add-ons on some plans) | Google's or Apple's push service | Yes, on business plans | Closed |
| Desktop mail apps (Thunderbird, Apple Mail) | Your mail provider; the app keeps a copy on your computer | Optional OpenPGP or S/MIME, when both sides set it up | The app asks the mail server itself | None | Thunderbird open source, the others closed |

UniHub does not replace your mail provider: mail to the outside world still
goes through an ordinary mail server and is as private as that server.

## Encryption, honestly

What UniHub protects today, and how:

| What | How | Who can still read it |
| --- | --- | --- |
| Between your devices and your server | HTTPS from your reverse proxy (UniHub speaks plain HTTP inside the deployment); sign-in cookies are `HttpOnly`, `Secure` and `SameSite=Strict` in production | Your proxy and server |
| Mail to and from other servers | IMAP and SMTP with strict TLS certificate checks, unless you confirm a specific certificate. No S/MIME or OpenPGP | Your mail provider and every server on the way |
| Mail, contacts, calendars, tasks and recordings on the server | Stored as ordinary data in MariaDB and the uploads volume. Use disk or volume encryption on the host | Whoever runs the server or holds its disks |
| Saved mail and calendar passwords, subscription addresses, authenticator keys, the push key | AES-256-GCM with your `ENCRYPTION_KEY` | Whoever holds the database and that key |
| UniHub passwords | bcrypt | Nobody; only checked |
| Notifications | Encrypted for each device as Web Push does (RFC 8291), in the browser and the Android app; how much they show is set on the server and by the app lock | The device; the push service sees that a notification was sent, when and how large, but not its content |
| Account backups (ALPHA) | AES-256 ZIP (WinZip AE-2) with a random 256-bit recovery password | You with the password, and the server, which keeps that password sealed with its backup key (by default the same `ENCRYPTION_KEY`) |
| Whole-server backup (ALPHA) | AES-256-GCM with a key of its own from the deployment's settings; never offered for download | Whoever holds that key |
| Chat messages, files and voice messages | End-to-end encrypted on the devices with MLS (OpenMLS); each file with a key of its own that travels inside the message. The server stores ciphertext and sees who is in which chat, the names of group chats, who was mentioned, the size of each file, and when ([what the server sees](docs/CHAT.md#what-the-server-sees)). The history is kept under a key protected by each person's chat passphrase | The devices of the people in the chat. Not the server's database, backups or administrators, as long as the chat passphrase is not easy to guess; no recovery key exists. It does not protect against a server someone changed to attack its users, because every client loads its code from the server ([Chat](docs/CHAT.md#what-the-encryption-protects)) |
| Calls | WebRTC between the two devices (DTLS-SRTP), also through the optional relay, which passes on only encrypted sound. The server sees who calls whom, when and for how long, and the two devices' network addresses while the call is set up ([Calls](docs/CHAT.md#calls)) | The two devices. As for Chat, not protected against a server someone changed to attack its users |
| On a phone or computer | The offline copy and Chat's messages sit in the browser's or app's storage; the app lock is a gate, not encryption | The device; rely on its own encryption |

**Honest self-rating.** UniHub keeps your data on hardware you control and
keeps Google and Apple out of notifications on Android, which most hosted
services cannot offer. Chat is end-to-end encrypted, with OpenMLS, whose
protocol code was audited independently; the audit did not cover the parts
around it or UniHub's own code ([Chat](docs/CHAT.md#mls-and-the-library)).
Everything else on the server (mail, contacts, calendars, recordings) is
readable by whoever runs it, backup and restore are still
experimental, it is pre-1.0, and it is AI-written without an independent
security audit (see [Project](#project)). Treat it as a strong privacy step for
a self-hoster, not yet as audited infrastructure for confidential company data.

## Limitations

- **No OAuth.** UniHub signs in to mail and calendar servers with a password,
  usually an app password (iCloud, Fastmail, Yahoo; Gmail with 2-Step
  Verification on, though a work or school account may not offer app
  passwords). **Microsoft 365 and Outlook.com mail cannot be connected:**
  Microsoft accepts only OAuth for IMAP there (Microsoft 365 since 2022,
  Outlook.com since September 2024). An Exchange server an organisation runs
  itself may work if it allows IMAP and SMTP with a password; this has not
  been tested.
- **Calendars** sync two ways over CalDAV only. Google and Microsoft calendars
  (including Exchange and Microsoft 365) are read-only subscriptions, Exchange
  Web Services is not supported, tasks do not sync with CalDAV, and
  invitations are neither synced nor sent. [Calendar limits](docs/CALENDAR.md#limitations)
- **Contacts** do not sync with any provider (no CardDAV, Google or Exchange).
  They move by vCard or CSV import and export, and the Android app syncs them
  with the phone's contacts both ways.
- **Inside the organisation, no outside sync is needed:** local calendars and
  task lists, the company directory, shared address books and groups work
  within UniHub, and shared calendars and task lists follow in 0.32.
- **iOS has no app.** The web app works in Safari and, added to the Home
  Screen, gets notifications through Apple's push service (encrypted for the
  device), but without the Android app's independent notifications, phone
  contacts or fingerprint lock.
- **One application container.** Several API replicas are not supported.
  Sign-up has no email verification, two-factor authentication is TOTP with
  recovery codes (no passkeys), and browser notifications are not guaranteed
  on every browser and OS. The feature guides list further limits.

## Install: start here

**Running 0.15.x or older?** Those installations use MySQL. From 0.16.0 UniHub
needs MariaDB and refuses to start on MySQL, so a restart that pulls `latest` stops
the app. Read [the 0.16.0 upgrade notes](docs/UPGRADING.md#0160-mariadb) first, or
pin `ghcr.io/mrksrus/selfhost-unihub:0.15.1` to stay on MySQL for now.

The published deployment uses **two containers: UniHub and MariaDB 11.8 LTS**. You need
Docker with Compose, persistent storage for both containers, and an HTTPS reverse
proxy for normal browser access. A reverse proxy is the service that accepts your
HTTPS address and forwards requests to UniHub's internal HTTP port; it must let
chat uploads of 101 MB through ([Installation](docs/INSTALLATION.md#1-prepare-your-server-and-browser-address)).

For a **new installation**, first collect:

| You supply | Why it is needed |
| --- | --- |
| First administrator email and password | Creates your first UniHub login. The password must have at least 12 characters. This is not your email-provider password. |
| Two database passwords | One for UniHub's database user and a different one for MariaDB administration. |
| Two independently generated secrets | One signs login sessions; the other encrypts stored credentials. Keep both with your deployment records. |
| Your browser address | For example, `https://hub.example.com`. It must be entered as an allowed origin. |
| Your HTTPS proxy's address | Identifies the proxy allowed to report visitor IPs. It is not a list of permitted visitors. |
| Persistent storage | Keep the database and `/app/uploads` across updates and restarts. |

The [Compose file](docker-compose.yml) is the only file you need to download: it
pulls both images and contains every database setting.

**Follow the [installation guide](docs/INSTALLATION.md) before starting the containers.**
It gives the exact field names, where to enter them, examples, first-login checks
and fixes for common startup errors. Do not put passwords into the Dockerfile.

Published image: `ghcr.io/mrksrus/selfhost-unihub`, tagged with each version
(for example `0.28.4`).
The `latest` tag follows successful main-branch and release builds; use a version
tag when you want explicit control of upgrades. The supplied
[Compose file](docker-compose.yml) currently uses `latest`.

**TrueNAS:** UniHub is in the TrueNAS Community catalog
([added here](https://github.com/truenas/apps/pull/5975)). See
[UniHub as a TrueNAS app](docs/TRUENAS_INSTALLER.md).

## Keep your data recoverable

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Keep **both persistent volumes plus your deployment configuration and secrets**.
A consistent server backup is needed to recover the whole installation. A UniHub
account export does not include other users or deployment configuration.

Download important account backups and keep their recovery passwords somewhere
safe. Backups left only on the UniHub server do not protect you if that server or
its storage is lost. The experimental [instance backup](docs/DATA_RECOVERY.md#instance-backup)
can copy the whole installation daily to a disk you mount; keep an independent
copy as well.

Version 0.10.6 enables backup creation/import again. Its schema-3 archives include
disabled modules; older schema-1/2 archives are read automatically.
Older applications cannot read schema-3 archives. Downgrading an image does not
undo database changes. Read [Backup and restore (ALPHA)](docs/BACKUP_RESTORE.md) and
[Upgrading](docs/UPGRADING.md) before relying on either operation.

## Help and documentation

| I want to… | Read this |
| --- | --- |
| Install and understand every required setting | [Installation and configuration](docs/INSTALLATION.md) |
| Run UniHub as a TrueNAS app | [UniHub as a TrueNAS app](docs/TRUENAS_INSTALLER.md) |
| Update without replacing my data | [Upgrade guide](docs/UPGRADING.md) |
| Back up or restore my account | [Backup and restore (ALPHA)](docs/BACKUP_RESTORE.md) |
| Choose Download or Sync | [Mail modes](docs/MAIL_MODES.md) |
| Reorder, hide or disable modules | [Modules](docs/MODULES.md) |
| Add people, groups, roles and rules; configure trusted proxies | [Authentication and administration](docs/AUTH_ADMIN_SETTINGS.md) |
| Install the PWA or troubleshoot notifications | [PWA guide](docs/PWA.md) |
| Read saved data without a connection | [Offline reading](docs/OFFLINE.md) |
| Lock UniHub on a phone or browser | [App lock](docs/APP_LOCK.md) |
| Develop or inspect the application | [Development](docs/DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md), [recovery contracts](docs/DATA_RECOVERY.md) |

For reproducible bugs, open a [GitHub issue](https://github.com/mrksrus/selfhost-unihub/issues)
with the version and steps to reproduce. Remove passwords, keys and personal mail
from logs. Report security vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/mrksrus/selfhost-unihub/security/advisories/new); see [Security](SECURITY.md).

## Project

UniHub is AI-written. Its maintainer, **[mrksrus](https://github.com/mrksrus)**,
is not a developer and has no formal software-development qualifications; prior
coding experience was a tic-tac-toe game and a webpage about 15 years ago.
Code development, maintenance and security/function reviews are done with
Anthropic's Claude models: Claude Opus 5.5 for development and independent reviews,
Claude Fable 5.2 for frontend, design and build plans. Earlier releases were written with
OpenAI/GPT models, which are no longer used. Automated tests
and AI reviews do not constitute an independent professional security audit.
UniHub is not affiliated with or endorsed by these providers.

Release CI checks the API, frontend, MariaDB recovery and built-container startup,
authentication and recordings. These checks do not guarantee every provider,
device or existing installation behaves identically.

Starting with v0.10.1, project-owned code is source-available under
[PolyForm Noncommercial 1.0.0](LICENSE). Earlier versions retain their original
terms; dependencies retain their own licences. [Licensing details](LICENSING.md).
