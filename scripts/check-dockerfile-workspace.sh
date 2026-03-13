#!/usr/bin/env bash
# Verify that all workspace members have their package.json COPY'd
# in every deploy Dockerfile that uses `bun ci` (frozen lockfile).
#
# bun ci validates the lockfile, which references every workspace member.
# If a member's package.json isn't present, the install fails at build time.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

# --- 1. Discover workspace members ---
# Extract workspace globs from root package.json (simple text parsing, no jq needed).
# Grabs everything between "workspaces": [ ... ]
WORKSPACE_BLOCK=$(sed -n '/"workspaces"/,/]/p' "$ROOT/package.json")
GLOBS=$(echo "$WORKSPACE_BLOCK" | grep -oP '"\K[^"]+' | grep -v workspaces)

MEMBERS=()
for glob in $GLOBS; do
  # Expand glob patterns (packages/*) and literal paths (create-atlas-plugin)
  for dir in $ROOT/$glob; do
    if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
      MEMBERS+=("${dir#"$ROOT/"}")
    fi
  done
done

# Deduplicate and sort
MEMBERS=($(printf '%s\n' "${MEMBERS[@]}" | sort -u))

if [ ${#MEMBERS[@]} -eq 0 ]; then
  echo "::error::No workspace members found — check package.json workspaces field"
  exit 1
fi

echo "Found ${#MEMBERS[@]} workspace members:"
printf '  %s\n' "${MEMBERS[@]}"
echo ""

# --- 2. Find Dockerfiles with bun ci ---
DOCKERFILES=()
while IFS= read -r df; do
  if grep -q 'bun ci' "$df"; then
    DOCKERFILES+=("$df")
  fi
done < <(find "$ROOT/deploy" -name Dockerfile -type f 2>/dev/null)

if [ ${#DOCKERFILES[@]} -eq 0 ]; then
  echo "No Dockerfiles with 'bun ci' found in deploy/ — nothing to check"
  exit 0
fi

echo "Checking Dockerfiles with bun ci:"
printf '  %s\n' "${DOCKERFILES[@]}"
echo ""

# --- 3. Verify each member is COPY'd ---
for df in "${DOCKERFILES[@]}"; do
  rel_df="${df#"$ROOT/"}"
  echo "--- $rel_df ---"
  missing=0
  for member in "${MEMBERS[@]}"; do
    expected="$member/package.json"
    if ! grep -qF "$expected" "$df"; then
      echo "::error file=$rel_df::Missing COPY for workspace member $expected"
      missing=$((missing + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [ $missing -eq 0 ]; then
    echo "  All workspace members present"
  fi
done

echo ""
if [ $ERRORS -gt 0 ]; then
  echo "FAIL: $ERRORS missing workspace member(s) in Dockerfile COPY lines"
  exit 1
fi

echo "OK: All workspace members are COPY'd in all deploy Dockerfiles"
