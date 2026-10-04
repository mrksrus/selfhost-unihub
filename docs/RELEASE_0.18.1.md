# 0.18.1: Delete an account's local data, reconnect restored accounts, offline recovery

Removes a mail account together with its local data in one step, reconnects
accounts that a restore paused, and ends offline mode by itself once UniHub is
reachable again. No database upgrade. See [Disconnect and purge](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/MAIL_MODES.md#disconnect-and-purge)
and [Offline](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/OFFLINE.md).

### Added

- **Disconnect and delete local data in one step.** The Disconnect dialog now
  also offers **delete local data…**. It shows what will be removed (emails,
  attachments, raw messages and the linked calendar with its events) and asks
  for the account address. Confirming disconnects the account and removes it
  with that data from UniHub. Mail and events at the provider are not touched.
  The account and its calendar are removed together or not at all. A delete
  that is blocked (unresolved provider changes, mail filed in another account,
  a linked calendar while Calendar is turned off or being restored) changes
  nothing.

### Changed

- **Deleting a disconnected account's data** (the bin icon) also lists the
  linked calendar and its events, and is confirmed with the account address
  instead of the account ID. The server checks the typed address too.

### Fixed

- **Accounts paused by a restore can be reconnected, with their saved
  password.** A restore pauses every mail account so Sync cannot remove
  restored mail before you check it again. Entering the password in the account
  settings did not switch such an account back on, and resuming it from the
  sync overview was refused. Now **Save** in the account settings reconnects
  it. When the backup included the password (credentials restored), leave the
  field empty: UniHub tests the saved password with the provider and uses it,
  so no new app password is needed. The sidebar shows such an account as
  **Paused** instead of **Disconnected**. Do not disconnect it first:
  Disconnect deletes the saved password.
- **Disconnect also stops the linked calendar.** Disconnecting a mail account
  now cancels a sync or event change of its linked calendar that is running at
  that moment, and no later one uses the mail password again, also when
  Calendar was turned off at the time. Reconnecting the mail account resumes
  the calendar, also when that was missed at the time (Calendar off, or a
  failed update). A missed password change reaches it the same way, and at
  the latest before its next sync or event change. A calendar you paused
  yourself stays paused.
- **Offline mode ends by itself.** One request that failed in the network (a
  restart, a proxy hiccup) switched the open app to read-only offline mode until
  **Retry connection** was clicked or the page was reloaded, even though
  everything else kept loading. Writes then failed with "Offline mode is
  read-only". The next answer from UniHub now ends offline mode, and a refused
  write checks the connection so a retry a moment later works.
