#!/bin/sh
# Start the Hono API server.
# Used in Docker production builds (API-only deployment).
#
# For full-stack deployment (API + Next.js frontend), see examples/nextjs-standalone/.
set -e

# Seed demo data if ATLAS_SEED_DEMO is enabled (Railway "Atlas Demo" template).
# Retries up to 5 times with 3s intervals to wait for Postgres readiness.
# Note: seed command is inside `if`, so set -e does not apply to it (POSIX spec).
if [ "$ATLAS_SEED_DEMO" = "true" ] && [ -n "$ATLAS_DATASOURCE_URL" ]; then
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
