#!/bin/bash
set -e

# Start the ps5upload engine in the background.
# PS5_ADDR can be overridden at runtime via docker compose environment.
PS5_ADDR="${PS5_ADDR:-192.168.1.x:9113}"

echo "[entrypoint] Starting ps5upload-engine (ps5=${PS5_ADDR})"
PS5_ADDR="${PS5_ADDR}" /usr/local/bin/ps5upload-engine &
ENGINE_PID=$!

# Give the engine a moment to bind :19113 before Nginx starts
sleep 1

echo "[entrypoint] Starting Nginx"
nginx -g "daemon off;" &
NGINX_PID=$!

# Wait for either process to exit — if one dies, kill the other and exit
wait -n $ENGINE_PID $NGINX_PID
STATUS=$?

echo "[entrypoint] A process exited (status=${STATUS}), shutting down"
kill $ENGINE_PID $NGINX_PID 2>/dev/null || true
exit $STATUS
