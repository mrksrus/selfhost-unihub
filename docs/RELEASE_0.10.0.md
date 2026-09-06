# UniHub 0.10.0

This release adds a black, white and blue appearance, server-driven Web Push, opt-in offline reading, and a focused mail/state refactor.

## Changes

- Dark mode defaults to black backgrounds, white text and blue accents. Light/System remain available in Settings. HTML mail has a dark reading view and an explicit original-format option.
- Notifications use persistent encrypted VAPID keys, per-device subscriptions, a transactional outbox, retries and service-worker delivery. Calendar reminders survive restarts and revalidate edits/cancellations and restores. Notification links open the specific item. Enable and test notifications in Settings.
- Offline reading saves the latest 100 full non-draft emails across accounts, all contacts and calendar entries in a bounded 32 MiB snapshot. The offline view is read-only; attachments remain online. Snapshot ownership and clearing are enforced across tabs and in-flight requests.
- Private query state is isolated per signed-in user. Generic service-worker API caches are removed. Temporary network errors and confirmed session revocation are handled separately.
- Routes and games load lazily. The main production JavaScript bundle decreased from 1,061.79 kB (310.01 kB gzip) to approximately 610.92 kB (196.21 kB gzip). Service-worker precaching still downloads the offline-capable chunks during installation.
- Mail search is debounced and cancellable; stale reader responses cannot reopen or replace a later selection. Shared query invalidation refreshes lists, counts and dashboard previews.
- Backup status polling runs only for active jobs in the active tab. Contact pagination no longer silently stops at 2,000 records.
- Default folder creation preserves renamed/reordered system folders. A 1,000-message routing fixture now uses three SQL calls to load its folder/rule context instead of 11,000 repeated calls.
- Draft replacements and imported attachment metadata commit atomically. Per-folder IMAP UID/UIDVALIDITY progress preserves retryability, including new folders and incomplete imports. Attachment downloads stream from disk; request parsing preserves split UTF-8 characters and rejects invalid JSON.
- Builds now enforce TypeScript checking. Node 24 is used in both Docker stages and CI. Image publication is gated by tests and a container smoke test.

## Upgrade

**0.9.23.0 is the checked upgrade baseline.** The changes are designed for an in-place upgrade using the existing database, uploads and keys. The subsequent 0.10.1 validation adds a populated 0.9.23.0 schema migration/restart test; earlier 0.9.x versions and locally modified schemas are not all runtime-verified. Rehearse those upgrades on an isolated copy first. See the [upgrade guide](UPGRADING.md) for the procedure and exact validation scope.

**Keep a matching pre-upgrade database/uploads/configuration backup. An image-only downgrade is not a verified rollback path.** Preserve the Compose project/volume mappings and encryption keys; changing them can make data appear missing or credentials unreadable.

Volumes and required environment variables remain unchanged. MySQL readiness now allows up to five minutes (300 seconds) for slower hosts, and startup continues immediately after an authenticated check succeeds. The probe uses the same driver and DATABASE_URL/MYSQL_* configuration as the API. The application image and supplied Compose health checks allow 360 seconds for startup. Update older Compose files that explicitly set a 120-second readiness budget or shorter health-check grace period; pulling the image alone cannot override an explicit Compose environment setting. Custom timing overrides remain supported.

Database migrations are additive. Keep a backup of the database and uploads before upgrading, and retain the existing ENCRYPTION_KEY: it also protects the deployment's new Web Push private key.

The first mail sync after upgrading revalidates existing imports and establishes per-folder progress, so it can take longer. Historical first imports and UIDVALIDITY resets do not send a flood of notifications. Existing calendar colors are preserved.

After upgrading over HTTPS, open Settings and enable notifications on each device. Test once with the PWA minimized. Mail discovery still follows the server's roughly ten-minute IMAP sync interval. Browser permission, OS settings and connectivity affect delivery; closed-app alarms while completely offline require native scheduling.

Enable Offline reading separately on each device, and wait for the saved timestamp. App updates prompt before reload so you can save edits first.

See [PWA notifications](PWA.md), [Offline reading and appearance](OFFLINE.md), and [Mail sync](MAIL_SYNC.md).

## Validation

The refactor is covered by frontend state/lifecycle tests and API regression tests, including optional MySQL tests. CI uses MySQL 8 for real SQL, production schema initialization/reinitialization, stable encrypted VAPID identity and session-revocation cascades. A built-container smoke test checks Node 24, Nginx/API health, authentication/CSRF, isolated recording storage, byte/range downloads, MP3 conversion and cleanup before publication.

The black/blue sign-in layout was checked at desktop and phone widths. A real two-tab service-worker update test confirmed that the requesting tab refreshes while the other retains its unsaved input and can refresh later. Actual minimized/locked-screen delivery still needs verification on the intended phone/browser; CI does not simulate its OS policies.
