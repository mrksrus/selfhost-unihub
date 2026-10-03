#!/usr/bin/env bash
# On-demand local MariaDB 11.8 for UniHub development and tests.
# Runs as the current user from an unpacked official tarball: no service, no
# sudo, nothing at boot. `test`, `migrate-check` and `schema-dump` stop the server afterwards
# unless it was already running when they started.
#
#   scripts/local-db.sh start|stop|status|sql [args]
#   scripts/local-db.sh test [api/tests/file.test.js ...]   full database suite (like CI) or given files
#   scripts/local-db.sh migrate-check [dump.sql]            run startup upgrades on a dump
#   scripts/local-db.sh schema-dump                         regenerate docker/mariadb/schema.sql
#   scripts/local-db.sh dev                                 start, seed unihub_dev, print API env
#   scripts/local-db.sh reset                               delete all local data (asks first)
#
# Overrides: UNIHUB_DB_HOME (default ~/.local/opt/mariadb-11.8),
# UNIHUB_DB_DATA (~/.local/share/unihub-mariadb), UNIHUB_DB_PORT (3307).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
DB_HOME=${UNIHUB_DB_HOME:-$HOME/.local/opt/mariadb-11.8}
DATA=${UNIHUB_DB_DATA:-$HOME/.local/share/unihub-mariadb}
PORT=${UNIHUB_DB_PORT:-3307}
# Per port, so separate instances (e.g. parallel test runs) never share a socket.
RUN=${XDG_RUNTIME_DIR:-/tmp}/unihub-mariadb-$(id -u)-$PORT
CNF=$DATA.cnf
ENV_FILE=$REPO/.private/local-db.env
SOCKET=$RUN/mariadbd.sock

die() { echo "local-db: $*" >&2; exit 1; }
[ -x "$DB_HOME/bin/mariadbd" ] || die "MariaDB not found at $DB_HOME (see docs/DEVELOPMENT.md)"

write_config() {
  mkdir -p "$RUN"
  # Mirrors the database command in docker-compose.yml, sized for a laptop, bound to loopback.
  cat > "$CNF" <<EOF
[mariadbd]
basedir = $DB_HOME
datadir = $DATA
socket = $SOCKET
pid-file = $RUN/mariadbd.pid
log-error = $DATA.err
bind-address = 127.0.0.1
port = $PORT
# Local only: no replication, and binary logging roughly doubles DDL time on slow disks.
skip-log-bin
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
# Production/CI containers run in UTC; DATETIME defaults are compared with UTC_TIMESTAMP().
default-time-zone = '+00:00'
innodb_buffer_pool_size = 256M
innodb_log_file_size = 96M
# As in docker-compose.yml; also covers the tests' own connection pools.
innodb_snapshot_isolation = OFF
innodb_flush_log_at_trx_commit = 2
max_connections = 200
skip-name-resolve
local_infile = 0
performance_schema = OFF

[client]
socket = $SOCKET
port = $PORT
default-character-set = utf8mb4
EOF
}
load_env() { [ -f "$ENV_FILE" ] && . "$ENV_FILE"; true; }
running() { [ -S "$SOCKET" ] && "$DB_HOME/bin/mariadb-admin" --defaults-file="$CNF" -uroot ${ROOT_PW:+-p"$ROOT_PW"} ping >/dev/null 2>&1; }
# SQL via the API's mysql2 driver, the same driver the app uses; the tarball's
# command-line client needs system libraries some distributions do not ship.
rootsql() {
  local db=() sql=()
  while [ $# -gt 0 ]; do case "$1" in -e) sql=(-e "$2"); shift 2 ;; *) db=(--database "$1"); shift ;; esac; done
  LOCAL_MYSQL_SOCKET=$SOCKET LOCAL_MYSQL_PASSWORD=${ROOT_PW:-} node "$REPO/api/scripts/local-sql.cjs" "${db[@]}" "${sql[@]}"
}

wait_up() {
  for _ in $(seq 1 60); do running && return 0; sleep 0.5; done
  tail -n 20 "$DATA.err" >&2 || true
  die "server did not come up"
}
initialize() {
  echo "local-db: initializing $DATA"
  mkdir -p "$(dirname "$DATA")" "$(dirname "$ENV_FILE")"
  write_config
  "$DB_HOME/scripts/mariadb-install-db" --defaults-file="$CNF" --auth-root-authentication-method=normal --skip-test-db >/dev/null
  launch
  ROOT_PW=; wait_up
  local root app
  root=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  app=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  rootsql <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$root';
DROP USER IF EXISTS ''@'localhost';
CREATE USER 'unihub'@'127.0.0.1' IDENTIFIED BY '$app';
GRANT ALL PRIVILEGES ON \`unihub\\_%\`.* TO 'unihub'@'127.0.0.1';
SQL
  umask 077
  cat > "$ENV_FILE" <<EOF
# Local development MariaDB (scripts/local-db.sh). Not a production secret.
ROOT_PW=$root
APP_PW=$app
EOF
  ROOT_PW=$root APP_PW=$app
}
# The tarball has no --daemonize; mariadbd-safe would restart a crashed server.
launch() { setsid "$DB_HOME/bin/mariadbd" --defaults-file="$CNF" >/dev/null 2>&1 < /dev/null & }
start() {
  load_env; write_config
  if [ ! -d "$DATA/mysql" ]; then initialize; echo "local-db: running on 127.0.0.1:$PORT"; return; fi
  running && return 0
  launch
  wait_up; echo "local-db: running on 127.0.0.1:$PORT"
}
stop() {
  load_env; write_config
  if running; then "$DB_HOME/bin/mariadb-admin" --defaults-file="$CNF" -uroot ${ROOT_PW:+-p"$ROOT_PW"} shutdown 2>/dev/null; for _ in $(seq 1 60); do [ -S "$SOCKET" ] || break; sleep 0.5; done; echo "local-db: stopped"; fi
}
# Start for one command; stop again only if this call started the server.
with_server() {
  load_env; write_config
  local was_running=0; running && was_running=1
  start >/dev/null
  if [ $was_running = 0 ]; then trap 'stop >/dev/null' EXIT INT TERM; fi
  "$@"
}
fresh_db() { rootsql -e "DROP DATABASE IF EXISTS \`$1\`; CREATE DATABASE \`$1\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"; }
app_env() {
  export MYSQL_HOST=127.0.0.1 MYSQL_PORT=$PORT MYSQL_USER=unihub MYSQL_PASSWORD=$APP_PW MYSQL_DATABASE=$1
  export JWT_SECRET=local-dev-jwt-secret-not-for-production-0001 ENCRYPTION_KEY=local-dev-encryption-key-not-for-production-01
  export BACKUP_MASTER_KEY=local-dev-backup-master-key-not-for-production
  export BOOTSTRAP_ADMIN_EMAIL=admin@example.com BOOTSTRAP_ADMIN_PASSWORD=local-dev-admin-password
}

run_tests() {
  fresh_db unihub_test
  local env=(MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT="$PORT" MYSQL_TEST_DATABASE=unihub_test
    MYSQL_TEST_USER=unihub MYSQL_TEST_PASSWORD="$APP_PW" MYSQL_TEST_SCHEMA_SMOKE=1
    ENCRYPTION_KEY=ci-test-encryption-key BACKUP_MASTER_KEY=ci-test-backup-master-key)
  mkdir -p "$RUN/tmp"
  if [ $# -gt 0 ]; then (cd "$REPO/api" && env "${env[@]}" TMPDIR="$RUN/tmp" node --test --test-concurrency=1 "${@#api/}")
  else (cd "$REPO/api" && env "${env[@]}" TMPDIR="$RUN/tmp" npm run --silent test:ci); fi
}
migrate() {
  local source=${1:-}
  [ -n "$source" ] || die "usage: migrate-check dump.sql (a MariaDB dump of an existing install)"
  [ -f "$source" ] || die "no such dump: $source"
  fresh_db unihub_migrate_test
  echo "local-db: loading $(basename "$source")"
  rootsql unihub_migrate_test < "$source"
  app_env unihub_migrate_test
  # Runs every startup upgrade (failing on any error), then compares the result
  # with the generated fresh-install schema. Old installs may legitimately keep
  # small differences, so a mismatch is reported but not fatal.
  local status=0
  (cd "$REPO/api" && node scripts/dump-schema.cjs --existing --check) || status=$?
  rootsql -e 'DROP DATABASE unihub_migrate_test' >/dev/null
  case $status in
    0) echo 'local-db: upgrades completed and verified; schema matches a fresh install' ;;
    2) echo 'local-db: upgrades completed and verified; WARNING: schema differs from a fresh install (see above)' ;;
    *) die 'upgrade failed' ;;
  esac
}
schema_dump() {
  fresh_db unihub_schema_test
  app_env unihub_schema_test
  local status=0
  (cd "$REPO/api" && node scripts/dump-schema.cjs) || status=$?
  rootsql -e 'DROP DATABASE unihub_schema_test' >/dev/null
  return $status
}
dev() {
  start; load_env
  rootsql -e 'CREATE DATABASE IF NOT EXISTS unihub_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  app_env unihub_dev
  (cd "$REPO/api" && node scripts/seed-dev.cjs "$@")
  cat <<EOF

Local MariaDB keeps running for this session. Start the app with:
  (cd api && MYSQL_HOST=127.0.0.1 MYSQL_PORT=$PORT MYSQL_USER=unihub MYSQL_PASSWORD=\$(. ../.private/local-db.env; echo \$APP_PW) \\
     MYSQL_DATABASE=unihub_dev JWT_SECRET=$JWT_SECRET ENCRYPTION_KEY=$ENCRYPTION_KEY \\
     BOOTSTRAP_ADMIN_EMAIL=$BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD=$BOOTSTRAP_ADMIN_PASSWORD \\
     ALLOWED_ORIGINS=http://localhost:8080 PORT=4000 npm start)
  VITE_API_URL=http://localhost:4000/api npm run dev
Sign in as admin@example.com / $BOOTSTRAP_ADMIN_PASSWORD (or alex@example.com, same password).
When finished: scripts/local-db.sh stop
EOF
}

cmd=${1:-status}; shift || true
case "$cmd" in
  start) start ;;
  stop) stop ;;
  status) load_env; write_config; if running; then echo "running on 127.0.0.1:$PORT"; else echo "stopped"; fi ;;
  sql) load_env; write_config; running || die "not running (scripts/local-db.sh start)"; rootsql "$@" ;;
  test) with_server run_tests "$@" ;;
  migrate-check) with_server migrate "$@" ;;
  schema-dump) with_server schema_dump ;;
  dev) dev "$@" ;;
  reset)
    load_env; write_config; running && die "stop the server first"
    read -r -p "Delete all local UniHub MariaDB data in $DATA? Type yes: " ok
    [ "$ok" = yes ] && rm -rf "$DATA" "$CNF" "$DATA.err" "$ENV_FILE" && echo "local-db: data removed" ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
