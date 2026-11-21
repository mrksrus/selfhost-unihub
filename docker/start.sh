#!/bin/sh

UNIHUB_API_START_DELAY_SECONDS="${UNIHUB_API_START_DELAY_SECONDS:-2}"

case "$UNIHUB_API_START_DELAY_SECONDS" in
  ''|*[!0-9]*) UNIHUB_API_START_DELAY_SECONDS=2 ;;
esac

# The API runs as UNIHUB_API_UID/GID (set in the image). Volumes created before
# 0.11.1 are owned by root, so hand /app/uploads over once. The scan only
# changes ownership when some entry differs; -h changes a symlink itself and
# never the file it points to. A marker written after a completed pass skips
# the whole-tree scan on later starts (the API creates its files as its own
# user); remove the marker to scan again after adding files as root.
if [ "$(id -u)" = 0 ] && [ -n "${UNIHUB_API_UID:-}" ] && [ -d /app/uploads ]; then
  owner="${UNIHUB_API_UID}:${UNIHUB_API_GID:-$UNIHUB_API_UID}"
  marker="/app/uploads/.owned-by-${UNIHUB_API_UID}"
  if [ ! -e "$marker" ]; then
    handed_over=1
    if [ -n "$(find /app/uploads \( ! -user "$UNIHUB_API_UID" -o ! -group "${UNIHUB_API_GID:-$UNIHUB_API_UID}" \) -print 2>/dev/null | head -n 1)" ]; then
      echo "Giving /app/uploads to the API user ($owner)..."
      if ! chown -R -h "$owner" /app/uploads; then
        handed_over=0
        echo "WARNING: could not change ownership of /app/uploads. The API runs as uid $UNIHUB_API_UID and needs write access; see docs/UPGRADING.md (0.11.1)." >&2
      fi
    fi
    if [ "$handed_over" = 1 ]; then
      { : > "$marker" && chown -h "$owner" "$marker"; } 2>/dev/null || true
    fi
  fi
fi

# Nginx listens on UNIHUB_HTTP_PORT (80 unless set). Started as root on port 80
# it uses the image's configuration as it is. Otherwise it runs from a copy
# with that port; when the container runs as another user (docker run --user,
# no capabilities needed) the copy also keeps Nginx's pid file and
# temporary files in its own folder, which that user can write. The API
# listens on 4000 inside the container; given that port, Nginx gets it and
# the API moves to 4001.
UNIHUB_HTTP_PORT="${UNIHUB_HTTP_PORT:-80}"
case "$UNIHUB_HTTP_PORT" in
  ''|*[!0-9]*|0*|??????*) UNIHUB_HTTP_PORT=0 ;;
esac
if [ "$UNIHUB_HTTP_PORT" -lt 1 ] || [ "$UNIHUB_HTTP_PORT" -gt 65535 ]; then
  echo "UNIHUB_HTTP_PORT must be a port number from 1 to 65535 without leading zeros." >&2
  exit 1
fi
if [ "$(id -u)" != 0 ] || [ "$UNIHUB_HTTP_PORT" != 80 ]; then
  nginx_dir=/tmp/unihub-nginx
  rm -rf "$nginx_dir" && mkdir -p "$nginx_dir/conf.d" || exit 1
  api_port=4000
  [ "$UNIHUB_HTTP_PORT" != 4000 ] || { api_port=4001; export PORT=4001; }
  sed "s|listen 80;|listen $UNIHUB_HTTP_PORT;|;s|127.0.0.1:4000|127.0.0.1:$api_port|" /etc/nginx/conf.d/default.conf > "$nginx_dir/conf.d/default.conf" || exit 1
  moved="s|/etc/nginx/conf.d/|$nginx_dir/conf.d/|"
  if [ "$(id -u)" != 0 ]; then
    moved="$moved;s|/var/run/nginx.pid|$nginx_dir/nginx.pid|"
    for kind in client_body proxy fastcgi uwsgi scgi; do
      echo "${kind}_temp_path $nginx_dir/$kind;"
    done > "$nginx_dir/conf.d/temp-paths.conf"
    # No account in the image has this user's ID, so it has no home folder.
    export HOME=/tmp
    [ -w /app/uploads ] || echo "WARNING: /app/uploads is not writable by uid $(id -u), which runs UniHub. Uploads, recordings, backups and mail archives will fail." >&2
  fi
  sed "$moved" /etc/nginx/nginx.conf > "$nginx_dir/nginx.conf" || exit 1
  export UNIHUB_NGINX_CONF="$nginx_dir/nginx.conf"
fi

# Use the API's driver/configuration for an authenticated check. The helper caps
# elapsed wait time; the API retains its own bounded retry if readiness expires.
# It reads the secrets as the API does (api/src/config.ts readSecret): a
# MYSQL_PASSWORD_FILE or DATABASE_URL_FILE (a Docker secret) before the
# variable. Started as root, this check runs as root while the API reads the
# same files as UNIHUB_API_UID, so a secret file must be readable by that user too.
node /app/api/src/database-readiness.js || true

# The relay for calls (coturn) runs beside the API once it has a shared secret;
# its configuration, which holds the secret, exists only in the temp area.
turn_secret="${TURN_SECRET:-}"
if [ -n "${TURN_SECRET_FILE:-}" ]; then
  turn_secret="$(cat -- "$TURN_SECRET_FILE")" || turn_secret=
  [ -n "$turn_secret" ] || echo "WARNING: TURN_SECRET_FILE ($TURN_SECRET_FILE) could not be read or is empty; the relay for calls is off." >&2
fi
if [ -z "$turn_secret" ]; then
  [ -z "${TURN_URLS:-}" ] || echo "WARNING: TURN_URLS is set without TURN_SECRET or TURN_SECRET_FILE; the relay for calls is off and calls between different networks fail." >&2
else
  [ -n "${TURN_URLS:-}" ] || echo "WARNING: TURN_SECRET is set without TURN_URLS; the relay for calls runs but devices are not told about it." >&2
  # The first address devices are told, without scheme, query and port.
  turn_realm="${TURN_URLS%%,*}"; turn_realm="${turn_realm#*:}"; turn_realm="${turn_realm%%\?*}"
  case "$turn_realm" in \[*) turn_realm="${turn_realm%%]*}"; turn_realm="${turn_realm#[}" ;; *) turn_realm="${turn_realm%%:*}" ;; esac
  case "$turn_realm" in ''|*[!A-Za-z0-9.:-]*) turn_realm=unihub ;; esac
  turn_user=
  if [ "$(id -u)" = 0 ]; then
    # coturn drops to the API user by name after binding its ports.
    turn_user="$(awk -F: -v id="${UNIHUB_API_UID:-}" '$3 == id { print $1; exit }' /etc/passwd)"
    turn_group="$(awk -F: -v id="${UNIHUB_API_GID:-$UNIHUB_API_UID}" '$3 == id { print $1; exit }' /etc/group)"
    [ -n "$turn_user" ] && [ -n "$turn_group" ] || { echo "WARNING: no account in the image has UNIHUB_API_UID/GID; the relay for calls is off." >&2; turn_secret=; }
  fi
  # The secret and the address end up in a config line: nothing that could start another one.
  case "$turn_secret" in =*|*[!A-Za-z0-9+/=._~-]*) echo "WARNING: TURN_SECRET may hold only letters, digits and + / = . _ ~ - (openssl rand -base64 48); the relay for calls is off." >&2; turn_secret= ;; esac
  case "${TURN_EXTERNAL_IP:-}" in *[!0-9A-Fa-f.:/]*) echo "WARNING: TURN_EXTERNAL_IP is not an IP address; the relay for calls is off." >&2; turn_secret= ;; esac
fi
if [ -n "$turn_secret" ]; then
  turn_dir=/tmp/unihub-turn
  rm -rf "$turn_dir" && mkdir -m 700 -p "$turn_dir" || exit 1
  # Peers the relay never sends to: this network, loopback, link-local,
  # multicast and reserved, IPv4-compatible IPv6, and every address of the
  # container itself. Ranges stay prefix-aligned, as coturn compares IPv6 ranges byte by byte.
  turn_denied="0.0.0.0-0.255.255.255 127.0.0.0-127.255.255.255 169.254.0.0-169.254.255.255 224.0.0.0-255.255.255.255
    ::-::ffff:ffff fe80::-feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
    $(awk '/\/32 host LOCAL/ { print last } { last = $2 }' /proc/net/fib_trie 2>/dev/null | sort -u)
    $(sed 's/^\(....\)\(....\)\(....\)\(....\)\(....\)\(....\)\(....\)\(....\) .*/\1:\2:\3:\4:\5:\6:\7:\8/' /proc/net/if_inet6 2>/dev/null)"
  # Private networks and carrier-grade NAT, unless everyone calls from one private network or VPN.
  [ "${TURN_ALLOW_PRIVATE_PEERS:-}" = true ] || turn_denied="$turn_denied 10.0.0.0-10.255.255.255
    172.16.0.0-172.31.255.255 192.168.0.0-192.168.255.255 100.64.0.0-100.127.255.255 fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  (
    umask 077 && exec > "$turn_dir/turnserver.conf" || exit 1
    printf '%s\n' listening-port=3478 min-port=49160 max-port=49200 use-auth-secret "static-auth-secret=$turn_secret" \
      "realm=$turn_realm" fingerprint no-tcp-relay no-tls no-dtls cli=0 no-multicast-peers no-dynamic-ip-list \
      no-dynamic-realms user-quota=8 total-quota=40 log-file=stdout "pidfile=$turn_dir/turnserver.pid" userdb=:memory:
    [ -z "${TURN_EXTERNAL_IP:-}" ] || echo "external-ip=$TURN_EXTERNAL_IP"
    [ -z "$turn_user" ] || printf '%s\n' "proc-user=$turn_user" "proc-group=$turn_group"
    for peer in $turn_denied; do echo "denied-peer-ip=$peer"; done
  ) || exit 1
  echo "✓ Starting the relay for calls on port 3478..."
  supervisor_pid=$$
  # The relay's end stops the supervisor (the PID this script hands over by
  # exec), which ends the container for its restart policy.
  (
    turnserver -c "$turn_dir/turnserver.conf"
    echo 'The relay for calls stopped; restarting the container.' >&2
    while kill -TERM "$supervisor_pid" 2>/dev/null; do sleep 5; done
  ) &
fi

# The supervisor exits if either service dies, allowing the existing Docker
# restart policy to recover the whole app. It also forwards shutdown signals.
export UNIHUB_API_START_DELAY_SECONDS
exec node /app/api/src/service-supervisor.js
