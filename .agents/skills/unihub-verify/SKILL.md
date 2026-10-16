---
name: unihub-verify
description: Choose and run the UniHub checks a change needs before it is accepted, or the full release contract before a UniHub release, and report what ran, what failed and what could not run.
---

# Verify a UniHub change or release

Work from the candidate commit. Read `AGENTS.md` (Working and verification)
and, for a release, `docs/RELEASE_CONTRACT.md`. Use synthetic data and
disposable databases only; never point a check at a live server, database or
uploads.

## A change

Pick checks by what the change touches; run every row that applies.

| Change touches | Run |
| --- | --- |
| Any API code | `npm --prefix api run build`, the focused `node --test api/tests/<file>.test.cts` |
| SQL, migrations, stored data, backup/restore, data inventory | `scripts/local-db.sh test api/tests/<file>-mysql-integration.test.cts`, `npm --prefix api run test:recovery` against an empty `_test` database, then `node scripts/recovery-fresh-install.mts --local` |
| A new recovery section, table or file kind | the above; extend `api/tests/helpers/fresh-install-seed.cts` and the comparison in `scripts/recovery-fresh-install.mts` (the check fails until you do) |
| Auth, sessions, CSRF, request boundary | the auth/request/login-limit tests named in `AGENTS.md`, and `node scripts/pwa-update-check.mts --local` (two tabs, one session) |
| Service worker, `vite.config.ts` PWA settings, update notice, offline | `npm run build`, `node scripts/pwa-update-check.mts --local`, and with `--old <each earlier release in android/support-window.json> --new dist` |
| Frontend UI | `npm run typecheck`, `npm run lint`, focused `npm test -- src/test/<file>.test.tsx`, `npm --prefix tools/ui-regression run verify` (setup in `docs/UI_BASELINES.md`), and relevant acceptance scenarios outside its coverage |
| Email rendering | `node scripts/email-privacy-browser-check.mts` and the safe-email tests |
| `android/`, `src/lib/platform.ts`, `api/src/services/app-version.ts` | `node scripts/android-support-window.mts`; on an emulator `android/scripts/launch-test.sh` and `android/scripts/window-test.sh` (see `docs/ANDROID_COMPATIBILITY.md`) |
| Dockerfile, `docker/`, start-up | `npm --prefix api run test:ci` with a disposable database, then CI (`scripts/container-smoke.sh`, `--image` runs) |
| Documentation only | links, paths and the diff; no application run |

A `--local` run needs `npm --prefix api run build`, the MariaDB tarball
(`UNIHUB_DB_HOME`, default `~/.local/opt/mariadb-11.8`) and `bwrap`. If a
prerequisite is missing, report the check as not run with the reason; do not
substitute a weaker check silently.

## A release

Run or confirm, for the exact commit, every row of the release contract. The
CI workflow `.github/workflows/docker-image.yml` must be green on that commit.
Also complete the contract's required acceptance beyond CI, especially actual
Android/server pairings and any cross-version data upgrade/import checks.
These are currently manual gates. Missing evidence blocks release even when
CI is green. Before tagging, run real-phone/provider checks relevant to the
change and label their evidence separately.

When the version changes, update `android/support-window.json` first (this
version and the three releases before it), or the Android window check fails.

## Report

For each check: command, where it ran (local, CI run link, emulator, phone),
result, and for failures the first failing assertion. List checks that did not
run and why. Keep source review, local tests, CI, browser, emulator and
real-device results apart. Never turn a missing or skipped check into a pass.
