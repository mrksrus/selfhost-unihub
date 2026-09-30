# 0.10.8: fix restricted-container Nginx startup

The reference Compose file dropped capabilities that Nginx needs to access its
owned log/temp paths and start workers as the nginx user/group. A fresh catalog
installation exposed permission errors and a restart loop. The application image
smoke test previously used Docker's default capabilities and missed this.

The app now retains `CHOWN`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`, `SETGID` and
`SETUID` while still dropping all other capabilities and keeping
`no-new-privileges`. The release smoke test now uses those same restrictions.
These permissions apply inside the container; no privileged mode or Docker socket
mount is added. The API/supervisor still run as root, as before.

## Updating an existing installation

Image: `ghcr.io/mrksrus/selfhost-unihub:0.10.8`.

**An image update alone does not fix saved custom-app YAML.** Update the `unihub`
service's `cap_add` list to the five capabilities above, matching the reference
Compose file. Keep `cap_drop: ALL`, `no-new-privileges`, the same volumes and keys.
The proposed TrueNAS catalog includes the corrected settings.

No new database migrations, archive format changes or data changes are introduced.
The five-minute MySQL readiness allowance is unchanged and ends when ready.

**Account backup, import and restore remain ALPHA.** Keep independent backups of
the database, uploads, configuration and secrets. Do not rely solely on account
archives before deleting mail from your email provider.
