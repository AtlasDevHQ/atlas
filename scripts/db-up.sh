#!/usr/bin/env bash
set -euo pipefail

if ! docker compose up -d postgres; then
  echo "Error: Failed to start Postgres container." >&2
  echo "Check that Docker is running and port 5432 is free." >&2
  exit 1
fi

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
