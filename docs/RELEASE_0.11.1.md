# 0.11.1: maintenance and a non-root API

Mostly internal cleanup after 0.11.0, plus one deployment change: the API no longer runs as root.

**Back up MySQL and uploads before updating.** Migration 9 runs on startup.

### Security

- **The API no longer runs as root in the container.** The Node API runs as the
  `unihub` user (uid/gid 10001) without capabilities; Nginx is unchanged. The
  first start after updating hands `/app/uploads` over to that user. If you
  bind-mount uploads from the host, it must be writable by uid 10001. See
  [upgrading](UPGRADING.md#0111-non-root-api).

### Fixes

- **Retried mail actions no longer fail on a database deadlock.** Two identical
  requests with the same `Idempotency-Key` (for example a move or read change
  resent after a slow response) could deadlock and one of them failed. The
  second request now waits and returns the first one's result.
- **Correct due times on MySQL servers not set to UTC.** The API now switches
  every database connection to UTC. Before, a MySQL server with a different
  default time zone shifted scheduled work, expiries and timestamps by hours.

### Maintenance

- Removed the retired pre-0.11 mail sync code and other unused mail helpers.
- Mail has one job runner. Read/star/move changes now run on the same durable
  scheduler as sync instead of a separate in-process queue. One worker slot is
  kept free for these changes, so a click starts right away even while other
  accounts are syncing long folders.
- Split the three largest API files (mail service, mail routes, backup service)
  into smaller modules by area. No behavior change.
- Upgraded pre-0.9.23 installations now get the same calendar colour default as
  fresh installs (migration 9).
- `docker/mysql/init/01-schema.sql` is generated from the app's own upgrades
  (`scripts/local-mysql.sh schema-dump`) and checked by a MySQL test; the legacy
  baseline upgrade is frozen and every schema change is a numbered migration.
- Frontend: strict TypeScript, and unused pages, UI components and 18 packages
  removed.
- Development: an on-demand local MySQL 8.4 (`scripts/local-mysql.sh`, nothing runs
  at boot) and deterministic sample data (`npm run db:dev`). See
  [development](DEVELOPMENT.md#local-mysql-and-sample-data).
- Release notes are collected in this changelog.
