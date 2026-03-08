#!/usr/bin/env bash
set -euo pipefail

# E2E test orchestrator.
#
# Usage:
#   bash e2e/scripts/run.sh                    # Run core + scaffold (no API key needed)
#   bash e2e/scripts/run.sh --tier core        # Core surfaces only (needs Docker)
#   bash e2e/scripts/run.sh --tier query       # Query surface only (needs Docker + ANTHROPIC_API_KEY)
#   bash e2e/scripts/run.sh --tier scaffold    # Scaffold only (no Docker needed)
#   bash e2e/scripts/run.sh --surface auth     # Run a specific surface (needs Docker)
#   bash e2e/scripts/run.sh --all              # Run all surfaces including query
#   bash e2e/scripts/run.sh --no-docker ...    # Skip Docker lifecycle (CI: services already provisioned)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"

TIER=""
SURFACE=""
RUN_ALL=false
NO_DOCKER=false

while [ $# -gt 0 ]; do
  case "$1" in
    --all) RUN_ALL=true ;;
    --no-docker) NO_DOCKER=true ;;
    --tier)
      shift
      if [ -z "${1:-}" ]; then
        echo "ERROR: --tier requires a value (core, query, scaffold)" >&2
        exit 1
      fi
      case "$1" in
        core|query|scaffold) TIER="$1" ;;
        *)
          echo "ERROR: Unknown tier '$1'. Must be: core, query, scaffold" >&2
          exit 1
          ;;
      esac
      ;;
    --surface)
      shift
      if [ -z "${1:-}" ]; then
        echo "ERROR: --surface requires a surface name" >&2
        exit 1
      fi
      if [ ! -f "$E2E_DIR/surfaces/$1.test.ts" ]; then
        echo "ERROR: Unknown surface '$1'. Available:" >&2
        for f in "$E2E_DIR"/surfaces/*.test.ts; do
          echo "  $(basename "$f" .test.ts)" >&2
        done
        exit 1
      fi
      SURFACE="$1"
      ;;
    *)
      echo "ERROR: Unknown argument '$1'. Usage: run.sh [--tier core|query|scaffold] [--surface <name>] [--all] [--no-docker]" >&2
      exit 1
      ;;
  esac
  shift
done

# --- Surface definitions ---
CORE_SURFACES=(helpers health auth auth-managed conversations slack actions mcp scheduler agent-multistep error-scenarios)
QUERY_SURFACES=(query)
SCAFFOLD_SURFACES=(scaffold)

# --- Determine if Docker is needed ---
NEEDS_DOCKER=true
if [ "$TIER" = "scaffold" ] || [ "$NO_DOCKER" = true ]; then
  NEEDS_DOCKER=false
fi

# --- Docker lifecycle ---
start_docker() {
  if ! command -v docker &>/dev/null; then
    echo "ERROR: docker is not installed or not in PATH" >&2
    exit 1
  fi
  if ! docker info &>/dev/null 2>&1; then
    echo "ERROR: Docker daemon is not running" >&2
    exit 1
  fi

  echo "==> Starting E2E services..."
  if ! docker compose -f "$E2E_DIR/docker-compose.yml" up -d --wait; then
    echo "ERROR: Failed to start E2E services. Check port conflicts (5433, 3307, 8124, 1025, 8025)." >&2
    echo "  Try: docker compose -f $E2E_DIR/docker-compose.yml down -v" >&2
    exit 1
  fi

  # Cleanup on exit
  cleanup() {
    echo ""
    echo "==> Stopping E2E services..."
    if ! docker compose -f "$E2E_DIR/docker-compose.yml" down -v; then
      echo "WARNING: cleanup failed, containers may still be running" >&2
      echo "  Run: docker compose -f $E2E_DIR/docker-compose.yml down -v" >&2
    fi
  }
  trap cleanup EXIT
}

if [ "$NEEDS_DOCKER" = true ]; then
  start_docker
fi

# --- Run tests ---
FAILURES=0

run_surface() {
  local name="$1"
  local allow_missing="${2:-false}"
  local test_file="$E2E_DIR/surfaces/$name.test.ts"
  if [ ! -f "$test_file" ]; then
    if [ "$allow_missing" = true ]; then
      echo "--- Skipping $name.test.ts (file not found) ---"
      return 0
    fi
    echo "ERROR: Test file not found: $test_file" >&2
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  echo "--- $name.test.ts ---"
  if ! bun test "$test_file"; then
    echo "FAIL: $name.test.ts"
    FAILURES=$((FAILURES + 1))
  fi
}

run_surfaces() {
  local surfaces=("$@")
  for name in "${surfaces[@]}"; do
    run_surface "$name"
  done
}

if [ -n "$SURFACE" ]; then
  echo "==> Running E2E tests for surface: $SURFACE"
  run_surface "$SURFACE"
elif [ "$RUN_ALL" = true ]; then
  echo "==> Running ALL E2E tests..."
  for test_file in "$E2E_DIR"/surfaces/*.test.ts; do
    name="$(basename "$test_file" .test.ts)"
    run_surface "$name"
  done
elif [ -n "$TIER" ]; then
  echo "==> Running E2E tests for tier: $TIER"
  case "$TIER" in
    core)     run_surfaces "${CORE_SURFACES[@]}" ;;
    query)    run_surfaces "${QUERY_SURFACES[@]}" ;;
    scaffold) run_surfaces "${SCAFFOLD_SURFACES[@]}" ;;
  esac
else
  # Default: core + scaffold (skip query)
  echo "==> Running core E2E tests..."
  run_surfaces "${CORE_SURFACES[@]}"
  echo "==> Running scaffold E2E tests..."
  run_surfaces "${SCAFFOLD_SURFACES[@]}"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "==> E2E tests FAILED ($FAILURES surface(s) failed)"
  exit 1
fi
echo "==> E2E tests complete (all passed)."
