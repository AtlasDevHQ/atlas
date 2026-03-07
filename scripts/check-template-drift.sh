#!/usr/bin/env bash
# check-template-drift.sh — CI check that verifies prepare-templates.sh produces
# correct output (template source matches monorepo source).
#
# The create-atlas/templates/nextjs-standalone/src/ directory is gitignored and
# regenerated at publish time by create-atlas/scripts/prepare-templates.sh.
# This script:
#   1. Runs prepare-templates.sh to generate template source
#   2. Compares the generated template against the monorepo source
#   3. Fails if any file that should be identical has drifted
#
# Files intentionally different (template-specific overrides, preserved by prepare script):
#   - lib/api-url.ts — embedded same-origin (no cross-origin API URL)
#   - lib/auth/client.ts — embedded same-origin (no admin client, no cross-origin)
#   - app/layout.tsx — simpler layout (no nuqs adapter, no dark mode script)
#   - app/global-error.tsx — template-only error boundary
#   - app/api/[...route]/route.ts — template-only catch-all route
#   - app/globals.css — may differ (no shadcn/tailwind.css import)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

# ── Step 1: Generate template source ────────────────────────────────
echo ":: Running prepare-templates.sh..."

# Set SKIP_SYNCPACK so the prepare script can skip the syncpack step in CI.
# The prepare script needs to check this env var.
SKIP_SYNCPACK=1 bash create-atlas/scripts/prepare-templates.sh

# ── Step 2: Verify generated output ────────────────────────────────
echo ":: Checking generated template for drift..."

TEMPLATE="create-atlas/templates/nextjs-standalone/src"
API_SRC="packages/api/src"
WEB_SRC="packages/web/src"

# Files that are intentionally different (template-specific overrides).
EXCLUDED=(
  "lib/api-url.ts"
  "lib/auth/client.ts"
  "app/layout.tsx"
  "app/global-error.tsx"
  "app/globals.css"
  "app/api/[...route]/route.ts"
)

is_excluded() {
  local rel="$1"
  for excl in "${EXCLUDED[@]}"; do
    [[ "$rel" == "$excl" ]] && return 0
  done
  return 1
}

mono_path() {
  local rel="$1"
  case "$rel" in
    ui/*|app/*|components/*|hooks/*)  echo "$WEB_SRC/$rel" ;;
    lib/utils.ts)                     echo "$WEB_SRC/$rel" ;;
    *)                                echo "$API_SRC/$rel" ;;
  esac
}

ERRORS=0
CHECKED=0

while IFS= read -r -d '' f; do
  rel="${f#$TEMPLATE/}"

  is_excluded "$rel" && continue

  mono="$(mono_path "$rel")"
  [[ ! -f "$mono" ]] && continue

  CHECKED=$((CHECKED + 1))

  if ! diff -q "$mono" "$f" >/dev/null 2>&1; then
    echo "::error file=$f::Template file $rel differs from $mono after prepare-templates.sh"
    ERRORS=$((ERRORS + 1))
  fi
done < <(find "$TEMPLATE" -type f \( -name '*.ts' -o -name '*.tsx' \) -print0)

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "ERROR: $ERRORS template file(s) differ from monorepo after generation."
  echo "This means prepare-templates.sh is not copying files correctly."
  echo "Check create-atlas/scripts/prepare-templates.sh for issues."
  exit 1
fi

echo "Template drift check passed — $CHECKED files verified after generation."
