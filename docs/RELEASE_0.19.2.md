# 0.19.2: A new layout

Every page now uses the same calm layout: a slim navigation rail on desktop,
an optional panel next to the page, and plain rows with one main action each.
On phones the page header is the top bar and the panel opens from the button
next to the title. Things that need your attention are collected in one
place.

### Changed

- **Navigation.** A rail with your pages, Search, Attention, Settings and your
  account replaces the sidebar. The phone bottom bar shows your first four
  pages and More.
- **Panels.** Mail folders and accounts, task lists, calendars, contact
  views, recording categories and settings sections live in the page's panel.
- **Attention.** Mail changes to review, failed syncs and a waiting app
  update appear in one list instead of separate banners.
- **Pages.** Today, Mail, Calendar, ToDo, Contacts, Recordings, Music and
  Settings were rebuilt on rows. Contacts gained a detail pane, Settings has
  sections that save as you change them, and admins find Server settings and
  Users inside Settings.
- **Safer actions.** Deleting a contact and merging duplicate contacts now ask
  first. A repeating server event always asks whether a change applies to one
  occurrence or the series.
- **API groundwork for the native app.** Routes come from the route table,
  bearer-token requests without a cookie need no CSRF token, notifications go
  through a transport interface, and all schema setup runs as numbered
  upgrade steps.

### Upgrade

- Pull and restart. Database upgrade 15 adds notification tables and mail
  indexes only where they are missing; existing data is unchanged.
- Backups from earlier versions restore as before.
