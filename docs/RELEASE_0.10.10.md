# 0.10.10: immediate mail read state and working retries

Read/unread actions update the visible mail list immediately. In Sync mode,
accepted read and star changes stay visible while provider confirmation is
pending, including after a page reload. Message details, filters, unread counts
and account/folder badges use the same pending state. Mail shows a pending label;
failed or conflicting requests fall back to the last confirmed state.

The provider remains authoritative. UniHub sends the targeted IMAP flag request
and reads it back before updating confirmed storage. A full mailbox download is
not required to confirm a flag change, although an active account sync can delay
the write behind its account lock. This release does not change sync scheduling.

The Retry button for failed provider changes now reaches the parameterized API
handler instead of returning 404.

## Why the previous image workflow failed

The workflow for commit `2781d72` stopped in the API test step, before Docker
construction or publication. The mail-filing test distinguished list and detail
queries by looking for `SELECT *`. The pending-state query uses `SELECT emails.*`
and computed flags, so the mock incorrectly applied list-filter assertions to a
detail request. The real MySQL pending-state integration test passed in that run.

The fixture now distinguishes the request by its owner-scoped ID lookup and
returns the computed flag fields. It checks successful responses and flag values
alongside the existing provider-identity assertions. The release workflow runs
the full API suite with disposable MySQL 8 and no skipped checks, frontend tests,
lint/typecheck/build, and container startup/auth/recording smoke checks before
publishing the tested image.

## Updating

Image: `ghcr.io/mrksrus/selfhost-unihub:0.10.10`.

Keep existing volumes, configuration and encryption keys. No new migration or
Docker/YAML change is required relative to 0.10.9. Earlier installations must
still follow the [upgrade guide](UPGRADING.md). Refresh the browser/PWA after
updating the container.

Provider tests use simulated mail-server responses; this release has not been
verified against a live mailbox. Account backup, import and restore remain ALPHA.
