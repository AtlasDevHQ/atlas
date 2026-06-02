#!/bin/sh
# Start the Hono API server.
# AtlasDevHQ production deployment (api.useatlas.dev).
set -e

# Resolve whether to seed demo data through the env-profile (#2937):
# ATLAS_SEED_DEMO override → deploy-env profile default. resolve-seed-demo.ts
# prints "true"/"false". If it can't run (empty output), fall back to the
# legacy raw check so the "Atlas Demo" template (ATLAS_SEED_DEMO=true) never
# silently stops seeding.
SEED_DEMO="$(bun /app/scripts/resolve-seed-demo.ts 2>/dev/null || true)"
# Trust ONLY the two known-good tokens. Empty output (shim failed to run) or any
# unexpected value routes through the legacy raw check, so the "Atlas Demo"
# template (ATLAS_SEED_DEMO=true) can never silently stop seeding.
if [ "$SEED_DEMO" != "true" ] && [ "$SEED_DEMO" != "false" ]; then
    [ "$ATLAS_SEED_DEMO" = "true" ] && SEED_DEMO="true" || SEED_DEMO="false"
fi

# Seed demo data if enabled.
# Retries up to 5 times with 3s intervals to wait for Postgres readiness.
# Note: seed command is inside `if`, so set -e does not apply to it (POSIX spec).
if [ "$SEED_DEMO" = "true" ] && [ -n "$ATLAS_DATASOURCE_URL" ]; then
    SEED_OK=false
    for i in 1 2 3 4 5; do
        if bun /app/scripts/seed-demo.ts; then SEED_OK=true; break; fi
        if [ "$i" -lt 5 ]; then
            echo "start.sh: seed attempt $i/5 failed, retrying in 3s..."
            sleep 3
        fi
    done
    if [ "$SEED_OK" = "false" ]; then
        echo "start.sh: WARNING — demo seeding failed after 5 attempts. App will start without demo data." >&2
        echo "start.sh: Check ATLAS_DATASOURCE_URL and Postgres availability." >&2
    fi
fi

exec bun packages/api/src/api/server.ts
