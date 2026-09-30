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

## Email privacy

Remote images are blocked by default in both light mode and **Original email appearance**. Opening the original appearance does not grant permission to load images. **Load remote images** permits direct requests for this visit to this message. Loading them can disclose your IP address and the time you open the message to the sender or image host. There is no image proxy, anonymous relay or automatic external prefetching.

**Block suspected tracking images** starts enabled, including after you load other images. It uses tiny dimensions, hidden elements and tracking URL patterns without fetching images to classify them. These heuristics can miss trackers and block useful images. You can turn the filter off for the current message. **Block remote images again** prevents further image loading but cannot undo earlier requests or erase information already sent. Navigation away, revisiting a message and reloading the app reset both choices. They are not saved as account settings or included in backups.

The HTML display keeps basic formatting, safe inline styles, embedded raster images and UniHub's inline attachment image routes. Inline attachments still require their saved files and a connection. Stylesheets, CSS image/background URLs, alternate image sources such as `srcset`, SVG, embedded documents and media are removed from this display, even with image permission. Some messages therefore look different from the sender's layout. Script blocking, the iframe sandbox, a restrictive content security policy and no-referrer links remain in place. Clicking a link is separate from image permission and may disclose information through the destination URL.

Filtering only changes the displayed copy. Saved HTML, raw email and attachment files remain unchanged, as do Download/Sync behavior and offline snapshot contents.

## Updates

A new application version displays **UniHub update ready**. Save drafts and calendar edits and finish uploads before choosing **Saved — refresh now**. The update notice does not itself reload an active editor. Refresh consent applies to this tab; other open tabs keep their current input and can refresh later. A failed update keeps the notice available for retry.

## Implementation and tests

The API snapshot uses a single repeatable-read transaction, explicit safe field projections, size preflights and an exact serialized-size check. The browser uses a versioned IndexedDB snapshot and cross-tab epoch tokens; only a complete snapshot with the current account and epoch becomes reachable.

Run the frontend test suite with npm test and the API tests with npm --prefix api test. Optional MySQL tests use MYSQL_TEST_* configuration. Validate cold launch, minimized/closed/locked-screen notifications and update prompts on the actual target device; unit and CI tests cannot reproduce every browser/OS policy.

Email privacy checks are in `src/test/email-privacy.test.ts`, `src/test/safe-email-content.test.tsx` and `src/test/dark-email-content.test.tsx`. Run `node scripts/email-privacy-browser-check.mjs` with Chromium installed for a synthetic network check. It uses a disposable profile and intercepted fixture responses, without a server or live account. It verifies default blocking, permitted images with tracker filtering, the explicit filter override, re-blocking, inline attachments and absent referrers. This fixture check does not prove that heuristics identify every tracker in real mail.
