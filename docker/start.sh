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
# no capabilities needed) the copy also keeps Nginx's pid file, logs and
# temporary files in its own folder, which that user can write.
UNIHUB_HTTP_PORT="${UNIHUB_HTTP_PORT:-80}"
case "$UNIHUB_HTTP_PORT" in
  ''|*[!0-9]*) echo "UNIHUB_HTTP_PORT must be a port number, not '$UNIHUB_HTTP_PORT'." >&2; exit 1 ;;
  4000) echo "UNIHUB_HTTP_PORT cannot be 4000: the API listens on that port inside the container." >&2; exit 1 ;;
esac
if [ "$(id -u)" != 0 ] || [ "$UNIHUB_HTTP_PORT" != 80 ]; then
  nginx_dir=/tmp/unihub-nginx
  rm -rf "$nginx_dir" && mkdir -p "$nginx_dir/conf.d" || exit 1
  sed "s|listen 80;|listen $UNIHUB_HTTP_PORT;|" /etc/nginx/conf.d/default.conf > "$nginx_dir/conf.d/default.conf" || exit 1
  moved="s|/etc/nginx/conf.d/|$nginx_dir/conf.d/|"
  if [ "$(id -u)" != 0 ]; then
    moved="$moved;s|/var/run/nginx.pid|$nginx_dir/nginx.pid|;s|/var/log/nginx/|$nginx_dir/|g"
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

# The supervisor exits if either service dies, allowing the existing Docker
# restart policy to recover the whole app. It also forwards shutdown signals.
export UNIHUB_API_START_DELAY_SECONDS
exec node /app/api/src/service-supervisor.js
