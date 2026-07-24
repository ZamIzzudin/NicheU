#!/bin/sh
set -e

# Public entry for Dokploy/Cloudflare = WEB on 3000
# API private on 4000; Next rewrites /api/* -> 127.0.0.1:4000
export API_PORT="${API_PORT:-4000}"
export PORT="${API_PORT}"
export WEB_PORT="${WEB_PORT:-3000}"
export WHATSAPP_AUTH_DIR="${WHATSAPP_AUTH_DIR:-/app/whatsapp_auth}"
export NODE_ENV=production
export HOSTNAME=0.0.0.0

mkdir -p "$WHATSAPP_AUTH_DIR"

echo "========================================"
echo " Starting Niche Daily"
echo "  API (internal): 127.0.0.1:${API_PORT}"
echo "  Web (public)  : 0.0.0.0:${WEB_PORT}"
echo "  Auth dir      : ${WHATSAPP_AUTH_DIR}"
echo "========================================"

# Fail early if build artifacts missing
if [ ! -f /app/dist/server/index.js ]; then
  echo "ERROR: /app/dist/server/index.js missing (server build not in image)"
  ls -la /app/dist 2>/dev/null || true
  exit 1
fi
if [ ! -d /app/web/.next ]; then
  echo "ERROR: /app/web/.next missing (next build not in image)"
  ls -la /app/web 2>/dev/null || true
  exit 1
fi
if [ ! -x /app/web/node_modules/.bin/next ] && [ ! -f /app/web/node_modules/next/dist/bin/next ]; then
  echo "ERROR: next binary missing under web/node_modules"
  exit 1
fi

# Start API
node /app/dist/server/index.js &
API_PID=$!

# Wait API health (max ~90s)
i=0
until node -e "fetch('http://127.0.0.1:${API_PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "ERROR: API process died while starting"
    exit 1
  fi
  if [ "$i" -ge 45 ]; then
    echo "ERROR: API failed to become healthy on :${API_PORT}"
    kill -TERM "$API_PID" 2>/dev/null || true
    exit 1
  fi
  echo "Waiting API health... ($i)"
  sleep 2
done
echo "✓ API healthy on :${API_PORT}"

# Start Next.js web
cd /app/web
if [ -x ./node_modules/.bin/next ]; then
  NEXT_BIN=./node_modules/.bin/next
else
  NEXT_BIN=./node_modules/next/dist/bin/next
fi

# Do not let Next inherit PORT=API_PORT (would confuse logs/tools).
# Rewrite target was baked at image build (API_PORT=4000).
PORT="$WEB_PORT" API_PORT="$API_PORT" "$NEXT_BIN" start -H 0.0.0.0 -p "$WEB_PORT" &
WEB_PID=$!

# Wait web (max ~60s)
i=0
until node -e "fetch('http://127.0.0.1:${WEB_PORT}/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "ERROR: Web process died while starting"
    kill -TERM "$API_PID" 2>/dev/null || true
    exit 1
  fi
  if [ "$i" -ge 30 ]; then
    echo "ERROR: Web failed to become healthy on :${WEB_PORT}"
    kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
    exit 1
  fi
  echo "Waiting Web health... ($i)"
  sleep 2
done
echo "✓ Web healthy on :${WEB_PORT}"
echo "Ready for Dokploy/Cloudflare (domain port must be ${WEB_PORT})"

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
