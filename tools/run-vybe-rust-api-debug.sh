#!/usr/bin/env bash
# Run local Vybe Rust API (staging env) against local ix-builder for swap enumeration debugging.
# Keeps local-vybe-proxy on :8080; Rust API listens on :8090.
#
# Prerequisites:
#   - VPN routing to staging DB/Redis (10.192.x, 172.18.x)
#   - ix-builder on :8000 (PORT=8000 npm start in ix-builder-api-main-nodejs)
#   - vybe_api_rust/.env populated (see team staging secrets + IX_BUILDER_BASE_URL)
#
# To hit Rust API from swap-api (instead of local proxy for swap):
#   VYBE_API_BASE=http://127.0.0.1:8090
#
set -euo pipefail

RUST_DIR="${VYBE_API_RUST_DIR:-/Users/user/Projects/vybe_api_rust}"
SWAP_DIR="${SWAP_API_DIR:-/Users/user/Projects/solana-quote-swap-api}"
IX_PORT="${IX_BUILDER_PORT:-8000}"
PROXY_PORT="${LOCAL_VYBE_PROXY_PORT:-8080}"
RUST_PORT="${VYBE_RUST_API_PORT:-8090}"

export IX_BUILDER_BASE_URL="http://127.0.0.1:${IX_PORT}"
export LOCAL_VYBE_PROXY_PORT="${PROXY_PORT}"

cleanup() {
  [[ -n "${RUST_PID:-}" ]] && kill "$RUST_PID" 2>/dev/null || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

if ! curl -fsS --connect-timeout 2 "http://127.0.0.1:${IX_PORT}/health" >/dev/null 2>&1; then
  echo "ix-builder not on :${IX_PORT} — start it first:"
  echo "  cd ix-builder-api-main-nodejs && PORT=${IX_PORT} npm start"
  exit 1
fi

if ! lsof -i ":${PROXY_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Starting local Vybe proxy on :${PROXY_PORT}…"
  node "$SWAP_DIR/tools/local-vybe-proxy.mjs" &
  PROXY_PID=$!
  sleep 1
else
  echo "local Vybe proxy already on :${PROXY_PORT}"
fi

if [[ ! -f "$RUST_DIR/.env" ]]; then
  echo "Missing $RUST_DIR/.env — copy staging env and set:"
  echo "  API_PORT=${RUST_PORT}"
  echo "  IX_BUILDER_BASE_URL=http://127.0.0.1:${IX_PORT}"
  exit 1
fi

echo "Building vybe_api…"
(cd "$RUST_DIR" && cargo build -p vybe_api --bin vybe_api)

echo "Starting Rust Vybe API on :${RUST_PORT}…"
(
  cd "$RUST_DIR"
  export API_PORT="${RUST_PORT}"
  export IX_BUILDER_BASE_URL="http://127.0.0.1:${IX_PORT}"
  ./target/debug/vybe_api
) &
RUST_PID=$!

for i in $(seq 1 60); do
  if curl -fsS --connect-timeout 1 "http://127.0.0.1:${RUST_PORT}/v4/health" >/dev/null 2>&1; then
    echo "Rust API ready on http://127.0.0.1:${RUST_PORT}"
    break
  fi
  if ! kill -0 "$RUST_PID" 2>/dev/null; then
    echo "Rust API exited during startup — check VPN/DB connectivity"
    wait "$RUST_PID" || true
    exit 1
  fi
  sleep 1
done

echo ""
echo "Stack:"
echo "  ix-builder:   http://127.0.0.1:${IX_PORT}"
echo "  local proxy:  http://127.0.0.1:${PROXY_PORT}  (swap via ix-builder enumerate)"
echo "  Rust API:     http://127.0.0.1:${RUST_PORT}  (prod-like /v4/trading/swap)"
echo ""
echo "Test enumerate (Rust API):"
echo "  curl -X POST http://127.0.0.1:${RUST_PORT}/v4/trading/swap -H 'Content-Type: application/json' -H 'x-api-key: \$VYBE_API_KEY' -d @tools/fixtures/sol-bonk-enumerate.json"
echo ""
echo "swap-api .env for Rust path:"
echo "  VYBE_API_BASE=http://127.0.0.1:${RUST_PORT}"
echo ""

wait "$RUST_PID"
