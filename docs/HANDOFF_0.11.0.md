# 0.11.0 implementation handoff

Work stopped at the owner's request on 2026-09-30. This branch preserves the implementation for review and continuation by another developer. **It is not a published release or an accepted live deployment.** Package versions are 0.11.0, but no v0.11.0 release tag or production upgrade was made.

## Implementation included

- Durable mail jobs, account leases/fencing, command receipts, operation attempts and reconciliation.
- Bounded recent/history/flags/presence/body streams and separate logical items/mailbox occurrences.
- Provider-confirmed flags and native MOVE, including interrupted/unknown-outcome handling without blind MOVE replay.
- Optimistic, nonblocking mail UI with distinct accepted/pending/confirmed/attention-required states.
- Retention-aware disconnect/reconnect, backup schema 4 and quarantined restored provider evidence.
- Operator-controlled account canary holds via `api/mail-rollout.js`.
- Additive database migrations, including migration 8 for durable manual-refresh intent.
- Regression tests and draft upgrade, mail-mode, backup and release documentation.

## Established verification

The last full application source snapshot was built and tested before this documentation-only handoff was added:

| Check | Result / boundary |
| --- | --- |
| Full backend with disposable real MySQL | **522 passed, 0 failed, 0 skipped** |
| Frontend Vitest | **138 passed**; frontend source unchanged by the final backend fix |
| TypeScript | Passed |
| ESLint after final backend fix | Passed, zero errors; three existing Fast Refresh warnings in `src/hooks/use-note-draft.tsx` |
| Production Dockerfile | Built successfully; runtime package version 0.11.0 |
| Isolated container smoke | Auth, HTTP, backup/restore and packaged audio checks passed |
| Authorized real IMAP/SMTP fixture + browser | Incoming delivery/import, reader, read/star/reversals, external-client flags followed by manual Sync, MOVE out/back and rendered states passed |
| Provider operation/byte checks | Ten operations `done/confirmed`; identical original message bytes across MOVE out/back; source absence independently verified |
| Responsiveness | Flag/MOVE API acceptance 13–45 ms; optimistic UI and opening Compose while a real HTTP request was held: 444 ms. Cold Sync acceptance 2011 ms. Single-run observations, not an SLA |
| Synthetic S30 rollback | Actual schema-4 export/restore plus unmodified 0.10.12 writer: journal/raw bytes preserved, unresolved evidence quarantined, zero old-writer provider calls |

The exact tested image was `sha256:e9a6c56b63e615e2901a996f741b21ecf9541604f45f9bcdbd5e359ccf919277`. Its source archive SHA-256 was `80bc85c7dfc399d218247f95ea754d725959c710703f924ed670572029619fdb`; the separate backend-gate archive contained the same 489 files. These are private candidate identifiers, not a published registry release.

### Failure found and fixed during acceptance

External read/star changes originally failed to refresh after manual Sync because the completed-sweep 15-minute background throttle also applied to manual requests. The fix persists manual-refresh intent through durable jobs, refreshes completed sweeps immediately, preserves unfinished finite-window progress, and keeps periodic throttling. The formerly failing real-provider scenario subsequently passed. Historical failed runs were retained; no production queue was cleared to manufacture a pass.

## Not completed

- Final release-note/support-matrix review, release publication and tagged release-image validation.
- Production backup, migration, canary rollout, remaining account rollout, and post-deployment provider/browser acceptance.
- Final parent review of the site-specific TrueNAS deployment launcher. Its deployment entry point remains explicitly disabled.
- A full real-provider production rollback. S30 used synthetic completed/unknown journal evidence; it is not that stronger test.
- A universal provider/performance claim. Real-provider acceptance covered the authorized generic/Stalwart fixture; controlled protocol/MySQL tests are not live Gmail or Bridge certification.

No live update was performed. The last inspected deployment was v0.10.12 at commit `422ae1417caa330a249fd9abc067b94123ac7d54`.

## Deployment finding and private artifacts

Installed TrueNAS `app.stop` uses Docker Compose **down**, which removes containers and normally the project network. Do not assume a retained MySQL container can simply be restarted. The private launcher was revised to recreate only the pinned database service before offline migration/hold installation. An isolated lifecycle artifact reports successful DB-only recreation, five synthetic accounts/four holds, and a journal-containing dump; this final revision was **not accepted for production before the stop request**. Keep its execution block in place until reviewed.

Server-specific scripts, credentials/integration references, private logs, screenshots and provider fixture data were deliberately not copied into this repository. They remain in the operator workspace:

- `/opt/data/projects/unihub-ops/implementation-0.11.0/CANDIDATE-ACCEPTANCE-RESULT.md`
- `candidate-runner/` under the same directory: private API/browser/provider runner and passing `unihub-smoke-candidate-e5713da9aafb` evidence.
- `rollback-rehearsal/`: S30 runner and passing `unihub-s30-20260930t082038z-dbd7d8ed` evidence.
- `deployment/`: guarded launcher, runbook, offline tests and `rehearsal-evidence.json`.
- `/opt/data/projects/unihub-ops/planning/sync-redesign-20260929/UNIHUB-SYNC-REDESIGN-PLAN.md`: approved design and acceptance matrix.

## Safety boundaries to preserve

Do not discard existing pending operations or conflicts. Never blindly replay an ambiguous provider MOVE. Preserve the newer operation journal and actual provider effects before restoring an older database; an image-only downgrade is not rollback. Stop/drain provider writers, keep restored work quarantined, and restore only application-specific paths rather than whole shared datasets. Do not restart unrelated proxy/mail services for this upgrade.

Read `UPGRADING.md`, `BACKUP_FORMAT.md`, `MAIL_MODES.md` and the draft `RELEASE_0.11.0.md`. The repository license remains PolyForm Noncommercial 1.0.0; it was not relicensed as OSI-approved open source.
