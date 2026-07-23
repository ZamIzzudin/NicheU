#!/bin/sh
set -e

# Public entry for Dokploy domains = WEB on 3000 (single published port).
# API stays private on 4000; Next rewrites /api/* -> 127.0.0.1:4000
export API_PORT="${API_PORT:-4000}"
export PORT="${API_PORT}"
export WEB_PORT="${WEB_PORT:-3000}"
export WHATSAPP_AUTH_DIR="${WHATSAPP_AUTH_DIR:-/app/whatsapp_auth}"
export NODE_ENV=production

mkdir -p "$WHATSAPP_AUTH_DIR"

echo "Starting Niche Daily"
echo "  API (internal): http://127.0.0.1:${API_PORT}"
echo "  Web (public)  : http://0.0.0.0:${WEB_PORT}"
echo "  Auth dir      : ${WHATSAPP_AUTH_DIR}"

# Start API first
node /app/dist/server/index.js &
API_PID=$!

# Wait until API health is up (max ~60s)
i=0
until node -e "fetch('http://127.0.0.1:${API_PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "API failed to become healthy"
    kill -TERM "$API_PID" 2>/dev/null || true
    exit 1
  fi
  echo "Waiting API... ($i)"
  sleep 2
done
echo "API healthy"

# Start Next.js web on public WEB_PORT (default 3000 for Dokploy)
cd /app/web
./node_modules/.bin/next start -H 0.0.0.0 -p "$WEB_PORT" &
WEB_PID=$!

term() {
  echo "Shutting down..."
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap term INT TERM

while true; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API process exited"
    kill -TERM "$WEB_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Web process exited"
    kill -TERM "$API_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done
