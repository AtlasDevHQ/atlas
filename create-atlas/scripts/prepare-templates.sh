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

for seed in simple cybersec ecommerce; do
  test -d "$CLI_DATA/seeds/$seed/semantic" \
    || { echo "ERROR: packages/cli/data/seeds/$seed/semantic not found." >&2; exit 1; }
done

# ── Step 1: Copy shared assets into ALL templates ─────────────────────
# Every template gets: cli/bin, cli/data (seeds + init SQL), and docs/deploy.md
for tpl in docker nextjs-standalone; do
  echo ":: Syncing shared assets → $tpl"
  rm -rf "$TEMPLATES/$tpl/bin" \
         "$TEMPLATES/$tpl/data" \
         "$TEMPLATES/$tpl/docs"

  cp -r "$CLI_BIN"      "$TEMPLATES/$tpl/bin"
  # Copy seed data (structured layout + backward-compat symlinks)
  mkdir -p "$TEMPLATES/$tpl/data/seeds"
  cp -r "$CLI_DATA"/seeds/* "$TEMPLATES/$tpl/data/seeds/"
  cp "$CLI_DATA/init-demo-db.sql" "$TEMPLATES/$tpl/data/"
  # Backward-compat flat files for Docker mounts and legacy paths
  for seed in simple cybersec ecommerce; do
    cp "$CLI_DATA/seeds/$seed/seed.sql" "$TEMPLATES/$tpl/data/$seed.sql"
  done
  cp "$CLI_DATA/seeds/simple/seed.sql" "$TEMPLATES/$tpl/data/demo.sql"

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
# page.tsx uses the template override (standalone AtlasChat widget)
# rather than packages/web's native SaaS chat page.
OVERRIDES="$ROOT/overrides"
echo ":: Syncing Next.js app pages → docker"
mkdir -p "$TEMPLATES/docker/src/app/api/[...route]"
cp "$OVERRIDES/page.tsx"   "$TEMPLATES/docker/src/app/"
cp "$WEB_APP/layout.tsx"   "$TEMPLATES/docker/src/app/"
cp "$WEB_APP/error.tsx"    "$TEMPLATES/docker/src/app/"
cp "$WEB_APP/globals.css"  "$TEMPLATES/docker/src/app/"
cp "$NEXTJS_EXAMPLE/src/app/api/[...route]/route.ts" \
   "$TEMPLATES/docker/src/app/api/[...route]/route.ts"

# ── Step 2c: Copy UI components + web helpers into ALL templates ─────
# Both templates use @/ path alias: page.tsx imports @/ui/context, @/lib/api-url, etc.
for tpl in docker nextjs-standalone; do
  # Copy web-only directories (delete+replace — these don't conflict with API source)
  echo ":: Syncing web source → $tpl"
  mkdir -p "$TEMPLATES/$tpl/src/lib"
  for subdir in ui components config hooks types; do
    rm -rf "$TEMPLATES/$tpl/src/$subdir"
    if [ -d "$WEB_SRC/$subdir" ]; then
      cp -r "$WEB_SRC/$subdir" "$TEMPLATES/$tpl/src/$subdir"
    fi
  done
  # Merge web lib files into existing API lib (don't delete — API source lives there too)
  if [ -d "$WEB_SRC/lib" ]; then
    cp "$WEB_SRC"/lib/*.ts "$TEMPLATES/$tpl/src/lib/" 2>/dev/null || true
    # Copy web lib subdirs that don't exist in API (auth/client.ts has special handling)
  fi
  # Remove test files from synced web source
  find "$TEMPLATES/$tpl/src/ui" -name '__tests__' -type d -exec rm -rf {} + 2>/dev/null || true
  find "$TEMPLATES/$tpl/src" -name '*.test.ts' -delete 2>/dev/null || true
  find "$TEMPLATES/$tpl/src" -name '*.test.tsx' -delete 2>/dev/null || true
done

# Brand CSS — globals.css imports ../../brand.css (project root)
for tpl in docker nextjs-standalone; do
  cp "$MONOREPO/packages/web/brand.css" "$TEMPLATES/$tpl/brand.css"
done

# Docker template: ensure auth/client.ts override from web (not API)
echo ":: Syncing docker auth override"
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

# Copy ALL web lib files (utils, format, data-table, parsers, compose-refs, etc.)
for f in "$WEB_SRC"/lib/*.ts; do
  cp "$f" "$TEMPLATES/nextjs-standalone/src/lib/" 2>/dev/null || true
done

# Copy Next.js app pages — page.tsx and layout.tsx use template overrides:
# page.tsx: standalone AtlasChat widget (not SaaS native chat page)
# layout.tsx: no ModeBanner (developer/published mode is SaaS-only)
mkdir -p "$TEMPLATES/nextjs-standalone/src/app"
cp "$OVERRIDES/page.tsx"   "$TEMPLATES/nextjs-standalone/src/app/"
cp "$OVERRIDES/layout.tsx" "$TEMPLATES/nextjs-standalone/src/app/"
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
# Ships the pre-built demo (simple) semantic layer so 1-click deploys
# (Vercel deploy button, etc.) work out of the box with ATLAS_DEMO_DATA=true.
# Users with their own database will overwrite these by running `atlas init`.
DEMO_SEMANTIC="$MONOREPO/packages/cli/data/seeds/simple/semantic"
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

# ── Step 5e: Copy @useatlas/schemas source into ALL templates ────────
# Templates reach @useatlas/schemas via tsconfig path alias → src/schemas/,
# not via npm (the package is private and not published). API route files
# synced from packages/api/src/ import from "@useatlas/schemas"; the alias
# plus this copy keeps the scaffolded project building. Must happen AFTER
# Steps 2-4 wipe and rebuild src/.
SCHEMAS_SRC="$MONOREPO/packages/schemas/src"
for tpl in docker nextjs-standalone; do
  rm -rf "$TEMPLATES/$tpl/src/schemas"
  cp -r "$SCHEMAS_SRC" "$TEMPLATES/$tpl/src/schemas"
  # Remove test files — not needed in scaffolded projects
  find "$TEMPLATES/$tpl/src/schemas" -name '__tests__' -type d -exec rm -rf {} + 2>/dev/null || true
  find "$TEMPLATES/$tpl/src/schemas" -name '*.test.ts' -delete 2>/dev/null || true
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
