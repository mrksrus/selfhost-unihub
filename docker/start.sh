#!/bin/sh

UNIHUB_API_START_DELAY_SECONDS="${UNIHUB_API_START_DELAY_SECONDS:-2}"

case "$UNIHUB_API_START_DELAY_SECONDS" in
  ''|*[!0-9]*) UNIHUB_API_START_DELAY_SECONDS=2 ;;
esac

# Use the API's driver/configuration for an authenticated check. The helper caps
# elapsed wait time; the API retains its own bounded retry if readiness expires.
node /app/api/src/mysql-readiness.js || true

# The supervisor exits if either service dies, allowing the existing Docker
# restart policy to recover the whole app. It also forwards shutdown signals.
export UNIHUB_API_START_DELAY_SECONDS
exec node /app/api/src/service-supervisor.js
