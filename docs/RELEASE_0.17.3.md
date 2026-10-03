# 0.17.3: Two-factor authentication fixes

Makes two-factor authentication easier to set up and to recover from, and
hides the empty Legacy mail view. No database upgrade. See [Two-factor authentication](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/AUTH_ADMIN_SETTINGS.md#two-factor-authentication).

### Added

- **QR code for setup.** **Settings > Security > Set Up 2FA** shows a QR code to
  scan with an authenticator app, the setup key, and an **Open in authenticator
  app** link for an app on the same device. The code is drawn in the browser;
  the secret is not sent anywhere else. Before, setup showed only the key and
  the raw `otpauth://` link.
- **Admins can reset another user's 2FA.** For a user who lost both the
  authenticator and the recovery codes, **Admin > Users** has a **Reset 2FA**
  button on accounts with 2FA, marked with a **2FA** badge. The admin confirms
  with their own password. The user is signed out everywhere and signs in with
  their password. Admins cannot reset their own 2FA this way; the docs describe
  what to do if the only admin is locked out.

### Changed

- **Turning on 2FA signs out your other devices.** Sessions opened with the
  password alone end when 2FA is enabled, as they already did when it is
  disabled. The device you set it up on stays signed in. Setup now asks for
  your password, so a browser left signed in is not enough to turn on 2FA with
  someone else's authenticator and lock you out.
- **Legacy mail view is hidden when empty.** The **Legacy** entry in the mail
  account list holds mail that the 0.10.5 folder migration could not file. It
  is now listed only while it holds mail, so installations without such mail no
  longer show **Legacy (0)**. A view left on Legacy switches to All accounts
  once it is empty.

### Fixed

- **After an `ENCRYPTION_KEY` change.** The authenticator key is stored
  encrypted with `ENCRYPTION_KEY`, so after that key changes authenticator codes
  stop working. Recovery codes always kept working for sign-in. Now Settings
  says what happened and how to fix it: turn 2FA off with a recovery code and
  set it up again. Generating new recovery codes in that state used up the
  recovery code entered and then failed with a server error; it now refuses
  before checking the code.

### Documentation

- [Two-factor authentication](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/AUTH_ADMIN_SETTINGS.md#two-factor-authentication)
  covers setup, `ENCRYPTION_KEY` changes, the admin reset and turning 2FA off in
  the database when the only admin is locked out.
