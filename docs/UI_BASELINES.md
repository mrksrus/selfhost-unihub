# Interface baselines

The automated part of [UI acceptance](UI_ACCEPTANCE.md): approved pictures of
the reference screens, plus browser checks for the pinned layout and input
decisions in [PROJECT-PREFERENCES.md](../PROJECT-PREFERENCES.md). The runner is
a separate development package in `tools/ui-regression/`. It is not a
dependency of the app or the container image.

## What the current baselines are

**Initial current-code baseline.** The maintainer asked on 2026-10-16 to pin
the interface as it is. These twelve pictures record commit `04db73b` (branch
`chore/project-workflows-20261016`, no uncommitted frontend changes) as rendered
with synthetic fixture data in a pinned headless Chromium. They are not a
design approval: they include the two known defects listed below. They are also
not evidence from a real device, the Android app, a container or production.

| Identity | Value |
| --- | --- |
| Source | `04db73b446ad11688a56bbedcafda9e24df7cac8`, frontend input digest `0b1c4374…` |
| Browser | Chromium headless shell 156.0.8078.4 (revision 1248) from `@playwright/test` 1.64.0 |
| Platform | linux-x64 |
| Fonts | `@fontsource/inter` 5.3.0 and `@fontsource/jetbrains-mono` 5.3.0 (latin), isolated fontconfig |
| Rendering | device scale factor 1, `--font-render-hinting=none --disable-lcd-text --force-color-profile=srgb --disable-gpu --disable-skia-runtime-opts --num-raster-threads=1 --disable-partial-raster` |

`tools/ui-regression/baselines/manifest.json` holds the authoritative copy:
the render identity, a SHA-256 for every picture and one approval entry per
update (date, reason, source commit and digest, Node version, CI flag). Machine
names, kernels and paths are not recorded.

## What is checked

`npm run verify` builds the current frontend with the repository's own Vite
config and runs these checks against it in Chromium.

**Reference screens.** Each screen is captured in Dark Default and Light Default,
one hundred and eighty-four pictures in all, compared with zero tolerance:

| Picture | Viewport | Steps |
| --- | --- | --- |
| `mail-reader-wide-*` | Wide | Mail, All accounts, Inbox; open the long-subject message from Grace Hopper (split view with reader). |
| `todo-wide-*`, `todo-phone-*` | Wide, Phone | ToDo, Open view, all lists. |
| `recordings-phone-*` | Phone | Recordings library. |
| `settings-appearance-wide-*` | Wide | Settings → Appearance. |
| `composer-phone-*` | Phone | Mail, Compose (full screen: title bar; To, the folded "Cc/Bcc, From" line and Subject one row each; the message filling the rest; the formatting toolbar pinned above the buttons). |
| `contact-detail-wide-*`, `contact-detail-phone-*` | Wide, Phone | Contacts, the fixture contact that holds every kind of field (name parts, nickname, organisation, labelled numbers and addresses, dates, web, messaging, related people, categories, notes, kept import details). Since 0.26.0 (P-29, D29). |
| `contact-editor-wide-*`, `contact-editor-phone-*` | Wide, Phone | The same contact's editor: a dialog on Wide, the whole screen on Phone. |
| `merge-review-wide-*`, `merge-review-phone-*` | Wide, Phone | Possible duplicates, "Review and merge" on the group that needs a choice: side by side with the result column on Wide, stacked with chips on Phone. |
| `todo-drag-wide-*`, `todo-drag-phone-*` | Wide, Phone | ToDo, the rich task picked up with the keyboard (Space on its ≡ handle): the row lifted with its description, email and subtasks, the handle pressed. Since 0.27.0 (P-29, D31). |
| `new-task-wide-*`, `new-task-phone-*` | Wide, Phone | ToDo, New task with the List chooser open: the lists grouped by account, the default preselected, the server calendar greyed out with "Tasks without a date stay in UniHub", a list not shown in ToDo marked. Since 0.27.0. |
| `settings-pages-wide-*` | Wide | Settings → Pages and modules: a handle and a menu per page row. Since 0.27.0. |
| `settings-backup-wide-*` | Wide | Settings → Backup and restore: the section chips, the downloaded-mail switch, the "In the backup / Left out" ledger and the Create backup action; the backup rows (one running, one made before 0.28) and the restore options are on the page below the picture's fold, checked by `backup-settings.test.tsx`. Since 0.28.0 (P-29, D29). |
| `bin-wide-*`, `bin-phone-*` | Wide, Phone | Settings → Bin with the retention choice and the fixture bin: a synced task, a contact, a recording, a deleted calendar with its two events as one row, a merged contact; "Empty bin" greyed out with the policy's reason. Since 0.28.0. |
| `admin-policies-wide-*` | Wide | Server → Policies as the owner: the "Rules for" chooser at Everyone, then the Sign-in rules and the first Modules and pages rows, each a row with its choice and the default marked (Notifications, Phone and offline, Mail accounts, Backups, Accounts, Bin and App lock follow below the picture's fold). Since 0.28.0; the chooser and the rule groups above Mail accounts since 0.30.0. |
| `people-wide-*` | Wide | Server → People as the owner: the group chips, the columns Name, Role, Groups, Sign-in and Last active, the owner, an administrator, members, an invited person, one whose two-factor authentication is due and an inactive one. Since 0.30.0. |
| `person-wide-*` | Wide | Server → People → a person: Profile and role, Groups with the manager switch and the first Devices with "Sign out" (Account and the accounts, backups and bin follow below the picture's fold). Since 0.30.0. |
| `groups-wide-*` | Wide | Server → Groups: Everyone first, then each group with its description, members, managers and "own rules". Since 0.30.0. |
| `group-policies-wide-*` | Wide | A group's Rules view: the Members and Rules chips, the group's own rules chosen, the others marked "(as everyone)" with "Everyone: …" under each row. Since 0.30.0. |
| `invite-phone-*` | Phone | The setup-link page: the mark, the address the person was added as, the rules that apply to them, Name, Password twice and "Set password and sign in". Since 0.30.0. |
| `two-factor-required-phone-*` | Phone | The prompt after the 7 days: "Set up two-factor authentication to continue" with the server's reason, the set-up and Sign out, in place of the shell. Since 0.30.0. |
| `book-wide-*`, `book-phone-*` | Wide, Phone | Contacts, the shared book the synthetic person manages: the Shared group in the panel, the book's name, description and "You manage this book.", Share, New contact and the menu, the Contacts and Deleted views and "On my phones"; on Wide with a contact open beside the list. Since 0.31.0. |
| `book-share-wide-*` | Wide | The book's share dialog: who has it (the creator "Manages it", a group that can edit, a person who can read), then the people and groups to add under the search with the level beside it. Since 0.31.0. |
| `company-entry-phone-*` | Phone | Contacts → Company, an entry with a long name: job title and department, the groups as chips, phone, email and the note that it comes from the directory. Since 0.31.0. |
| `shared-books-wide-*` | Wide | Server → Shared books as the owner: every book with its contacts and creator, one whose creator has left, and a deleted one with Restore. Since 0.31.0. |
| `calendar-shared-wide-*` | Wide | Calendar as a person others share calendars with: the panel's "Shared with me", "Groups" and "Organisation" with whose each is and the marks "Busy only", "Read-only", "Archived" and a pending offer; the month with their events, a free/busy one as "Busy". Since 0.32.0. |
| `calendar-share-wide-*` | Wide | A calendar's share dialog as a member: a group that can add subtasks, a person who can edit, Everyone at "Sees busy times" (an administrator's share, which the member can only lower or remove), then the people to add under the search with the level beside it and what the levels mean. Since 0.32.0. |
| `event-contribute-phone-*` | Phone | An event of a group's calendar as a contributor reads it: the reason under the title, Subtasks first with who added each and the person's own changeable, then the fields read-only. Since 0.32.0. |
| `event-repeat-phone-*` | Phone | A new event with a repeat rule of its own: Custom…, every 2 weeks on Monday and Wednesday, ending after 10 times. Since 0.32.0. |
| `calendar-offer-wide-*` | Wide | Calendar as a person a colleague offers a calendar: the card at the top of the panel with Accept and Decline, the calendar marked "Offered to you". Since 0.32.0. |
| `calendar-hand-over-wide-*` | Wide | The owner's "Hand over…" dialog of an own calendar: what changes hands, the people within reach under the search, one chosen, Offer. Since 0.32.0. |
| `server-calendars-wide-*` | Wide | Server → Calendars as the owner: organisation and group calendars (one archived), the calendars people share by name and numbers, a deleted one with Restore. Since 0.32.0. |
| `person-leaving-calendars-wide-*` | Wide | Deactivate for a person who shares two calendars: each with its shares and events and "Leave it as it is" chosen. Since 0.32.0. |
| `chat-wide-*`, `chat-earlier-wide-*` | Wide | Chat with the fixed engine (`src/test/chat-mock-engine.ts`; this runner's build hands it out in place of the real one): the chats beside the open one. At its newest messages: "Saving the change…", a change that was not saved and a message that was not sent with "Try again", "Read", "Delivered", "Sent" and "Sending…". Scrolled to its first: the day labels, a reply with its quote, "edited", "Message deleted", "<name> added a device", a message that could not be read and a link. Since 0.33.0. Since 0.35.0 the handset "Call" in the header of a chat between two people. |
| `chat-list-phone-*`, `chat-thread-phone-*` | Phone | The list with the unread count in the row and in the bottom bar, a long name and the rows of people who cannot be written to; the open chat over the whole screen with its menu buttons. Since 0.33.0. Since 0.35.0 the handset "Call" in the open chat's header. |
| `chat-group-wide-*`, `chat-group-phone-*` | Wide, Phone | A group chat with the fixed engine: the people icon and "6 people" in its header with People and the notification bell; each sender's initials and name over their first message, a former colleague's name with "former colleague", "<name> left the chat" and "<name> joined the chat", a mention in the accent and the reader's own on the accent with the message outlined, and "Read by 3 of 3" and "Read by 2 of 3" under own messages. The list beside it (Wide) has the group rows with the people icon. Since 0.34.0. |
| `chat-people-wide-*`, `chat-people-phone-*` | Wide, Phone | The people of that chat as its manager sees them: Name with Rename, Add people, each person with initials, the online dot, "(you)", "Manager" or the server's reason they are not in it yet ("has not set up Chat yet", "is not signed in to Chat on any device", deactivated), Remove, and Leave chat. Since 0.34.0; the reasons of 0.35.0. |
| `chat-files-wide-*`, `chat-files-phone-*` | Wide, Phone | Files in a chat with the fixed engine: a picture by its preview with its text, a PDF and another file as rows with Save, a voice message with its play button and length, and an own file on its way with its bar, "40% sent" and "Sending…" with Cancel; the paperclip and the microphone left of the field. Since 0.34.0. Since 0.35.0 the handset "Call" in the header. |
| `chat-recorder-wide-*`, `chat-recorder-phone-*` | Wide, Phone | The same chat while a voice message is recorded (a silent microphone, the fixed clock at 0:00): the bin, the red dot, the time "of 10:00 at most" and Send in the field's place. Since 0.34.0. Since 0.35.0 the handset "Call" in the header. |
| `chat-search-wide-*`, `chat-search-phone-*` | Wide, Phone | "plan" in the search field: the chat found by its name, then the messages with the chat, the day, the sender and the line with the match marked, and the sentence that search looks only through this device. Wide: beside an open group chat; Phone: the list. Since 0.34.0. |
| `chat-passphrase-choose-wide-*`, `chat-passphrase-choose-phone-*` | Wide, Phone | Chat at its first open, with the fixed engine waiting for a passphrase: the passphrase typed (its hint reads "Strong."), the repeat empty, the warning about a lost device, why it is not the sign-in password, and the greyed "Set passphrase and open Chat". Since 0.33.0; since 0.35.0 it says that colleagues can write once the passphrase is chosen. |
| `chat-passphrase-enter-wide-*`, `chat-passphrase-enter-phone-*` | Wide, Phone | Chat on a device that is in Chat without the history: "Enter your chat passphrase", "Get my earlier messages" and "Not now", then what to do when it is forgotten with "Start a new key…". Since 0.33.0. |
| `settings-chat-wide-*`, `settings-chat-phone-*` | Wide, Phone | Settings → Chat on a device that holds the history: presence, read receipts and what a notification shows, "Set a new passphrase…", and what the encryption protects. Since 0.33.0; since 0.34.0 also "Messages and files": how long the person's messages are kept and the largest file they can send. Since 0.35.0 the paragraph on the two ways a new device is let in follows the passphrase row, below the picture's fold on Wide. Since 0.35.0 also "Calls". |
| `chat-waiting-wide-*`, `chat-waiting-phone-*` | Wide, Phone | Chat on a device that is not in Chat yet, with the fixed engine waiting: the grey dot on Chat's entry, "Not now" in the header, the passphrase with "Let this device in", "Or approve on another device" with the person's two devices in Chat and "Ask for approval", and "Forgot it?" naming those devices as what stands in the way of a new key. Since 0.35.0. |
| `chat-waiting-code-wide-*`, `chat-waiting-code-phone-*` | Wide, Phone | The same screen with a request open: the code "481 516", the sentence to compare it, "Ask again" and "The code works for 9 more minutes." Since 0.35.0. |
| `chat-waiting-alone-wide-*`, `chat-waiting-alone-phone-*` | Wide, Phone | The same screen for a person with no other device in Chat: no device can approve, and "Start a new key…" is offered. Since 0.35.0. |
| `chat-approval-wide-*`, `chat-approval-phone-*` | Wide, Phone | "A device asks to join your chats" over the chat list: the device's name, "Signed in 3 minutes ago. Asked just now.", the warning that the name comes from that device, the code, "This was not me" and "Approve". Since 0.35.0. |
| `call-ringing-wide-*`, `call-ringing-phone-*` | Wide, Phone | "Blair Example is calling" over the chat list, with a fixed call in place of a real one: the initials in their ring, "Voice call", "Decline" and "Answer". Since 0.35.0. |
| `call-calling-wide-*`, `call-calling-phone-*` | Wide, Phone | The call's screen while it rings on the other side: "Calling…", "Mute", "Hang up", "Open chat" and "Hide". Since 0.35.0. |
| `call-active-wide-*`, `call-active-phone-*` | Wide, Phone | The same screen three minutes into the call: the time "3:07". Since 0.35.0. |
| `call-reconnecting-wide-*`, `call-reconnecting-phone-*` | Wide, Phone | The same screen with the connection broken and the microphone off: "Reconnecting…", the greyed time, "Your microphone is off." and "Mute" pressed. Since 0.35.0. |
| `call-ended-wide-*`, `call-ended-phone-*` | Wide, Phone | A call that was answered and never connected: "Could not connect. Your administrator may need to set up the relay for calls.", "Close" and "Open chat". Since 0.35.0. |
| `call-page-phone-*` | Phone | `/call` with a call ringing: the call alone on the page, without the shell. Since 0.35.0. |
| `chat-calls-wide-*`, `chat-calls-phone-*` | Wide, Phone | A chat with one message and five calls: "Voice call, 5 min", "Call declined" and "No answer" on the caller's own side, "Call failed" and a red "Missed call" on the other, each with who called, the time and "Call back"; the handset in the chat's header. Since 0.35.0. |
| `chat-retention-dialog-wide-*`, `chat-retention-dialog-phone-*` | Wide, Phone | Server → Policies as the owner: "Delete chat messages after" changed from Never to 30 days and "Save changes…" pressed: the server's count, what follows, "Type DELETE to confirm" with the focus, the password, and "Save changes" in red, greyed out. Since 0.34.0. Since 0.35.0 the Chat group has the row "Calls". |
| `chat-retention-pending-wide-*`, `chat-retention-pending-phone-*` | Wide, Phone | The Chat group of Server → Policies with 30 days set and three chats in their 24 hours: the note under the rule with the server's date and "Apply now…", then "Largest file in a chat" and "Who members may add to a group chat". Since 0.34.0. Since 0.35.0 the Chat group has the row "Calls". |

**Behaviour checks.** These run against the same build and the same data.

| Decision / scenario | Check |
| --- | --- |
| P-07, T-01 | ToDo shows Overdue, Today, Later and No date, every title, the description, the source email with its attachment name and every subtask. No row control except its menu has `aria-expanded`. Rows stay inside the page body's visible width, and the body does not scroll sideways (Wide and Phone). |
| P-07, T-04 (partial) | Recordings rows show title, description, tags and chords; the chords use JetBrains Mono. Nothing folds and nothing is cut off (Phone). |
| P-08, N-03, N-04 (partial) | Wide Mail: "Hide panel" removes the column, moves focus to the scope button and stores `unihub:panel:mail`. The fold survives a reload and a visit to Contacts. Contacts keeps its own panel. The scope button opens the sheet and Escape returns focus to it. "Keep panel open" restores the column and focuses its fold button. |
| P-12, N-05 | Wide Mail: 45 Tab presses cover the rail, then the panel, then the page, in that order. Every stop shows a focus ring (outline or ring shadow) and is on screen. Ctrl+K opens search with its input focused, Escape closes it, and Tab continues afterwards. |
| P-02, A-01 | With the app script held back, the first paint is already black (default) or the stored Light colour, even when the OS prefers the other mode. After start-up, `theme-color` equals the page colour. Settings switches Light (kept after reload), System (follows a live OS change both ways) and Dark (kept after reload against a light OS). |
| P-11, M-10, T-02 | Phone, coarse pointer (asserted). On ToDo, the Mail list, the composer, Recordings, the Contacts list and detail, the contact editor, the merge review, Settings → Mail, Backup and restore and Bin: every control in view has a tap area of at least 40 px, counting its `tap-area` pseudo-element. No two neighbouring tap areas overlap; edges that touch along one CSS pixel or less count as touching, and the part of a tap area under the fixed bottom bar does not count (the person sees and taps the bar there). Every control is reachable by hit-testing once scrolled into view, so nothing stays under the bottom bar. Since 0.30.0 also Server → People, a person's page, a group with its Add people dialog (as an administrator) and the two-factor reminder bar. Since 0.31.0 also a shared book with its bin and share dialog, Company and one of its entries, and Server → Shared books. Since 0.32.0 also the Calendar panel with the calendars others share, a calendar's settings and share dialog and an event as a contributor reads it (the dialogs only: the month's day buttons are a known gap of the Calendar page); an offered calendar in the panel, the hand-over dialog, a new event's custom repeat, and Server → Calendars with a calendar's menu. Since 0.33.0 also the Chat list and an open chat (the chat alone: it lies over the page and its bottom bar), the chat passphrase prompt with its new-key dialog, and Settings → Chat. Since 0.34.0 also a group chat, its people panel and the new group chat dialog, a chat with files and two more waiting to be sent, the voice recorder and the search results. |
| H-06 | 412 × 560, as with the keyboard open: after typing two lines in a chat, its Back link, the field, Send and the newest message are on screen, the message above the field. |
| H-26, H-27 | Phone: "A device asks to join your chats" opens with the focus on the dialog and on no button; its controls, those of "The request was removed" and those of the waiting screen with a code have a tap area of at least 40 px and none overlap. |
| P-15, P-26, B-11 | 412 × 560 and 450 × 600, as with the keyboard open in the Android app: the composer fills the screen from the very top, and after typing one line in a new message at least 240 px of the message editor is on screen, counting every clipping box around it and the toolbar pinned above the button bar, with the typed line in view. The header rows scroll away above the message when it gets focus; at full height the layout is the approved picture. |

Every test also fails on an uncaught page error, on an `/api` request that has
no fixture, and on any request outside the loopback app and the intercepted
font hosts.

### Known defects in the pinned code

The checks found two violations in the pinned code and one more in 0.32.0. The remaining ones are listed
in `tools/ui-regression/support/known-defects.ts` and matched exactly. A check
fails on any new violation, and it also fails once a listed violation stops
occurring. The fix then removes the entry and re-approves the affected pictures
in the same change.

- **UIR-1 (P-07), fixed 2026-10-19.** A ToDo task row with a long source-email
  subject was wider than its list: cut off on Phone, past the row divider on
  Wide. The `todo-*` pictures were re-approved with the fix. The phone checks
  also require that `/todo`, `/mail`, `/recordings` and the appearance settings
  keep the layout at the screen width: the page allows pinch zoom, and any
  wider content (also a hidden label) lets a phone's browser widen the layout
  so the bottom bar leaves the screen.
- **UIR-2 (P-11).** Recording tag buttons stay 20 px tall on touch screens, with
  no 44 px tap area. Only the three exact existing size violations are waived:
  garden 60 × 20 px, ideas 50 × 20 px, sketch 57 × 20 px, each once. Overlap,
  coverage and any other size violation still fail.
- **UIR-3 (P-11).** In the Calendar panel the plain checkbox of a calendar row
  measures 16 px, with no tap area of its own; the label around it makes the
  whole row (44 px on touch screens since 0.32.0) the target. Waived only for
  the panel's check. The Calendar page has two more gaps the checks do not
  open yet: the month's day buttons (28 px) and the reminder rows of the event
  dialog (under 40 px tall).

The light pre-paint colour in `public/theme-init.js` (`#f5f7fa`) differs by one channel
step from the stylesheet's Light Default page colour (`rgb(246, 247, 248)`).
That is not a visible flash, so the check holds the mode, not the exact value.

## Fixed conditions

| Condition | Value |
| --- | --- |
| Viewports | Wide 1440 × 900, fine pointer. Phone 412 × 915, `isMobile` and touch, so `(pointer: coarse)` matches. Both at device scale factor 1. |
| Themes | Dark Default and Light Default, with the OS preference set to match. Accent blue. |
| Clock | `Date` fixed at 2026-06-15 09:30 UTC (a Monday). Time zone UTC, account time zone UTC, locale en-GB. |
| Motion | `prefers-reduced-motion: reduce`. Playwright disables CSS animations and transitions and hides the caret for each capture. Nothing is hovered. |
| Fonts | The app bundles Inter and JetBrains Mono (Fontsource, `src/main.tsx`) and serves them from its own origin, so nothing leaves the machine. Fallback fonts come from an isolated fontconfig that only knows the same files. Inter must be loaded before any capture. |
| Settling | The page has made no API request for 300 ms, no font is loading and nothing is `aria-busy`. A capture also has to be identical on two consecutive frames. |
| Service workers | Blocked, so every request goes through the test's interception. |

## Isolation and data

- The frontend is built from the working tree into
  `tools/ui-regression/.build/dist`, using an empty env directory with every
  `VITE_*` variable removed. A developer's `.env.local` therefore cannot point
  the bundle at a real server. The build also re-emits the classic workers into
  the git-ignored `/.worker-dist`, which `npm run dev` and `npm run build` do
  too.
- A server inside the test process serves the build on `127.0.0.1` on a random
  free port and shuts down at teardown, along with the browser that Playwright
  owns. It holds `/api/events` open without sending events and answers every
  other `/api` path with 599.
- Inside the browser, `/api` is answered by `tools/ui-regression/support/fixtures.ts`.
  Its shapes follow the frontend's API types and the offline snapshot reader
  (`src/lib/offline.ts`). An unknown route gets 501 and fails the test, so a new
  request in the product shows up as a fixture to add. Requests to any other
  origin are refused and fail the test.
- The data is synthetic: two mail accounts, six messages including one over-long
  subject with an attachment, four tasks including one with a description,
  source email and subtasks, three recordings with tags and chords, and seven
  contacts (one with every kind of field, two duplicate groups). Names are made up and addresses use `example.com`, `.net` and `.org`.
  Each test gets a fresh copy, so a message read in one test is unread in the
  next.

## Commands

Requirements: Node.js 26 or newer and the root frontend dependencies (`npm ci`
in the repository root). The browser download comes from Playwright's official
CDN, and the npm packages from registry.npmjs.org, pinned by
`tools/ui-regression/package-lock.json`.

```sh
cd tools/ui-regression
npm ci                       # pinned Playwright and fonts, separate from the app's lockfile
npm run browsers             # Chromium headless shell into tools/ui-regression/.browsers
npm run verify               # build the current frontend, run all checks
npm run verify -- -g "todo"  # a subset (Playwright's grep); skips the orphaned-baseline check
npm run typecheck            # the runner's own TypeScript, with the root compiler
```

From the repository root, the same commands work as
`npm --prefix tools/ui-regression ci`, `… run browsers` and `… run verify`.

`verify` fails, and never passes or writes a picture, when any of these holds:

- Node.js, the test dependencies, the root dependencies or the pinned browser is
  missing.
- `baselines/manifest.json` is missing.
- The render identity (browser, Playwright, platform, fonts, flags) differs from
  the approved one.
- A picture's hash differs from the manifest, for example after a raw
  `npx playwright test -u`.
- A picture is missing, unlisted, or no longer compared by any test (full runs
  only).
- The baseline files or manifest change during verification.
- Any check fails.

Only `-g`/`--grep`, `--repeat-each` and `--workers` are accepted as verify
options. Flags that bypass snapshots, change snapshots or select another
configuration are refused before a browser starts.

After a failure, `tools/ui-regression/report/index.html` shows the expected,
actual and diff pictures, and `test-results/` keeps a trace per failed test
(`npx playwright show-trace <file>`).

The image workflow runs this required check before building and publishing:

```sh
npm ci
npm --prefix tools/ui-regression ci
npm --prefix tools/ui-regression run browsers -- --with-deps
npm --prefix tools/ui-regression run verify
# on failure, upload tools/ui-regression/report and tools/ui-regression/test-results
```

The baselines were captured on a linux-x64 workstation, not on a CI runner. The
pinned browser, the isolated fonts and the flags above are meant to make
another linux-x64 host render the same pixels, but no second host has been
tried. If the first CI run differs, it fails. The remedy is an approved
`--update` from the CI environment, not a tolerance.

## Changing a baseline

Approval policy is in [UI_ACCEPTANCE.md](UI_ACCEPTANCE.md#baselines-and-approval).
In practice:

1. Run `npm run verify`. A changed screen fails. Open the report and decide
   whether the change is a defect (fix it) or an intended change.
2. For an intended change, run
   `npm run update -- --reason "<what changed, decision or CHANGELOG entry>"`.
   An update runs the whole suite. It writes only the pictures that differ and
   deletes pictures no test uses. It records the reason, source commit, render
   identity and the added, changed and removed names in `manifest.json`. If any
   check fails, nothing is approved and the manifest stays unchanged.
3. Review every listed picture in the pull request diff before merging, record
   the change in CHANGELOG.md under the release, and update
   PROJECT-PREFERENCES.md if a pinned decision changed. Regenerating pictures in
   bulk to make the check pass is not approval.

Adding a reference screen follows the same route: add the test with
`expectBaseline(page, '<name>.png')` in `tests/reference-screens.spec.ts`, then
run an approved update. UI_ACCEPTANCE asks for a new screen only when a decision
depends on it.

## Not covered

- Laptop (1100 × 800) and Tablet (900 × 1200) viewports, and real phone pixel
  densities. Phone pictures are taken at scale factor 1.
- Looks other than Default, accents other than blue, and the System mode in a
  picture. System is covered as behaviour only.
- Real devices, the Android app (A-04), the built container, production data
  and real providers. Headless Chromium on Linux with an emulated coarse
  pointer is browser evidence, not device evidence.
- Scenarios M-01 to M-09, N-01, N-02, N-06, T-03, T-05, A-02, A-03, A-05, C-01
  and C-02 of UI_ACCEPTANCE, apart from what the pictures happen to show.
  C-02/M-08 (the reader over the peek on phones) remains open.
- Fixture drift. The fixtures follow the frontend's types, not the live API, so
  a server response change that the frontend also absorbs will not show up here.
