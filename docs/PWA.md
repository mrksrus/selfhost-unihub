# Installation, notifications, and offline access

UniHub uses Web Push for new unread mail, new calendar/to-do items, and calendar reminders. The API sends notifications through the device browser's push service. The page does not need to remain open while the device has connectivity and allows notifications.

## Enable notifications

1. Open UniHub over HTTPS. On iPhone/iPad, add it to the Home Screen and launch that installed app.
2. Sign in, open Settings, and select **Enable notifications**. Grant the browser permission.
3. Select **Test notification**, minimize UniHub, and check that the notification arrives. Test on the actual devices you intend to use.

Enabling notifications applies to this browser/device and account. Device Focus settings, force-stopping the browser, lack of connectivity, and platform restrictions can delay or prevent delivery.

Notifications stay on as long as the device stays signed in:

- **Sessions slide.** Each sign-in lasts 21 days from the last time UniHub was used on that device (renewed at most once a day). Opening the app now and then is enough.
- **Warning before it ends.** When an unused session has 2 days left, the device gets a "Notifications will stop soon" notification. Opening UniHub renews the session and cancels the warning if it has not been sent yet.
- **Automatic re-registration.** Every app start re-sends this device's subscription. After signing in again, or after the push service replaced the subscription, notifications resume without pressing Enable again. This is skipped when notifications were disabled on this device or the browser permission was revoked.
- **Signing out** removes the device subscription. Signing in again as the same account turns it back on; disabling notifications in Settings keeps it off.
- **Status in Settings.** The Notifications card shows the last delivery to this device, an unresolved push-service error, and when the device's session ends.

Every push shows something. A push the worker cannot display (malformed, or for an account that is not signed in on this device) becomes a generic "You have a new notification" notice without content. Browsers may otherwise show their own message or, on some platforms, revoke subscriptions that receive pushes without a notification.

Subscriptions stay tied to sessions on purpose: if a device is lost, its notifications (which include mail senders and event titles) stop when its session is signed out or ends.

Mail notifications follow successful IMAP ingestion. New INBOX mail is usually noticed within seconds (IDLE) or at most about 30 seconds; other folders within about 5 minutes. Web Push does not make that discovery instantaneous. First account/folder imports and UIDVALIDITY resets establish a baseline without notifying every historical message. Already-read messages, drafts, sent mail, trash, and archive do not generate alerts.

The server checks due calendar reminders every 30 seconds. It persists delivery state, retries transient push failures, and catches up within a two-hour reminder window after restart. Edited, deleted, hidden, done, or cancelled events are rechecked before delivery. Recurrence retains the calendar's existing behavior: notifications concern stored event occurrences; this change does not introduce recurrence expansion.

Recordings that are still uploading when UniHub is closed finish in the service worker where the browser allows it (Background Sync). When they cannot, the device shows **Recording not uploaded yet**; if the browser stopped the worker first, the server sends that notice as a push after 10 minutes without progress. See [Recordings on the device](RECORDINGS.md#recordings-on-the-device).

## Install prompt

Browsers that support it show an **Install UniHub** card: **Install** opens the browser's install dialog, **Later** asks again after a day (also when the browser dialog is cancelled), and **No** stops asking in that browser. An unanswered card appears at most once a day. The choice is stored in the browser's local storage, so clearing site data resets it. The app can still be installed from the browser menu.

## Server configuration and persistence

No new container, exposed port, volume, or required environment variable is needed. The API stores subscriptions, its outbox, and reminder schedules in the existing MariaDB database. It generates one VAPID key pair and stores the private key encrypted using the existing `ENCRYPTION_KEY` in a dedicated `notification_config` table. Container rebuilds and restarts retain the keys; do not rotate `ENCRYPTION_KEY` or delete the notification tables casually.

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

Run `node --test api/tests/notifications.test.js api/tests/notification-worker.test.js`. The optional `notifications-mysql-integration.test.js` runs when `MYSQL_TEST_HOST` and the usual `MYSQL_TEST_*` settings are provided. It uses connection-local temporary tables to test real queries and transactions without altering the configured database. CI additionally runs `database-startup-mysql-integration.test.js` in an explicitly opted-in disposable MariaDB database: it exercises a populated 0.9.23.0 upgrade and fresh production schema startup, stable encrypted VAPID identity, and real session-revocation foreign-key cascades. These schema tests must not target a live database.

For release testing, cover permission grant/denial, foreground/minimized/closed/locked-screen delivery, zero-minute reminders, edits and cancellations, restarts, multi-tab duplication, account switch/logout isolation, old sender timestamps on newly imported mail, and stable subscriptions after replacing the API container. Test offline cold-start and updates while editing separately from push delivery.
