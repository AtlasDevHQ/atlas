#!/usr/bin/env bash
set -euo pipefail

# Stop ALL Atlas-related Docker containers across every checkout,
# remove their volumes, and clean up dangling images.
#
# Usage: bun run db:nuke

echo "Stopping Atlas containers across all checkouts..."

# 1. Stop containers whose compose project comes from any atlas checkout.
#    Container names follow the pattern: <project>-<service>-<n>
#    where project is the directory name (1, 2, 3, ide, etc.).
atlas_containers=$(docker ps -aq --filter "ancestor=postgres:16-alpine" 2>/dev/null || true)

# Also grab any sandbox sidecar containers (image built from this repo).
sidecar_containers=$(docker ps -aq --filter "name=sandbox" 2>/dev/null || true)

all_containers=$(echo -e "${atlas_containers}\n${sidecar_containers}" | sort -u | grep -v '^$' || true)

if [ -n "$all_containers" ]; then
  echo "Stopping and removing containers..."
  echo "$all_containers" | xargs docker rm -f 2>/dev/null || true
else
  echo "No Atlas containers running."
fi

# 2. Bring down compose in the current project (cleans networks).
docker compose down -v 2>/dev/null || true

# 3. Remove orphaned atlas pgdata volumes from any checkout.
echo "Removing Atlas volumes..."
atlas_volumes=$(docker volume ls -q | grep -E '(pgdata|atlas)' 2>/dev/null || true)
if [ -n "$atlas_volumes" ]; then
  echo "$atlas_volumes" | xargs docker volume rm -f 2>/dev/null || true
fi

echo ""
echo "Done. Run 'bun run dev' to start fresh."
