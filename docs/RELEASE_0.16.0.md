# 0.16.0: MariaDB

**Breaking: UniHub now runs on MariaDB instead of MySQL, and there is no in-place
upgrade.** 0.16.0 is for new installations. An existing 0.15.x installation that
pulls 0.16.0 stops at startup with a message and leaves its data untouched. Pin
`ghcr.io/mrksrus/selfhost-unihub:0.15.1` to keep it running, or move to a new
installation with account backups. See
[Upgrading](https://github.com/mrksrus/selfhost-unihub/blob/main/docs/UPGRADING.md#0160-mariadb).

### Changed

- **MariaDB 11.8 LTS.** The database container is now `mariadb:11.8`
  (supported until 2030). Any MariaDB 10.11 or later works if you bring your
  own server. UniHub refuses MySQL and older MariaDB versions at startup,
  before it changes anything.
- **One file to install.** `docker-compose.yml` no longer mounts files from the
  repository. Download it, set the two passwords and start it; the app creates
  its database tables itself. This also works in Portainer, Dockge and similar
  tools that take only a Compose file.
- **New names in the Compose file.** The database service is `unihub-db`, its
  volume is `mariadb_data`, and the `.env` fields are `UNIHUB_DB_PASSWORD` and
  `UNIHUB_DB_ROOT_PASSWORD`. The MySQL configuration file
  `docker/mysql/conf/custom.cnf` is gone; its settings are now options of the
  database service.
- **Health check.** The database uses MariaDB's own `healthcheck.sh`, and the
  app container starts only once the database reports ready.
