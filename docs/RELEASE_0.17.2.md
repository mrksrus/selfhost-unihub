# 0.17.2: Connect a mail account's calendar

Makes turning on the calendar of an existing mail account clearer. No
database upgrade. See [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md#connecting-a-calendar).

### Changed

- **Connect calendar button.** While a mail account's calendar is off, its
  Calendar section has a **Connect calendar** button, and Enter in the address
  field connects too. It uses the typed address, or finds the server when the
  field is empty. Before, Enter did nothing while the calendar was off, so an
  address could only be used through the switch.
- **Saving does not change the calendar, and the section says so.** The
  Calendar section applies its changes right away; **Save** on the mail account
  never turned the calendar on, which was easy to miss.
- **The last error stays visible.** When connecting fails, the error appears
  below the section until the next attempt instead of only in a toast that
  disappears.

### Documentation

- [Calendar](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/CALENDAR.md)
  explains what a self-hosted server such as Stalwart needs: CalDAV over HTTPS
  under a hostname with a valid certificate. The MX hostname alone is not
  enough.
