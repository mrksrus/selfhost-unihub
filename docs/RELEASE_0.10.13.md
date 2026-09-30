# 0.10.13: durable mail engine preview

This release ships the new durable mail engine planned for 0.11.0, plus review
fixes. 0.11.0 follows once the UI and stability work in
[the roadmap](ROADMAP_0.11.0.md) (P2) is done. The engine itself is described in
[the 0.11.0 notes](RELEASE_0.11.0.md).

**Back up MySQL and uploads before updating.** Database migrations run on
startup and cannot be undone by switching back to an older image. Backups made by
this version use data schema 4, which 0.10.12 and older cannot read.

## Changed

- Mail changes (read, star, move) are durable operations with explicit
  accepted / pending / confirmed / needs-attention states. A move that may have
  reached the provider is never sent twice.
- Mail sync runs as bounded, resumable jobs per folder and stream instead of one
  long scan per account.
- One IMAP session per account is reused between jobs, bulk changes run in
  batches of up to 50 on one connection, and the periodic wake-up only follows
  INBOX every 30 seconds. Full folder discovery runs at most every 5 minutes.
- The bundled `docker-compose.yml` uses MySQL 8.4 LTS. Switch the database image
  as a separate step after the application update; see [upgrading](UPGRADING.md).
  Comments in the file list the image tag and pull policy options.

## Fixed

- Stuck operations: every state has a working Retry or Discard, and the due-work
  pass backs off per operation (15 s up to 1 h) instead of retrying every second.
- The Mail background setting is respected and no longer cleared by a single
  foreground action.
- Follow-up syncs after a change are no longer treated as manual refreshes.
- Operator canary holds can only be released with `mail-rollout.js release`.

## Known limits

- A move that was sent but whose outcome cannot be proven stays in
  needs-attention and cannot be discarded yet.
- Native IMAP MOVE is required for provider moves.
