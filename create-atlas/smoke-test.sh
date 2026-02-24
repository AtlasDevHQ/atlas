#!/usr/bin/env bash
set -euo pipefail

# Smoke test for create-atlas-agent
# Scaffolds a project using --defaults, installs, builds, and verifies artifacts.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
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
echo "==> Scaffolding project with --defaults..."
cd "$TMP_DIR"
bun "$SCRIPT_DIR/index.ts" "$PROJECT_NAME" --defaults

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

# Check public/ exists
if [ ! -d "$TARGET_DIR/public" ]; then
  echo "FAIL: public/ directory not found"
  exit 1
fi
echo "  OK: public/ exists"

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

if ! grep -q "DATABASE_URL=file:./data/atlas.db" "$TARGET_DIR/.env"; then
  echo "FAIL: .env missing DATABASE_URL"
  exit 1
fi
echo "  OK: .env has DATABASE_URL"

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

# Check semantic layer was generated (from --demo)
if [ ! -f "$TARGET_DIR/semantic/catalog.yml" ]; then
  echo "FAIL: semantic/catalog.yml not found (demo seeding failed?)"
  exit 1
fi
echo "  OK: semantic/catalog.yml exists"

if [ ! -d "$TARGET_DIR/semantic/entities" ]; then
  echo "FAIL: semantic/entities/ not found"
  exit 1
fi
echo "  OK: semantic/entities/ exists"

echo ""
echo "==> Building project..."
cd "$TARGET_DIR"
unset VERCEL  # Ensure standalone output is generated (template skips it when VERCEL is set)
bun run build

# Check .next/standalone exists
if [ ! -d "$TARGET_DIR/.next/standalone" ]; then
  echo "FAIL: .next/standalone not found after build"
  exit 1
fi
echo "  OK: .next/standalone exists"

echo ""
echo "==> All checks passed!"
