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
twelve pictures in all, compared with zero tolerance:

| Picture | Viewport | Steps |
| --- | --- | --- |
| `mail-reader-wide-*` | Wide | Mail, All accounts, Inbox; open the long-subject message from Grace Hopper (split view with reader). |
| `todo-wide-*`, `todo-phone-*` | Wide, Phone | ToDo, Open view, all lists. |
| `recordings-phone-*` | Phone | Recordings library. |
| `settings-appearance-wide-*` | Wide | Settings → Appearance. |
| `composer-phone-*` | Phone | Mail, Compose (bottom sheet, From focused). |

**Behaviour checks.** These run against the same build and the same data.

| Decision / scenario | Check |
| --- | --- |
| P-07, T-01 | ToDo shows Overdue, Today, Later and No date, every title, the description, the source email with its attachment name and every subtask. No row control except its menu has `aria-expanded`. Rows stay inside the page body's visible width, and the body does not scroll sideways (Wide and Phone). |
| P-07, T-04 (partial) | Recordings rows show title, description, tags and chords; the chords use JetBrains Mono. Nothing folds and nothing is cut off (Phone). |
| P-08, N-03, N-04 (partial) | Wide Mail: "Hide panel" removes the column, moves focus to the scope button and stores `unihub:panel:mail`. The fold survives a reload and a visit to Contacts. Contacts keeps its own panel. The scope button opens the sheet and Escape returns focus to it. "Keep panel open" restores the column and focuses its fold button. |
| P-12, N-05 | Wide Mail: 45 Tab presses cover the rail, then the panel, then the page, in that order. Every stop shows a focus ring (outline or ring shadow) and is on screen. Ctrl+K opens search with its input focused, Escape closes it, and Tab continues afterwards. |
| P-02, A-01 | With the app script held back, the first paint is already black (default) or the stored Light colour, even when the OS prefers the other mode. After start-up, `theme-color` equals the page colour. Settings switches Light (kept after reload), System (follows a live OS change both ways) and Dark (kept after reload against a light OS). |
| P-11, M-10, T-02 | Phone, coarse pointer (asserted). On ToDo, the Mail list, the composer and Recordings: every control in view has a tap area of at least 40 px, counting its `tap-area` pseudo-element. No two neighbouring tap areas overlap; edges that touch along one CSS pixel or less count as touching. Every control is reachable by hit-testing once scrolled into view, so nothing stays under the bottom bar. |
| P-15, B-11 | Phone width at 560 px tall, as with the keyboard open in the Android app: after typing twelve lines in a new message, at least 120 px of the message editor is on screen, counting every clipping box around it and the button bar. Below 44rem of height the composer's fields scroll away with the message; at full height the layout is the approved picture. |

Every test also fails on an uncaught page error, on an `/api` request that has
no fixture, and on any request outside the loopback app and the intercepted
font hosts.

### Known defects in the pinned code

The checks found two violations in the pinned code. A remaining one is listed
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
  source email and subtasks, three recordings with tags and chords, and five
  contacts. Names are made up and addresses use `example.com`, `.net` and `.org`.
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
