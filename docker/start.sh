#!/bin/sh

UNIHUB_API_START_DELAY_SECONDS="${UNIHUB_API_START_DELAY_SECONDS:-2}"

case "$UNIHUB_API_START_DELAY_SECONDS" in
  ''|*[!0-9]*) UNIHUB_API_START_DELAY_SECONDS=2 ;;
esac

# Use the API's driver/configuration for an authenticated check. The helper caps
# elapsed wait time; the API retains its own bounded retry if readiness expires.
node /app/api/src/mysql-readiness.js || true

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
