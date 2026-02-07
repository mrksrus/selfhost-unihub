#!/bin/sh

# Wait for MySQL to finish initializing (first boot can take 2+ minutes)
echo "Waiting 120 seconds for MySQL to be ready…"
sleep 120

# Start the Node.js API server in the background
node /app/api/server.js &

# Start Nginx in the foreground (keeps container alive)
exec nginx -g 'daemon off;'
