# 0.20.0: Email to task, attachments in place, a steadier server

An email with something to do in it becomes a task that leads back to the
email; attachments open without leaving UniHub; folders can be deleted on
the mail server; the accent colour is yours to choose; and a slow database
no longer restarts the server or signs you out.

### Added

- **Add task** from an email, a draft or the message menu. The subject becomes
  the title, the task goes to a list of your choice (or a new one), and a day
  with a reminder puts it in the calendar. The task keeps the email's summary
  and opens it with **Show email**, over the page you are on, with reply and
  forward; the reader lists the tasks made from a message.
- An attachment viewer for images, PDFs (drawn by UniHub, with selectable
  text), text, HTML, audio and video.
- **Delete a folder on the mail server** together with its server copy.
  Messages the server still has elsewhere, drafts and local copies stay.
- **Appearance** settings with six accent colours, saved with your account.
- A default account to send from, under Settings → General → Mail.

### Changed

- ToDo and Music show their views and lists as chips above the list.
- Small controls get a larger tap area on touch screens.

### Fixed

- A slow database no longer fills the API's connection pool, a failed
  periodic sync no longer restarts the container, and the app no longer
  shows the sign-in page while the server is busy or restarting.
- "Tomorrow" is the next calendar day in your timezone, also when the
  clocks change.

### Upgrade

- Take a backup, pull and restart. Database upgrade 16 runs at startup and
  adds two fields to tasks and events; nothing else changes. No
  configuration change.
