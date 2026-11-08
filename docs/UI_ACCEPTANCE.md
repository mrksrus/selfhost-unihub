# Interface acceptance

What a change to UniHub's interface must prove before it is accepted, and how
approved appearance is protected from drifting. The decisions themselves live in
[PROJECT-PREFERENCES.md](../PROJECT-PREFERENCES.md) (IDs `P-nn` below refer to
it); this document turns them into checks. Release-wide gates (recovery into a
fresh installation, Android and server compatibility) are the subject of
`docs/RELEASE_CONTRACT.md`; the interface scenarios here are one
input to that contract.

Written 2026-10-16 against release 0.21.4.

## What counts as verified

Every scenario carries one of these marks. Do not upgrade a mark without doing
the corresponding check.

| Mark | Meaning |
| --- | --- |
| Source | The behavior is read in the cited source and, where named, covered by a Vitest test that fails on a real regression. |
| Browser | Checked in a real browser at the stated viewport, theme and pointer type. |
| Device | Checked on a phone or emulator, including the Android app where relevant. |
| Open | Required by a decision, not yet checked at runtime. |

A scenario marked Source only has not been looked at; "the component renders in
tests" is not a visual check. When reporting a change, list the scenarios
exercised and their marks. A missing check is reported as missing, never as
passed.

## Fixed conditions

Run visual checks under the same conditions every time so a difference means a
change in the product, not in the setup.

**Viewports** (CSS pixels; the breakpoints are in `src/hooks/use-mobile.tsx`
and the mail reader's `xl:` classes):

| Name | Size | What it exercises |
| --- | --- | --- |
| Wide | 1440 × 900, fine pointer | Rail, panel column, mail split view with resizable reader. |
| Laptop | 1100 × 800, fine pointer | Rail and panel column; the reader fills the page (below 1280). |
| Tablet | 900 × 1200, coarse pointer | Rail; panel opens as a sheet (below 1024); touch sizes. |
| Phone | 412 × 915, coarse pointer | Top bar, bottom bar, full-screen reader, full-screen composer, safe areas. |

**Themes.** Every scenario in Dark Default and Light Default (P-02). Appearance
scenarios also take one spot check in each remaining look (P-03). System mode is
checked once by flipping the OS preference and watching the page follow.

**Data.** Synthetic only: names and addresses on `example.com` and the other
reserved example domains, fixed dates in 2026, no real mail, contacts, calendar
entries, recordings or screenshots of them (AGENTS.md "Private data"). Use the
same fixture set for every run so lists have the same length and the same long
titles; include at least one over-long subject, one task with description,
source email and subtasks, one song with chords and one without, one recording
with tags.

**Stability.** Fixed clock (the fixture dates decide "Today" and "Overdue"),
fonts loaded before capture (Inter and JetBrains Mono, or the documented system
fallbacks on every machine alike), animations disabled or `prefers-reduced-motion`
on, no hover state unless the scenario says so, sync and upload indicators in a
settled state.

## Scenarios

The IDs are stable; add new scenarios at the end of a group. The "Checks" column
is the expected outcome, the "Mark" column the current state.

### Shell and navigation (P-06, P-08, P-12)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| N-01 | Wide, Laptop | Open each page from the rail. | Rail shows pages in the saved order, then Search, Attention, Settings, account; the active page has the accent bar; each page has its own header; no page draws a second sidebar inside its body. | Source (`NavRail.tsx`, `modules-navigation.test.tsx`) |
| N-02 | Phone | Open each page from the bottom bar; open More. | First four pages then More; More lists the rest in order, then Settings, admin pages for admins, sign out; the bar clears the home indicator; body content is not hidden under the bar. | Source (`BottomNav.tsx`, `More.tsx`, `.pb-mobile-nav`) |
| N-03 | Wide | On Mail, Contacts, Calendar, Recordings, Settings: click "Hide panel", reload, visit another page and come back. | Panel is gone after reload and after returning; the scope button in the title opens it as a sheet; "Keep panel open" restores the column. Folding Mail does not fold Contacts. | Source (`page-shell.test.tsx`) |
| N-04 | Tablet, Phone | Open the panel from the scope button, pick an entry. | The sheet closes on the pick; the page shows the chosen scope; focus returns to the scope button. | Source (`page-shell.test.tsx`), Open at runtime |
| N-05 | Wide | Keyboard only: Tab through rail, header, panel, body; Ctrl/Cmd K. | Every stop has a visible ring; order follows the visual order; search opens and closes with Escape; no focus trap outside dialogs. | Open |
| N-06 | All | Visit a page whose module is hidden by direct address; disable a module. | Hidden pages open by link; disabled pages do not mount; Settings stays reachable. | Source (`modules-navigation.test.tsx`) |

### Mail (P-09, P-14, P-15, P-16, P-17)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| M-01 | Wide | Open a message; drag the reader's left edge; press Left and Right on the handle; double-click it; reload. | Reader stays between 30 % and 70 %, list keeps at least 20 rem, arrow keys move in 2 % steps, double-click returns to 45 %, the share survives reload. | Source (`resizable-width.test.tsx`), Open at runtime |
| M-02 | Laptop, Phone | Open a message; use Back. | Reader fills the page; Back returns to the same list and scope; a dirty inline reply asks before leaving. | Source (`MailPage.tsx` `onBack`), Open at runtime |
| M-03 | All, Dark | Open an HTML message with remote images. | Dark reading view by default with "Original email appearance" offered; remote images blocked until allowed; leaving and reopening the message resets both. | Source (`dark-email-content.test.tsx`, `safe-email-content.test.tsx`) |
| M-04 | Wide, Phone | Compose from All accounts with a default account set; compose from a single account; reply to a message received by account B. | From is the default account, the open account, and account B respectively; changing From does not change the page scope. | Source (`mail-compose-from.test.tsx`) |
| M-05 | Wide, Phone | Type two letters in To, pick a suggestion. | Suggestion inserted as `Name <address>` (on Phone as a chip showing the name), list closes, no extra dismissal needed; Escape with a list open closes only the list. | Source (`mail-compose-from.test.tsx`, `phone-composer.test.tsx`) |
| M-06 | Wide | Send to `Jane Doe <jane@example.com>` with a Cc `"Doe, Jane" <jane2@example.com>` against the synthetic SMTP peer; open Sent and Drafts. | Headers carry the names, the comma name is quoted, Bcc is absent on the wire and present in the own copy. | Source (`api/tests`, `mail-recipients.ts`) |
| M-07 | Wide, Phone | Write a draft with an attachment, close it; reopen; add a task from the draft. | Close asks save, discard or keep editing; reopened draft lists the attachment; "Add task" saves the draft first and the task links back to it. | Source (`mail-page-ui.test.tsx`, `email-task.test.tsx`) |
| M-08 | Phone | From a task, open its email in the peek; set it aside; open the full reader from the list; return. | Peek opens as a bottom sheet; set-aside bar stays usable; the full-screen reader does not leave the peek unreachable or hide its set-aside bar permanently. | Open (see PROJECT-PREFERENCES C-02) |
| M-09 | Wide, Phone | Open an image, a PDF and a spreadsheet attachment from the reader. | Image shows in place; PDF renders with selectable text and a page count; spreadsheet offers download only; moving between attachments does not refetch. | Source (`attachment-viewer.test.tsx`) |
| M-10 | Phone, coarse | Inspect the row actions, panel item trailing buttons, the composer's recipient chips, its folded "Cc/Bcc, From" line and the dialog close control. | No two tap areas overlap; a destructive action has a gap from its neighbours; close controls are 40 px. | Source (`touch:gap` uses), Open at runtime |
| M-11 | Phone | New message: type an address and a comma; tap the "Cc/Bcc, From" line; tap into the message. | The address becomes a chip (tap it for the full address and Remove); the line opens into Cc, Bcc and From rows and is open from the start when the message has a Cc or Bcc; the header rows scroll away and the formatting toolbar stays pinned above the buttons; with the keyboard open the composer is the visible area above it. | Source (`phone-composer.test.tsx`, `tools/e2e/tests/compose/layout.e2e.ts`), Open on a device |

### Tasks, music, recordings (P-07, P-11)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| T-01 | Wide, Phone | Open ToDo with the fixture set. | Overdue, Today, Later and No date sections are all expanded, with description, source email block and subtasks visible per row; nothing is collapsible; view and list chips are in the header and scroll sideways on Phone. | Source (`todo-page.test.tsx`, `TodoPage.tsx`) |
| T-02 | Phone, coarse | Tick a task done from its circle; open the row menu. | The circle has a 44 px tap area that does not overlap the title or the menu; the menu button is 40 px. | Source (`TaskRow.tsx`), Open at runtime |
| T-03 | Wide, Phone | Open Music, both views. | Every song shows its chords in monospace; a song without chords shows the editor at once; only one song plays at a time. | Source (`music.test.tsx`) |
| T-04 | Wide, Phone | Open Recordings with device drafts and library items. | Rows show title, meta, player for the playing one, description, chords and tags inline; device rows show status and progress; nothing folds. | Source (`RecordingRows.tsx`), Open at runtime |
| T-05 | All | Empty, loading and failed list on each of the three pages. | Loading label, an empty state that says what to do next, an error state with Retry; all from the shared components. | Source (`page-states.tsx`), Open at runtime |
| T-06 | Wide, Phone | Drag a task by its ≡ handle within a section (mouse after 4 px; on Phone a 250 ms hold, then drag); Tab to a handle, press Space, ArrowDown, Space; open a row menu; reload. | The handle shows on row hover and focus with a mouse and always on Phone, at least 24 px from the screen edges, with a 44 px tap area that does not overlap the done circle or the menu; the row keeps its description, email and subtasks while it moves; a swipe on the handle without the hold scrolls; the keyboard path is announced in plain words and focus stays on the handle; Move up and Move down are in the menu, disabled at the ends; the order survives a reload and reaches another device; Done shows no handles. Subtasks drag the same way. | Source (`task-order.test.tsx`, `sortable-list.tsx`), Browser (pictures `todo-drag-*`), e2e (`tools/e2e/tests/tasks/order*.e2e.ts`) |
| T-07 | Wide, Phone | New task: open the List chooser with and without a time; Move to another list from the row menu; New event: the Calendar chooser. | Lists are grouped by account ("On this UniHub", then each server account); the server-marked default is preselected; a list that cannot take the item is greyed out with its reason ("Tasks without a date stay in UniHub", "Read-only", "Sync is paused"); a list not shown in ToDo says so; taking the time away from a task in a server calendar returns it to the default list; a move the server has not confirmed says "Moving…" and closes with Close. | Source (`task-order.test.tsx`), Browser (pictures `new-task-*`), e2e (`tools/e2e/tests/tasks/lists.e2e.ts`) |

### Appearance (P-01, P-02, P-03, P-13)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| A-01 | Wide, Phone | Switch Dark, Light, System; reload each. | Page, rail, panel and the browser bar colour follow; no flash of the other mode on reload; System follows the OS. | Source (`public/theme-init.js`, `ThemeProvider.tsx`), Browser (production build with the Nginx CSP, 2026-10-18), Open at runtime |
| A-02 | Wide, Phone | Choose a look for Dark and another for Light; switch modes; reload; open a second browser. | Each mode keeps its own look on this device; the second browser has the defaults (looks are per device). | Source (`appearance-settings.test.tsx`), Open at runtime |
| A-03 | Wide, Phone | Choose an accent; open a second browser signed in as the same account; sign in as another account. | Accent follows the account across browsers and does not leak to another account; icon and mark take the accent; text on the accent is legible in every look. | Source (`appearance-settings.test.tsx` contrast), Open at runtime |
| A-04 | Device | In the Android app, switch modes and looks. | Status and navigation bars follow the page colour of the look. | Open |
| A-05 | All | With `prefers-reduced-motion`, open a sheet, a dialog and the sync details. | No decorative animation; disclosure arrows do not animate; nothing depends on motion to be understood. | Open (see PROJECT-PREFERENCES S-03) |
| A-06 | Wide, Phone, both themes | Capture the reference screens listed under Baselines. | Matches the approved baseline, or the difference is an intended change recorded with the release. | Browser ([runner and coverage](UI_BASELINES.md)) |

The deployed image sends a Content Security Policy that allows scripts from the
page's origin only, so the pre-paint script of A-01 is the file
`public/theme-init.js`, loaded before any stylesheet; an inline script would be
refused and the page would flash the dark default. `scripts/container-smoke.sh`
asserts that header and the absence of inline scripts in the built image, and
`appearance-settings.test.tsx` holds the file and its order in `index.html`.

### Data safety: backups, the bin and policies (P-31, D29)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| D-01 | Wide, Phone | Settings → Backup and restore: choose sections, switch "Include downloaded mail", create a backup. | No encryption choice exists; the ledger says what the backup holds and what is left out (Sync-mode mail, calendar-server events download again); the switch is checked and greyed with the reason when a policy or a provider-deleting account forces it; the request carries the choice; the new backup appears as a row with its progress. | Source (`backup-settings.test.tsx`), Browser (pictures `settings-backup-*`), e2e (`tools/e2e/tests/backup/user-backup.e2e.ts`) |
| D-02 | Wide, Phone | Download a backup; download one made before 0.28; review an uploaded old archive. | The recovery password is shown once and Download waits until it is saved; the file is a password-protected `.zip` and leaves through a download ticket (in the app without the session cookie); "How to open it" lists the steps to open it outside UniHub; an old row says "Not encrypted, made before 0.28"; the review lists what the archive holds, what was left out with counts, and the server's notes. | Source (`backup-settings.test.tsx`), e2e (`tools/e2e/tests/backup/old-archive.e2e.ts`, `tools/e2e/tests/backup/readable-backup.e2e.ts`) |
| D-03 | Wide, Phone | Delete a contact, an event, a task, a recording and a local calendar; use Undo from the notice; open the Bin of each page and Settings → Bin. | Every delete says "Moved to the bin" with Undo, which brings the item back; the bin lists items with when they go for good, a merge or a calendar with its events as one row, a synced item with "Restoring creates it on the calendar server again"; Restore returns the item; Delete for good and Empty bin ask first. | Source (`bin.test.tsx`), Browser (pictures `bin-*`), e2e (`tools/e2e/tests/bin/bin.e2e.ts`) |
| D-04 | Wide, Phone | Settings → Bin: change "Keep deleted items for". | The choice is saved as a user setting and the bin's sentence follows; while an administrator forbids deleting from the bin for good, the choices shorter than their minimum are greyed out with the server's reason, a shorter saved choice reads as the minimum, and the server refuses a shorter value. | Source (`bin.test.tsx`), e2e (`tools/e2e/tests/policies/policies.e2e.ts`) |
| D-05 | Wide, Phone | As a person under a rule: open the mail account dialog, the panel's Disconnect, Settings → Delete data, Backup and restore, the Bin. | Every forbidden control stays visible, greyed out, with the reason the server sent for it (`reason` of `GET /api/policies/effective`) beside it in a `PolicyNote`, never hidden and never a reason written in the client; a forbidden menu entry stays in its menu, greyed, with the reason wrapped under its label (`PolicyMenuItem`); Delete of a backup younger than the minimum age is greyed with the date from which it can go; a preset mode for new accounts is selected and locked; the controls are usable until the rules have loaded; the server refuses the action anyway. | Source (`data-safety-policies.test.tsx`), e2e (`tools/e2e/tests/policies/policies.e2e.ts`) |
| D-06 | Wide | Server settings → Policies: change two rules, discard, change again, save with the password. | Each rule is a row with its choices and the default marked; a changed row says so and the effect of a non-default value shows under it; the bar counts the changes; saving asks for the administrator's password and sends only the changed keys; nothing is deleted. | Source (`admin-data-safety.test.tsx`), Browser (pictures `admin-policies-*`) |
| D-07 | Wide | Server settings → Instance backup, with and without the environment set. | Off says which variables are missing and the server runs normally; on shows destination and key fingerprint read-only, from the environment; the time of the daily run (UTC, also in the administrator's zone) and the number kept are edited and saved with the administrator's password, a status refresh while editing leaves the typed values alone, and an impossible count is refused before the password; last and next run show, and "Back up now" starts a run; the restore command is shown, never a web restore. | Source (`admin-data-safety.test.tsx`), e2e (`tools/e2e/tests/settings/instance-backup.e2e.ts`) |
| D-08 | Wide | Users → a person → Accounts, backups and bin: add and remove a mail account, delete a backup, empty the bin, delete a module's data. | Every change asks for the administrator's password and names the person; adding uses the person's own fields and checks; a rule that forbids the person does not grey anything here; the activity log records each action. | Source (`admin-data-safety.test.tsx`), e2e (`tools/e2e/tests/policies/policies.e2e.ts`) |
| D-09 | Wide, Phone | As a person whose rules changed since they last confirmed them: sign in; close the notice; open the app again; confirm with OK; open Settings → Profile. Sign up as a new person on a server with rules. | The rules notice opens at start, "Your administrator changed the data rules" (for a person who never confirmed any, "Rules on this server"), and lists the rules in force in the server's words; OK has the focus, so Enter confirms; the rules scroll inside the dialog on a small phone with title and OK in place, and Tab reaches the list so PageDown and the arrows scroll it with a visible focus ring; OK records the revision shown and the notice does not come back for it; closing without OK records nothing, keeps it closed for this session and shows it again at the next start; Settings → Profile lists the same rules; the sign-up form lists them and the new account starts with that revision confirmed. | Source (`policy-notice.test.tsx`, `signup-rules-revision.test.tsx`), Browser (`behaviour.spec.ts`, the full rules notice on a 360×640 phone), e2e (`tools/e2e/tests/policies/policies.e2e.ts`) |

### Contacts and settings (P-10, P-18)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| C-01 | Wide | Ctrl/Cmd+click two contacts, Shift+click a range, press Escape, press Delete, use "Set company…". | Selection grows without opening a contact; Escape clears; Delete asks first; the company is written to all selected. | Source (`contacts-page.test.tsx`) |
| C-03 | Wide, Phone | Open a contact with every kind of field; Edit; add a field from "Add field"; save with a stale version. | Labelled rows call, write, open or copy; categories are plain chips; kept import details are collapsed and read-only. The editor is a dialog on Wide and the whole screen on Phone, keeps one empty phone and email row, labels values with a preferred star, lets a date leave its year empty, and shows a contact changed elsewhere with "Load their version" or "Save mine anyway". | Source (`contact-editor.test.tsx`, `contacts-page.test.tsx`), Browser (pictures `contact-detail-*`, `contact-editor-*`) |
| C-04 | Wide, Phone | Open Possible duplicates; review a group that needs a choice; merge; undo under Recently merged. | Groups show confidence, reasons and "Needs your choice"; the review lists every number and email as kept with no untick and waits for each choice; the merge notice offers Undo; Recently merged shows the expiry and Undo per entry. | Source (`contact-merge-import.test.tsx`, `contacts-page.test.tsx`), Browser (pictures `merge-review-*`) |
| C-02 | Wide, Phone | Open Settings → Appearance, General, Mail and Notifications. | Device settings say "Saved on this device"; account settings say they follow the account; the two are not mixed in one row. A setting an administrator fixed is greyed out with "Set by your administrator", never hidden. | Source (`AppearanceSettings.tsx`, `settings-pages.test.tsx`), Open at runtime |
| C-05 | Wide, Phone | Settings → Pages and modules: drag Contacts above Mail by its handle; use a row's menu; reload. | Every page row has a ≡ handle and a menu with Move up and Move down (disabled at the ends); the rail (Wide) and the bottom bar (Phone) follow at once; a refused save puts the rows back and says why; the order survives a reload. Settings → General shows "New tasks go to" and "New events go to" beside the reminder, only with the Calendar module on; a choice that is gone reads "Let UniHub choose" with the list in effect named. | Source (`modules-navigation.test.tsx`, `task-order.test.tsx`), Browser (pictures `settings-pages-*`), e2e (`tools/e2e/tests/settings/pages-order.e2e.ts`) |

## Baselines and approval

A baseline is an approved picture of a reference screen under the fixed
conditions above. Baselines protect the identity (P-01 to P-05) and the
layout decisions (P-06 to P-09) from quiet drift; they are not a substitute for
the behavioral scenarios.

**Reference screens.** Mail with a message open (Wide), ToDo open view (Wide
and Phone), Recordings library (Phone), Settings → Appearance (Wide), the
composer (Phone), since 0.26.0 the contact detail, the contact editor and
the merge review (Wide and Phone; P-29, D29), and since 0.27.0 a ToDo row
picked up by its handle and the new-task dialog with its list chooser open
(Wide and Phone) and Settings → Pages and modules (Wide; P-29, D29, D31),
and since 0.28.0 Settings → Backup and restore (Wide), the Bin (Wide and
Phone) and Server settings → Policies (Wide; P-29, D29), each in Dark Default
and Light Default. Forty-two pictures in total; add a screen only when a
decision depends on it.

**Approval policy.**

1. A baseline is created or replaced only with an explicit maintainer decision
   recorded in the release notes (CHANGELOG under the release) and, if it
   changes a pinned decision, in PROJECT-PREFERENCES.md. A picture that only
   adds content within the accepted design, or carries out a design the
   maintainer already chose, is replaced by the release's integrator without
   asking first (PROJECT-PREFERENCES P-27); it is still recorded in the
   CHANGELOG and shown beside the old one in the pull request.
2. A changed picture fails the check. The change is either a defect to fix or a
   proposed new baseline that the pull request shows side by side with the old
   one. Regenerating baselines in bulk to make a check pass is not approval.
3. Differences from rendering noise are handled by fixing the conditions
   (fonts, clock, animation), not by widening a tolerance until the check stops
   failing.
4. Pictures contain fixture data only. A baseline that shows real data is
   removed and the history is flagged as described in AGENTS.md.
5. Use `tools/ui-regression/baselines/` for approved synthetic reference captures
   and their hashed manifest. [UI baselines](UI_BASELINES.md) documents the
   automated runner, exact coverage and known-defect exceptions. The SVG
   wireframes in `docs/ui/` remain schematics, not painted-screen baselines.

**What is not a baseline.** A unit test that asserts incidental class names,
copy or pixel positions. AGENTS.md explicitly permits approved visual
baselines, tap-target geometry, keyboard focus and pinned behavior checks that
protect user-visible outcomes. See PROJECT-PREFERENCES C-01 for that resolved
distinction.

## Reporting

A change report names the scenarios run with their marks, the viewports and
themes used, what was not run and why. For pull requests touching the shell,
tokens, looks, mail layout or row components, include the Wide and Phone
pictures in both default themes in the description, built from fixture data.
