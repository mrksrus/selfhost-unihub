#!/bin/sh

MYSQL_HOST="${MYSQL_HOST:-unihub-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"
MYSQL_STARTUP_MAX_WAIT_SECONDS="${MYSQL_STARTUP_MAX_WAIT_SECONDS:-120}"
MYSQL_STARTUP_CHECK_INTERVAL_SECONDS="${MYSQL_STARTUP_CHECK_INTERVAL_SECONDS:-5}"
UNIHUB_API_START_DELAY_SECONDS="${UNIHUB_API_START_DELAY_SECONDS:-2}"

case "$MYSQL_STARTUP_MAX_WAIT_SECONDS" in
  ''|*[!0-9]*) MYSQL_STARTUP_MAX_WAIT_SECONDS=120 ;;
esac
case "$MYSQL_STARTUP_CHECK_INTERVAL_SECONDS" in
  ''|*[!0-9]*) MYSQL_STARTUP_CHECK_INTERVAL_SECONDS=5 ;;
esac
case "$UNIHUB_API_START_DELAY_SECONDS" in
  ''|*[!0-9]*) UNIHUB_API_START_DELAY_SECONDS=2 ;;
esac

if [ "$MYSQL_STARTUP_CHECK_INTERVAL_SECONDS" -eq 0 ]; then
  MYSQL_STARTUP_CHECK_INTERVAL_SECONDS=5
fi

echo "⏳ Waiting for MySQL at ${MYSQL_HOST}:${MYSQL_PORT} (checking every ${MYSQL_STARTUP_CHECK_INTERVAL_SECONDS}s for up to ${MYSQL_STARTUP_MAX_WAIT_SECONDS}s)..."
ELAPSED=0
MYSQL_READY=0

while [ "$ELAPSED" -lt "$MYSQL_STARTUP_MAX_WAIT_SECONDS" ]; do
  # Check if MySQL TCP port is open.
  if nc -z -w 2 "$MYSQL_HOST" "$MYSQL_PORT" 2>/dev/null; then
    # If mysql CLI exists, verify query connectivity with configured credentials.
    if command -v mysql >/dev/null 2>&1; then
      if [ -n "$MYSQL_PASSWORD" ]; then
        if MYSQL_PWD="$MYSQL_PASSWORD" mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -e "SELECT 1" >/dev/null 2>&1; then
          echo "✓ MySQL is ready! (connected successfully)"
          MYSQL_READY=1
          break
        fi
      else
        if mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -e "SELECT 1" >/dev/null 2>&1; then
          echo "✓ MySQL is ready! (connected successfully)"
          MYSQL_READY=1
          break
        fi
      fi
    else
      # mysql client not available; port-open is the best readiness signal here.
      echo "✓ MySQL port is open (assuming ready)"
      MYSQL_READY=1
      break
    fi
  fi

  echo "  Still waiting... (${ELAPSED}s/${MYSQL_STARTUP_MAX_WAIT_SECONDS}s)"
  sleep "$MYSQL_STARTUP_CHECK_INTERVAL_SECONDS"
  ELAPSED=$((ELAPSED + MYSQL_STARTUP_CHECK_INTERVAL_SECONDS))
done

if [ "$MYSQL_READY" -eq 0 ]; then
  echo "⚠ MySQL took longer than expected (waited ${ELAPSED}s), but continuing anyway..."
fi

echo "✓ Starting Node.js API server..."
node /app/api/server.js &
API_PID=$!

# Give API a moment to bind its port before starting nginx.
sleep "$UNIHUB_API_START_DELAY_SECONDS"

if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "✗ API server failed to start!"
  exit 1
fi

echo "✓ Starting Nginx..."
if ! nginx -t; then
  echo "✗ Nginx configuration test failed!"
  exit 1
fi

echo "✓ All services started. Container is ready."
exec nginx -g 'daemon off;'
