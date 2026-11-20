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

### App lock

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| L-01 | Wide, Phone | Settings → App lock: choose Whole app, set a PIN twice; choose Chosen modules and tick Mail; change Ask again; turn the lock off. | Turning on asks for the method once (Set a UniHub PIN; in the app, the phone's prompt) and saves only after it; the section says it applies to this device; choices under the administrator's requirement are checked and greyed with the server's reason, Off and Chosen are greyed when the whole app is required, longer times than the maximum are greyed with the reason; "Also when the phone is locked" is greyed on the web with its reason; Screenshots shows only while forbidden, read-only; Contacts says synced contacts stay on the phone; turning off, dropping a module or a longer time asks for the unlock first and saves nothing when it is closed. | Source (`app-lock-settings.test.tsx`), Browser (pictures `settings-app-lock-*`), e2e (`tools/e2e/tests/app-lock/pin-lock.e2e.ts`) |
| L-02 | Phone, Wide | With the whole app locked, reload; type a wrong PIN; the right one; open "Forgot PIN? Sign out". | The lock screen replaces the shell (no navigation, no page in the DOM): the mark in the accent, "UniHub is locked", the account's name small, the PIN field focused above the keyboard, Unlock; a wrong PIN is announced in the live region, from the seventh the tries left, after the fifth a countdown; the tenth signs out; "Forgot PIN? Sign out" says what goes (offline copy, PIN) and what stays (unsent recordings) before it signs out; uploads keep running meanwhile. | Source (`app-lock-gate.test.tsx`), Browser (pictures `lock-app-phone-*`), e2e (`pin-lock.e2e.ts`) |
| L-03 | Wide | With Mail locked, open Mail, Calendar, Today, ToDo's email peek, Ctrl/Cmd K, Settings → Mail. | Mail shows "Mail is locked" inside its page under its own header while the navigation works; Calendar opens; Today's Unread mail, the peek and Settings → Mail show the same locked row with Unlock and fetch nothing; the search leaves Mail's results and "New email" out and shows "Mail is locked: unlock to search it"; the rail and bottom bar show no unread count for Mail; one unlock opens every locked module until the next relock, and the target route (a notification's) shows after it. | Source (`app-lock-gate.test.tsx`), Browser (pictures `lock-module-wide-*`), e2e (`module-lock.e2e.ts`) |
| L-04 | Phone, Wide | As a person whose administrator requires the lock, start UniHub; after the rules notice, set it up; sign out instead. | The rules notice comes first; then "Your administrator requires the app lock" with the server's reason and what is required in one sentence; Turn on the app lock runs the same set-up as Settings and the locked parts open after it; Sign out is the other way out; an older Android app says to update for the fingerprint and offers the PIN meanwhile; a refused save shows the server's words. | Source (`app-lock-required.test.tsx`), Browser (pictures `lock-required-phone-*`), e2e (`required-by-admin.e2e.ts`) |
| L-05 | Wide | Server settings → Policies: App lock required (Chosen modules: Mail, Contacts), Longest time in the background, Screenshots; save with the password. | The group follows the other rules: a select per row with the default marked, the module boxes under Chosen modules, the server's effect under a changed row, only the changed keys sent with the password. | Source (`admin-data-safety.test.tsx`), Browser (pictures `admin-policies-app-lock-wide-*`) |
| L-06 | Wide, Phone | Settings → Security → Devices; sign out another device. | Every device with a live session is a row: an icon by kind, "UniHub app 0.29.0 on Android" or "Firefox on Linux", This device, last used and signed in since, its app lock and notifications; Sign out (confirmed) ends that device at once and never shows for this one. | Source (`devices-settings.test.tsx`), Browser (pictures `devices-wide-*`), e2e (`devices.e2e.ts`) |
| L-07 | Device | With Mail locked and the device in the background, receive mail. | The notification names nothing of the message (sender and subject are left out) until the device is unlocked; a calendar reminder still shows its content. | Open (`tools/e2e/tests/app-lock/notification-privacy.e2e.ts` once the delivery record is readable; Android rows in the tracker) |

### Organisation: people, groups and rules

The e2e files are in `tools/e2e/tests/organisation/`.

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| O-01 | Wide, Phone | Server → People: filter by a group; Add person with a setup link, then with an initial password; open a row's menu as the owner and as an administrator. | People are rows (Wide: Name, Role, Groups, Sign-in, Last active as columns; Phone: one line under the name), filtered by group chips; Add person takes email, name, role, groups and how they get in, and asks for your password; the setup link shows once in a dialog with Copy link and what it does (works once, until when, send it yourself); an invited person reads "Invited", one without a way in "Not set up"; making or removing an administrator is greyed for an administrator with "Only the owner makes or removes administrators."; the owner's Deactivate and Delete person are greyed with the reason. | Source (`organisation-people.test.tsx`), Browser (pictures `people-wide-*`), e2e (`people.e2e.ts`) |
| O-02 | Wide, Phone | Server → People → a person: change the role, add to a group, make them its manager, sign out one device and all, deactivate, activate, delete; open the owner's page as the owner. | Sections in this order: Profile and role, Groups, Devices, Account, then accounts, backups and bin; every change that needs it asks for your password and names the person; devices read as in Settings → Security; signing out deletes nothing and says so; Deactivate says data, groups and manager roles stay; the owner's Deactivate and Delete are greyed with the reason, and "Hand over ownership…" lists the active administrators. | Source (`organisation-people.test.tsx`), Browser (pictures `person-wide-*`), e2e (`admin-devices.e2e.ts`, `deactivate.e2e.ts`) |
| O-03 | Wide, Phone | Server → Groups: New group; open it; Add people (search, tick two, change the search); make a manager; remove a member; Rename; Delete group. | Everyone is the first row and opens Policies; each group row shows members, managers and "own rules"; a new group opens at once; ticked people stay listed while the search changes; removing asks first and says the account and data are not touched; Delete group asks for your password and says nobody's data is deleted. | Source (`organisation-groups.test.tsx`), Browser (pictures `groups-wide-*`), e2e (`groups.e2e.ts`) |
| O-04 | Wide, Phone | As a group's manager: Settings → Your groups; open the group; add and remove a member; open another group's address. As a member who manages nothing: open their group. | "Your groups" shows in Settings and More only for a manager, and under Profile for everyone in a group; the manager adds and removes members and renames, sees no manager switch, no Rules view and no Delete; a manager's row is greyed with "Only an administrator removes a manager."; a member sees the managers only; a group out of sight reads "No such group"; a refusal shows the server's sentence. | Source (`organisation-groups.test.tsx`), e2e (`group-manager.e2e.ts`) |
| O-05 | Wide | Server → Policies: choose a group under "Rules for"; make a rule stricter; set it back; save with the password. Then for Everyone: require two-factor authentication and open the save dialog. | One page for everyone and for each group; a group's row marks everyone's value "(as everyone)", offers only values at least as strict and says "Everyone: …" under it; setting a row back gives the group's rule up; for Everyone a row says where a group is stricter; the save dialog for required two-factor authentication says how many people lack it, how many of them get 7 days from now, who is already in their 7 days and whose 7 days have ended; only changed rows are sent. | Source (`organisation-policies.test.tsx`), Browser (pictures `admin-policies-wide-*`, `group-policies-wide-*`), e2e (`group-policies.e2e.ts`) |
| O-06 | Phone, Wide | Open a setup link; open it again after use; open one with a wrong token. | The page stands alone (the mark, one column): the address the person was added as, the rules that will apply to them, Name, Password twice, "Set password and sign in"; the token leaves the address bar at once and the page sends no referrer; a used, replaced or expired link reads "This setup link does not work" with the way to sign in; a failed check says the link is not used up and offers Try again. | Source (`invite-accept.test.tsx`), Browser (pictures `invite-phone-*`), e2e (`people.e2e.ts`) |
| O-07 | Phone, Wide | As a person whose administrator requires two-factor authentication: start UniHub during the 7 days; close the reminder; reload; start after them; set it up. | During the 7 days a bar under the header names the day and offers "Set up now"; closed, it stays away until the next start; after them the prompt replaces the shell with the server's reason, the set-up and Sign out, after the rules notice; the set-up is the one of Settings → Security, and the recovery codes stay until Done although the requirement is already met; Settings → Security greys "Turn off" with the reason. | Source (`two-factor-required.test.tsx`), Browser (pictures `two-factor-required-phone-*`), e2e (`two-factor-required.e2e.ts`) |
| O-08 | Wide, Phone | As a person under the rules: Settings → Pages and modules, Offline reading, Security; open Music by its address; choose a start page. | A module or page the administrator turned off keeps its row with the switch greyed and the server's reason, leaves navigation, More and the start-page choices, and a direct visit says "… is not available" with the reason; Offline reading is greyed with "Not available on this server." and the copy on the device is deleted; the Contacts row says when UniHub contacts may not go to the phone; the shortest password follows the rule. | Source (`organisation-greyed-controls.test.tsx`), e2e (`modules-policy.e2e.ts`, `offline-policy.e2e.ts`) |

| O-09 | Wide, Phone | Contacts: open the panel; New book; open the book; add a contact; open Share, choose "Can edit", add a group, change a person to "Can read", remove them; Rename; Delete book. | The panel's Shared group lists Company first, then the books with their contact counts, then New book. A book shows its name, description, how many contacts and "You manage this book." or "You can edit it.", with Share (managers), New contact and a menu (Import from a file…, Rename, Delete book); its contacts are rows as in All contacts, without the star and the selection. The share dialog lists who has the book with the creator as "Manages it", each other share with its level and Remove, then the people and groups to add under a search with the level beside it; a member is told whom they can share with; each change applies at once and a refusal shows the server's sentence. Delete book asks first and says an administrator can restore it. | Browser (pictures `book-wide-*`, `book-phone-*`, `book-share-wide-*`), e2e (`tools/e2e/tests/contacts/shared-books.e2e.ts`) |
| O-10 | Wide, Phone | As a person a book is shared with for editing: edit a contact, delete it, open Deleted, Restore. As one who only reads a book: open it and a contact. After being removed from the group that had the book: reload. | An editor has New contact, Edit and Delete and sees the Contacts and Deleted views; a deleted contact is "Moved to the bin" with Undo and waits in the book's own bin, which says how long the server keeps the book's deleted contacts (30 days, an administrator's longer minimum, or until someone restores or deletes them) and that everyone who can edit the book sees it. A reader sees "You can read this book. …" under the book's name and again under the contact's fields, and no New contact, Edit, Delete or Deleted view. A book that is gone or no longer shared reads "No such book". | Browser (throwaway pictures), e2e (`shared-books.e2e.ts`) |
| O-11 | Wide, Phone | Contacts → Company; open an entry. Settings → Profile: fill in Phone, Job title and Department; save. Server → People → a person: correct their entry. | Company says who is in it and where a person fills in their entry; an entry shows the job title and department under the name, the person's groups as chips, their phone and email, and a note that it comes from the directory; nothing can be edited there. Settings → Profile has a Company directory section with the three fields and "Save directory entry", greyed until something changed; it shows the current entry with Contacts off too, and only the changed fields are sent. The person page has the same section after Devices, with "Save correction"; an inactive person is "not listed while the account is inactive". | Browser (picture `company-entry-phone-*`), e2e (`tools/e2e/tests/contacts/directory.e2e.ts`) |
| O-12 | Wide, Phone | On any book: switch "On my phones" off and on. As a person whose administrator forbids contacts on the phone: open a book. | The switch is on every book, Company included, with "(read-only, with the Android app)"; it is saved for the account at once. Under the rule it is off and greyed out with the server's reason beside it. | Source (`BookView.tsx`), Open at runtime (the phone is checked in the Android tests) |
| O-13 | Wide, Phone | All contacts: open a contact that is also in a shared book; select two contacts and "Copy to book…"; on a phone, "Copy to <book>" from the contact's menu. In a book: Import from a file…. | The contact reads "Also in <book>" under its name, each book a link to it. Copying says how many were copied and that the copies are not linked; only books the person may edit are offered. The import is the usual two steps, titled "Import into <book>", offers Add and Skip but no Merge, and says the contacts are added for everyone who can see the book. | Browser (picture `contact-detail-*`), e2e (`shared-books.e2e.ts`) |
| O-14 | Wide, Phone | Server → Shared books: open a book; Restore a deleted one. Server → People: Deactivate or Delete a person who manages a book. | Every book of the server is a row with its contacts and creator ("its creator has left" when the account is gone) and opens in Contacts, where the administrator manages it; deleted books are listed under Deleted with Restore and what restoring brings back. The Deactivate and Delete dialogs list "Shared address books they manage" with "They stay; administrators keep managing them." | Browser (picture `shared-books-wide-*`), e2e (`tools/e2e/tests/organisation/deactivate.e2e.ts`) |
| O-15 | Wide, Phone | Calendar: open the panel as a person others share calendars with; switch one off; open its settings; change its colour; switch "Notify me of others' changes". Open the settings of an own calendar and of a calendar synced from a provider. | Under the person's own accounts the panel has "Shared with me", "Groups" and "Organisation", each calendar with whose it is (the person or the group) and, where it applies, "Read-only", "Busy only", "Archived" and a pending offer ("Offered to …"). On or off and the colour are the person's own view, saved for the account at once; the settings of a reached calendar say what the person may do and have no "Show its events in ToDo" and no Delete. "Notify me of others' changes" is on every UniHub calendar, the person's own too, off until switched on. An own UniHub calendar has Sharing with Share; a calendar synced with CalDAV says "Shared at its provider", a subscription "Read-only, from its address". An archived calendar of the person's own offers no "Save reminders" in its events. | Browser (pictures `calendar-shared-wide-*`), e2e (`tools/e2e/tests/calendar/shared-calendars.e2e.ts`) |
| O-16 | Wide, Phone | A calendar's settings → Share: choose a level, add a group, lower a person, remove one. As a member, open the level of a share made beyond their reach. | The dialog is the shared books' with five levels (Sees busy times, Can read, Can add subtasks, Can edit, Can manage), what the two less obvious ones mean under the search, and for a member whom they can share with. Each change applies at once and a refusal shows the server's sentence. A share's level offers a higher level only where the server takes it: within the person's reach (their groups and the people in them; an administrator's is everyone); below it, lowering and Remove stay. | Browser (pictures `calendar-share-wide-*`), e2e (`shared-calendars.e2e.ts`) |
| O-17 | Wide, Phone | Open events of calendars held at free/busy, read, contribute and edit; add a subtask as a contributor; open the Calendar chooser of a new event and of an existing one. | Free/busy: the block and the dialog read "Busy" with the times and "You only see when … is busy.", nothing else. Read: the fields are read-only with the reason under the title; fields nobody filled in are left out. Contribute: the same, with Subtasks first: the person adds one and changes, ticks and deletes those they added, the others are read-only, nothing is reordered and each says who added it ("You" for their own). Below edit "Your reminders" stay changeable and "Save reminders" sends only them. Edit: the dialog as for an own event, the reminders the person's own. A new event's chooser lists the person's own calendars and those they may edit, grouped by whose they are; an existing event's lists the calendars of the same owner. | Browser (pictures `event-contribute-phone-*`), e2e (`shared-calendars.e2e.ts`) |
| O-18 | Wide, Phone | ToDo as a person a list is shared with for editing, for adding subtasks and for reading; tick a task; move one up. | Shared lists are chips beside the person's own (a colleague's with their name) and their tasks show in the date sections with whose list it is. An editor ticks, edits and moves tasks as their own; below edit the circle is greyed out with the reason as its tooltip and the menu offers only "Add a subtask" (a contributor) and Move up and Move down. The order is each person's own. "Move to another list" is offered for the person's own tasks; an editor moves a shared task to another list of its owner from the Calendar event dialog. | e2e (`tools/e2e/tests/tasks/shared-lists.e2e.ts`), Browser (throwaway pictures) |
| O-19 | Wide, Phone | Calendar → Bin as a person who can edit a calendar others share: choose it under "Deleted from"; Restore. | The bin's header has "Deleted from": "My calendars", then each reached calendar the person may edit (a colleague's with their name). A calendar's bin says how long the server keeps what was deleted from it and that everyone who can edit the calendar sees it; Restore puts an item back into that calendar; Empty bin and Delete for good follow the bin rule. A reader or contributor sees no such chip. | e2e (`shared-calendars.e2e.ts`), Browser (throwaway pictures) |
| O-20 | Wide, Phone | New event in one of UniHub's own calendars: open Repeat; choose "Weekly on …"; move the start to another day; choose Custom…. Open a date of the series; change it and save; delete it. Open a new event in a calendar synced from a provider. | Repeat offers Does not repeat, Daily, Weekly on the start's weekday, Every weekday, Monthly on its day and on its first to last weekday, Yearly on its date, and Custom…: Every [number] [days, weeks, months, years], the weekdays as toggle buttons (weekly; at least one stays on), "On day N" or "On the Nth weekday" (monthly, with "Months without a day 31 are skipped." where it applies), and Ends: Never, On a date, or After [number] times. A ready-made rule follows a moved start. Saving a date of a series asks "This event" or "All events" and says each event keeps its ToDo progress and subtasks; a changed rule or calendar offers "All events" only and says what happens to dates that no longer fit; switching between all-day and timed for all events says the dates are made anew; "Does not repeat" asks "Stop repeating?". Delete asks "This event" or "All events" and says the bin. A synced calendar's events have no Repeat field. | Source (`repeating.test.ts`), Browser (pictures `event-repeat-phone-*`), e2e (`tools/e2e/tests/calendar/repeating-events.e2e.ts`) |
| O-21 | Wide, Phone | ToDo with a repeating item in a list: look at Overdue, Today and Later; tick the one under Later. | Later shows the item once, at its next date; ticking it brings the next date. Every overdue date and today's stay, and the counts of the views and lists follow what is shown. Calendars synced from a provider behave the same. | Source (`repeating.test.ts`) |
| O-22 | Wide, Phone | As a group's manager: Settings → Your groups → the group → Calendars: New calendar; "Name and color"; Share; Delete. Open the calendar's settings in the Calendar panel. | The group's page has Calendars with what members and managers may do, New calendar and each calendar as a row with its actions in a menu. A new calendar shows for every member under Groups at once. Delete asks first and says an administrator can restore it. The calendar's settings in the Calendar panel point to the group's page for renaming and deleting. A member who manages nothing sees no Calendars section. | e2e (`tools/e2e/tests/organisation/group-calendars.e2e.ts`), Browser (throwaway pictures) |
| O-23 | Wide, Phone | An own UniHub calendar's settings: Hand over…; search a colleague; Offer; Withdraw offer. As the colleague: open the Calendar panel; Accept, or Decline. As a manager of a group a colleague's calendar is shared with: its settings → Hand over…. | The settings of a person's UniHub calendar have Owner with "Hand over…" for its owner and for a manager of any group (the server decides which calendars); a pending offer reads "Offered to …" with "Withdraw offer". The dialog says what changes hands and what stays, lists the people within reach under a search, and has Offer; a manager also has "Hand over now". The recipient finds a card at the top of the panel: who offers which calendar, what accepting means, Accept and Decline. After Accept the calendar stands under their own account and its former owner reaches it under "Shared with me". An archived or synced calendar offers no hand-over. | Browser (pictures `calendar-offer-wide-*`, `calendar-hand-over-wide-*`), e2e (`tools/e2e/tests/calendar/hand-over.e2e.ts`) |
| O-24 | Wide, Phone | Server → Calendars: New calendar for the organisation and for a group; a row's menu: "Name and color", Share, Hand over…, Archive, Delete; Restore a deleted one; Hand over… and Archive on a person's calendar. | The Settings panel and More list Calendars for administrators. Organisation and group calendars are rows with whose they are, shares, events and "archived"; a person's shared calendars follow under "Shared by people" by name and numbers, with "Hand over…" and Archive or Unarchive only; deleted ones under Deleted with Restore. Hand over and Archive ask for the administrator's password and say what happens and that the owner is told; the new owner is chosen from "Make it an organisation calendar" and the active people. With Calendar switched off for the administrator the page says so. | Browser (pictures `server-calendars-wide-*`), e2e (`group-calendars.e2e.ts`) |
| O-25 | Wide, Phone | Server → People → Deactivate, then Delete, a person who shares calendars. | Both dialogs list "Calendars they share", each with its shares and events and one choice: when deactivating "Leave it as it is" (the default), "Make it an organisation calendar", "Hand it to …" a person, "Delete it to their bin"; when deleting "Make it an organisation calendar" (the default), a person, "Delete it with the person", and the dialog says a calendar deleted with the person is gone for good. The choices are carried out before the person is deactivated or deleted. | Browser (pictures `person-leaving-calendars-wide-*`), e2e (`tools/e2e/tests/organisation/deactivate.e2e.ts`) |

### Chat (P-44)

Pictured and checked with a fixed engine in place of the real one
(`src/test/chat-mock-engine.ts`): the screens read only the engine's
interface (`src/lib/chat/types.ts`).

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| H-01 | Wide, Phone | Open Chat with several chats; open one; on Phone go back. | The chats are rows, the newest first: initials with a dot while the person has UniHub open, the name, the time or day, the last message ("You: …" for your own, "Message deleted", "No messages yet") and the unread count, which the rail and the bottom bar show too. Wide: the list beside the open chat, "Choose a chat" with none open. Phone: the list, then the chat over the whole screen with Back. An address that names a chat the person does not have says "This chat is not available". | Browser (pictures `chat-wide-*`, `chat-list-phone-*`), Source (`chat-page.test.tsx`) |
| H-02 | Wide, Phone | Read a chat with messages of three days. | A label per day ("Today", "Yesterday", then the date); the other person's messages left, your own right in the accent's tint; a reply shows whom and what it answers; "edited" beside the time; "Message deleted" and "This message could not be read." in an outline; "<name> added a device" as a line; a web address is a link, nothing else is. Under your messages the last one read says "Read", the last one delivered "Delivered", the last one sent "Sent"; one on its way "Sending…"; one that did not go out "Not sent" with the reason and "Try again", and the same for a change that was not saved. | Browser (pictures `chat-wide-*`, `chat-earlier-wide-*`, `chat-thread-phone-*`) |
| H-03 | Wide, Phone | Write two lines; send; open a message's menu: Reply, Edit, Delete; press Escape in a reply. | The field grows with the text. Enter sends with a keyboard and Shift+Enter is a new line; on a touch screen Enter is a new line and the button sends. After sending the focus stays in the field. Reply and Edit show what is answered or edited above the field and move the focus into it; Escape or the X leaves them, and an edit gives the unsent text back. Delete asks first and says it is for both people and final. Text not sent yet waits while another chat is open. | Source (`chat-page.test.tsx`) |
| H-04 | Wide, Phone | As a person whose administrator forbids deleting for good: open the menu of an own message. Delete a message the server refuses. | Delete stays in the menu, greyed out, with the server's reason under it; a refusal that arrives after the click shows the server's sentence and the message stays. | Source (`chat-page.test.tsx` for the refusal), Open at runtime for the greyed entry |
| H-05 | Wide, Phone | Open the chat with a person who is deactivated, has Chat off or has not opened UniHub since the update; open Chat in a browser without WebAssembly; open it while it starts or after it failed. | The chat stays readable and the server's reason stands where the composer was; Reply and Edit are greyed out. Without WebAssembly the page says "Chat cannot run in this browser" with the reason; a failed start offers "Try again"; before the passphrase is given the page says Chat is being set up. | Browser (throwaway pictures), Open at runtime |
| H-06 | Phone | 412 × 560, as with the keyboard open: type two lines in a chat. Measure the controls of the list and of an open chat. | The chat's header, the field, Send and the newest message are on screen, the message above the field. Every control has a tap area of at least 40 px and none overlap; each message's menu button shows without hovering. | Browser (`behaviour.spec.ts`), Open on a device |
| H-07 | Wide, Phone | Contacts › Company: open a colleague, then yourself. Open one of your own contacts that has a colleague's address. Settings › General: Start page. | "Message" on the colleague's entry and on the contact opens the one chat with them; your own entry has none, and with Chat off nobody's has. Chat is among the start pages. | Browser (throwaway pictures), Source (`chat-page.test.tsx` for an answer after an account switch) |

### Contacts and settings (P-10, P-18)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| C-01 | Wide | Ctrl/Cmd+click two contacts, Shift+click a range, press Escape, press Delete, use "Set company…". | Selection grows without opening a contact; Escape clears; Delete asks first; the company is written to all selected. | Source (`contacts-page.test.tsx`) |
| C-03 | Wide, Phone | Open a contact with every kind of field; Edit; add a field from "Add field"; save with a stale version. | Labelled rows call, write, open or copy; categories are plain chips; kept import details are collapsed and read-only. The editor is a dialog on Wide and the whole screen on Phone, keeps one empty phone and email row, labels values with a preferred star, lets a date leave its year empty, and shows a contact changed elsewhere with "Load their version" or "Save mine anyway". | Source (`contact-editor.test.tsx`, `contacts-page.test.tsx`), Browser (pictures `contact-detail-*`, `contact-editor-*`) |
| C-04 | Wide, Phone | Open Possible duplicates; review a group that needs a choice; merge; undo under Recently merged. | Groups show confidence, reasons and "Needs your choice"; the review lists every number and email as kept with no untick and waits for each choice; the merge notice offers Undo; Recently merged shows the expiry and Undo per entry. | Source (`contact-merge-import.test.tsx`, `contacts-page.test.tsx`), Browser (pictures `merge-review-*`) |
| C-02 | Wide, Phone | Open Settings → Appearance, General, Mail and Notifications. | Device settings say "Saved on this device"; account settings say they follow the account; the two are not mixed in one row. A setting an administrator fixed is greyed out with "Set by your administrator", never hidden. | Source (`AppearanceSettings.tsx`, `settings-pages.test.tsx`), Open at runtime |
| C-05 | Wide, Phone | Settings → Pages and modules: drag Contacts above Mail by its handle; use a row's menu; reload. | Every page row has a ≡ handle and a menu with Move up and Move down (disabled at the ends); the rail (Wide) and the bottom bar (Phone) follow at once; a refused save puts the rows back and says why; the order survives a reload. Settings → General shows "New tasks go to" and "New events go to" beside the reminder, only with the Calendar module on; a choice that is gone reads "Let UniHub choose" with the list in effect named. | Source (`modules-navigation.test.tsx`, `task-order.test.tsx`), Browser (pictures `settings-pages-*`), e2e (`tools/e2e/tests/settings/pages-order.e2e.ts`) |

### Android home-screen widgets (D69)

Checked by `tools/e2e/android/widgets.test.mjs` in the emulator: each widget
alone on the screen at a size in dp (the debug app's `TestWidgetHost`), and
both on the launcher's home screen. Its pictures go to the run's evidence
folder; the approved ones are in `tools/e2e/android/baselines/`
(`widget-<agenda or tasks>-<size or state>-<theme>.png`; `agenda` is the Calendar widget). They are compared
by eye, not by pixel: the dates are the day's own and each emulator draws
type a little differently.

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| W-01 | Device, light and dark | Place Calendar at about 3 by 2 cells, about 4 by 4 and the whole screen. | The page colour with a border and the system's widget corners; "Calendar" as the header; events under "Today", "Tomorrow" or the date, a line between days; start over end in tabular figures, "All day" for a day's event, the calendar's colour as a bar, the title on one line (two from about 300dp wide, with larger type); a long title ends in an ellipsis; the list scrolls. | Device (emulator, API 35 and CI's Android 16; pictures `widget-agenda-{small,medium,full}-{light,dark}`), Open on a real phone (32-08) |
| W-02 | Device, light and dark | Place ToDo at the same three sizes. | "ToDo" and the count of open tasks; each task with its done circle, title, and the date in words under it, "Overdue · …" in the warning colour; a line between tasks; "and N more in UniHub" under the rows beyond 50. | Device (as W-01; pictures `widget-tasks-{small,medium,full}-{light,dark}`), Open on a real phone (32-08) |
| W-03 | Device | ToDo at the smallest size: measure the circles and a title; tap the title; tap an event in Calendar; tap the header. | Every circle is a tap target of at least 48dp each way, ends where the title begins and does not lie on the next row's; "Mark done: <title>" is its label; the title opens ToDo at the task, an event its dialog in Calendar, the header the page, also from the launcher. | Device (emulator: the measures and the taps on a task and an event are asserted), Source for the header (`Widgets.kt` `views`) |
| W-04 | Device | No events or tasks; no connection; the least notification detail; signed out. | "Nothing in the next 14 days" or "No open tasks"; without a connection the rows stay with "No connection. Updated <time>" under them (the date too when it was not today); with titles hidden "Event" and "Task", faint circles without a tick and "Titles hidden, as in notifications"; signed out one line and "Open UniHub" in the accent, 48dp high. | Device (emulator; pictures `widget-*-empty`, `widget-tasks-no-connection`, `widget-*-titles-hidden`, `widget-tasks-signed-out`) |
| W-05 | Device | Calendar turned off for the person; two-factor sign-in due; the app lock required; a server before 0.32; before the first answer; add a widget from the launcher's picker on Android 10 to 16. | The same line-and-button layout as signed out with "Calendar is turned off", "Set up two-factor sign-in to see this", "Turn on the app lock to see this", "The server needs an update for widgets"; "Loading…" (or "No connection") before the first answer; the picker shows each widget's picture and description. | Source (`Widgets.kt` `line`, `res/xml/widget_*.xml`), Open at runtime |

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
Phone) and Server settings → Policies (Wide; P-29, D29), and since 0.29.0
Settings → App lock (Wide and Phone), the whole-app lock screen (Phone), a
module's lock screen (Wide), the required-by-your-administrator prompt
(Phone), the Policies page at its App lock group (Wide) and Settings →
Security with Devices (Wide; P-29), and since 0.30.0 Server → People, a
person's page, Groups and a group's Rules view (Wide), the setup-link page
and the required two-factor prompt (Phone; P-29), and since 0.31.0 a shared
address book with a contact open and its share dialog (Wide), a book's list
and a company directory entry (Phone) and Server → Shared books (Wide), and
since 0.32.0 the calendars others share and a calendar's share dialog (Wide)
and an event as a contributor reads it (Phone), and since 0.33.0 Chat with
an open chat at its newest and at its first messages (Wide) and the list
and an open chat (Phone), each in Dark Default and Light Default. One
hundred and two pictures in total; add a screen only when a
decision depends on it. The Android widgets' eighteen pictures (0.32.0, D69)
are kept apart, in `tools/e2e/android/baselines/`, and compared by eye (see
the W rows).

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
