#!/usr/bin/env bash
# Idempotent npm publish: publish the package in the current directory (or $1)
# ONLY if its exact name@version is not already on the registry.
#
# Why: publish.yml's steps are tag-triggered with no `needs:` ordering, and a tag
# can legitimately point at a commit whose package.json version is already live —
# notably when BACKFILLING a missing release tag for an already-published version
# (see scripts/check-unpublished-versions.ts). A plain `npm publish` 403s with
# EPUBLISHCONFLICT in that case and turns the run red for no real problem. This
# makes "already published" a green no-op while still publishing genuinely new
# versions. Preserves --provenance (needs the workflow's id-token permission).
#
# Usage (from a publish step, after `cd <pkgdir>`): bash "$GITHUB_WORKSPACE/scripts/npm-publish-if-new.sh"
#    or with an explicit dir:                       bash scripts/npm-publish-if-new.sh plugins/clickhouse
set -euo pipefail

dir="${1:-.}"
cd "$dir"

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

if npm view "${name}@${version}" version >/dev/null 2>&1; then
  echo "::notice::${name}@${version} is already published — skipping publish (idempotent)."
  exit 0
fi

echo "Publishing ${name}@${version}..."
npm publish --access public --provenance
