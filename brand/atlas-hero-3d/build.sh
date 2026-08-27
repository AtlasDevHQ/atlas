#!/usr/bin/env bash
# Builds the self-contained hero page: brand/atlas-hero-3d/atlas-hero.html
#
# The page has to be one file with zero external requests — the Artifact CSP
# blocks CDN scripts, remote textures, and the blob:/data: image paths that
# three's GLTFLoader would otherwise use. So three is bundled and inlined, and
# the mesh and its textures are embedded as base64.
set -euo pipefail
cd "$(dirname "$0")"

command -v bun >/dev/null || { echo "bun is required (never npm — see CLAUDE.md)" >&2; exit 2; }

echo "› bundling three"
(cd src && bun install --silent && bun build entry.js \
    --minify --format=iife --target=browser --outfile=three-bundle.js >/dev/null)

echo "› inlining assets"
bun run inline.ts

echo "✓ atlas-hero.html"
