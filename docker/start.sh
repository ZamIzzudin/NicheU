#!/bin/sh
set -e

export PORT="${PORT:-3000}"
export WEB_PORT="${WEB_PORT:-3001}"
export API_PORT="${API_PORT:-$PORT}"
export WHATSAPP_AUTH_DIR="${WHATSAPP_AUTH_DIR:-/app/whatsapp_auth}"
export NODE_ENV=production

mkdir -p "$WHATSAPP_AUTH_DIR"

echo "Starting Niche Daily"
echo "  API : http://0.0.0.0:${PORT}"
echo "  Web : http://0.0.0.0:${WEB_PORT}"
echo "  Auth: ${WHATSAPP_AUTH_DIR}"

# Start API (compiled)
node dist/server/index.js &
API_PID=$!

# Start Next.js web (proxies /api/* to API via next.config rewrite)
cd /app/web
npx next start -H 0.0.0.0 -p "$WEB_PORT" &
WEB_PID=$!

term() {
  echo "Shutting down..."
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap term INT TERM

# If either dies, stop container
while true; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API process exited"
    kill -TERM "$WEB_PID" 2>/dev/null || true
    wait "$API_PID" || true
    exit 1
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Web process exited"
    kill -TERM "$API_PID" 2>/dev/null || true
    wait "$WEB_PID" || true
    exit 1
  fi
  sleep 2
done
