#!/usr/bin/env bash
set -euo pipefail

# Smoke test for @useatlas/create
# Scaffolds a project using --defaults, installs, builds, and verifies artifacts.
# Usage: bash smoke-test.sh [platform]  (default: docker)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
PLATFORM="${1:-docker}"
PROJECT_NAME="smoke-test-app"
TARGET_DIR="$TMP_DIR/$PROJECT_NAME"

cleanup() {
  echo "Cleaning up $TMP_DIR..."
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "==> Running prepublishOnly to refresh template..."
cd "$SCRIPT_DIR"
bun run prepublishOnly

echo ""
echo "==> Scaffolding project with --defaults --platform $PLATFORM..."
cd "$TMP_DIR"
bun "$SCRIPT_DIR/index.ts" "$PROJECT_NAME" --defaults --platform "$PLATFORM"

echo ""
echo "==> Verifying scaffolded project..."

# Check .gitignore exists (renamed from gitignore)
if [ ! -f "$TARGET_DIR/.gitignore" ]; then
  echo "FAIL: .gitignore not found"
  exit 1
fi
echo "  OK: .gitignore exists"

# Check gitignore (source) was removed
if [ -f "$TARGET_DIR/gitignore" ]; then
  echo "FAIL: gitignore (source) was not renamed"
  exit 1
fi
echo "  OK: gitignore renamed correctly"

# Check public/ exists (docker template only — all platforms except vercel)
if [ "$PLATFORM" != "vercel" ]; then
  if [ ! -d "$TARGET_DIR/public" ]; then
    echo "FAIL: public/ directory not found"
    exit 1
  fi
  echo "  OK: public/ exists"
fi

# Check .env was written
if [ ! -f "$TARGET_DIR/.env" ]; then
  echo "FAIL: .env not found"
  exit 1
fi
echo "  OK: .env exists"

# Validate .env contents
if ! grep -q "ATLAS_PROVIDER=anthropic" "$TARGET_DIR/.env"; then
  echo "FAIL: .env missing ATLAS_PROVIDER=anthropic"
  exit 1
fi
echo "  OK: .env has ATLAS_PROVIDER"

if ! grep -q "ATLAS_DATASOURCE_URL=" "$TARGET_DIR/.env"; then
  echo "FAIL: .env missing ATLAS_DATASOURCE_URL"
  exit 1
fi
echo "  OK: .env has ATLAS_DATASOURCE_URL"

# Check package.json has project name
if ! grep -q "\"name\": \"$PROJECT_NAME\"" "$TARGET_DIR/package.json"; then
  echo "FAIL: package.json does not contain project name"
  exit 1
fi
echo "  OK: package.json has correct name"

# Check node_modules exists (bun install ran)
if [ ! -d "$TARGET_DIR/node_modules" ]; then
  echo "FAIL: node_modules not found (bun install failed?)"
  exit 1
fi
echo "  OK: node_modules exists"

# Note: Semantic layer generation requires a running database.
# With PostgreSQL as the default, demo seeding may not succeed without a live server.
# We only verify that the semantic directory exists (created by the template).
if [ -d "$TARGET_DIR/semantic" ]; then
  echo "  OK: semantic/ directory exists"
else
  echo "  WARN: semantic/ directory not found (expected — no database available during smoke test)"
fi

echo ""
echo "==> Building project..."
cd "$TARGET_DIR"
unset VERCEL  # Ensure standalone output is generated (template skips it when VERCEL is set)
bun run build

# Check build output based on template
# Note: The create-atlas docker *template* uses Next.js (so .next/standalone is correct here).
# This is distinct from the *example* at examples/docker/, which is API-only (Hono).
if [ "$PLATFORM" != "vercel" ]; then
  if [ ! -d "$TARGET_DIR/.next/standalone" ]; then
    echo "FAIL: .next/standalone not found after build"
    exit 1
  fi
  echo "  OK: .next/standalone exists"
else
  echo "  OK: build succeeded (no build artifacts to check)"
fi

echo ""
echo "==> All checks passed!"
