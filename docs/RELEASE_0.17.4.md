# 0.17.4: Recordings on the device and separate pages

Makes recordings safe to close the app on, and lets each page be shown, hidden
and ordered on its own: Calendar and ToDo, Recordings and Music, and Today. No
database upgrade. See [Recordings on the device](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/RECORDINGS.md#recordings-on-the-device)
and [Modules](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/MODULES.md).

### Added

- **Recordings are kept on the device until they are uploaded.** A recording is
  written to the browser's storage every 2 seconds while it runs and stays
  there until the server has stored it. If the app or the browser closes before
  **Stop**, the next visit to Recordings offers it as a recovered draft. The
  new **On this device** list shows drafts, waiting uploads with their progress,
  and files the server refused, each with Download.
- **Uploads continue after the app is closed.** The upload runs while UniHub is
  open, on any page. When it is closed, the service worker finishes it where the
  browser allows (Background Sync in Chrome, Edge and Android). If it cannot,
  the device shows **Recording not uploaded yet**, or **Sign in to finish
  uploading** when the session ended. If the browser stops the worker before it
  can say so (iOS), the server sends that notice as a push after 10 minutes
  without progress. Notifications need permission in Settings → Notifications.
- **Pages can be hidden and ordered one by one.** Settings → Modules now lists
  **Pages** (Mail, Calendar, ToDo, Contacts, Recordings, Music, Today), each with
  **Show in navigation** and its place in the order. Music and Today are regular
  pages in the sidebar and mobile bar instead of fixed links under More.
- **Music as start page.** Settings → General → Default start page offers Music.

### Changed

- **Modules switch their pages on and off together.** The **Modules** list keeps
  **Enabled** and **Background work**. Calendar and ToDo still share one module,
  and so do Recordings and Music, now named **Recordings and Music**. A module
  hidden before this release keeps all its pages hidden until changed.
- **Uploads resume without duplicates.** The browser picks the upload ID, so
  repeating a start after a lost answer resumes the same upload, and a chunk or
  completion whose answer was lost is not stored twice. Every 512 KiB chunk is
  checked with SHA-256 on the server.

### Fixed

- **Volume swelling and fading in recordings.** UniHub already asked the
  browser to turn off automatic gain control, noise suppression and echo
  cancellation, but some browsers ignore that request. Recording now checks what
  was applied, asks again, and warns when one is still on. A recording also
  survives the microphone being taken away (it stops and keeps the audio) and
  the browser suspending audio (it resumes and says so).

### Documentation

- [Recordings on the device](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/RECORDINGS.md#recordings-on-the-device)
  describes capture, recovery, the upload queue and the notifications.
- [Modules](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/MODULES.md)
  covers pages and how they relate to modules.
