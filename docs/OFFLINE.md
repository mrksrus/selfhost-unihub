# Offline reading and appearance

## Save this device for offline use

Open **Settings → General → Offline reading → Enable offline reading** while signed in and connected. Wait for the saved timestamp and counts before relying on the snapshot. This stores the latest **100 non-draft emails across all accounts**, including full text/HTML bodies, plus **all contacts and calendar entries** (including to-dos, attendees and subtasks).

Attachments, raw email files, remote images, recordings and backup archives are not downloaded. Attachment metadata remains visible, but the files require a connection. Search and folder counts offline describe the saved messages, so an older message outside the latest 100 is unavailable. Saving all contacts and events is deliberate; a snapshot that cannot fit the 32 MiB budget fails with an explanation instead of silently omitting records.

The snapshot refreshes while an authenticated UniHub window is open, visible and connected, approximately every five minutes and on focus/reconnect with a minimum one-minute gap. **Refresh offline data** requests a fresh snapshot immediately. Replacement is atomic: a failed download, quota error or oversized response retains the previous complete snapshot and its timestamp. Successful refreshes reflect additions, changes and deletions.

## Use it offline

After one completed save and application-shell installation, launch the installed PWA without connectivity. UniHub can reopen the last signed-in account's local snapshot and shows an offline, read-only banner with the saved time. Viewing a message does not mark it read. Editing, sending, deleting, importing, uploading and other server mutations require a connection and authenticated server session.

The cached profile is only a local viewing identity. A network failure can open saved data; a confirmed 401/403 invalid session removes it. Reconnect revalidates the session before enabling writes. A server 500 error during startup does not masquerade as authenticated offline access.

**Clear device data**, explicit logout and switching accounts invalidate offline access, including other open tabs. Late downloads cannot restore a cleared snapshot or publish the previous account's data. Browser storage limits, manual site-data removal and browser eviction can remove the snapshot; it is a convenience copy, not a backup.

## Black, white and blue

New installations default to **Dark**: black page backgrounds, white text and blue accents. **Settings → General → Appearance** also provides Light and System, saved on this browser. Existing calendar colors remain user data; newly created calendar defaults use blue. Success/warning/destructive colors remain meaningful.

Dark mode displays HTML mail in a readable text view by default. **Original email appearance** opens the existing sandboxed HTML view for messages whose formatting matters. Remote-content permission is scoped to that message. HTML email artwork may have its own white backgrounds in the original view.

## Updates

A new application version displays **UniHub update ready**. Save drafts and calendar edits and finish uploads before choosing **Saved — refresh now**. The update notice does not itself reload an active editor. Refresh consent applies to this tab; other open tabs keep their current input and can refresh later. A failed update keeps the notice available for retry.

## Implementation and tests

The API snapshot uses a single repeatable-read transaction, explicit safe field projections, size preflights and an exact serialized-size check. The browser uses a versioned IndexedDB snapshot and cross-tab epoch tokens; only a complete snapshot with the current account and epoch becomes reachable.

Run the frontend test suite with npm test and the API tests with npm --prefix api test. Optional MySQL tests use MYSQL_TEST_* configuration. Validate cold launch, minimized/closed/locked-screen notifications and update prompts on the actual target device; unit and CI tests cannot reproduce every browser/OS policy.
