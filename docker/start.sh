#!/bin/sh

echo "⏳ Waiting for MySQL to be ready (checking every 5 seconds for up to 120 seconds)..."
# Wait for MySQL healthcheck to pass (max 2 minutes with 5s intervals)
MAX_WAIT=120
ELAPSED=0
MYSQL_READY=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  # Check if MySQL port is open using nc (netcat) - more reliable than bash TCP redirection
  if nc -z -w 2 unihub-mysql 3306 2>/dev/null; then
    # Port is open, try to connect with mysql client (using mysql command if available)
    # If mysql client is not available, just check port - that's usually enough
    if command -v mysql >/dev/null 2>&1; then
      if mysql -h unihub-mysql -u root -p"${MYSQL_ROOT_PASSWORD:-CHANGE_ME_root_password}" -e "SELECT 1" >/dev/null 2>&1; then
        echo "✓ MySQL is ready! (connected successfully)"
        MYSQL_READY=1
        break
      fi
    else
      # mysql client not available, but port is open - assume MySQL is ready
      echo "✓ MySQL port is open (assuming ready)"
      MYSQL_READY=1
      break
    fi
  fi
  
  echo "  Still waiting... (${ELAPSED}s/${MAX_WAIT}s)"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [ $MYSQL_READY -eq 0 ]; then
  echo "⚠ MySQL took longer than expected (waited ${ELAPSED}s), but continuing anyway..."
fi

echo "✓ Starting Node.js API server..."
# Start the Node.js API server in the background
node /app/api/server.js &
API_PID=$!

# Give API a moment to start
sleep 2

# Check if API process is still running
if ! kill -0 $API_PID 2>/dev/null; then
  echo "✗ API server failed to start!"
  exit 1
fi

echo "✓ Starting Nginx..."
# Test nginx configuration
if ! nginx -t; then
  echo "✗ Nginx configuration test failed!"
  exit 1
fi

# Start Nginx in the foreground (keeps container alive)
echo "✓ All services started. Container is ready."
exec nginx -g 'daemon off;'
