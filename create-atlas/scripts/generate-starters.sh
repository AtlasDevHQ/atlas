#!/usr/bin/env bash
# generate-starters.sh — Generate platform-specific starter repos for publishing.
#
# Usage:
#   bash scripts/generate-starters.sh [output-dir]
#
# Generates 3 standalone projects (vercel, railway, docker) using
# create-atlas with --defaults. Output goes to <output-dir>/<platform>/
# (default: ./starters/).
#
# Each generated project is a deployable Atlas starter with:
#   - Platform-specific README with deploy buttons
#   - Correct config files (vercel.json, railway.json, Dockerfile)
#   - .env.example (renamed from .env — no secrets in repos)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE_ATLAS="$SCRIPT_DIR/../index.ts"
OUTPUT_DIR="${1:-$SCRIPT_DIR/../starters}"

PLATFORMS=("vercel" "railway" "docker")

mkdir -p "$OUTPUT_DIR"

echo "Generating starter projects in $OUTPUT_DIR..."
echo ""

for platform in "${PLATFORMS[@]}"; do
  project_name="atlas-starter-${platform}"
  target_dir="$OUTPUT_DIR/$project_name"

  echo "--- $platform ---"

  # Clean previous output
  rm -rf "$target_dir"

  # Generate project (non-interactive, bun install runs automatically)
  WORK_DIR="$(mktemp -d)"
  cd "$WORK_DIR"
  bun "$CREATE_ATLAS" "$project_name" --platform "$platform" --defaults 2>&1 | sed 's/^/  /'
  mv "$WORK_DIR/$project_name" "$target_dir"
  rm -rf "$WORK_DIR"

  # Rename .env → .env.example (don't commit placeholder secrets)
  if [ -f "$target_dir/.env" ]; then
    mv "$target_dir/.env" "$target_dir/.env.example"
  fi

  # Remove node_modules — starter repos don't need them
  rm -rf "$target_dir/node_modules"

  echo "  Generated: $target_dir"
  echo ""
done

echo "Done. Starters generated in $OUTPUT_DIR/"
echo ""
echo "To publish, push each directory to its own repo:"
for platform in "${PLATFORMS[@]}"; do
  echo "  cd $OUTPUT_DIR/atlas-starter-${platform} && git init && gh repo create AtlasDevHQ/atlas-starter-${platform} --public --source=. --push"
done
