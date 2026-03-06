#!/usr/bin/env bash
# generate-starters.sh — Generate platform-specific starter repos for publishing.
#
# Usage:
#   bash scripts/generate-starters.sh [output-dir]
#
# Generates 4 standalone projects (vercel, railway, render, docker) using
# create-atlas with --defaults. Output goes to <output-dir>/<platform>/
# (default: ./starters/).
#
# Each generated project is a deployable Atlas starter with:
#   - Platform-specific README with deploy buttons
#   - Correct config files (vercel.json, railway.json, render.yaml, Dockerfile)
#   - .env.example (renamed from .env — no secrets in repos)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE_ATLAS="$SCRIPT_DIR/../index.ts"
OUTPUT_DIR="${1:-$SCRIPT_DIR/../starters}"

PLATFORMS=("vercel" "railway" "render" "docker")

echo "Generating starter projects in $OUTPUT_DIR..."
echo ""

for platform in "${PLATFORMS[@]}"; do
  project_name="atlas-starter-${platform}"
  target_dir="$OUTPUT_DIR/$project_name"

  echo "--- $platform ---"

  # Clean previous output
  rm -rf "$target_dir"

  # Generate project (non-interactive, skip bun install)
  cd "$OUTPUT_DIR/.." 2>/dev/null || cd /tmp
  bun "$CREATE_ATLAS" "$project_name" --platform "$platform" --defaults 2>&1 | sed 's/^/  /'

  # Move to output dir if generated elsewhere
  if [ -d "$project_name" ] && [ "$project_name" != "$target_dir" ]; then
    mkdir -p "$OUTPUT_DIR"
    mv "$project_name" "$target_dir"
  fi

  # Rename .env → .env.example (don't commit placeholder secrets)
  if [ -f "$target_dir/.env" ]; then
    mv "$target_dir/.env" "$target_dir/.env.example"
  fi

  echo "  Generated: $target_dir"
  echo ""
done

echo "Done. Starters generated in $OUTPUT_DIR/"
echo ""
echo "To publish, push each directory to its own repo:"
echo "  cd $OUTPUT_DIR/atlas-starter-vercel && git init && gh repo create AtlasDevHQ/atlas-starter-vercel --public --source=. --push"
echo "  cd $OUTPUT_DIR/atlas-starter-railway && git init && gh repo create AtlasDevHQ/atlas-starter-railway --public --source=. --push"
echo "  cd $OUTPUT_DIR/atlas-starter-render && git init && gh repo create AtlasDevHQ/atlas-starter-render --public --source=. --push"
echo "  cd $OUTPUT_DIR/atlas-starter-docker && git init && gh repo create AtlasDevHQ/atlas-starter-docker --public --source=. --push"
