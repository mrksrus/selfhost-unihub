# 0.10.11: correct mail flags and responsive interactions

## Fixed

- Mail list, detail and draft responses now explicitly decode database flags.
  MySQL can return computed flags as strings: JavaScript previously interpreted
  `"0"` as true, making unstarred or unread messages appear starred/read even
  though the Starred folder and stored flags were correct.
- Read and star actions keep list/detail caches consistent during a slow request,
  block duplicate submissions, preserve newer edits across stale detail responses,
  and roll back only the failed flag without undoing a concurrent successful edit.
- Accepted queued changes remain visible until provider settlement; pending UI
  distinguishes saving the request from waiting for the mail provider. An unstarred
  message leaves the Starred list without losing its open reader.
- Failed bulk flag actions show an error. A rejected bulk read no longer looks
  applied, even if the subsequent list refresh also fails.
- Provider-writeback polling no longer invalidates itself after every poll.
- A busy account rejects competing mutations/retries immediately with HTTP 409
  before queuing a write. No delayed action is applied after that rejection.
- IMAP has a 60-second socket inactivity timeout and 120-second per-command
  deadline, rather than a whole-import deadline. Cancellation closes stalled
  transport; account locks are retained through cleanup and durable outcome
  handling so another writer cannot race an uncertain provider result.

## Behavior and limits

This does not rewrite stored mail flags, change account modes, shorten successful
large imports to two minutes, or upload historical local flags. The provider stays
authoritative in Sync mode. A busy-account error means nothing was changed: retry
when syncing or the other operation finishes. This release does not permit
simultaneous provider mutations on the same account. Connection/authentication
cancellation can still await its handshake/socket timeout; arbitrary database
stalls are not covered by the IMAP command deadline.

## Validation

Before publication, the full frontend suite passed **113 tests**; TypeScript and
lint passed (three existing unrelated Fast Refresh warnings). The complete API
release gate passed **372 tests with no skips** using disposable MySQL 8 and
Node 24 containers on an isolated network, without production data or mounts.
Coverage includes MySQL string-valued flags, pending/confirmed state, rollback,
filters/counts, ownership isolation, stalled IMAP cancellation and slow UI actions.

The release workflow additionally requires frontend checks, the zero-skip MySQL
API gate, production image build, and container startup/authentication/recording/
backup smoke checks before publishing the tested image. Provider-write tests use
simulated mail servers; no live mailbox mutation was used as a release test.

## Updating

Image: `ghcr.io/mrksrus/selfhost-unihub:0.10.11`.

Keep existing volumes, settings and encryption keys. No new schema migration or
Compose change is required relative to 0.10.10. Earlier installations still need
the [upgrade guide](UPGRADING.md). Retain a consistent database/uploads/config
backup, then refresh the browser/PWA after updating the container.

Account backup, import and restore remain ALPHA.
