#!/usr/bin/env bash
set -euo pipefail

# E2E smoke test orchestrator.
# Starts local Postgres, seeds the canonical demo data, launches the API, runs
# smoke tests, then cleans up. Uses port 3099 to avoid conflict with dev on 3001.
#
# Atlas ships a single canonical demo dataset since 1.4.0 (#2021): NovaMart
# e-commerce. The previous --demo simple|cybersec picker is gone.
#
# Usage:
#   bash scripts/smoke.sh           # seeds the canonical NovaMart demo
#   bash scripts/smoke.sh --keep    # leave DB running after test

PORT=3099
API_PID=""
KEEP_DB=false
SMOKE_API_KEY="smoke-test-key-$(date +%s)"


for arg in "$@"; do
  case "$arg" in
    --keep) KEEP_DB=true ;;
  esac
done

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    echo "  Stopped API server (PID $API_PID)"
  fi
  if [ "$KEEP_DB" = false ]; then
    docker compose down 2>/dev/null || true
    echo "  Stopped database"
  else
    echo "  Database left running (--keep)"
  fi
}
trap cleanup EXIT

echo "==> Starting Postgres..."
bun run db:up

echo ""
echo "==> Seeding canonical demo data (NovaMart ecommerce)..."
bun run atlas -- init --demo --no-enrich

echo ""
echo "==> Starting API server on port $PORT..."
# Override env vars that may come from .env — Bun auto-loads .env, so unset won't
# work. Setting to empty ensures clean auth (simple-key only) and disables rate limiting.
ATLAS_API_KEY="$SMOKE_API_KEY" \
ATLAS_AUTH_JWKS_URL="" \
ATLAS_AUTH_ISSUER="" \
ATLAS_AUTH_AUDIENCE="" \
BETTER_AUTH_SECRET="" \
BETTER_AUTH_URL="" \
BETTER_AUTH_TRUSTED_ORIGINS="" \
ATLAS_RATE_LIMIT_RPM="0" \
ATLAS_DATASOURCE_URL="postgresql://atlas:atlas@localhost:5432/atlas_demo" \
PORT="$PORT" \
bun packages/api/src/api/server.ts &
API_PID=$!

# Wait for API to be ready
echo "  Waiting for API..."
ready=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/api/health" > /dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" = false ]; then
  echo "  ERROR: API server not ready after 30s"
  exit 1
fi
echo "  API server ready (PID $API_PID)"

echo ""
echo "==> Running smoke tests..."
bun run atlas -- smoke \
  --target "http://localhost:$PORT" \
  --api-key "$SMOKE_API_KEY" \
  --verbose

EXIT_CODE=$?
exit $EXIT_CODE
