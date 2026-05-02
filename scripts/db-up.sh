#!/usr/bin/env bash
set -euo pipefail

# Pre-create bind-mount source directories with host-user ownership.
# docker-compose mounts ./semantic into the sandbox container; if the host
# path doesn't exist, the docker daemon creates it as root, which then
# breaks wizard save (EACCES on mkdir semantic/.orgs/) and `atlas init`.
# See issue #1951.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if ! mkdir -p "$REPO_ROOT/semantic"; then
  echo "Error: cannot create $REPO_ROOT/semantic (needed for sandbox bind-mount, see #1951)." >&2
  exit 1
fi
# If the directory was created by a prior root-owned `docker compose up`,
# `mkdir -p` is a no-op. Probe writability so we surface the real cause
# now, instead of letting the wizard hit a confusing EACCES later.
if [ ! -w "$REPO_ROOT/semantic" ] || ! ( probe="$REPO_ROOT/semantic/.atlas-write-probe-$$"; touch "$probe" 2>/dev/null && rm -f "$probe" ); then
  echo "Error: $REPO_ROOT/semantic exists but is not writable by $(id -un)." >&2
  echo "This usually means a prior 'docker compose up' created it as root (see #1951)." >&2
  echo "Fix: sudo chown -R \"\$(id -u):\$(id -g)\" \"$REPO_ROOT/semantic\"" >&2
  exit 1
fi

# Start all services: Postgres + sandbox sidecar
if ! docker compose up -d; then
  echo "Error: Failed to start containers." >&2
  echo "Check that Docker is running and ports 5432/8080 are free." >&2
  exit 1
fi

# --- Wait for Postgres ---

echo "Waiting for Postgres..."
pg_ready=false
pg_err=""
for i in $(seq 1 30); do
  if pg_err=$(docker compose exec -T postgres pg_isready -U atlas -q 2>&1); then
    pg_ready=true
    break
  fi
  sleep 1
done

if [ "$pg_ready" = false ]; then
  echo "Error: Postgres not ready after 30s." >&2
  if [ -n "$pg_err" ]; then
    echo "$pg_err" >&2
  fi
  exit 1
fi

echo "Postgres is ready."

psql_out=""
if ! psql_out=$(docker compose exec -T postgres psql -U atlas -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'atlas_demo'" 2>&1); then
  echo "Error: Failed to query Postgres." >&2
  echo "$psql_out" >&2
  exit 1
fi

if ! echo "$psql_out" | grep -q 1; then
  echo "" >&2
  echo "Error: Database 'atlas_demo' not found." >&2
  echo "The pgdata volume may be stale. Run 'bun run db:reset' to re-initialize." >&2
  echo "" >&2
  exit 1
fi

# --- Wait for sandbox sidecar ---

echo "Waiting for sandbox sidecar..."
sidecar_ready=false
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    sidecar_ready=true
    break
  fi
  sleep 1
done

if [ "$sidecar_ready" = false ]; then
  echo "Error: Sandbox sidecar not ready after 30s." >&2
  echo "Check 'docker compose logs sandbox' for details." >&2
  exit 1
fi

echo "Sandbox sidecar is ready."
