# Code review

Part of the [agent guide](../../AGENTS.md). Read it before reviewing a change, and before briefing a reviewer.

## What blocks, and the shape of a review

Maintainer's rules of 2026-11-15 ([P-42](../../PROJECT-PREFERENCES.md#p-42-small-parts-a-blocking-bar-for-reviews-one-test-layer-per-behaviour)). From 0.23.0 to 0.30.0, review rounds after the second found no new major defect, and about half of their findings were defects made by the previous round's fix; the defects that shipped were caught by executed tests.

- **A finding blocks** only when you show a trigger in the changed code that an ordinary user action, a background job, a realistic crash or a network loss can reach on the supported deployment (one app container, one API process, MariaDB), and the result is lost or exposed data, a security hole, a broken user flow or a failing required check. Name the trigger and the result.
- **It does not block** when it needs a held request, a second API process, crafted input or a misbehaving server and you have not reproduced it; when it is wording, test style or documentation detail; or when it asks for more tests of code the change did not touch. Report these as notes.
- **Required of new work.** The [Roadmap fit](#roadmap-fit) items are required checks, so they block when new work in the change lacks them: a feature outside the version's scope, a table without its declarations, a destructive route without a policy key, a sharing check outside the access service, a missing three-person test, a second implementation of an existing foundation.
- **Older defects.** A defect the released version already has never blocks. List it for the maintainer with a recommendation; it does not become a patch release by itself.
- **Scope.** Review the changed behaviour and its callers. Do not audit the rest of the application unless the brief asks for an audit.
- **Round one is deep.** Walk the changed user flows end to end. Check each accepted "only X may Y" rule in every place that can act: routes, workers, notifications, live streams, offline copies. Run the new tests and the focused database tests yourself. Give the verdict on a candidate whose CI is green. "Ready" with a blocker open is "not ready".
- **Round two is narrow.** Read only the fix diff and its callers. For each fix, ask whether it added a state, counter, lock, wrapper or option, and whether a smaller fix or a revert would do.
- **Two rounds at most** per pull request or separately reviewed part, then the finisher (`babysit` skill). Test tooling, CI changes and documentation get one round.
- **A review fix stays small.** It does the least that removes its finding and adds no table, migration, queue, lock layer, route, state or option unless the integration owner decides nothing smaller works.
- **Verdict.** End with "Ready" or "Not ready" for the commit, the blockers with file and line, then the notes.

## Review rules by area

Review the changed behavior through its callers, workers, database writes and recovery paths. Apply these rules to relevant changes; do not turn a small PR into an unrelated refactor. Prioritize exploitable security failures and irreversible data loss, then correctness and concrete maintenance costs. For each finding, cite the narrowest affected lines and explain the trigger, impact and missing guard. Check existing safeguards before reporting; distinguish demonstrated behavior from an unverified risk. Follow SECURITY.md for private vulnerability reporting and use synthetic examples.

Every review must end with an explicit verdict for the reviewed commit. When nothing needs fixing, say so in a review comment, for example "No issues found in <commit>.", rather than staying silent, so whoever waits on the review knows it is finished.

### Access and secrets

- Trace user ownership through IDs, parent/child relationships, joins, bulk operations, files, job polling, downloads and SSE. Check with two users; an owned parent does not make an arbitrary child ID safe. Admin routes also need a server-side role check.
- Check authentication, CSRF, body limits and module/restore gates at the request boundary and before service side effects. Test disabled modules and active restores, including Mail-prefixed calendar routes. Background work must recheck applicable permissions after waits or retries.
- Preserve session revocation and single-use login challenges/recovery codes under concurrency. Do not trust forwarded client IPs beyond configured proxy hops or expand public/CSRF exceptions without a concrete reason and a boundary test.
- Credentials, ICS subscription URLs, push endpoints, archive unlock keys and raw provider errors can contain secrets. Check API serialization, logs, notifications, exports and browser storage; keep stored credentials encrypted and use allowlisted public fields. Intentional encrypted credential backup must follow the recovery policy.

### Untrusted input and network access

- Validate mail, CalDAV, ICS, discovery and restored connection targets through the existing network policy. Check every redirect and DNS-resolved connection, including IPv6/private addresses; retain the original TLS hostname. TRUSTED_MAIL_HOSTS permits explicit network exceptions, not blanket TLS bypass. Preserve the existing user-confirmed mail trust policy; CalDAV/ICS require HTTPS and certificate verification. CalDAV credentials may only follow a confirmed origin or the configured built-in provider scope.
- Treat email HTML, calendar data, backup archives and uploaded filenames as untrusted. Preserve inert email sanitization and restricted iframe/CSP. Remote-image consent resets on leaving a message, including A -> B -> A; changing the display format must not grant consent. Review path traversal, symlinks, archive expansion limits, bounded parsing/recurrence, stream size/time limits and subprocess argument handling where applicable.
- File and recording changes must preserve original bytes, ownership and storage-root checks, bounded chunk uploads/conversion, Range validators and disconnect cleanup. Keep streaming downloads outside service-worker interception. Failed conversion must leave the original recording available.

### Synchronization and recovery

- Distinguish a verified remote deletion from an incomplete listing, parse failure or transport error. Keep last known-good data on failure; do not advance ETags, checkpoints or successful status before the corresponding work is safely stored. Preserve local ToDo state and subtasks when occurrences remain valid.
- Check writeback identity, read-only providers and conflict handling before mutation. CalDAV writes must respect ETags and recurrence scope; missing restored/legacy remote links must not silently fall back to local-only edits or deletes. Account links need explicit provenance, not email equality alone. Inspect partial failure of cross-calendar moves and retries for duplicates or data loss.
- Preserve mail mode, UID/UIDVALIDITY identity, account locking, cancellation and provider-deletion opt-in. Distinguish accepted intent from confirmed provider state. Accepted jobs/intents and pending UI state must survive retries or recover predictably; a lost connection does not prove a remote operation failed. A dispatched IMAP MOVE must reconcile its outcome without sending the MOVE again. Restore must not replay destructive provider operations.
- For persisted-data changes, review migrations, backup-catalog field policies, data-inventory coverage, mail-engine/recovery-policy.ts, owner-safe ID remapping and credentials together. Stage files before writes; clean replaced files only after a known commit, and retain staged files while a commit outcome is uncertain. Restore must not resurrect sessions, push credentials or installation-local worker leases. Keep archive versions distinct from database migration IDs; preserve historical fixtures. Respect section locks and retired-module handling; test old archives as well as new round trips. Confirm older documentation against the current catalog and format readers when they disagree.

### Roadmap fit

- Check that a change is in the current version's scope or fixes a bug in existing behaviour; a feature outside the version is a finding, not a bonus.
- Check new work against [Building toward 1.0](building-toward-1.0.md). Report these as findings:
  - a table without its declarations
  - a destructive route without a policy key
  - a sharing check outside the access service
  - a missing three-person test
  - a second implementation of an existing foundation

### Browser state and maintainability

- Check account switches, sign-out, expired sessions, module pauses and reconnects for private-data leaks through React Query, IndexedDB, delayed responses, SSE and push messages. Only transport failure may fall back to saved offline identity; 401/403 or server errors must not. Keep offline writes disabled and service-worker caches free of private API/download responses; notification links must stay on the application origin and load owned records.
- Keep HTTP handling in the request boundary/routes, domain behavior in services and browser requests in existing API helpers. Flag duplicated security policy, hidden mutable state, unbounded work or inconsistent error/pending states only when they cause a concrete failure or maintenance cost. Prefer a focused regression test over a speculative abstraction; leave formatting and lint checks to tooling.
