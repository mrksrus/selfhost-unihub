# 0.15.1: Notifications that keep working, a calmer install card

### Fixed

- **Notifications stopped after 3 weeks.** A sign-in lasted 21 days from
  sign-in, however often UniHub was used. When it ended, that device's
  notifications stopped without any sign. Now:
  - A sign-in lasts 21 days from the last time UniHub was used on that device,
    so opening the app now and then keeps it signed in.
  - When an unused device has 2 days left, it gets a "Notifications will stop
    soon" notification.
  - After signing in again, notifications on that device turn back on by
    themselves if they were on before. This also happens when the browser's
    push service replaced the subscription.
- **Pushes are never dropped silently.** A push the device cannot show (for
  example for an account that is not signed in there) now shows a generic
  "You have a new notification" notice without content. Some browsers revoke
  subscriptions that receive pushes without a notification.
- **Install card appeared too often.** It now has **Install**, **Later** and
  **No**. Later asks again after a day, and so does cancelling the browser's
  install dialog. No stops asking in that browser. A card that is ignored
  appears at most once a day.

### Changed

- **Notification status per device.** Settings → Notifications shows the last
  notification delivered to this device, any unresolved delivery problem, and
  until when the device stays signed in. The text about how often mail is
  checked was wrong (it said every 10 minutes) and was removed.

### After updating

Reload UniHub, or accept the update prompt, so the new service worker is used.
Devices that were already signed out need to sign in once. See
[Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0151-sliding-sessions).
