#!/usr/bin/env bash
# Disposable UniHub installation for agent end-to-end tests (tools/e2e/README.md).
# MariaDB with the synthetic dev seed, the API, the built frontend behind the
# container's nginx configuration, and GreenMail as the IMAP/SMTP provider.
# Everything binds to 127.0.0.1 and holds only made-up data.
#
#   tools/e2e/stack.sh up [--rebuild]   start (builds the API; the frontend if missing or --rebuild)
#   tools/e2e/stack.sh down             stop everything and free its memory
#   tools/e2e/stack.sh status           show what runs
#   tools/e2e/stack.sh reset            stop and delete all state (database, mail, uploads)
#   tools/e2e/stack.sh restart-api      restart only the API (restart checks; no rebuild)
#
# UNIHUB_E2E_INSTANCE=N (default 1) runs a separate stack beside the first:
# ports shift by N-1, the mail server binds 127.0.0.N, state gets its own
# directory. Instances share the worktree's dist/ and api/dist/.
#
# Overrides: UNIHUB_E2E_STATE (~/.local/state/unihub-e2e), UNIHUB_E2E_NGINX
# (nginx on PATH), UNIHUB_E2E_MIME_TYPES (Alpine nginx's mime.types, as in the
# image), UNIHUB_E2E_GREENMAIL_JAR, JAVA (java on PATH), UNIHUB_DB_HOME.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
INSTANCE=${UNIHUB_E2E_INSTANCE:-1}
case "$INSTANCE" in [1-9]) ;; *) echo "e2e-stack: UNIHUB_E2E_INSTANCE must be 1 to 9" >&2; exit 1 ;; esac
STATE=${UNIHUB_E2E_STATE:-$HOME/.local/state/unihub-e2e$([ "$INSTANCE" = 1 ] || echo "-$INSTANCE")}
NGINX=${UNIHUB_E2E_NGINX:-$(command -v nginx || true)}
MIME_TYPES=${UNIHUB_E2E_MIME_TYPES:-}
GREENMAIL_JAR=${UNIHUB_E2E_GREENMAIL_JAR:-}
JAVA=${JAVA:-$(command -v java || true)}

DB_PORT=$((3310 + INSTANCE)) API_PORT=$((4099 + INSTANCE)) WEB_PORT=$((8087 + INSTANCE)) GREENMAIL_API_PORT=$((8084 + INSTANCE))
# Implicit TLS on the standard ports (the API uses implicit TLS for SMTP only
# on 465), so each instance's mail server gets its own loopback address.
MAIL_HOST=127.0.0.$INSTANCE IMAPS_PORT=993 SMTPS_PORT=465
# Synthetic accounts: the seed's two UniHub users plus an outside correspondent.
MAIL_PASSWORD=e2e-mail-password
MAIL_USERS="admin@example.com alex@example.com sam@example.org"

export UNIHUB_DB_PORT=$DB_PORT UNIHUB_DB_DATA=$STATE/mariadb UNIHUB_DB_ENV_FILE=$STATE/local-db.env

die() { echo "e2e-stack: $*" >&2; exit 1; }
pidfile() { echo "$STATE/run/$1.pid"; }
alive() { local f; f=$(pidfile "$1"); [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; }
wait_port() {
  for _ in $(seq 1 240); do (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 0.5; done
  die "$2 did not open port $1 (log: $STATE/log/$2.log)"
}
spawn() { # name command...
  local name=$1; shift
  alive "$name" && return 0
  setsid "$@" >"$STATE/log/$name.log" 2>&1 < /dev/null &
  echo $! > "$(pidfile "$name")"
}
stop_one() {
  local f; f=$(pidfile "$1")
  if alive "$1"; then
    kill -TERM -- "-$(cat "$f")" 2>/dev/null || kill -TERM "$(cat "$f")"
    for _ in $(seq 1 40); do alive "$1" || break; sleep 0.25; done
    alive "$1" && kill -KILL -- "-$(cat "$f")" 2>/dev/null
    echo "e2e-stack: $1 stopped"
  fi
  rm -f "$f"
}

app_env() {
  # Same synthetic values as scripts/local-db.sh dev, so its seed signs in.
  . "$UNIHUB_DB_ENV_FILE"
  export MYSQL_HOST=127.0.0.1 MYSQL_PORT=$DB_PORT MYSQL_USER=unihub MYSQL_PASSWORD=$APP_PW MYSQL_DATABASE=unihub_dev
  export JWT_SECRET=local-dev-jwt-secret-not-for-production-0001 ENCRYPTION_KEY=local-dev-encryption-key-not-for-production-01
  export BACKUP_MASTER_KEY=local-dev-backup-master-key-not-for-production
  export BOOTSTRAP_ADMIN_EMAIL=admin@example.com BOOTSTRAP_ADMIN_PASSWORD=local-dev-admin-password
  export PORT=$API_PORT ALLOWED_ORIGINS=http://127.0.0.1:$WEB_PORT,http://localhost:$WEB_PORT
  export TRUST_PROXY_HEADERS=true TRUSTED_MAIL_HOSTS=$MAIL_HOST
  export MAIL_ATTACHMENT_UPLOAD_ROOT=$STATE/uploads/attachments MAIL_RAW_STORAGE_ROOT=$STATE/uploads/mail-raw
  export RECORDINGS_ROOT=$STATE/uploads/recordings BACKUP_ARCHIVES_ROOT=$STATE/uploads/backups
}

nginx_config() {
  # The image's own files, with container paths swapped for local ones.
  local conf=$STATE/nginx
  mkdir -p "$conf/conf.d" "$conf/temp" "$STATE/downloads"
  sed -e "s|/etc/nginx/mime.types|$MIME_TYPES|" \
      -e "s|/etc/nginx/|$conf/|g" \
      -e "s|/var/log/nginx/|$STATE/log/nginx-|g" \
      -e "s|/var/run/nginx.pid|$STATE/run/nginx-master.pid|" \
      -e "s|^worker_processes auto;|worker_processes 2;\ndaemon off;|" \
      "$REPO/docker/nginx/nginx.conf" > "$conf/nginx.conf"
  sed -i "s|^http {|http {\n    client_body_temp_path $conf/temp/body;\n    proxy_temp_path $conf/temp/proxy;\n    fastcgi_temp_path $conf/temp/fastcgi;\n    uwsgi_temp_path $conf/temp/uwsgi;\n    scgi_temp_path $conf/temp/scgi;|" "$conf/nginx.conf"
  cp "$REPO/docker/nginx/security-headers.conf" "$conf/security-headers.conf"
  sed -e "s|listen 80;|listen 127.0.0.1:$WEB_PORT;|" \
      -e "s|/usr/share/nginx/html|$REPO/dist|g" \
      -e "s|/app/downloads/|$STATE/downloads/|g" \
      -e "s|/etc/nginx/|$conf/|g" \
      -e "s|127.0.0.1:4000|127.0.0.1:$API_PORT|g" \
      "$REPO/docker/nginx/default.conf" > "$conf/conf.d/default.conf"
}

up() {
  [ -x "$NGINX" ] || die "nginx not found; set UNIHUB_E2E_NGINX (README)"
  [ -f "$MIME_TYPES" ] || die "set UNIHUB_E2E_MIME_TYPES to Alpine nginx's mime.types (README)"
  [ -f "$GREENMAIL_JAR" ] || die "set UNIHUB_E2E_GREENMAIL_JAR to greenmail-standalone.jar (README)"
  [ -x "$JAVA" ] || die "java not found; set JAVA"
  mkdir -p "$STATE/run" "$STATE/log" "$STATE/uploads"

  if [ "${1:-}" = --rebuild ] || [ ! -f "$REPO/dist/index.html" ]; then
    echo "e2e-stack: building the frontend"; (cd "$REPO" && npm run --silent build) >"$STATE/log/build.log" 2>&1 || die "frontend build failed ($STATE/log/build.log)"
  fi
  # Builds the API, then creates and seeds unihub_dev; the seed skips a database it already filled.
  echo "e2e-stack: building the API and starting the database"
  "$REPO/scripts/local-db.sh" dev >"$STATE/log/db-seed.log" 2>&1 || die "database start or seed failed ($STATE/log/db-seed.log)"

  local users="" u
  # GreenMail's format is local:password@domain; users.login=email signs in with the whole address.
  for u in $MAIL_USERS; do users+="${users:+,}${u%@*}:$MAIL_PASSWORD@${u#*@}"; done
  spawn greenmail "$JAVA" -Xmx256m -Dgreenmail.startup.timeout=60000 \
    -Dgreenmail.hostname=$MAIL_HOST -Dgreenmail.users="$users" -Dgreenmail.users.login=email \
    -Dgreenmail.imaps.port=$IMAPS_PORT -Dgreenmail.smtps.port=$SMTPS_PORT \
    -Dgreenmail.api.hostname=127.0.0.1 -Dgreenmail.api.port=$GREENMAIL_API_PORT \
    -jar "$GREENMAIL_JAR"
  wait_port $GREENMAIL_API_PORT greenmail

  app_env
  spawn api node "$REPO/api/dist/server.js"
  wait_port $API_PORT api

  nginx_config
  spawn nginx "$NGINX" -p "$STATE/nginx" -c "$STATE/nginx/nginx.conf" -e "$STATE/log/nginx-error.log"
  wait_port $WEB_PORT nginx
  status
}

status() {
  local name
  for name in greenmail api nginx; do printf '%-10s %s\n' "$name" "$(alive $name && echo running || echo stopped)"; done
  printf '%-10s %s\n' mariadb "$("$REPO/scripts/local-db.sh" status 2>/dev/null | tail -1)"
  cat <<EOF
App:        http://127.0.0.1:$WEB_PORT  (admin@example.com or alex@example.com, password local-dev-admin-password)
Mail:       IMAPS $MAIL_HOST:$IMAPS_PORT, SMTPS $MAIL_HOST:$SMTPS_PORT; users $MAIL_USERS, password $MAIL_PASSWORD
            self-signed certificate: confirm its fingerprint when adding the account
Mail API:   http://127.0.0.1:$GREENMAIL_API_PORT/api/user (GreenMail REST, for checking delivered mail)
Logs:       $STATE/log/
EOF
}

down() {
  stop_one nginx; stop_one api; stop_one greenmail
  "$REPO/scripts/local-db.sh" stop
}

cmd=${1:-status}; shift || true
case "$cmd" in
  up) up "$@" ;;
  down) down ;;
  status) status ;;
  reset) down; rm -rf "$STATE"; echo "e2e-stack: state removed ($STATE)" ;;
  restart-api) stop_one api; app_env; spawn api node "$REPO/api/dist/server.js"; wait_port $API_PORT api; echo "e2e-stack: api restarted" ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
