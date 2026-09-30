# 0.10.12: working provider writes and independent mail jobs

## Fixed

- Correct conditional IMAP flag commands. The pinned `imap@0.8.19` library
  omitted the parentheses around `UNCHANGEDSINCE`, causing real servers to reject
  read/star updates. A narrow, version-checked protocol adapter sends the correct
  single-UID flag delta and treats tagged `MODIFIED` responses as conflicts. It
  does not remove conflict checks or replace all of a message's flags.
- Mail sync is queued per account instead of treating any account's active sync
  as completion for everyone else. The API acknowledges acceptance promptly;
  owner-scoped status reports queued/running/progress/finished/error/cancelled
  states. At most two complete account syncs run concurrently.
- Read/star/move intents are accepted in a short database transaction rather
  than waiting for an account's entire provider scan. Provider commands remain
  serialized per account. Opposite flag intents are protected from stale worker
  completions; bulk acceptance retains all-or-nothing validation.
- An independent due-work pass runs at startup and every 30 seconds. Both direct
  and scheduled writebacks share a four-connection bound. Accounts waiting for
  sync do not consume independent provider-worker slots.
- Long syncs service accepted provider changes at safe checkpoints. A move
  invalidates and restarts the snapshot instead of applying stale location data;
  flags are read again before committing confirmed metadata.
- Verified, unambiguous new messages are imported during the scan, so later
  inventory churn does not discard their progress. Adjacent body reads reuse
  the selected folder; a bounded cache avoids duplicate reads where safe.
- The browser no longer says “Sync complete” for a queued or already-running
  request. Progress and cancellation are account-scoped. Other messages, views
  and accounts remain usable while a request/provider job is active.
- Background jobs are discovered without a reload; status polling recovers from
  temporary errors. Mail lists refresh during progressing imports at a bounded
  cadence without repeatedly refreshing the open reader or all other queries.
- Bulk actions deduplicate matching requests, preserve newer flag edits, and
  distinguish provider-pending acceptance from an actual failure.

## Safety and limits

No queue reset, account-mode change, historical flag upload, new schema migration,
volume, secret, or Compose change is required relative to 0.10.11. Existing
**pending** user intents can resume through the due worker. Failed/conflicting
operations still need review; uncertain provider moves are not blindly replayed.

Network confirmation is necessarily asynchronous: immediate UI feedback means
an intent was accepted, not that a disconnected provider has already applied it.
Busy job pools show queued work instead of pretending it completed. Reconciliation
of location/missing state is deliberately deferred if a complete consistent
inventory cannot be established; verified new imports remain saved. A continually
changing mailbox can therefore still report a reconciliation error.

The protocol adapter intentionally fails closed if its pinned IMAP dependency
changes. Dependency upgrades must rerun the actual-wire regression tests and
review the adapter. Providers without safe IMAP MOVE retain the existing safe
failure behavior; there is no unsafe COPY/EXPUNGE fallback.

## Validation and reproducibility

Before publication, **124 frontend tests** passed, along with TypeScript and lint
(zero errors; three existing unrelated Fast Refresh warnings). The API release
gate passed **394 tests with zero skips** against disposable MySQL 8 and Node 24.
The production Dockerfile also built successfully and reported version 0.10.12.
The publication workflow additionally requires container smoke checks before
pushing the tested image.

The IMAP regressions use the installed library over a local protocol peer, rather
than only mocking `addFlagsSince`/`delFlagsSince` method calls.

The opt-in [live mail acceptance test](LIVE_MAIL_TESTING.md) uses normal public
API authentication/actions plus independent IMAP readback. It tests delivery,
incoming sync/content, prompt actions, rapid reversals, incoming external-client
changes, folder creation and moves with exact body preservation. A pending UI
flag or successful HTTP response alone cannot pass the test. Use a dedicated test
mailbox; this is not automatically run against an operator's personal messages.

A passing test on one provider is not a guarantee for all providers or networks.
Account backup/import/restore remain ALPHA.

## Updating

Image: `ghcr.io/mrksrus/selfhost-unihub:0.10.12`.

Keep a consistent database/uploads/configuration backup and existing encryption
keys. Follow [Upgrading](UPGRADING.md) for older installations. Refresh the browser
or PWA after installing the new image so its UI and API contract match.
