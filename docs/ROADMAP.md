# Road to 1.0

This is the plan from UniHub 0.23 to 1.0: what 1.0 contains, the versions on
the way and the rules that keep the scope fixed. It has no dates. A version is
released when it is ready and has been tested. The [changelog](../CHANGELOG.md)
shows what has shipped.

The plan may still change, but only under the rules below. Details that are
still open, such as exactly which contact fields 0.26 adds, are decided when
that version starts.

## What 1.0 is

**UniHub 1.0 is a self-hosted workplace and communication system for one
organisation.** It covers mail, contacts, calendar, ToDo and recordings, plus
end-to-end encrypted chats and internal voice and video calls, on the web and
Android. The organisation's administrators run it, it is secure enough for
company data, and it can be recovered after a failure. It works just as well
for one person or a family.

1.0 promises, and every 1.x release keeps:

- **Data survives upgrades.** Every 1.x release upgrades from every earlier
  1.x release and from the last 0.x release.
- **Stable formats.** The backup format, the Android protocol and the settings
  and policy keys stay compatible for the whole 1.x line.
- **The Android app and the server stay compatible** within a published
  support window.
- **Administrators control the organisation:** users, groups, roles,
  policies, the activity log and devices. Data-safety policies let them make
  sure users cannot delete or lose data the organisation needs.
- **A documented security baseline and threat model**, with no "ALPHA" label
  left on anything an organisation relies on.

**Not in 1.0:** iOS, calls to ordinary phone numbers, communication between
UniHub servers, AI features and new Music features.

## Scope rules

1. **This page lists the whole 1.0 scope.** An idea that is not listed goes to
   the [parking lot](#parking-lot) by default, however small it seems.
2. **Swap, don't add.** Putting something new into a version means naming what
   leaves it, or moving 1.0 on purpose. Only the maintainer decides this.
3. **A version's list closes when its development starts.** Ideas that come up
   while building it go to a later version or the parking lot.
4. **Bugs are not scope.** A fix to something that already exists can ship in
   a patch release at any time. A patch never carries a feature.
5. **Music stays as it is.** It gets no new features before 1.0, and
   administrators can switch it off for their organisation.

## Release rhythm

- **One theme per minor version.** `0.N.0` delivers the theme. A test window
  follows on real phones, a live server and with several people. Fixes ship
  as `0.N.1`, `0.N.2` and so on, and contain fixes only.
- **The next version is released only when the previous one has passed its
  tests.** It may be developed in the meantime.
- **Numbers are fixed per theme.** If a theme turns out too big, its second
  half takes the reserve number 0.37.0 and nothing else moves. Otherwise
  0.37.0 is skipped.
- **Every release follows the [release contract](RELEASE_CONTRACT.md):** CI
  gates, a container smoke test, and a backup restored into a fresh
  installation.
- **Release candidates** are tagged `1.0.0-rc.N` and are never published as
  `latest`.

## Versions

| Version | Theme | Main contents |
| --- | --- | --- |
| 0.23.x | Hardening | Released. Patch releases carry the fixes found in review and testing. |
| 0.24.0 | Notifications and settings | Per-account folder filter for notifications ("notify except selected", Junk excluded by default, or "only selected"); how much a notification shows (sender and subject, sender only, or nothing); notifications per calendar; a typed settings registry that later admin policies build on; a few general mail and calendar settings, such as a signature per account. |
| 0.25.0 | Mail on the phone | A phone composer modelled on Apple Mail (compact header, recipient chips, a body that stays above the keyboard); keyboard handling in the Android app and PWA; attachments: open with another app, save and share on Android; an automated Android check against a real server. |
| 0.26.0 | Contacts | Any number of emails and phone numbers per contact; duplicate detection by name as well as email and phone, with a reason for each match; side-by-side merge review that keeps every value, can be undone, and lets you mark contacts as "not the same person"; a written contacts input contract. |
| 0.27.0 | ToDo and calendar order and defaults | Drag handles to reorder tasks, subtasks and module pages; choose the list or calendar when creating an item, and move tasks between lists; default task list and calendar in Settings. |
| 0.28.0 | Data safety | Smaller encrypted user backups (basics plus data only UniHub holds; provider data syncs again after a restore); a scheduled, encrypted instance backup for administrators; data-safety policies, so an administrator can require mail to be in backups and stop users from deleting accounts or backups or removing mail accounts; automated upgrade tests across releases. |
| 0.29.0 | App lock | Fingerprint or face lock in the Android app, for the whole app or chosen modules, with lock timing and hidden notification content; administrators can require it. |
| 0.30.0 | Organisation I | Users created or invited by administrators; groups and departments; owner, admin and member roles; a complete policies page per installation or group (2FA, sessions, modules, notification detail, app lock, phone sync, offline copies, data safety); login limits that survive a restart. |
| 0.31.0 | Organisation II | A company directory of every active user; shared address books for everyone or chosen groups, with read and edit permissions, also on the phone (read-only). |
| 0.32.0 | Organisation III | Share local calendars and task lists with people or groups (free/busy, read, edit, manage); organisation calendars such as a holiday or support rota. |
| 0.33.0 | Messaging I | A Chat module with end-to-end encrypted 1:1 chats (MLS) on the web, PWA and Android; delivery and read state; presence; a key backup so a new phone keeps the history. |
| 0.34.0 | Messaging II | Group chats, optionally following an organisation group; encrypted attachments and voice messages; mentions; retention policies. |
| 0.35.0 | Calls I | Encrypted 1:1 voice calls between UniHub users that ring like normal phone calls on Android (system call screen, lock screen, headsets), plus calls in the browser; an optional TURN relay. |
| 0.36.0 | Calls II | Video, screen sharing in the browser, and group calls through an optional self-hosted media server. |
| 0.37.0 | Reserve | Only for the second half of a theme that grew too big. |
| 1.0.0-rc.N | Stabilisation | No features. The full release contract on every candidate; a security review; a size test; real phones; a week of real chat and call use; administrator and user guides and the threat model; frozen formats; then 14 days of daily use without a serious bug. |
| 1.0.0 | Release | Tag, image, Android app, release notes and the upgrade guide. |

## Foundations

New work builds on these foundations, so that each version fits the 1.0 end
state without rework. Each foundation is built in the version that first needs
it, together with that version's feature, not as a separate refactor. The
condensed rules are in [AGENTS.md](../AGENTS.md#building-toward-10).

| | Foundation | Built in |
| --- | --- | --- |
| F1 | Settings and policies: one typed registry. A value resolves from the user, then the strictest group, then the installation, then the default; administrators can lock a value. | 0.24.0 |
| F2 | Data classes: every stored record has a class, such as local, provider mirror, organisation or ciphertext, and backups and restores follow the class. | 0.28.0 |
| F3 | Principals: users, groups and "Everyone", in one organisation per installation. | 0.30.0 |
| F4 | Ownership and grants: one access service decides who may read, edit or manage a shared resource. | 0.30.0, first used in 0.31.0 |
| F5 | Devices as records that can be listed, locked and removed. | 0.29.0 |
| F6 | One notification pipeline that applies the privacy level before anything leaves the server. | 0.24.0 |
| F7 | Realtime: change hints to clients, WebSocket for chat and calls. | 0.33.0 |
| F8 | Platform boundary between the web app and the Android shell (keyboard, files, biometrics, calls). | 0.25.0, 0.29.0 |
| F9 | Short-lived tickets for file downloads, so a session cookie is never handed to another app. | 0.25.0 |
| F10 | Keys: secrets from files, versioned encryption, a separate key for instance backups. | step by step |
| F11 | Contracts and module manifests for new routes and modules. | from 0.24.0 |
| F12 | Contacts with any number of values. | 0.26.0 |
| F13 | Destructive actions under policy: the server refuses what a policy forbids, with a clear reason. | 0.28.0 |
| F14 | End-to-end encrypted messaging with MLS; the server stores ciphertext only. | 0.33.0 |
| F15 | Calls: WebRTC signalling and media, an optional relay and media server, native Android call handling. | 0.35.0 |

## After 1.0

1.x releases keep the 1.0 promises and take items from the parking lot one at
a time, under the same rules.

## Parking lot

These items are not planned. Each one can come after 1.0, or never.

- iOS app
- Single sign-on (OIDC, SAML) or LDAP
- Passkeys for sign-in
- Several organisations on one installation
- Meeting invitations inside the organisation, "find a time", free/busy
  across people
- Assigning tasks to people, board views
- Calendars in the phone's own calendar app
- CardDAV contact sync with providers
- UnifiedPush as an optional notification route
- Sharing into UniHub from other Android apps, document scanning
- Quiet hours and smart notification rules
- Encrypting mail and files inside the server beyond volume encryption
- Several API processes or replicas
- Communication between UniHub servers
- Collaborative documents and notes
- Calls to and from ordinary phone numbers
- Automated CI tests against self-hosted mail and calendar servers in
  containers
- An AI assistant
- New Music features

## Contributing

Bug reports and fixes for existing behaviour are welcome at any time through
the [issue tracker](https://github.com/mrksrus/selfhost-unihub/issues). For a
feature, check this page first. If it is listed, say in an issue which version
you want to work on before starting. If it is not listed, open an issue to
propose it; it goes to the parking lot unless the maintainer swaps it in.
Report security problems privately as described in [SECURITY.md](../SECURITY.md).
