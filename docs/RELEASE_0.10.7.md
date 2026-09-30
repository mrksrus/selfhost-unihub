# 0.10.7: mark account backup and restore ALPHA

Account backup creation, import and restore are experimental. Data Management,
export/import headings, the recovery-password dialog and the mail server-deletion
setting now say ALPHA. Installation, backup and compatibility documentation carry
the same status. These features remain available; no data is removed.

Do not rely on account archives as your only copy of important data. Keep an
independent, consistent backup of MySQL, uploads, deployment configuration and
secrets, especially before deleting messages from the email provider.

## Upgrading

Image: `ghcr.io/mrksrus/selfhost-unihub:0.10.7`.

This release changes UI wording, documentation and version metadata only.
There are no new database migrations, archive format changes or deployment-setting
changes. Existing 0.10.6 installations keep the same volumes, keys and credentials.
For older versions, follow [the upgrade guide](UPGRADING.md).

The 0.10.6 image remains unchanged. Its release notes now also identify account
backup/import/restore as ALPHA; the visible UI labels require 0.10.7.
