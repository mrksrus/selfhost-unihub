# 0.18.2: Linked calendars use the mail login directly

A calendar connected from a mail account no longer keeps its own copy of the
mail password. It reads the mail account's login each time it syncs or saves
a change. This removes a whole group of cases where the copy and the mail
account got out of step. Database upgrade 14 runs at startup. See
[Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md).

### Changed

- **A linked calendar follows its mail account.** A new mail password or a
  reconnect applies to the calendar right away, also when Calendar was turned
  off or being restored at the time. While the mail account is disconnected,
  or paused by a restore, the calendar is shown as paused with "The mail
  account is disconnected" and syncs again once the mail account is
  reconnected. Disconnecting mail no longer switches the calendar off; a
  calendar you paused yourself stays paused.
- **Restored mail calendars find their mail account.** A calendar restored
  from a backup that belonged to a mail account is no longer restored paused
  for lack of a password. It finds the mail account with its address and uses
  that login.
- **Collapsed sidebars stay collapsed.** On desktop, the app navigation and
  the mail account and folder list remember whether you collapsed them, also
  after a reload. The choice is kept in this browser.

### Upgrade

- The upgrade removes the copied mail passwords from linked calendars, and
  turns calendars that were switched off only by a mail disconnect back on.
  They sync once their mail account is connected.
