#!/usr/bin/env bash
# Disposable UniHub installation for agent end-to-end tests (tools/e2e/README.md).
# MariaDB with the synthetic dev seed, the API, the built frontend behind the
# container's nginx configuration, GreenMail as the IMAP/SMTP provider and
# Radicale as the CalDAV server, both behind a local test CA the API trusts.
# Everything binds to loopback and holds only made-up data.
#
#   tools/e2e/stack.sh up [--rebuild]   start (builds the API; the frontend if missing or --rebuild)
#   tools/e2e/stack.sh down             stop everything and free its memory
#   tools/e2e/stack.sh status           show what runs
#   tools/e2e/stack.sh reset            stop and delete all state (database, mail, calendars, uploads)
#   tools/e2e/stack.sh restart-api      restart only the API (restart checks; no rebuild)
#   tools/e2e/stack.sh env              print the instance's values as shell variables
#
# UNIHUB_E2E_INSTANCE=N (default 1) runs a separate stack beside the first:
# ports shift by N-1, the mail and CalDAV servers bind 127.0.0.N, state gets
# its own directory. Instances share the worktree's dist/ and api/dist/.
#
# UNIHUB_E2E_IMAGE=<image> (CI: the candidate image) runs that image in place
# of the local nginx and API, and MariaDB 11.8 in a container with the
# settings of docker-compose.yml, both with Docker on the host network as in
# scripts/container-smoke.sh: the image's nginx serves port 80 and its API
# 127.0.0.1:4000, so only instance 1 runs this way. The providers, the seeds
# and the test CA stay as below; the API built here only seeds the database.
#
# Tool locations come from the environment or from
# ${XDG_CONFIG_HOME:-~/.config}/unihub-e2e/tools.env: UNIHUB_E2E_NGINX,
# UNIHUB_E2E_MIME_TYPES (Alpine nginx's mime.types, as in the image),
# UNIHUB_E2E_GREENMAIL_JAR, UNIHUB_E2E_RADICALE, JAVA, UNIHUB_DB_HOME.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
TOOLS_ENV=${XDG_CONFIG_HOME:-$HOME/.config}/unihub-e2e/tools.env
# shellcheck source=/dev/null
[ -f "$TOOLS_ENV" ] && . "$TOOLS_ENV"
INSTANCE=${UNIHUB_E2E_INSTANCE:-1}
case "$INSTANCE" in [1-9]) ;; *) echo "e2e-stack: UNIHUB_E2E_INSTANCE must be 1 to 9" >&2; exit 1 ;; esac
STATE=${UNIHUB_E2E_STATE:-$HOME/.local/state/unihub-e2e$([ "$INSTANCE" = 1 ] || echo "-$INSTANCE")}
# One test CA for every instance; its certificate covers 127.0.0.1 to 127.0.0.9.
CA_DIR=${UNIHUB_E2E_CA:-$HOME/.local/state/unihub-e2e-ca}
NGINX=${UNIHUB_E2E_NGINX:-$(command -v nginx || true)}
MIME_TYPES=${UNIHUB_E2E_MIME_TYPES:-}
GREENMAIL_JAR=${UNIHUB_E2E_GREENMAIL_JAR:-}
RADICALE=${UNIHUB_E2E_RADICALE:-$(command -v radicale || true)}
JAVA=${JAVA:-$(command -v java || true)}
IMAGE=${UNIHUB_E2E_IMAGE:-}

DB_PORT=$((3310 + INSTANCE)) API_PORT=$((4099 + INSTANCE)) WEB_PORT=$((8087 + INSTANCE)) GREENMAIL_API_PORT=$((8184 + INSTANCE))
if [ -n "$IMAGE" ]; then
  [ "$INSTANCE" = 1 ] || { echo "e2e-stack: UNIHUB_E2E_IMAGE runs instance 1 only (the image's ports are fixed)" >&2; exit 1; }
  API_PORT=4000 WEB_PORT=80
fi
APP_CONTAINER=unihub-e2e-app DB_CONTAINER=unihub-e2e-db
# Implicit TLS on the standard ports (the API uses implicit TLS for SMTP only
# on 465), so each instance's providers get their own loopback address.
PROVIDER_HOST=127.0.0.$INSTANCE IMAPS_PORT=993 SMTPS_PORT=465 CALDAV_PORT=5232
# Synthetic provider accounts: one per UniHub user (tools/e2e/support/seed.mjs)
# plus outside correspondents. GreenMail also accepts mail for any other address.
PROVIDER_PASSWORD=e2e-provider-password
PROVIDER_USERS="admin@mail.test alex@mail.test blair@mail.test sam@example.org carol@example.org"

# Real test accounts (tests/providers): this checkout's .private/, unless
# UNIHUB_E2E_PROVIDERS names the canonical checkout's file for worktrees.
PROVIDERS_FILE=${UNIHUB_E2E_PROVIDERS:-$REPO/.private/e2e-providers.env}

export UNIHUB_DB_PORT=$DB_PORT UNIHUB_DB_DATA=$STATE/mariadb UNIHUB_DB_ENV_FILE=$STATE/local-db.env

die() { echo "e2e-stack: $*" >&2; exit 1; }
pidfile() { echo "$STATE/run/$1.pid"; }
# A pid file holds "pid start-time"; a process only counts as ours when both
# match, so a pid reused after a crash is never signalled.
started_at() { sed -E 's/^.*\) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; }
owned_pid() { # name -> pid of our live process, or nothing
  local f pid start; f=$(pidfile "$1")
  [ -f "$f" ] || return 1
  read -r pid start < "$f" || true
  [ -n "${pid:-}" ] && [ -n "${start:-}" ] && [ "$(started_at "$pid")" = "$start" ] && echo "$pid"
}
alive() { owned_pid "$1" >/dev/null; }
wait_port() { # port name [host]
  for _ in $(seq 1 240); do (exec 3<>"/dev/tcp/${3:-127.0.0.1}/$1") 2>/dev/null && return 0; sleep 0.5; done
  die "$2 did not open port $1 (log: $STATE/log/$2.log)"
}
spawn() { # name command...
  local name=$1; shift
  alive "$name" && return 0
  setsid "$@" >"$STATE/log/$name.log" 2>&1 < /dev/null &
  echo "$! $(started_at $!)" > "$(pidfile "$name")"
}
stop_one() {
  local pid
  if pid=$(owned_pid "$1"); then
    # spawn() made the process a session and group leader: stop the whole group.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 1 40); do alive "$1" || break; sleep 0.25; done
    alive "$1" && kill -KILL -- "-$pid" 2>/dev/null
    echo "e2e-stack: $1 stopped"
  fi
  rm -f "$(pidfile "$1")"
}

test_ca() {
  [ -f "$CA_DIR/server.p12" ] && return 0
  mkdir -p "$CA_DIR"; chmod 700 "$CA_DIR"
  local sans="DNS:localhost" i
  for i in 1 2 3 4 5 6 7 8 9; do sans+=",IP:127.0.0.$i"; done
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=UniHub e2e test CA" \
    -keyout "$CA_DIR/ca.key" -out "$CA_DIR/ca.pem" -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$CA_DIR/server.key" -out "$CA_DIR/server.csr" 2>/dev/null
  openssl x509 -req -in "$CA_DIR/server.csr" -CA "$CA_DIR/ca.pem" -CAkey "$CA_DIR/ca.key" -CAcreateserial -days 3650 \
    -out "$CA_DIR/server.pem" -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$sans") 2>/dev/null
  openssl pkcs12 -export -name greenmail -in "$CA_DIR/server.pem" -inkey "$CA_DIR/server.key" \
    -out "$CA_DIR/server.p12" -passout pass:changeit
}

app_env() {
  # Same synthetic values as scripts/local-db.sh dev, so its seed signs in.
  . "$UNIHUB_DB_ENV_FILE"
  export MYSQL_HOST=127.0.0.1 MYSQL_PORT=$DB_PORT MYSQL_USER=unihub MYSQL_PASSWORD=$APP_PW MYSQL_DATABASE=unihub_dev
  export JWT_SECRET=local-dev-jwt-secret-not-for-production-0001 ENCRYPTION_KEY=local-dev-encryption-key-not-for-production-01
  export BACKUP_MASTER_KEY=local-dev-backup-master-key-not-for-production
  export BOOTSTRAP_ADMIN_EMAIL=admin@example.com BOOTSTRAP_ADMIN_PASSWORD=local-dev-admin-password
  local port=":$WEB_PORT"; [ "$WEB_PORT" = 80 ] && port=
  export PORT=$API_PORT API_LISTEN_HOST=127.0.0.1 ALLOWED_ORIGINS=http://127.0.0.1$port,http://localhost$port
  # The real providers' hosts may resolve to private addresses (split DNS), which
  # UniHub refuses unless they are trusted, as an administrator would set them.
  local real_hosts=""
  [ -f "$PROVIDERS_FILE" ] && real_hosts=$(sed -n -E 's/^E2E_[A-Z0-9_]+_(IMAP_HOST|SMTP_HOST)=([^[:space:]]+).*/\2/p; s#^E2E_[A-Z0-9_]+_CALDAV_URL=https?://([^/:[:space:]]+).*#\1#p' "$PROVIDERS_FILE" | sort -u | paste -sd, -)
  export TRUST_PROXY_HEADERS=true TRUSTED_MAIL_HOSTS=$PROVIDER_HOST${real_hosts:+,$real_hosts} NODE_EXTRA_CA_CERTS=$CA_DIR/ca.pem
  export MAIL_ATTACHMENT_UPLOAD_ROOT=$STATE/uploads/attachments MAIL_RAW_STORAGE_ROOT=$STATE/uploads/mail-raw
  export RECORDINGS_ROOT=$STATE/uploads/recordings BACKUP_ARCHIVES_ROOT=$STATE/uploads/backups
  export UPLOAD_SPOOL_ROOT=$STATE/uploads/spool CONTACT_PHOTOS_ROOT=$STATE/uploads/contact-photos
  export CONTACT_IMPORTS_ROOT=$STATE/uploads/contacts/imports
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
  local f
  for f in "$REPO/docker/nginx/"*.conf; do # included files, e.g. security-headers.conf
    case "${f##*/}" in nginx.conf|default.conf) ;; *) sed "s|/etc/nginx/|$conf/|g" "$f" > "$conf/${f##*/}" ;; esac
  done
  sed -e "s|listen 80;|listen 127.0.0.1:$WEB_PORT;|" \
      -e "s|/usr/share/nginx/html|$REPO/dist|g" \
      -e "s|/app/downloads/|$STATE/downloads/|g" \
      -e "s|/etc/nginx/|$conf/|g" \
      -e "s|127.0.0.1:4000|127.0.0.1:$API_PORT|g" \
      "$REPO/docker/nginx/default.conf" > "$conf/conf.d/default.conf"
  # The debug Android app, when built, is offered like the image's.
  local apk=$REPO/android/app/build/outputs/apk/debug/app-debug.apk
  [ -f "$apk" ] && ln -sfn "$apk" "$STATE/downloads/unihub.apk"
  return 0
}

radicale_config() {
  mkdir -p "$STATE/radicale/collections"
  local u users=""
  for u in $PROVIDER_USERS; do users+="$u:$PROVIDER_PASSWORD"$'\n'; done
  printf '%s' "$users" > "$STATE/radicale/users"
  cat > "$STATE/radicale/config" <<EOF
[server]
hosts = $PROVIDER_HOST:$CALDAV_PORT
ssl = True
certificate = $CA_DIR/server.pem
key = $CA_DIR/server.key
[auth]
type = htpasswd
htpasswd_filename = $STATE/radicale/users
htpasswd_encryption = plain
[storage]
filesystem_folder = $STATE/radicale/collections
[logging]
level = warning
EOF
}

# Image mode: the database container, seeded like scripts/local-db.sh dev.
image_database() {
  if [ ! -f "$UNIHUB_DB_ENV_FILE" ]; then
    local root app
    root=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
    app=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
    (umask 077; printf '# MariaDB of the e2e stack (container). Not a production secret.\nROOT_PW=%s\nAPP_PW=%s\n' "$root" "$app" > "$UNIHUB_DB_ENV_FILE")
  fi
  . "$UNIHUB_DB_ENV_FILE"
  if [ -z "$(docker ps -q --filter "name=^$DB_CONTAINER\$")" ]; then
    docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
    # The options of docker-compose.yml, on this instance's loopback port and in UTC.
    docker run -d --name "$DB_CONTAINER" --network host --init --security-opt no-new-privileges \
      --mount type=volume,source=unihub-e2e-mariadb,target=/var/lib/mysql \
      -e MARIADB_DATABASE=unihub_dev -e MARIADB_USER=unihub -e "MARIADB_PASSWORD=$APP_PW" -e "MARIADB_ROOT_PASSWORD=$ROOT_PW" \
      mariadb:11.8 --port="$DB_PORT" --bind-address=127.0.0.1 --default-time-zone=+00:00 \
      --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --max-connections=100 \
      --innodb-buffer-pool-size=192M --innodb-log-file-size=96M --innodb-log-buffer-size=16M \
      --innodb-flush-log-at-trx-commit=2 --innodb-snapshot-isolation=OFF --skip-name-resolve --local-infile=0 >/dev/null
  fi
  local ready=0
  for _ in $(seq 1 120); do
    docker exec "$DB_CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 && { ready=1; break; }
    sleep 1
  done
  [ "$ready" = 1 ] || { docker logs --tail 40 "$DB_CONTAINER" >&2; die "the database container did not become ready"; }
  npm --prefix "$REPO/api" run --silent build
  (cd "$REPO/api" && MYSQL_HOST=127.0.0.1 MYSQL_PORT=$DB_PORT MYSQL_USER=unihub MYSQL_PASSWORD=$APP_PW MYSQL_DATABASE=unihub_dev \
    JWT_SECRET=local-dev-jwt-secret-not-for-production-0001 ENCRYPTION_KEY=local-dev-encryption-key-not-for-production-01 \
    BACKUP_MASTER_KEY=local-dev-backup-master-key-not-for-production \
    BOOTSTRAP_ADMIN_EMAIL=admin@example.com BOOTSTRAP_ADMIN_PASSWORD=local-dev-admin-password node scripts/seed-dev.cts)
}

# Image mode: the image as docker-compose.yml runs it (production settings,
# Secure cookies; 127.0.0.1 is a secure context for the browser), with the
# stack's keys, providers and test CA.
image_app() {
  app_env
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$APP_CONTAINER" --network host --init --stop-timeout 15 \
    --cap-drop ALL --security-opt no-new-privileges --cap-add CHOWN --cap-add DAC_OVERRIDE \
    --cap-add NET_BIND_SERVICE --cap-add SETGID --cap-add SETUID \
    --mount type=volume,source=unihub-e2e-uploads,target=/app/uploads \
    --mount "type=bind,source=$CA_DIR/ca.pem,target=/etc/unihub-e2e-ca.pem,readonly" \
    -e NODE_ENV=production -e MYSQL_HOST -e MYSQL_PORT -e MYSQL_USER -e MYSQL_PASSWORD -e MYSQL_DATABASE \
    -e JWT_SECRET -e ENCRYPTION_KEY -e BACKUP_MASTER_KEY -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD \
    -e ALLOWED_ORIGINS -e TRUST_PROXY_HEADERS -e TRUSTED_MAIL_HOSTS -e NODE_EXTRA_CA_CERTS=/etc/unihub-e2e-ca.pem \
    -e MYSQL_STARTUP_MAX_WAIT_SECONDS=60 -e MYSQL_STARTUP_CHECK_INTERVAL_SECONDS=2 "$IMAGE" >/dev/null
  wait_healthy
}
wait_healthy() {
  for _ in $(seq 1 120); do
    [ "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null)" = true ] || break
    curl --silent --fail --max-time 2 "http://127.0.0.1:$WEB_PORT/health" >/dev/null && return 0
    sleep 1
  done
  docker logs --tail 80 "$APP_CONTAINER" >&2 || true
  die "the image did not become healthy"
}

up() {
  if [ -z "$IMAGE" ]; then
    [ -x "$NGINX" ] || die "nginx not found; set UNIHUB_E2E_NGINX (README)"
    [ -f "$MIME_TYPES" ] || die "set UNIHUB_E2E_MIME_TYPES to Alpine nginx's mime.types (README)"
  fi
  [ -f "$GREENMAIL_JAR" ] || die "set UNIHUB_E2E_GREENMAIL_JAR to greenmail-standalone.jar (README)"
  [ -x "$RADICALE" ] || die "radicale not found; set UNIHUB_E2E_RADICALE (README)"
  [ -x "$JAVA" ] || die "java not found; set JAVA"
  mkdir -p "$STATE/run" "$STATE/log" "$STATE/uploads"
  test_ca

  if [ -n "$IMAGE" ]; then
    echo "e2e-stack: starting the database container and seeding it"
    image_database >"$STATE/log/db-seed.log" 2>&1 || die "database start or seed failed ($STATE/log/db-seed.log)"
  else
    if [ "${1:-}" = --rebuild ] || [ ! -f "$REPO/dist/index.html" ]; then
      echo "e2e-stack: building the frontend"; (cd "$REPO" && npm run --silent build) >"$STATE/log/build.log" 2>&1 || die "frontend build failed ($STATE/log/build.log)"
    fi
    # Builds the API, then creates and seeds unihub_dev; the seed skips a database it already filled.
    echo "e2e-stack: building the API and starting the database"
    "$REPO/scripts/local-db.sh" dev >"$STATE/log/db-seed.log" 2>&1 || die "database start or seed failed ($STATE/log/db-seed.log)"
  fi

  local users="" u
  # GreenMail's format is local:password@domain; users.login=email signs in with the whole address.
  for u in $PROVIDER_USERS; do users+="${users:+,}${u%@*}:$PROVIDER_PASSWORD@${u#*@}"; done
  spawn greenmail "$JAVA" -Xmx256m -Dgreenmail.startup.timeout=60000 \
    -Dgreenmail.hostname=$PROVIDER_HOST -Dgreenmail.users="$users" -Dgreenmail.users.login=email \
    -Dgreenmail.imaps.port=$IMAPS_PORT -Dgreenmail.smtps.port=$SMTPS_PORT \
    -Dgreenmail.tls.keystore.file="$CA_DIR/server.p12" -Dgreenmail.tls.keystore.password=changeit -Dgreenmail.tls.key.password=changeit \
    -Dgreenmail.api.hostname=127.0.0.1 -Dgreenmail.api.port=$GREENMAIL_API_PORT \
    -jar "$GREENMAIL_JAR"
  radicale_config
  spawn radicale "$RADICALE" --config "$STATE/radicale/config"
  wait_port $GREENMAIL_API_PORT greenmail
  wait_port $CALDAV_PORT radicale "$PROVIDER_HOST"

  if [ -n "$IMAGE" ]; then
    echo "e2e-stack: starting $IMAGE"
    image_app
  else
    app_env
    spawn api node "$REPO/api/dist/server.js"
    wait_port $API_PORT api

    nginx_config
    spawn nginx "$NGINX" -p "$STATE/nginx" -c "$STATE/nginx/nginx.conf" -e "$STATE/log/nginx-error.log"
    wait_port $WEB_PORT nginx
  fi

  # Connect each UniHub user's mail and calendar accounts once.
  ( eval "$(print_env | sed 's/^/export /')"; node "$REPO/tools/e2e/support/seed.mjs" ) >"$STATE/log/e2e-seed.log" 2>&1 || die "e2e seed failed ($STATE/log/e2e-seed.log)"
  status
}

print_env() {
  cat <<EOF
UNIHUB_E2E_INSTANCE=$INSTANCE
UNIHUB_E2E_URL=http://127.0.0.1$([ "$WEB_PORT" = 80 ] || echo ":$WEB_PORT")
UNIHUB_E2E_STATE=$STATE
UNIHUB_E2E_PROVIDER_HOST=$PROVIDER_HOST
UNIHUB_E2E_PROVIDER_PASSWORD=$PROVIDER_PASSWORD
UNIHUB_E2E_IMAPS_PORT=$IMAPS_PORT
UNIHUB_E2E_SMTPS_PORT=$SMTPS_PORT
UNIHUB_E2E_CALDAV_URL=https://$PROVIDER_HOST:$CALDAV_PORT/
UNIHUB_E2E_GREENMAIL_API=http://127.0.0.1:$GREENMAIL_API_PORT
UNIHUB_E2E_CA=$CA_DIR/ca.pem
UNIHUB_E2E_DB_PORT=$DB_PORT
UNIHUB_E2E_DB_ENV=$UNIHUB_DB_ENV_FILE
UNIHUB_E2E_PROVIDERS=$PROVIDERS_FILE
EOF
}

status() {
  local name
  for name in greenmail radicale; do printf '%-10s %s\n' "$name" "$(alive $name && echo running || echo stopped)"; done
  if [ -n "$IMAGE" ]; then
    for name in "$APP_CONTAINER" "$DB_CONTAINER"; do printf '%-10s %s\n' "${name#unihub-e2e-}" "$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo stopped)"; done
  else
    for name in api nginx; do printf '%-10s %s\n' "$name" "$(alive $name && echo running || echo stopped)"; done
    printf '%-10s %s\n' mariadb "$("$REPO/scripts/local-db.sh" status 2>/dev/null | tail -1)"
  fi
  cat <<EOF
App:        http://127.0.0.1:$WEB_PORT${IMAGE:+ ($IMAGE)}  (admin@example.com, alex@example.com, blair@example.com; password local-dev-admin-password)
Providers:  $PROVIDER_HOST IMAPS $IMAPS_PORT, SMTPS $SMTPS_PORT, CalDAV https://$PROVIDER_HOST:$CALDAV_PORT/
            accounts $PROVIDER_USERS (password $PROVIDER_PASSWORD), certificate from the test CA $CA_DIR/ca.pem
Mail API:   http://127.0.0.1:$GREENMAIL_API_PORT/api/user (GreenMail REST, for checking delivered mail)
Logs:       $STATE/log/
EOF
}

down() {
  if [ -n "$IMAGE" ]; then docker rm -f "$APP_CONTAINER" "$DB_CONTAINER" >/dev/null 2>&1 || true; fi
  stop_one nginx; stop_one api; stop_one radicale; stop_one greenmail
  [ -d "$STATE/mariadb" ] && "$REPO/scripts/local-db.sh" stop
  return 0
}

cmd=${1:-status}; shift || true
case "$cmd" in
  up) up "$@" ;;
  down) down ;;
  status) status ;;
  env) print_env ;;
  reset) down; [ -z "$IMAGE" ] || docker volume rm unihub-e2e-uploads unihub-e2e-mariadb >/dev/null 2>&1 || true
    rm -rf "$STATE"; echo "e2e-stack: state removed ($STATE)" ;;
  restart-api)
    # The image restarts as a whole (docker restart: SIGTERM, as docker stop).
    if [ -n "$IMAGE" ]; then docker restart "$APP_CONTAINER" >/dev/null; wait_healthy
    else stop_one api; app_env; spawn api node "$REPO/api/dist/server.js"; wait_port $API_PORT api; fi
    echo "e2e-stack: api restarted" ;;
  *) sed -n '2,22p' "$0"; exit 1 ;;
esac
