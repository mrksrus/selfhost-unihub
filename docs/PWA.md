# Installation, notifications, and offline access

UniHub uses Web Push for new unread mail, new calendar/to-do items, and calendar reminders. The API sends notifications through the device browser's push service. The page does not need to remain open while the device has connectivity and allows notifications.

## Enable notifications

1. Open UniHub over HTTPS. On iPhone/iPad, add it to the Home Screen and launch that installed app.
2. Sign in, open Settings, and select **Enable notifications**. Grant the browser permission.
3. Select **Test notification**, minimize UniHub, and check that the notification arrives. Test on the actual devices you intend to use.

Enabling notifications applies to this browser/device and account. Signing out revokes that device subscription. Session expiry, revoked browser permission, browser data removal, or an expired push subscription may require signing in and enabling notifications again. Device Focus settings, force-stopping the browser, lack of connectivity, and platform restrictions can delay or prevent delivery.

Mail notifications follow successful IMAP ingestion. The server checks mail approximately every ten minutes; Web Push does not make that discovery instantaneous. First account/folder imports and UIDVALIDITY resets establish a baseline without notifying every historical message. Already-read messages, drafts, sent mail, trash, and archive do not generate alerts.

The server checks due calendar reminders every 30 seconds. It persists delivery state, retries transient push failures, and catches up within a two-hour reminder window after restart. Edited, deleted, hidden, done, or cancelled events are rechecked before delivery. Recurrence retains the calendar's existing behavior: notifications concern stored event occurrences; this change does not introduce recurrence expansion.

## Server configuration and persistence

No new container, exposed port, volume, or required environment variable is needed. The API stores subscriptions, its outbox, and reminder schedules in the existing MySQL database. It generates one VAPID key pair and stores the private key encrypted using the existing `ENCRYPTION_KEY` in a dedicated `notification_config` table. Container rebuilds and restarts retain the keys; do not rotate `ENCRYPTION_KEY` or delete the notification tables casually.

The VAPID contact defaults to the first administrator's email when the keys are generated. `WEB_PUSH_SUBJECT` can optionally supply a contact URI before first initialization. The private key is never exposed by the frontend configuration endpoint.

Outbound HTTPS/DNS must permit browser push services. Accepted subscription hosts belong to Google FCM, Mozilla, Microsoft WNS, and Apple; arbitrary or private-network endpoints are rejected. The server validates resolved public addresses at connection time. The browser connection to its push service is managed by the browser/OS.

Device subscriptions are tied to authenticated database sessions. Session deletion cascades to subscription and delivery deletion. Account exports are not intended to transfer active device subscriptions or server VAPID identity to another installation. After moving an account to a different server, enable notifications there. Infrastructure database backups preserve the deployment's notification configuration.

## Delivery and retry behavior

Mail ingestion commits the new message and notification outbox together. Calendar creation similarly commits the event, attendees, and notification event together. A database lock prevents concurrent API instances from running overlapping notification jobs. Delivery IDs and per-device delivery records make enqueueing idempotent; the worker also retains a bounded per-user deduplication store. Failed displays are not marked delivered.

Temporary sender/network failures retry with exponential delay, bounded to eight attempts. Expired endpoints are removed. The server can report that the push service accepted a message; it cannot guarantee that the user saw it. A rare crash after push acceptance but before saving the acknowledgement can result in a retry, which the worker deduplicates.

Legacy periodic notification checks are retired. They were browser-scheduled refresh opportunities, not reliable five-minute alarm timers. Existing private API caches are removed when the new worker activates. Authentication responses and private API GETs use the network; deliberate offline snapshots are a separate feature.

## Offline limits

Optional offline snapshots make selected content readable when the API is unavailable. Reading cached event data does not give a PWA a continuously running alarm scheduler. UniHub can attempt local reminders while an offline page remains alive, and the server can deliver pending push notifications when connectivity returns within their lifetime. Closed-app reminders that must fire while completely offline require native device scheduling; an Android browser wrapper alone does not supply it.

## Verification

Run `node --test api/tests/notifications.test.js api/tests/notification-worker.test.js`. The optional `notifications-mysql-integration.test.js` runs when `MYSQL_TEST_HOST` and the usual `MYSQL_TEST_*` settings are provided. It uses connection-local temporary tables to test real queries and transactions without altering the configured database. CI additionally runs `database-startup-mysql-integration.test.js` in an explicitly opted-in disposable MySQL 8 database: it exercises a populated 0.9.23.0 upgrade and fresh production schema startup, stable encrypted VAPID identity, and real session-revocation foreign-key cascades. These schema tests must not target a live database.

For release testing, cover permission grant/denial, foreground/minimized/closed/locked-screen delivery, zero-minute reminders, edits and cancellations, restarts, multi-tab duplication, account switch/logout isolation, old sender timestamps on newly imported mail, and stable subscriptions after replacing the API container. Test offline cold-start and updates while editing separately from push delivery.
