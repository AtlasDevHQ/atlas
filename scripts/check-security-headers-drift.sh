#!/usr/bin/env bash
# check-security-headers-drift.sh — CI check that the canonical security
# `headers()` policy in packages/web/next.config.ts is mirrored byte-for-byte
# into every scaffold next.config.ts.
#
# Why: PR #1991 hardened the production hosts (HSTS, CSP, X-Frame-Options,
# nosniff, Referrer-Policy). The scaffolds duplicate that block because they
# can't `import` from the monorepo. Without enforcement, the next CSP tweak
# silently leaves new `bun create @useatlas` installs running a stale policy.
#
# How: the canonical and each mirror file wrap their `headers()` function in
# `// SECURITY-HEADERS-START` / `// SECURITY-HEADERS-END` sentinel comments.
# This script extracts the block from each file and diffs them.
#
# To update: edit packages/web/next.config.ts, then copy the new block into
# every file listed under MIRRORS below, preserving the sentinel comments.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

CANONICAL="packages/web/next.config.ts"
MIRRORS=(
  "examples/nextjs-standalone/next.config.ts"
  "create-atlas/templates/nextjs-standalone/next.config.ts"
  "create-atlas/templates/docker/next.config.ts"
)

extract_block() {
  local file="$1"
  awk '
    /\/\/ SECURITY-HEADERS-START/ { capture = 1; next }
    /\/\/ SECURITY-HEADERS-END/   { capture = 0 }
    capture { print }
  ' "$file"
}

if [[ ! -f "$CANONICAL" ]]; then
  echo "ERROR: canonical file $CANONICAL not found" >&2
  exit 1
fi

CANONICAL_BLOCK="$(extract_block "$CANONICAL")"

if [[ -z "$CANONICAL_BLOCK" ]]; then
  echo "ERROR: no SECURITY-HEADERS-START/END block found in $CANONICAL" >&2
  echo "Add the sentinel comments around the canonical async headers() function." >&2
  exit 1
fi

ERRORS=0
for mirror in "${MIRRORS[@]}"; do
  if [[ ! -f "$mirror" ]]; then
    echo "::error file=$mirror::mirror file not found"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  MIRROR_BLOCK="$(extract_block "$mirror")"

  if [[ -z "$MIRROR_BLOCK" ]]; then
    echo "::error file=$mirror::no SECURITY-HEADERS-START/END block found — add sentinel comments around the headers() function"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  if [[ "$MIRROR_BLOCK" != "$CANONICAL_BLOCK" ]]; then
    echo "::error file=$mirror::security headers block drifted from $CANONICAL"
    diff <(echo "$CANONICAL_BLOCK") <(echo "$MIRROR_BLOCK") | head -40 >&2 || true
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "ERROR: $ERRORS scaffold next.config.ts file(s) drifted from $CANONICAL."
  echo "Copy the SECURITY-HEADERS-START..END block from $CANONICAL into each drifted file."
  exit 1
fi

echo "Security-headers drift check passed — ${#MIRRORS[@]} mirror(s) match $CANONICAL."
