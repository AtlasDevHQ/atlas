#!/usr/bin/env bash
# check-launch-sentence.sh — the launch cycle's sentence renders verbatim on
# every surface that prints it (#5606).
#
# docs/prd/launch-cycle.md decides the sentence once. The README, the landing
# page, the docs intro, the comparisons index and both llms.txt surfaces each
# carry it as a literal, and nothing but a reader's eye kept them identical —
# a one-word edit meant seven hand edits across three packages, and the
# reviews of #5628/#5631/#5632 each asked for a gate on the plugin-count model.
#
# The PRD's blockquote is the source of truth. Every surface below must contain
# that exact string. Add a surface here when a new one starts printing the
# sentence; remove it when it stops.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PRD="docs/prd/launch-cycle.md"
SENTENCE="$(grep -m1 -oE '^> \*\*Atlas is the company facts.*\*\*$' "$PRD" | sed -E 's/^> \*\*//; s/\*\*$//')"
if [ -z "$SENTENCE" ]; then
  echo "check-launch-sentence: could not read the sentence from $PRD (expected a '> **Atlas is the company facts…**' blockquote)." >&2
  exit 1
fi
echo ":: The sentence, from $PRD: ${SENTENCE}"

SURFACES=(
  "README.md"
  "apps/www/src/components/landing/data.ts"
  "apps/www/public/llms.txt"
  "apps/docs/src/lib/llms-surface.ts"
  "apps/docs/content/docs/index.mdx"
  "apps/docs/content/shared/comparisons/index.mdx"
  "scripts/generate-brand-assets.tsx"
)

fail=0
for surface in "${SURFACES[@]}"; do
  if [ ! -f "$surface" ]; then
    echo "check-launch-sentence: listed surface not found: $surface" >&2
    fail=1
    continue
  fi
  if ! grep -qF -- "$SENTENCE" "$surface"; then
    echo "$surface: does not contain the sentence verbatim." >&2
    echo "  Paste it exactly as $PRD states it, or drop this file from SURFACES if it no longer prints the sentence." >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "Launch-sentence check passed — every surface carries the sentence verbatim."
