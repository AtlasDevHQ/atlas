#!/usr/bin/env bash
set -euo pipefail

# prepare-templates.sh
# Syncs monorepo source files into create-atlas template directories.
# Called by prepublishOnly to ensure templates are up-to-date before npm publish.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."          # create-atlas/
MONOREPO="$ROOT/.."            # repo root

TEMPLATES="$ROOT/templates"
CLI_BIN="$MONOREPO/packages/cli/bin"
CLI_DATA="$MONOREPO/packages/cli/data"
API_SRC="$MONOREPO/packages/api/src"
WEB_SRC="$MONOREPO/packages/web/src"
WEB_APP="$WEB_SRC/app"
NEXTJS_EXAMPLE="$MONOREPO/examples/nextjs-standalone"
DEPLOY_DOC="$MONOREPO/docs/guides/deploy.md"

# ── Pre-flight checks ────────────────────────────────────────────────
test -f "$DEPLOY_DOC" \
  || { echo "ERROR: docs/deploy.md not found." >&2; exit 1; }

test -f "$TEMPLATES/docker/gitignore" \
  || { echo "ERROR: templates/docker/gitignore not found." >&2; exit 1; }

# ── Step 1: Copy shared assets into ALL templates ─────────────────────
# Every template gets: cli/bin, cli/data, and docs/deploy.md
for tpl in docker nextjs-standalone; do
  echo ":: Syncing shared assets → $tpl"
  rm -rf "$TEMPLATES/$tpl/bin" \
         "$TEMPLATES/$tpl/data" \
         "$TEMPLATES/$tpl/docs"

  cp -r "$CLI_BIN"      "$TEMPLATES/$tpl/bin"
  cp -r "$CLI_DATA"     "$TEMPLATES/$tpl/data"

  mkdir -p "$TEMPLATES/$tpl/docs"
  cp "$DEPLOY_DOC"      "$TEMPLATES/$tpl/docs/deploy.md"
done

# ── Step 2: Copy API source into docker template ─────────────────────
# The docker template ships the full @atlas/api source tree.
for tpl in docker; do
  echo ":: Syncing API source → $tpl"
  rm -rf "$TEMPLATES/$tpl/src"
  cp -r "$API_SRC" "$TEMPLATES/$tpl/src"
  # Remove test files — not needed in scaffolded projects
  find "$TEMPLATES/$tpl/src" -name '__tests__' -type d -exec rm -rf {} + 2>/dev/null || true
  find "$TEMPLATES/$tpl/src" -name '__mocks__' -type d -exec rm -rf {} + 2>/dev/null || true
  find "$TEMPLATES/$tpl/src" -name '__test-utils__' -type d -exec rm -rf {} + 2>/dev/null || true
  find "$TEMPLATES/$tpl/src" -name '*.test.ts' -delete 2>/dev/null || true
  find "$TEMPLATES/$tpl/src" -name 'test-setup.ts' -delete 2>/dev/null || true
done

# ── Step 2b: Copy Next.js app pages + catch-all route into docker template ──
# The docker template is a full-stack Next.js + embedded Hono API.
echo ":: Syncing Next.js app pages → docker"
mkdir -p "$TEMPLATES/docker/src/app/api/[...route]"
cp "$WEB_APP/page.tsx"     "$TEMPLATES/docker/src/app/"
cp "$WEB_APP/layout.tsx"   "$TEMPLATES/docker/src/app/"
cp "$WEB_APP/error.tsx"    "$TEMPLATES/docker/src/app/"
cp "$WEB_APP/globals.css"  "$TEMPLATES/docker/src/app/"
cp "$NEXTJS_EXAMPLE/src/app/api/[...route]/route.ts" \
   "$TEMPLATES/docker/src/app/api/[...route]/route.ts"

# ── Step 2c: Copy UI components + web helpers into ALL templates ─────
# Both templates use @/ path alias: page.tsx imports @/ui/context, @/lib/api-url, etc.
for tpl in docker nextjs-standalone; do
  echo ":: Syncing UI components → $tpl"
  mkdir -p "$TEMPLATES/$tpl/src"
  rm -rf "$TEMPLATES/$tpl/src/ui"
  cp -r "$WEB_SRC/ui" "$TEMPLATES/$tpl/src/ui"
  # Remove test files — not needed in scaffolded projects
  find "$TEMPLATES/$tpl/src/ui" -name '__tests__' -type d -exec rm -rf {} + || true

  # Copy shadcn primitives (src/components/ui/) — used by src/ui/ components
  echo ":: Syncing shadcn components → $tpl"
  rm -rf "$TEMPLATES/$tpl/src/components"
  cp -r "$WEB_SRC/components" "$TEMPLATES/$tpl/src/components"

  # Copy hooks (src/hooks/) — used by shadcn sidebar component
  echo ":: Syncing hooks → $tpl"
  rm -rf "$TEMPLATES/$tpl/src/hooks"
  cp -r "$WEB_SRC/hooks" "$TEMPLATES/$tpl/src/hooks"
done

# Brand CSS — globals.css imports ../../brand.css (project root)
for tpl in docker nextjs-standalone; do
  cp "$MONOREPO/packages/web/brand.css" "$TEMPLATES/$tpl/brand.css"
done

# Docker template gets web helpers directly from packages/web
echo ":: Syncing web helpers → docker"
cp "$WEB_SRC/lib/api-url.ts" "$TEMPLATES/docker/src/lib/"
cp "$WEB_SRC/lib/utils.ts"   "$TEMPLATES/docker/src/lib/"
mkdir -p "$TEMPLATES/docker/src/lib/auth"
cp "$WEB_SRC/lib/auth/client.ts" "$TEMPLATES/docker/src/lib/auth/"

# ── Step 3: Sync nextjs-standalone template ──────────────────────────
# The nextjs-standalone template merges API source with Next.js-specific
# overrides (api-url.ts, auth/client.ts, app pages). Custom files are
# preserved across the copy by saving them to a temp dir first.
echo ":: Syncing nextjs-standalone (API source + Next.js overrides)"

# Replace API source directories
rm -rf "$TEMPLATES/nextjs-standalone/src/api" \
       "$TEMPLATES/nextjs-standalone/src/lib"
rm -f  "$TEMPLATES/nextjs-standalone/src/test-setup.ts"

cp -r "$API_SRC/api"          "$TEMPLATES/nextjs-standalone/src/api"
cp -r "$API_SRC/lib"          "$TEMPLATES/nextjs-standalone/src/lib"

# Remove test files from nextjs-standalone API source
find "$TEMPLATES/nextjs-standalone/src" -name '__tests__' -type d -exec rm -rf {} + 2>/dev/null || true
find "$TEMPLATES/nextjs-standalone/src" -name '__mocks__' -type d -exec rm -rf {} + 2>/dev/null || true
find "$TEMPLATES/nextjs-standalone/src" -name '__test-utils__' -type d -exec rm -rf {} + 2>/dev/null || true
find "$TEMPLATES/nextjs-standalone/src" -name '*.test.ts' -delete 2>/dev/null || true
find "$TEMPLATES/nextjs-standalone/src" -name 'test-setup.ts' -delete 2>/dev/null || true

# Apply nextjs-standalone-specific overrides from examples/ (canonical, tracked in git)
cp "$NEXTJS_EXAMPLE/src/lib/api-url.ts"      "$TEMPLATES/nextjs-standalone/src/lib/"
mkdir -p "$TEMPLATES/nextjs-standalone/src/lib/auth"
cp "$NEXTJS_EXAMPLE/src/lib/auth/client.ts"   "$TEMPLATES/nextjs-standalone/src/lib/auth/"

# Copy utils.ts (cn() helper used by UI components)
cp "$WEB_SRC/lib/utils.ts" "$TEMPLATES/nextjs-standalone/src/lib/"

# Copy Next.js app pages from packages/web
mkdir -p "$TEMPLATES/nextjs-standalone/src/app"
cp "$WEB_APP/page.tsx"     "$TEMPLATES/nextjs-standalone/src/app/"
cp "$WEB_APP/layout.tsx"   "$TEMPLATES/nextjs-standalone/src/app/"
cp "$WEB_APP/error.tsx"    "$TEMPLATES/nextjs-standalone/src/app/"
cp "$WEB_APP/globals.css"  "$TEMPLATES/nextjs-standalone/src/app/"

# ── Step 4: Sync catch-all API route into nextjs-standalone ──────────
# The route.ts handler delegates all /api/* requests to the Hono app.
# Keep it in sync with the canonical copy in examples/nextjs-standalone.
echo ":: Syncing route.ts → nextjs-standalone"
mkdir -p "$TEMPLATES/nextjs-standalone/src/app/api/[...route]"
cp "$NEXTJS_EXAMPLE/src/app/api/[...route]/route.ts" \
   "$TEMPLATES/nextjs-standalone/src/app/api/[...route]/route.ts"

# ── Step 5: Copy demo semantic layer into ALL templates ──────────────
# Ships the pre-built demo semantic layer so 1-click deploys (Vercel
# deploy button, etc.) work out of the box with ATLAS_DEMO_DATA=true.
# Users with their own database will overwrite these by running `atlas init`.
DEMO_SEMANTIC="$MONOREPO/packages/cli/data/demo-semantic"
for tpl in docker nextjs-standalone; do
  echo ":: Syncing demo semantic layer → $tpl"
  rm -rf "$TEMPLATES/$tpl/semantic"
  cp -r "$DEMO_SEMANTIC" "$TEMPLATES/$tpl/semantic"
done

# ── Step 5b: Ensure docker public dir exists ──────────────────────────
mkdir -p "$TEMPLATES/docker/public"
touch    "$TEMPLATES/docker/public/.gitkeep"

# ── Step 5c: Copy enterprise source into ALL templates ───────────────
# API routes import @atlas/ee/* — tsconfig paths resolve to ./ee/src/*
EE_SRC="$MONOREPO/ee/src"
for tpl in docker nextjs-standalone; do
  rm -rf "$TEMPLATES/$tpl/ee"
  mkdir -p "$TEMPLATES/$tpl/ee"
  cp -r "$EE_SRC" "$TEMPLATES/$tpl/ee/src"
  # Remove test files
  find "$TEMPLATES/$tpl/ee" -name '__tests__' -type d -exec rm -rf {} + 2>/dev/null || true
  find "$TEMPLATES/$tpl/ee" -name '*.test.ts' -delete 2>/dev/null || true
done

# ── Step 5d: Copy CLI source files referenced by bin/atlas.ts ────────
# bin/atlas.ts imports ../src/env-check and ../src/progress.
# Must happen AFTER src/ is populated (Steps 2-4 wipe and rebuild src/).
CLI_SRC="$MONOREPO/packages/cli/src"
for tpl in docker nextjs-standalone; do
  cp "$CLI_SRC/env-check.ts" "$TEMPLATES/$tpl/src/"
  cp "$CLI_SRC/progress.ts"  "$TEMPLATES/$tpl/src/"
done

# ── Step 6: Sync dependency versions into templates ───────────────
# Skip syncpack when SKIP_SYNCPACK=1 (used by CI drift check and sync-starter)
if [[ "${SKIP_SYNCPACK:-}" != "1" ]]; then
  echo ":: Syncing dependency versions to templates"
  cd "$MONOREPO"
  bun x syncpack fix
  bun x syncpack lint
else
  echo ":: Skipping syncpack (SKIP_SYNCPACK=1)"
fi

echo ":: All templates prepared successfully."
