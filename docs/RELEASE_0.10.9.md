# 0.10.9: two-way mail updates

Sync mode now sends new read/unread changes, stars and folder moves from UniHub
back to the email provider. Moving mail to Trash uses the provider's mapped Trash
folder. Changes made at the provider continue to flow into UniHub.

Only new explicit actions are sent. Upgrading does not upload historical local
differences. Download mode and retained local-only messages keep their existing
behavior. Pending or failed provider changes are visible in the mail UI.

## Interrupted updates and conflicts

Commands survive an app restart. UniHub checks the provider before at most one
safe automatic retry. It preserves provider state when an interrupted flag update
cannot be reconciled safely. Flag changes use conditional writes where supported;
servers without CONDSTORE retain a small race between checking and writing.
Uncertain moves are never blindly repeated. Moves require native IMAP MOVE and
an existing mapped folder on the same account.

This release does not add draft mirroring, remote folder rename/deletion,
permanent server deletion, cross-account transfers or browser-offline editing.
Existing SMTP sending is unchanged. See [mail modes](MAIL_MODES.md) for details.

## Updating an existing installation

Image: `ghcr.io/mrksrus/selfhost-unihub:0.10.9`.

Keep existing volumes, configuration and encryption keys. Migration 5 adds the
outgoing-command table without rewriting existing messages or changing account
modes. No new Docker/YAML changes are required relative to 0.10.8. Installations
older than 0.10.8 must still apply its Nginx capability correction; see
[the upgrade guide](UPGRADING.md). An image downgrade does not undo migrations.

**Account backup, import and restore remain ALPHA.** Keep independent, consistent
backups of MySQL, uploads, configuration and secrets. Outgoing commands are
excluded from account archives; restoring mail clears destination commands so
old actions cannot be replayed against a provider.

## Verification

Focused protocol and UI checks passed, including durable-command tests on MySQL.
All 131 recovery checks passed with no skipped checks, including historical
upgrades and production export/restore. TypeScript and the production build
passed. Mail-server responses were simulated; this release has not been tested
against the maintainer's live Gmail account. GitHub's image workflow additionally
runs the full API/frontend checks and container startup/auth/recording smoke test.
