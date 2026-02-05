#!/bin/sh

# Start the Node.js API server in the background
node /app/api/server.js &

# Start Nginx in the foreground (keeps container alive)
exec nginx -g 'daemon off;'
