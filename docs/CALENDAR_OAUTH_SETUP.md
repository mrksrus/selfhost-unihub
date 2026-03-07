# Calendar connection (URL-based, no OAuth)

Calendar connection in UniHub uses **URL + optional password** per account. There is no Google or Microsoft OAuth; no server env vars are required.

- **Web calendar (iCal URL):** For Google Calendar or Outlook, get the private iCal/ICS link from the provider and add a “Web calendar” account with that URL (and optional password if the feed is protected).
- **iCloud / CalDAV:** For Apple, add an “iCloud / CalDAV” account with your Apple ID, an app-specific password (from appleid.apple.com), and your iCalendar or CalDAV URL.

See the **(i)** guide next to “Add Calendar Account” in the Calendar UI for step-by-step instructions for Google, Microsoft, and Apple.

**Note:** Sending, accepting, or declining invitations natively is not supported with URL-based sync; use the provider’s app for that.
