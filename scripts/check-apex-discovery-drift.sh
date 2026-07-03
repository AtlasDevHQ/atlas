#!/usr/bin/env bash
# check-apex-discovery-drift.sh — CI gate that keeps the STATIC agent-discovery
# artifacts on the apex brand domain (useatlas.dev, served by apps/www) and the
# docs site in lockstep with the API they mirror.
#
# The apex hosts a static mirror of the canonical discovery surface so an agent
# resolving the brand domain finds it on the first hop:
#   - apps/www/public/auth.md                                  (agent onboarding)
#   - apps/www/public/.well-known/oauth-protected-resource.json (RFC 9728)
#   - apps/docs/.../oauth-protected-resource/resource-metadata.generated.json
# All three are GENERATED from one source in packages/api by
# `scripts/generate-apex-discovery.ts` — auth.md via the SAME renderer the live
# `api.useatlas.dev/auth.md` route serves, the JSON from one canonical body.
#
# This gate re-runs the generator and fails if any emitted file differs from
# the committed copy (a hand-edit, or an upstream change to the auth.md builder
# / scopes / hosts that wasn't regenerated). Same generate-then-diff discipline
# as check-template-drift.sh / check-openapi-drift.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

FILES=(
  "apps/www/public/auth.md"
  "apps/www/public/.well-known/oauth-protected-resource.json"
  "apps/docs/src/app/.well-known/oauth-protected-resource/resource-metadata.generated.json"
)

# Closes the "forgot to commit a newly generated file" blind spot: `git diff`
# ignores untracked files, so an uncommitted generated artifact would sail
# through the diff below. Assert each is tracked first.
for f in "${FILES[@]}"; do
  if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo "::error file=$f::Generated apex-discovery artifact is not committed."
    echo "Run: cd packages/api && bun scripts/generate-apex-discovery.ts   then commit $f"
    exit 1
  fi
done

echo ":: Regenerating apex discovery artifacts..."
( cd packages/api && bun scripts/generate-apex-discovery.ts )

echo ":: Checking for drift..."
if ! git diff --exit-code -- "${FILES[@]}"; then
  echo ""
  echo "::error::Apex agent-discovery artifacts are stale."
  echo "useatlas.dev's static discovery mirror (auth.md + oauth-protected-resource) and the docs"
  echo "copy are GENERATED from packages/api — never edit them by hand. Regenerate and commit:"
  echo "    cd packages/api && bun scripts/generate-apex-discovery.ts"
  exit 1
fi

echo "Apex discovery drift check passed — generated artifacts match committed copies."
