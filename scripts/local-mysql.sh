#!/usr/bin/env bash
# On-demand local MySQL 8.4 for UniHub development and tests.
# Runs as the current user from an unpacked official tarball: no service, no
# sudo, nothing at boot. `test` and `migrate-check` stop the server afterwards
# unless it was already running when they started.
#
#   scripts/local-mysql.sh start|stop|status|sql [args]
#   scripts/local-mysql.sh test [api/tests/file.test.js ...]   full MySQL suite (like CI) or given files
#   scripts/local-mysql.sh migrate-check [dump.sql]            run upgrades on the 0.9.23.0 fixture or a dump
#   scripts/local-mysql.sh dev                                 start, seed unihub_dev, print API env
#   scripts/local-mysql.sh reset                               delete all local data (asks first)
#
# Overrides: UNIHUB_MYSQL_HOME (default ~/.local/opt/mysql-8.4),
# UNIHUB_MYSQL_DATA (~/.local/share/unihub-mysql), UNIHUB_MYSQL_PORT (3307).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
MYSQL_HOME=${UNIHUB_MYSQL_HOME:-$HOME/.local/opt/mysql-8.4}
DATA=${UNIHUB_MYSQL_DATA:-$HOME/.local/share/unihub-mysql}
PORT=${UNIHUB_MYSQL_PORT:-3307}
RUN=${XDG_RUNTIME_DIR:-/tmp}/unihub-mysql-$(id -u)
CNF=$DATA.cnf
ENV_FILE=$REPO/.private/local-mysql.env
SOCKET=$RUN/mysqld.sock

die() { echo "local-mysql: $*" >&2; exit 1; }
[ -x "$MYSQL_HOME/bin/mysqld" ] || die "MySQL not found at $MYSQL_HOME (see docs/DEVELOPMENT.md)"

write_config() {
  mkdir -p "$RUN"
  # Mirrors docker/mysql/conf/custom.cnf, sized for a laptop, bound to loopback.
  cat > "$CNF" <<EOF
[mysqld]
basedir = $MYSQL_HOME
datadir = $DATA
socket = $SOCKET
pid-file = $RUN/mysqld.pid
log-error = $DATA.err
bind-address = 127.0.0.1
port = $PORT
mysqlx = OFF
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
# Production/CI containers run in UTC; DATETIME defaults are compared with UTC_TIMESTAMP().
default-time-zone = '+00:00'
innodb_buffer_pool_size = 256M
innodb_redo_log_capacity = 96M
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
running() { [ -S "$SOCKET" ] && "$MYSQL_HOME/bin/mysqladmin" --defaults-file="$CNF" -uroot ${ROOT_PW:+-p"$ROOT_PW"} ping >/dev/null 2>&1; }
# SQL via the API's mysql2 driver: the minimal tarball's client needs libncurses.so.6.
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
  echo "local-mysql: initializing $DATA"
  mkdir -p "$(dirname "$DATA")" "$(dirname "$ENV_FILE")"
  write_config
  "$MYSQL_HOME/bin/mysqld" --defaults-file="$CNF" --initialize-insecure
  "$MYSQL_HOME/bin/mysqld" --defaults-file="$CNF" --daemonize >/dev/null
  ROOT_PW=; wait_up
  local root app
  root=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  app=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  rootsql <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$root';
CREATE USER 'unihub'@'127.0.0.1' IDENTIFIED BY '$app';
GRANT ALL PRIVILEGES ON \`unihub\\_%\`.* TO 'unihub'@'127.0.0.1';
SQL
  umask 077
  cat > "$ENV_FILE" <<EOF
# Local development MySQL (scripts/local-mysql.sh). Not a production secret.
ROOT_PW=$root
APP_PW=$app
EOF
  ROOT_PW=$root
}
start() {
  load_env; write_config
  if [ ! -d "$DATA/mysql" ]; then initialize; echo "local-mysql: running on 127.0.0.1:$PORT"; return; fi
  running && return 0
  "$MYSQL_HOME/bin/mysqld" --defaults-file="$CNF" --daemonize >/dev/null
  wait_up; echo "local-mysql: running on 127.0.0.1:$PORT"
}
stop() {
  load_env; write_config
  if running; then "$MYSQL_HOME/bin/mysqladmin" --defaults-file="$CNF" -uroot ${ROOT_PW:+-p"$ROOT_PW"} shutdown 2>/dev/null; for _ in $(seq 1 60); do [ -S "$SOCKET" ] || break; sleep 0.5; done; echo "local-mysql: stopped"; fi
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
  local source=${1:-$REPO/api/tests/fixtures/v0.9.23.0/schema.sql}
  [ -f "$source" ] || die "no such dump: $source"
  fresh_db unihub_migrate_test
  echo "local-mysql: loading $(basename "$source")"
  rootsql unihub_migrate_test < "$source"
  app_env unihub_migrate_test
  (cd "$REPO/api" && node -e "require('./src/services/database').initDatabase()
    .then(async () => { console.log('local-mysql: upgrades completed and verified'); await require('./src/state').db.end(); })
    .catch(error => { console.error(error); process.exit(1); })")
  rootsql -e 'DROP DATABASE unihub_migrate_test'
}
dev() {
  start; load_env
  rootsql -e 'CREATE DATABASE IF NOT EXISTS unihub_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  app_env unihub_dev
  (cd "$REPO/api" && node scripts/seed-dev.cjs "$@")
  cat <<EOF

Local MySQL keeps running for this session. Start the app with:
  (cd api && MYSQL_HOST=127.0.0.1 MYSQL_PORT=$PORT MYSQL_USER=unihub MYSQL_PASSWORD=\$(. .private/local-mysql.env; echo \$APP_PW) \\
     MYSQL_DATABASE=unihub_dev JWT_SECRET=$JWT_SECRET ENCRYPTION_KEY=$ENCRYPTION_KEY \\
     BOOTSTRAP_ADMIN_EMAIL=$BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD=$BOOTSTRAP_ADMIN_PASSWORD \\
     ALLOWED_ORIGINS=http://localhost:8080 PORT=4000 npm start)
  VITE_API_URL=http://localhost:4000/api npm run dev
Sign in as admin@example.com / $BOOTSTRAP_ADMIN_PASSWORD (or alex@example.com, same password).
When finished: scripts/local-mysql.sh stop
EOF
}

cmd=${1:-status}; shift || true
case "$cmd" in
  start) start ;;
  stop) stop ;;
  status) load_env; write_config; if running; then echo "running on 127.0.0.1:$PORT"; else echo "stopped"; fi ;;
  sql) load_env; write_config; running || die "not running (scripts/local-mysql.sh start)"; rootsql "$@" ;;
  test) with_server run_tests "$@" ;;
  migrate-check) with_server migrate "$@" ;;
  dev) dev "$@" ;;
  reset)
    load_env; write_config; running && die "stop the server first"
    read -r -p "Delete all local UniHub MySQL data in $DATA? Type yes: " ok
    [ "$ok" = yes ] && rm -rf "$DATA" "$CNF" "$DATA.err" "$ENV_FILE" && echo "local-mysql: data removed" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
