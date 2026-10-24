# UniHub project preferences

Accepted product and design decisions that ordinary work must preserve. This
file pins *what the maintainer decided*; [AGENTS.md](AGENTS.md) says how to
work, and the feature documents under `docs/` describe how things are built.
Detailed implementation facts stay in source. Pinned on 2026-10-16 against
release 0.21.4.

## How to use this file

- **Order of precedence.** An explicit instruction in the current task wins.
  Then this file. Then the visual style section of AGENTS.md. Then any general
  design guidance a skill or model brings along. Approved existing design
  always beats a skill's generic aesthetics: a frontend or design skill may
  choose details this file leaves open, and may not reopen a decision below.
- **Superseding.** Only new explicit maintainer direction supersedes a
  decision. A general request to improve, modernize or "use your judgment" does
  not reopen a specific accepted choice. When a decision changes, rewrite its
  entry with the new date and move the old text to
  [Superseded decisions](#superseded-decisions) so old instructions do not
  return.
- **Conflicts.** When a task cannot be done without changing a decision below,
  or two decisions collide, flag it before changing the affected behavior:
  state the existing choice, the proposed difference, the tradeoff and a
  recommendation, then continue unaffected work. A code regression against a
  decision is a bug to fix, not a reason to rewrite the decision.
- **New ideas** go under [Open decisions and conflicts](#open-decisions-and-conflicts)
  or into the task report. They are not decisions until the maintainer accepts
  them.

Each decision has a stable ID, a status, the date it was pinned, what it
covers, the decision itself, and its evidence.

| Status | Meaning |
| --- | --- |
| Accepted | Explicit maintainer direction, approval of a concrete proposal, or part of the baseline the maintainer asked to pin on 2026-10-16. |
| Proposed | A suggestion from an audit or an agent, waiting for the maintainer. |
| Open conflict | Two accepted things disagree, or a decision cannot be kept as stated. |
| Superseded | Replaced by later explicit direction; kept so the old choice is recognised. |

Each accepted entry also says how far it is verified: **in source** means the
behavior exists at 0.21.4 in the cited files; **not yet runtime-tested** means
the cited source supports the promise, but no browser, device or installation
check of this exact promise exists yet.

Evidence names repository files and public release notes
([CHANGELOG.md](CHANGELOG.md)). Maintainer decisions are given in substance,
not verbatim, and dated by the release they first shipped in.

## Accepted decisions

### Identity and theme

#### P-01 Black, white and blue

Accepted, in source. Pinned 2026-10-16.

UniHub's identity is a black page, white text and one blue accent, with dark
grey surfaces behind the rail, panels and dialogs. Semantic colours carry
meaning and are never reused for decoration: warning is attention (overdue,
needs a decision), destructive is reserved for actions that remove something,
success and info keep their roles. Feature views use the semantic CSS variables
through Tailwind classes and never hard-coded colours.

Evidence: `src/index.css` (the `:root, .light` and `.dark` blocks and their
header comment), `tailwind.config.ts` (every colour maps to a variable),
AGENTS.md "Visual style".

#### P-02 Dark is the default; Light and System must work equally

Accepted, in source. Pinned 2026-10-16.

The theme mode is a per-device choice with three values: Dark (default), Light
and System. The page is coloured before the first paint from the stored mode so
there is no flash, and the browser or Android chrome follows the resolved
background. Every screen must be usable in both resolved modes.

Evidence: `public/theme-init.js`, loaded first by `index.html` (pre-paint
script reads the stored mode and look; external since 0.23.0 because the
Content-Security-Policy forbids inline scripts),
`src/components/theme/ThemeProvider.tsx` (default `dark`, system enabled,
updates `theme-color` and the Android status bar), `src/lib/platform.ts`
(`showThemeInApp`), `docs/ANDROID.md` (the `theme` bridge message),
`src/components/settings/AppearanceSettings.tsx` (Theme switch).

#### P-03 Looks are per device; the accent is per account

Accepted, in source. Pinned 2026-10-16 (requested for 0.21.1; accents 0.20.0).

Each mode has a set of *looks*: Dark has Default, OLED black, Dim, High
contrast, Colour-safe and Neon; Light has Default, Paper, High contrast and
Colour-safe. A look is remembered on the device, separately for dark and light,
and never with the account, so one person can run OLED black on a phone and Dim
on a laptop. Each look exists for a stated reason shown under its swatch; a new
look needs such a reason, not only a colour scheme. The listed looks are the
current baseline, not an inferred permanent limit on future choices.

The accent colour (blue, indigo, violet, pink, teal, green) is saved with the
account, applied on every device, and written inline on `<html>` so it works on
top of every look. The UniHub mark and page icon follow the accent. Text on the
accent must stay legible (WCAG AA) in both modes and every look; High contrast
moves the accent until 7:1 is reached. Semantic colours do not follow the
accent, so an accent never collides with a meaning.

Evidence: `src/lib/theme.ts` (the looks table, storage keys
`unihub:theme:dark` and `unihub:theme:light`), `src/index.css`
(`[data-theme]` blocks), `src/lib/accent.ts`, `src/components/theme/`,
`src/test/appearance-settings.test.tsx` (contrast test over every look),
CHANGELOG 0.21.1 "Looks", CHANGELOG 0.20.0 (Appearance settings with accents).

#### P-04 Type and tone

Accepted, in source. Pinned 2026-10-16.

Inter for interface text, JetBrains Mono where fixed-width helps (chords, code,
tabular data). Headings and actions are plain sentence case. Hierarchy comes
from spacing, size and alignment; borders, cards, gradients and motion appear
only where they mark a real distinction. Interface text is kept short; the
maintainer asked for unnecessary UI text to be removed (0.19.x). Within that,
copy says what happens ("Save draft", "Delete"), keeps one name for one action
through a flow, and errors say what went wrong and what to do.

The two fonts ship with the app and load from its own origin, never from a
font service (maintainer, 2026-10-19: until 0.23.0 the security policy refused
the Google Fonts import, so installations showed fallback fonts).

Evidence: `src/main.tsx` (Fontsource imports), `src/index.css` (`body`,
headings, `code, pre`), `tailwind.config.ts` (`fontFamily`), AGENTS.md "Visual
style".

#### P-05 Reuse the existing controls

Accepted, in source. Pinned 2026-10-16.

New UI composes `src/components/ui/` controls and their variants (`Button`
sizes and variants, `Chip`/`ChipGroup`, `Sheet`, `Dialog`, `DropdownMenu`,
`EmptyState`, `LoadingState`, `ErrorState`, …). A common control never gets a
second visual treatment when an existing variant fits; feature-specific layout
stays in the feature component.

Evidence: `src/components/ui/`, `src/components/ui/button-variants.ts`,
`src/components/ui/chips.tsx`, `src/components/ui/page-states.tsx`.

### Layout and navigation

#### P-06 One shell: rail or bottom bar, then the page's own header, panel and body

Accepted, in source. Pinned 2026-10-16.

Global navigation is the 72 px rail on wide windows (pages in the user's order,
then Search, Attention, Settings, account) and a bottom bar on phones (the first
four pages in the user's order, then More). Every page renders through
`PageShell`: an optional context panel for scope (accounts and folders, lists,
calendars, settings sections), a `PageHeader` that becomes the top bar on
phones, and a scrolling `PageBody` with `reading` (text, single list), `wide`
(lists with columns, dashboards) or `full` width. A new feature adds its own
panel instead of a second sidebar inside the page. Layout follows window width
only, never touch capability: phone layout below 768 px, panel-as-sheet below
1024 px, mail split view from 1280 px.

Evidence: `src/components/layout/AppLayout.tsx`, `NavRail.tsx`, `BottomNav.tsx`,
`PageShell.tsx`, `src/hooks/use-mobile.tsx` (`PHONE_QUERY`, `NARROW_QUERY`),
`src/lib/navigation.ts` (`BOTTOM_NAV_PAGES`), `src/pages/More.tsx`,
`docs/MODULES.md` (page order and visibility).

#### P-07 Content rows stay in view; nothing folds data away

Accepted, in source. Pinned 2026-10-16 (requested for 0.20.0, reinforced for
0.21.1).

Tasks, songs and recordings are rows with everything they hold in view: title,
when, description, the source email, subtasks, chords, tags, the player for the
one playing. Rows are never collapsible, and collapsing is not offered as an
option. Pages scroll instead. Views and lists are chosen with chip rows in the
header, shown in full, not hidden behind a disclosure. Prefer rows to cards, one
main action per row, the rest in the row's menu.

Maintainer's reasoning: collapsing only hides data that needs to be seen, and a
scrollable page works better without it on both desktop and phone.

Evidence: `src/pages/TodoPage.tsx` ("Views and lists stay in sight on every
window size; nothing folds away"), `src/components/todo/TaskRow.tsx`,
`src/pages/Music.tsx` (`SongRow`), `src/components/recordings/RecordingRows.tsx`,
`src/components/ui/chips.tsx`, CHANGELOG 0.20.0 (collapsed panels removed).

#### P-08 Context panels fold independently and remember it per browser and page

Accepted, in source. Pinned 2026-10-16 (requested for 0.21.1).

This is a different thing from P-07. The *context panel* of a page (mail
accounts and folders, contact lists, calendars, recording lists, settings
sections) can be folded away from its header on wide windows. Folded, it opens
as a sheet from the scope button in the page title, exactly as on phones. The
choice is stored in the browser under the page's `panelId` and survives
reloads and moving between pages; pages that share a panel share the id. Folding
one page's panel does not fold another's.

Maintainer's reasoning: with the reader open, a fixed mail sidebar makes the
desktop view busy; the panel must be collapsible again and must not flip back
after a reload or a visit to another page.

Evidence: `src/components/layout/PageShell.tsx` (`usePersistedFlag` with
`unihub:panel:<id>`, `PanelHeader` fold button), `src/test/page-shell.test.tsx`,
CHANGELOG 0.21.1 "Changed".

#### P-09 The mail reader is a resizable column, remembered per machine

Accepted, in source. Pinned 2026-10-16 (requested for 0.21.1).

On wide windows (1280 px and up) the reader is the right column of a split
view. Its left edge can be dragged, or nudged with the arrow keys on the
handle, between 30 % and 70 % of the page; the list always keeps at least 20
rem. Double-click resets to the default 45 %. The share is stored in this
browser and survives window resizing. Below 1280 px the reader takes the whole
page and returns to the list with its Back action.

Evidence: `src/components/mail/MailReader.tsx` (`unihub:mail:reader-width`,
`defaultValue: 0.45, min: 0.3, max: 0.7`), `src/hooks/use-resizable-width.ts`,
`src/test/resizable-width.test.tsx`.

#### P-10 What is remembered on the device, and what travels with the account

Accepted, in source. Pinned 2026-10-16.

Per device (browser storage, never sent to the server): theme mode, the look for
each mode, the panel fold per page, the mail reader share, the last task list
used from an email, the install-prompt state, offline snapshots. A copy of the
accent is kept on the device only so a reload does not flash blue before the
preference loads.

Per account (server preferences, so every device follows): accent colour,
default send-from mail account, page order and visibility, modules, timezone,
notification choices.

A device setting says "Saved on this device" in Settings; an account setting
says it follows the account. When storage is unavailable, the default applies
and nothing breaks.

Evidence: `src/lib/theme.ts`, `src/lib/accent.ts`, `src/hooks/use-persisted-flag.ts`,
`src/hooks/use-resizable-width.ts`, `src/lib/email-tasks.ts` (`email-task-list`),
`src/components/settings/AppearanceSettings.tsx` (the two descriptions),
`src/hooks/use-mail-compose.ts` (`default_mail_account_id`), `docs/MODULES.md`.

### Input, focus and accessibility

#### P-11 Touch targets are bigger on touch screens and never overlap

Accepted, in source. Pinned 2026-10-16 (requested for 0.20.0 and 0.21.1).

On coarse pointers controls grow about 15 %: buttons, inputs, chips, menu rows,
checkboxes, the done circle, the bottom-bar glyphs. Widths and font sizes do not
balloon, nothing overflows the screen. Any control that stays under 44 px gets a
44 px tap area through `tap-area`. Where neighbours' tap areas would overlap,
the group gets a `touch:` gap so a tap cannot land on a destructive neighbour by
accident. Nothing changes for a mouse.

Maintainer's reasoning: on a current mid-size Android phone the targets were
usable but not confident; make them 10 to 20 % bigger without widening the
layout or inflating the type.

Evidence: `src/index.css` (`.tap-area` under `@layer components`),
`tailwind.config.ts` (`touch` variant), `src/components/ui/button-variants.ts`,
`src/components/ui/checkbox.tsx`, `src/components/todo/TaskRow.tsx`, the
`touch:gap` uses in `src/components/mail/MailPanel.tsx`,
`src/components/mail/MailCompose.tsx` and `src/components/layout/PageShell.tsx`,
CHANGELOG 0.21.1 "Changed", CHANGELOG 0.20.0 (item 7).

#### P-12 Keyboard focus is visible and returns to where the user was

Accepted, in source. Pinned 2026-10-16.

Every interactive element shows a focus ring (`focus-visible:ring-ring`; High
contrast adds a 3 px outline). Closing the panel sheet returns focus to the
scope button that opened it, or to the fold button when "Keep panel open" removed
the scope button. "Hide panel" moves focus to the scope button. Search opens
with Ctrl/Cmd K. Dialog close controls are reachable and, on touch screens, 40
px. Escape in the composer closes an open recipient list before it closes the
dialog.

Evidence: `src/components/layout/PageShell.tsx` (`restoreFocus`, `setFolded`),
`src/test/page-shell.test.tsx`, `src/index.css` (`html[data-theme="contrast"] :focus-visible`),
`src/components/GlobalCommandPalette.tsx`, `src/components/ui/sheet.tsx`,
`src/components/ui/dialog.tsx`, `src/components/mail/MailCompose.tsx`
(`keepDialogOpenWhileSuggesting`).

#### P-13 States, contrast and motion

Accepted, in source. Pinned 2026-10-16.

Every list has useful loading, empty and error states built from the shared
components; an empty state says what to do next. Text and icons on the accent
meet WCAG AA in both modes and all looks (tested). Motion only answers an action
and respects `prefers-reduced-motion` (`motion-reduce:` on transitions);
decorative animation is not added. Phone layouts clear the bottom bar and the
safe areas.

Evidence: `src/components/ui/page-states.tsx`, `src/test/appearance-settings.test.tsx`,
`src/components/mail/MailSyncControl.tsx` and `MailPendingChanges.tsx`
(`motion-reduce:transition-none`), `src/index.css` (`.pb-mobile-nav`),
`src/components/layout/AppLayout.tsx` (safe-area top padding).

#### P-14 Email is untrusted content

Accepted, in source. Pinned 2026-10-16.

HTML mail renders only through `SafeEmailContent` with its privacy controls. In
the dark theme a message opens in the dark reading view with "Original email
appearance" one click away; remote-image consent and the appearance choice are
scoped to one message and reset on leaving it. Sender HTML is never rendered as
application UI.

Evidence: `src/components/mail/SafeEmailContent.tsx`, `src/test/dark-email-content.test.tsx`,
`src/test/safe-email-content.test.tsx`, AGENTS.md "Visual style" and review
rules.

### Mail, tasks and attachments

#### P-15 Editing context is never lost

Accepted, in source. Pinned 2026-10-16 (requested for 0.20.0).

A person writing mail can make a task from the draft (the draft is saved first
so the task leads back to it), open an attachment in the viewer (images, PDF
with selectable text, text, HTML, audio, video) and read or reply to a linked
email in the peek without leaving what they were doing. The peek is a column on
wide windows and a bottom sheet on phones; "Set aside" shrinks it to a bar and
brings it back with a reply still in progress. Closing a dirty composer asks to
save, discard or keep editing; a dirty inline reply is guarded the same way.
Existing draft attachments are kept when a draft is saved again unless the
person removed them.

Evidence: `src/pages/MailPage.tsx` (`addTaskFromDraft`), `src/components/mail/MailCompose.tsx`
(`AddTaskFromDraft`, save/discard prompt), `src/hooks/use-mail-compose.ts`
(`existingDraftAttachments`, `attachmentsDirty`), `src/components/mail/MailPeek.tsx`
(header comment), `src/components/mail/AttachmentViewer.tsx`,
`src/test/mail-page-ui.test.tsx`, `src/test/attachment-viewer.test.tsx`,
`src/test/email-task.test.tsx`, CHANGELOG 0.20.0 (items 1 to 4).

#### P-16 Recipients keep their display names

Accepted, in source. Pinned 2026-10-16 (decided for 0.21.2).

A recipient entered as `Jane Doe <jane@example.com>` arrives with "Jane Doe" in
the To or Cc header, and drafts and the Sent copy show the name. Names with
commas or quotes are quoted correctly; non-ASCII names are encoded by the
mailer. Bcc is kept only in the sender's own copy and omitted from outbound
SMTP headers. This pinned requirement covers outgoing messages, drafts and
Sent copies. Imported messages retain their raw source, but the current parsed
To/Cc fields store bare addresses; preserving imported display names separately
is an implementation limitation, not an already verified feature.

Evidence: `api/src/services/mail-recipients.ts` (`formatRecipient` and the
parser comment), `api/src/services/mail-send.ts`, CHANGELOG 0.21.2 and 0.21.1.

#### P-17 Which account a message comes from, and how recipients are picked

Accepted, in source. Pinned 2026-10-16 (requested for 0.20.0 and 0.21.1).

A new message starts from the account in view; in All accounts it starts from
the default send-from account chosen in Settings, else the first connected
account. A reply or forward always comes from the account that received the
message. Choosing another account in the composer never changes what the Mail
page shows. Picking a contact from the suggestion list inserts it and closes the
list until more is typed, so one recipient needs no extra dismissal. Cc and Bcc
sit behind small buttons at the right end of To; a message needs at least one
recipient in any of the three.

Evidence: `src/hooks/use-mail-compose.ts` (`fromAccountId`,
`replaceActiveRecipient`), `src/components/mail/MailCompose.tsx`,
`src/test/mail-compose-from.test.tsx`, CHANGELOG 0.20.0 (item 8), CHANGELOG
0.21.1 "Added".

#### P-18 Contacts are selectable on the desktop

Accepted, in source. Pinned 2026-10-16 (requested for 0.21.1).

Ctrl/Cmd+click adds a contact to the selection, Shift+click adds a range, Escape
clears, Delete asks to delete the selection, and "Set company…" writes a company
or job title to all selected contacts at once. Deleting is always confirmed.
Phones are not the target for bulk contact management, but nothing may break
there.

Evidence: `src/pages/Contacts.tsx`, `src/test/contacts-page.test.tsx`, CHANGELOG
0.21.1 "Added".

#### P-25 Quick search finds words in message bodies

Accepted, in source. Pinned 2026-10-19.

The quick search (command palette and the Mail search field) matches mail
bodies as well as subjects and addresses. The maintainer declined the audit
proposal (2026-10-17, B17) to drop bodies for speed; a faster index may replace
the scan, but not the reach.

Evidence: `api/src/routes/search.ts`, `api/src/routes/mail-messages.ts`
(`body_text` in the search conditions).

#### P-26 Compose stays uncluttered: optional features are switched on first

Accepted, in source since 0.24.0 (`MailCompose.tsx`: `SendButton`,
`FEATURES_IN_TOOLBAR`; `src/test/compose-essentials.test.tsx`). Decided
2026-10-20 (for 0.24.0 and the 0.25.0 phone composer); layout chosen 2026-10-23;
phone composer made full screen and compact 2026-10-24 (0.24.1).

Optional compose features (templates, scheduled send, the compose format
switch and later ones) are off until the person switches them on in Settings;
only then does the composer show their button. One to three such buttons share
an existing line; more get a line of their own. Phones come first: the message
body keeps most of the screen while typing, and the header may scroll away.
Desktop may show more at once. Before a new compose layout is built, the
maintainer is offered two or three options to choose from.

Source: maintainer's direction while deciding the 0.24.0 scope (Road to 1.0
D21), prompted by the Android composer leaving almost no room for the body.

Layout chosen 2026-10-23 from three options (A toolbar, B a More menu, C the
title bar): **A**. Templates and the format switch end the formatting
toolbar row, where they act on the message; Send later turns Send into a split
button whose arrow half is at least 44 px wide on touch, with no gap between
the halves. Up to three features take no extra line; plain text keeps a
one-row strip for them; four or more get a line of their own above the
message. Switching a formatted body to plain text asks first. In the same
choice the phone composer's footer became one row: Cancel (the same as the
close control) is dropped on phones and Add task is an icon there. The phone peek's
reply footer follows the same one-row rule.

Phone composer, decided 2026-10-24 by the maintainer after 0.24.0 left one
line of message above the Android keyboard ("The entire UI needs to be pushed
to the very top of the screen and compressed a bit… `To: *to field*`"): on
phones the composer fills the screen from the very top, its header is compact,
and From, To, Cc, Bcc and Subject each take one row with the label beside the
field. Typing in the message scrolls the field rows away so the message keeps
the space above the keyboard. The wide dialog and the desktop inline reply are
unchanged.

### Product reliability

#### P-19 Product reliability

Accepted, not yet runtime-tested. Pinned 2026-10-16.

A release promises that existing data survives, supported clients keep working,
approved workflows remain usable, and a failed update has a recoverable path.
Beta may have explicitly unfinished features; it may not make basic reliability
depend on which agent worked last. "No P1 or P2 in review" is one input, never
the acceptance rule. Acceptance means observable evidence for each promise, with
source review, local tests, CI, built-container checks, browser or device
checks and live validation kept distinct and a missing check never reported as
passing.

Evidence: AGENTS.md "Working and verification" and "Code Review Rules";
`.github/workflows/docker-image.yml` and `scripts/container-smoke.sh` for the
checks that exist today; [docs/UI_ACCEPTANCE.md](docs/UI_ACCEPTANCE.md) for the
interface part.

#### P-20 Every release proves a full backup into a fresh installation

Accepted. Local proof recorded below; image/CI evidence still required. Pinned 2026-10-16.

Before a release is published, a backup of every supported recoverable module
taken from one installation must import into an empty, independent installation
(separate database, storage root and keys) built from the candidate image, and
the restored data must be usable after a restart. The exact procedure, evidence
and failure rules are in [the release contract](docs/RELEASE_CONTRACT.md).
The fresh-install gate has passed locally with synthetic data; built-image CI
evidence is still required before a release. Existing recovery tests and the
container smoke test remain required alongside it.

Evidence: `docs/DATA_RECOVERY.md`, `docs/BACKUP_RESTORE.md`, `api/tests/`
recovery integration tests, `scripts/container-smoke.sh`.

#### P-21 Android shell and server stay compatible across a few releases

Accepted, not yet runtime-tested. Pinned 2026-10-16.

The Android app is a thin shell; the server advertises protocol, minimum app
version and features. The current shell must work against the current server and
at least the previous few published server releases, and the current server must
keep serving at least the previous few shell builds. Unsupported combinations
fail with a clear message and an upgrade path, never a crash. The exact window,
manifest and tests are in [the release contract](docs/RELEASE_CONTRACT.md) and
[Android compatibility](docs/ANDROID_COMPATIBILITY.md). The initial window is
the current release plus the three previous published releases. Known-broken
historical APKs are explicit exceptions with upgrade instructions, never
reported as working. Launch checks alone do not prove the server/app matrix;
missing real-server pairings remain verification gaps.

Evidence: `docs/ANDROID.md`, `api/src/services/app-version.ts`,
`src/lib/platform.ts`, CHANGELOG 0.21.4.

#### P-22 The Android app keeps UniHub contacts in the phone's contacts, both ways

Accepted, in source; emulator-tested against a stub server (Android 16) and
in Google Contacts on the emulator, not yet on a real phone with a real
server. Pinned 2026-10-16 (requested for 0.22.0); changed to both ways
2026-10-17 (requested for 0.22.3), replacing the one-way copy (see
[Superseded decisions](#superseded-decisions)).

The Android app makes the signed-in user's UniHub contacts known to the
phone, so the Phone app, WhatsApp and other apps show their names. It is done
natively in the app; the server and web pages stay unchanged, so a release of
it changes only the Android app in the image.

Changes on the phone reach UniHub as well: contacts added, edited or deleted
in the phone's UniHub account, including device contacts Android moves into
it, are added, changed or deleted in UniHub. The maintainer expects local
changes made in the app to reach the server in general; contacts are the
only data the app keeps outside its pages, which write to the server directly.

How it is built (agent's choices within that request, open to maintainer
change): opt-in once per server; a "UniHub" Android account editable in
contacts apps; names/numbers/emails/company/job title shared, never notes
(UniHub's notes stay off the phone, the phone's notes stay off UniHub); a
field changed on both sides takes UniHub's value, numbers and addresses merge
one by one; a phone contact with the same address or number as a UniHub
contact is joined to it, not duplicated; ten or more deletions at once wait
for the person's answer in Android's "Too many deletions" notification;
UniHub's contacts leave the phone on sign-out, session end or a disabled
Contacts module, while contacts not yet sent or holding phone-only data stay
for the same user and are never sent to another; contacts saved on the phone
belong to the user who last used the app; the account and its contacts are
deleted on a server change or account removal.

Evidence: `android/app/src/main/java/io/github/mrksrus/unihub/ContactsSync.kt`,
`ContactCard.kt` (merge rules, `ContactMergeTest`), `ContactsServices.kt`,
`res/xml/contacts.xml`, `android/scripts/contacts-test.sh`, `docs/ANDROID.md`
(Contacts on the phone), CHANGELOG 0.22.0 and 0.22.3.

#### P-23 Notifications reach phones without a third-party push service

Accepted, in source for Android; emulator-tested against a stub server, not
yet on a real phone with a real server. iOS not started. Pinned 2026-10-16
(requested for 0.22.1).

UniHub is meant to be fully self-hosted company communication, later with
messaging and calls, so notification content must not depend on trusting
Google's or Apple's push services, and people must not have to install and set
up a separate push app (such as ntfy) to get them.

- **Android: UniHub is the app's own push server.** The app keeps its own
  connection to the user's server; no push service, no extra app, no setup
  beyond turning notifications on.
- **One message format: Web Push encryption (RFC 8291).** Every notification
  is encrypted for the device's keys, as for a browser, so other routes can
  carry the same message later. A UnifiedPush distributor (ntfy and others)
  is planned as an optional route for people who already run one, never as a
  requirement; it is not in 0.22.1 because it cannot be tested without a
  distributor app yet.
- **iOS, later: APNs through Apple's approved distribution** (App Store,
  TestFlight or Business Manager, not the EU alternative-marketplace route).
  iOS cannot keep a connection of its own, so Apple's push service carries
  only encrypted or content-free pushes; the phone decrypts or fetches from
  UniHub. Local Push Connectivity on company Wi-Fi is a possible addition.

How it is built on Android (agent's choices within that request, open to
maintainer change): asked once per server after sign-in and switchable in
Settings → Notifications; a foreground service with a silent ongoing
notification that has a Turn off action; notifications are marked private,
so a phone set to hide sensitive content on the lock screen shows only "New
notification"; while notifications are on, the connection keeps the app's
session in use; delivery is acknowledged by the phone and sent again until it
is.

Evidence: `api/src/services/android-push.ts`, `notification-transports.ts`,
`android/app/src/main/java/io/github/mrksrus/unihub/AppNotifications.kt`,
`NotificationService.kt`, `PushCrypto.kt`, `android/scripts/notifications-test.sh`,
`api/tests/android-notifications-mysql-integration.test.cts`,
`docs/ANDROID.md` (Notifications), CHANGELOG 0.22.1.

#### P-24 A release publishes the image its pull request tested

Accepted, in source; first exercised by the release after 0.22.3. Pinned
2026-10-17 (maintainer's direction, for every project of theirs: tests belong
to the coding and review loop, not to publication).

The full checks run on the release's pull request, which carries the version,
changelog and support window, so the tested content is the released content.
Merging and tagging publish that tested image under `latest`, the version and
the commit without building or testing again. Only when the released content
differs from what was tested does the release run build and test it itself.
The broken Android 17 emulator step stays off until a working image ships.

Evidence: `.github/workflows/docker-image.yml` (`promote` job, "Keep the
tested image for its release"), `docs/RELEASE_CONTRACT.md`.

#### P-27 A new pinned picture needs approval only for a change of design

Accepted, 2026-10-24 (maintainer's direction while reviewing the 0.24.0
pictures). Refines the approval policy in docs/UI_ACCEPTANCE.md.

A changed reference picture that only adds content within the accepted design
(a new folder, setting, menu entry or button in the existing style) or carries
out a design the maintainer already chose (for example P-26's layout A) is
updated by the version's integrator: recorded in the CHANGELOG and shown old
beside new in the pull request, without asking first. A change of design
itself (layout, hierarchy, alignment, look, a control's style) and every
defect still waits for the maintainer, and a defect is fixed, not pinned.
Regenerating pictures just to make the check pass stays forbidden.

## Open decisions and conflicts

Open proposals do not override accepted decisions.

### Proposed

- **S-01 Leftover template stylesheet.** `src/App.css` still carries the Vite
  starter's `.logo` spin, `.card` and `.read-the-docs` rules. They are unused by
  UniHub's identity and could be removed in a cleanup release.
- **S-02 Hard-coded fallback colour.** `src/components/mail/EmailTaskDialog.tsx`
  falls back to `#3b82f6` for a task without a list colour. P-01 prefers the
  `--calendar-color` variable; the saved event colour still needs a concrete
  value, so this needs a small decision on what to store.
- **S-03 Sheet motion.** `src/components/ui/sheet.tsx` animates open and close
  over 500 ms and 300 ms without a `motion-reduce:` variant. P-13 suggests
  shortening and respecting reduced motion.
- **S-05 Recipient group parsing.** A hand-typed address group such as
  `Team: Alice;` followed by a named address merges "Alice" into the next
  display name when a draft is saved twice. No address is lost; left as is in
  0.21.2 and recorded here so it is not rediscovered as new.
- **S-06 Overlong mail headers are shortened, not refused.** Since 0.23.0
  (audit 2026-10-17) a parsed value longer than its database column (message
  id, sender address and name, attachment file name, content type and content
  id) is cut to the column length so the message is still stored, instead of
  the import refusing the message. Proposed by the
  implementing agent; the maintainer has not confirmed it.

### Open verification gaps

- **UIR-2, confirmed browser defect.** Recording tag buttons lack the accepted
  touch height. [UI baselines](docs/UI_BASELINES.md#known-defects-in-the-pinned-code)
  records the exact regression exception. Fixing it should remove the exception
  and update affected pictures, not weaken P-11. (UIR-1, ToDo rows overflowing
  with long source-email subjects, was fixed on 2026-10-19.)

- **C-02 Reader over the peek on phones.** After 0.20.0 the mail reader
  covering the peek panel on phones was noted as a follow-up. Whether 0.21.x
  resolved it is not verified in source for this pinning. P-15 states the
  intended behavior; a runtime check at phone width is listed in
  docs/UI_ACCEPTANCE.md (scenario M-08).
## Resolved conflicts

- **S-04 Visual baseline tooling implemented 2026-10-16.**
  [UI baselines](docs/UI_BASELINES.md) documents the isolated runner, twelve
  current-code reference pictures and sixteen behavior checks. Approved
  synthetic references live in `tools/ui-regression/baselines/` with hashes
  and an approval manifest. Verification cannot approve a changed picture.
  Browser evidence is distinct from device or live-server evidence. The initial
  pin preserves current appearance; known defects UIR-1 and UIR-2 remain bugs,
  not newly accepted design choices.

- **C-01 Test rule versus interface acceptance, resolved 2026-10-16.**
  AGENTS.md now distinguishes brittle source-text/incidental-label assertions
  from approved visual baselines, tap-target geometry, keyboard focus and
  pinned user-visible behavior. These acceptance checks are permitted.
- **C-03 Design skill freedom, resolved 2026-10-16.** The frontend-design skill encourages
  distinctive aesthetic risk and a memorable hero element. UniHub is a quiet
  productivity tool whose identity is fixed by P-01 to P-05. Resolution in
  force: the skill's quality floor (responsive, focus, reduced motion,
  contrast, copy) applies in full; its freedom applies only to details these
  decisions leave open, and a redesign proposal is a separate task with a
  reviewable preview before anything is published.

## Superseded decisions

When a decision above is replaced, move its old text here with its ID, the
date it was superseded and a pointer to the replacement.

- **P-22 as pinned 2026-10-16: a read-only, one-way copy.** Superseded
  2026-10-17 by the maintainer's request that contacts sync both ways (phone
  changes, including device contacts moved into the UniHub account, reach
  UniHub). Replaced by [P-22](#p-22-the-android-app-keeps-unihub-contacts-in-the-phones-contacts-both-ways).
  The old text:

> #### P-22 The Android app puts UniHub contacts in the phone's contacts
>
> Accepted, in source; emulator-tested against a stub server, not yet on a real
> phone with a real server. Pinned 2026-10-16 (requested for 0.22.0).
>
> The Android app can make the signed-in user's UniHub contacts known to the
> phone, so the Phone app, WhatsApp and other apps show their names. It is done
> natively in the app; the server and web pages stay unchanged, so a release of
> it changes only the Android app in the image.
>
> How it is built (agent's choices within that request, open to maintainer
> change): opt-in once per server, a read-only one-way copy in a "UniHub"
> Android account, names/numbers/emails/company/job title but never notes,
> emptied on sign-out, session end or a disabled Contacts module, deleted on a
> server change or account removal.
>
> Evidence: `android/app/src/main/java/io/github/mrksrus/unihub/ContactsSync.kt`,
> `ContactsServices.kt`, `MainActivity.kt`, `android/scripts/contacts-test.sh`,
> `docs/ANDROID.md` (Contacts on the phone), CHANGELOG 0.22.0.
