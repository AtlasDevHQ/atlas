#!/bin/sh
# Start both API and web servers with proper signal handling.
# Used in Docker production builds where both processes run in one container.
#
# Platforms like Railway set PORT for external traffic routing.
# Next.js inherits PORT (external-facing), while the API server gets a
# fixed internal port (ATLAS_API_PORT, default 3001) that the Next.js
# rewrite targets (ATLAS_API_URL defaults to http://localhost:3001).
set -e

cleanup() {
    echo "start.sh: shutting down child processes..."
    kill "$API_PID" "$WEB_PID" 2>/dev/null || true
    wait "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup INT TERM

PORT="${ATLAS_API_PORT:-3001}" bun packages/api/src/api/server.ts &
API_PID=$!

bun packages/web/server.js &
WEB_PID=$!

# Poll until either child exits. POSIX sh lacks wait -n, so we check liveness.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
    sleep 1
done

# Determine which process died and report it.
if ! kill -0 "$API_PID" 2>/dev/null; then
    wait "$API_PID" 2>/dev/null || EXIT_CODE=$?
    echo "start.sh: API server (PID $API_PID) exited with code ${EXIT_CODE:-0}" >&2
else
    wait "$WEB_PID" 2>/dev/null || EXIT_CODE=$?
    echo "start.sh: Next.js web server (PID $WEB_PID) exited with code ${EXIT_CODE:-0}" >&2
fi

cleanup
exit "${EXIT_CODE:-1}"
