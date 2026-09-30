#!/bin/sh

UNIHUB_API_START_DELAY_SECONDS="${UNIHUB_API_START_DELAY_SECONDS:-2}"

case "$UNIHUB_API_START_DELAY_SECONDS" in
  ''|*[!0-9]*) UNIHUB_API_START_DELAY_SECONDS=2 ;;
esac

# The API runs as UNIHUB_API_UID/GID (set in the image). Volumes created before
# 0.11.1 are owned by root, so hand /app/uploads over once. The scan only
# changes ownership when some entry differs; -h changes a symlink itself and
# never the file it points to.
if [ "$(id -u)" = 0 ] && [ -n "${UNIHUB_API_UID:-}" ] && [ -d /app/uploads ]; then
  owner="${UNIHUB_API_UID}:${UNIHUB_API_GID:-$UNIHUB_API_UID}"
  if [ -n "$(find /app/uploads \( ! -user "$UNIHUB_API_UID" -o ! -group "${UNIHUB_API_GID:-$UNIHUB_API_UID}" \) -print 2>/dev/null | head -n 1)" ]; then
    echo "Giving /app/uploads to the API user ($owner)..."
    if ! chown -R -h "$owner" /app/uploads; then
      echo "WARNING: could not change ownership of /app/uploads. The API runs as uid $UNIHUB_API_UID and needs write access; see docs/UPGRADING.md (0.11.1)." >&2
    fi
  fi
fi

# Use the API's driver/configuration for an authenticated check. The helper caps
# elapsed wait time; the API retains its own bounded retry if readiness expires.
node /app/api/src/mysql-readiness.js || true

# The supervisor exits if either service dies, allowing the existing Docker
# restart policy to recover the whole app. It also forwards shutdown signals.
export UNIHUB_API_START_DELAY_SECONDS
exec node /app/api/src/service-supervisor.js
