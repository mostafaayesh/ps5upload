#!/bin/bash
set -e

# Ensure the shared-state directory exists before the engine starts so
# the first write doesn't race with directory creation. The engine will
# also create it on startup, but doing it here avoids any startup log
# noise about falling back to the temp-dir path.
SHARED_STATE_DIR="${PS5UPLOAD_STATE_DIR:-/var/log/ps5upload/shared-state}"
mkdir -p "${SHARED_STATE_DIR}" 2>/dev/null || true

# Start the ps5upload engine in the background.
# PS5_ADDR can be overridden at runtime via docker compose environment.
PS5_ADDR="${PS5_ADDR:-192.168.1.x:9113}"

echo "[entrypoint] Starting ps5upload-engine (ps5=${PS5_ADDR})"
PS5_ADDR="${PS5_ADDR}" /usr/local/bin/ps5upload-engine &
ENGINE_PID=$!

# Give the engine a moment to bind :19113 before Nginx starts
sleep 1

# Update Nginx listen port dynamically from PORT (defaults to 8080)
PORT="${PORT:-8080}"
echo "[entrypoint] Configuring Nginx to listen on port ${PORT}"
sed -i "s/listen 80;/listen ${PORT};/g" /etc/nginx/sites-enabled/ps5upload

echo "[entrypoint] Starting Nginx"
nginx -g "daemon off;" &
NGINX_PID=$!

# Wait for either process to exit — if one dies, kill the other and exit
wait -n $ENGINE_PID $NGINX_PID
STATUS=$?

echo "[entrypoint] A process exited (status=${STATUS}), shutting down"
kill $ENGINE_PID $NGINX_PID 2>/dev/null || true
exit $STATUS
