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
| M-05 | Wide, Phone | Type two letters in To, pick a suggestion. | Suggestion inserted as `Name <address>`, list closes, no extra dismissal needed; Escape with a list open closes only the list. | Source (`mail-compose-from.test.tsx`) |
| M-06 | Wide | Send to `Jane Doe <jane@example.com>` with a Cc `"Doe, Jane" <jane2@example.com>` against the synthetic SMTP peer; open Sent and Drafts. | Headers carry the names, the comma name is quoted, Bcc is absent on the wire and present in the own copy. | Source (`api/tests`, `mail-recipients.ts`) |
| M-07 | Wide, Phone | Write a draft with an attachment, close it; reopen; add a task from the draft. | Close asks save, discard or keep editing; reopened draft lists the attachment; "Add task" saves the draft first and the task links back to it. | Source (`mail-page-ui.test.tsx`, `email-task.test.tsx`) |
| M-08 | Phone | From a task, open its email in the peek; set it aside; open the full reader from the list; return. | Peek opens as a bottom sheet; set-aside bar stays usable; the full-screen reader does not leave the peek unreachable or hide its set-aside bar permanently. | Open (see PROJECT-PREFERENCES C-02) |
| M-09 | Wide, Phone | Open an image, a PDF and a spreadsheet attachment from the reader. | Image shows in place; PDF renders with selectable text and a page count; spreadsheet offers download only; moving between attachments does not refetch. | Source (`attachment-viewer.test.tsx`) |
| M-10 | Phone, coarse | Inspect the row actions, panel item trailing buttons, composer Cc/Bcc buttons and the dialog close control. | No two tap areas overlap; a destructive action has a gap from its neighbours; close controls are 40 px. | Source (`touch:gap` uses), Open at runtime |

### Tasks, music, recordings (P-07, P-11)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| T-01 | Wide, Phone | Open ToDo with the fixture set. | Overdue, Today, Later and No date sections are all expanded, with description, source email block and subtasks visible per row; nothing is collapsible; view and list chips are in the header and scroll sideways on Phone. | Source (`todo-page.test.tsx`, `TodoPage.tsx`) |
| T-02 | Phone, coarse | Tick a task done from its circle; open the row menu. | The circle has a 44 px tap area that does not overlap the title or the menu; the menu button is 40 px. | Source (`TaskRow.tsx`), Open at runtime |
| T-03 | Wide, Phone | Open Music, both views. | Every song shows its chords in monospace; a song without chords shows the editor at once; only one song plays at a time. | Source (`music.test.tsx`) |
| T-04 | Wide, Phone | Open Recordings with device drafts and library items. | Rows show title, meta, player for the playing one, description, chords and tags inline; device rows show status and progress; nothing folds. | Source (`RecordingRows.tsx`), Open at runtime |
| T-05 | All | Empty, loading and failed list on each of the three pages. | Loading label, an empty state that says what to do next, an error state with Retry; all from the shared components. | Source (`page-states.tsx`), Open at runtime |

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

### Contacts and settings (P-10, P-18)

| ID | Where | Steps | Checks | Mark |
| --- | --- | --- | --- | --- |
| C-01 | Wide | Ctrl/Cmd+click two contacts, Shift+click a range, press Escape, press Delete, use "Set company…". | Selection grows without opening a contact; Escape clears; Delete asks first; the company is written to all selected. | Source (`contacts-page.test.tsx`) |
| C-02 | Wide, Phone | Open Settings → Appearance, General, Mail and Notifications. | Device settings say "Saved on this device"; account settings say they follow the account; the two are not mixed in one row. A setting an administrator fixed is greyed out with "Set by your administrator", never hidden. | Source (`AppearanceSettings.tsx`, `settings-pages.test.tsx`), Open at runtime |

## Baselines and approval

A baseline is an approved picture of a reference screen under the fixed
conditions above. Baselines protect the identity (P-01 to P-05) and the
layout decisions (P-06 to P-09) from quiet drift; they are not a substitute for
the behavioral scenarios.

**Reference screens.** Mail with a message open (Wide), ToDo open view (Wide
and Phone), Recordings library (Phone), Settings → Appearance (Wide), the
composer (Phone), each in Dark Default and Light Default. Twelve pictures in
total; add a screen only when a decision depends on it.

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
