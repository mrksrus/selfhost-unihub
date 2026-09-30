# UniHub 0.11.0 — release candidate

**Not yet a published release.** This working tree is undergoing the pre-push and provider/browser acceptance gates. Package version numbers alone do not indicate deployment or acceptance.

## What changes

- Durable, owner-scoped mail intentions and idempotent request receipts separate prompt API acceptance from provider confirmation. Explicit states and optimistic overlays replace long request-bound writes.
- Bounded, resumable discovery, body and flag/presence work use account fencing and durable jobs. Interactive changes can yield read-only background work. Cancelling a scan does not discard accepted provider changes.
- Logical items are separate from mailbox occurrences. Provider-stable Gmail identity can represent multiple labels without collapsing ordinary IMAP copies by Message-ID or body hash. Exact mailbox names and UIDVALIDITY remain part of the addressing rules.
- MOVE records dispatch before wire transmission. Native MOVE/COPYUID evidence can reconcile after a lost reply, scan-first race or worker restart without submitting a second MOVE. Unprovable outcomes remain attention-required.
- Disconnect retains local data and the operation journal; destructive local purge is separately confirmed and guarded. Explicit validated reconnect does not replay restored mutation jobs.
- Backup schema 4 preserves new mail state and quarantines imported provider evidence. Old supported backup formats remain readable. Older applications cannot read new schema-4 archives.
- Raw-message completion and provenance are distinct from header discovery. Legacy archives are retained, not automatically relabelled byte-verified.

## Validation boundary

Completed isolated checks include real-MySQL migration interruption/restart, restore/reconnect, occurrence-backed folder views, conflicting-write rollback, durable receipts, and selective foreground/background resume. Installed IMAP-library tests against a controlled wire peer and real MySQL cover a held acknowledgement, lost acknowledgement, actual worker SIGKILL after the provider effect, missing COPYUID, scan-first settlement and lease-expiry recovery. They assert that MOVE is not replayed.

These are regression and protocol gates, **not substitutes for real-provider and rendered-browser acceptance**. Final full-suite/build results, the backup/rollback rehearsal, candidate provider/browser checks, release publication and live deployment acceptance remain release gates. This document must be finalized from those results before publishing 0.11.0.

## Compatibility and limits

- Native IMAP MOVE is required. There is no COPY/EXPUNGE fallback or arbitrary permanent provider deletion.
- Missing/invalid COPYUID, uncertain identity, changed UIDVALIDITY or unknown historical operations may require attention. A matching body or Message-ID alone cannot authorize merging copies or declare a remote move successful.
- CONDSTORE support is provider-dependent. Without it, changes made by another client between a read and write cannot be made atomic.
- Header visibility is not proof of a complete body/archive. Discovery or a partial sweep does not prove provider absence.
- Existing user pending work and genuine conflicts must not be cleared to pass acceptance tests.
- No additional database service or upload volume, or replacement provider credentials/deployment secrets, are required solely for this version. Database schema migrations are required.

Read [upgrading](UPGRADING.md), [mail modes](MAIL_MODES.md) and [backup compatibility](BACKUP_FORMAT.md) before updating. Keep a consistent database/uploads/configuration backup and the previous image. An image-only downgrade cannot undo provider effects; preserve the newer operation journal and keep old provider writers disabled during a recovery.
