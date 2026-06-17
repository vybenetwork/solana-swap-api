#!/usr/bin/env bash
# Prod-like local stack: ix-builder :8000 + local Vybe proxy :8080 → swap-api uses remote Vybe URL.
set -euo pipefail

IX_DIR="${IX_BUILDER_DIR:-/Users/user/Projects/ix-builder-api-main-nodejs}"
SWAP_DIR="${SWAP_API_DIR:-/Users/user/Projects/solana-quote-swap-api}"
IX_PORT="${IX_BUILDER_PORT:-8000}"
PROXY_PORT="${LOCAL_VYBE_PROXY_PORT:-8080}"

export IX_BUILDER_BASE_URL="http://127.0.0.1:${IX_PORT}"
export LOCAL_VYBE_PROXY_PORT="${PROXY_PORT}"

cleanup() {
  [[ -n "${IX_PID:-}" ]] && kill "$IX_PID" 2>/dev/null || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting ix-builder on :${IX_PORT}…"
(cd "$IX_DIR" && PORT="$IX_PORT" npm start) &
IX_PID=$!
sleep 2

echo "Starting local Vybe proxy on :${PROXY_PORT}…"
node "$SWAP_DIR/tools/local-vybe-proxy.mjs" &
PROXY_PID=$!
sleep 1

if curl -fsS "http://127.0.0.1:${IX_PORT}/health" >/dev/null 2>&1; then
  echo "ix-builder health OK"
else
  echo "ix-builder not responding on :${IX_PORT} (continuing anyway)"
fi

echo ""
echo "Prod-like stack running."
echo "  ix-builder:  http://127.0.0.1:${IX_PORT}"
echo "  Vybe proxy:  http://127.0.0.1:${PROXY_PORT}"
echo ""
echo "swap-api .env:"
echo "  vybe_api_location=remote"
echo "  VYBE_API_BASE=http://127.0.0.1:${PROXY_PORT}"
echo ""
echo "Then: cd \"$SWAP_DIR\" && PORT=3000 npm run dev"
echo "Press Ctrl+C to stop ix-builder + proxy."

wait
