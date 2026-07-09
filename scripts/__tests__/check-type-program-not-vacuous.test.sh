#!/usr/bin/env bash
# Adversarial fixture suite for
# packages/web/scripts/check-type-program-not-vacuous.sh (#4447, #4450).
#
# Locks in the guard's FAIL branches against silent regression:
#   1. VACUATION — a tsconfig.test.json include broadened to claim app src
#      redirects those files OUT of the main program (#4447's failure mode);
#      the src-file count drops below the floor and the guard must trip.
#   2. FLOOR — a healthy-but-shrunken program below the minimum trips.
#   3. ROUTING ARTIFACT — tsconfig.test.json failing to load as a program
#      (the tsgolint file->program routing seam, #4443) trips.
#   4. TSGO LOOKUP — no resolvable tsgo binary fails loudly, never green.
#
# Fixtures point the guard at a scaffolded temp tree via
# TYPE_PROGRAM_GUARD_ROOT (+ TYPE_PROGRAM_GUARD_MIN for a fixture-sized
# floor), so they never touch the real packages/web tsconfigs; the suite ends
# with one real-repo sanity case that runs the guard un-overridden.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/packages/web/scripts/check-type-program-not-vacuous.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

# The synthetic trees have no node_modules; let the guard's `command -v tsgo`
# fallback find the repo's tsgo.
TSGO_PATH="$REPO_ROOT/node_modules/.bin"
if [ ! -x "$TSGO_PATH/tsgo" ]; then
  echo "::error::tsgo not found at $TSGO_PATH — run bun install first" >&2
  exit 2
fi

PASS=0
FAIL=0

# Scaffold a temp tree shaped like the real seam: a main program of $1 src
# files that excludes tests, referencing a composite test-only project.
# Returns the tree path.
scaffold() {
  local n="$1" tmp i
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/src"
  for ((i = 1; i <= n; i++)); do
    printf 'export const v%d = %d;\n' "$i" "$i" > "$tmp/src/f$i.ts"
  done
  printf 'export const t = 1;\n' > "$tmp/src/f1.test.ts"
  cat > "$tmp/tsconfig.json" <<'EOF'
{
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "types": [] },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "./tsconfig.test.json" }]
}
EOF
  cat > "$tmp/tsconfig.test.json" <<'EOF'
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "composite": true, "noEmit": false, "outDir": "dist/t" },
  "include": ["src/**/*.test.ts"],
  "exclude": []
}
EOF
  printf '%s' "$tmp"
}

# run_case EXPECTED NAME MIN TREE — run the guard against TREE with the given
# floor, assert pass/fail, clean up.
run_case() {
  local expected="$1" name="$2" min="$3" tree="$4" status=0
  # Refuse to run against an unbuilt fixture: an empty ROOT would make the
  # guard fall back to the real packages/web (`:-` treats "" as unset), which
  # would silently turn a fail-case into a result about the live tree.
  if [ -z "$tree" ] || [ ! -d "$tree" ]; then
    echo "  FAIL $name — scaffold produced no usable tree (got '$tree')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  (PATH="$TSGO_PATH:$PATH" TYPE_PROGRAM_GUARD_ROOT="$tree" TYPE_PROGRAM_GUARD_MIN="$min" \
    bash "$SCRIPT" >/dev/null 2>&1) || status=$?
  if { [ "$expected" = pass ] && [ "$status" -eq 0 ]; } ||
     { [ "$expected" = fail ] && [ "$status" -ne 0 ]; }; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tree"
}

# --- healthy tree ------------------------------------------------------------

# 5 src files, floor 3: the main program is populated and the test project loads.
run_case pass "healthy tree passes" 3 "$(scaffold 5)"

# --- vacuation (#4447) --------------------------------------------------------

# Broaden the referenced test project's include to claim app src: project-
# reference semantics redirect every claimed file OUT of the main program,
# so the count drops to 0 and the guard must trip.
tree="$(scaffold 5)"
cat > "$tree/tsconfig.test.json" <<'EOF'
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "composite": true, "noEmit": false, "outDir": "dist/t" },
  "include": ["src/**/*.ts"],
  "exclude": []
}
EOF
run_case fail "broadened test include vacuates the main program (#4447)" 3 "$tree"

# --- floor -------------------------------------------------------------------

# A structurally healthy program below the floor still trips (partial
# vacuation looks exactly like this: hundreds of files silently gone).
run_case fail "src count below the floor trips" 6 "$(scaffold 5)"

# --- routing artifact (#4443) --------------------------------------------------

# Main program healthy, but tsconfig.test.json no longer loads as a program:
# the guard's second assertion (tsgolint file->program routing) must trip.
tree="$(scaffold 5)"
cat > "$tree/tsconfig.json" <<'EOF'
{
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "types": [] },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
EOF
printf '{ this is not json\n' > "$tree/tsconfig.test.json"
run_case fail "unloadable tsconfig.test.json trips the routing assertion" 3 "$tree"

# --- tsgo lookup ---------------------------------------------------------------

# No tsgo anywhere (tree has no node_modules, PATH has none): the guard must
# fail loudly instead of skipping the check.
tree="$(scaffold 5)"
empty_path="$(mktemp -d)"
status=0
(PATH="$empty_path" TYPE_PROGRAM_GUARD_ROOT="$tree" TYPE_PROGRAM_GUARD_MIN=3 \
  bash "$SCRIPT" >/dev/null 2>&1) || status=$?
if [ "$status" -ne 0 ]; then
  echo "  ok   missing tsgo fails loudly (expected fail)"
  PASS=$((PASS + 1))
else
  echo "  FAIL missing tsgo did not fail — status=$status" >&2
  FAIL=$((FAIL + 1))
fi
rm -rf "$tree" "$empty_path"

# --- real tree sanity ----------------------------------------------------------

# The actual repo must pass with no overrides (default ROOT + 450 floor).
real_status=0
(bash "$SCRIPT" >/dev/null 2>&1) || real_status=$?
if [ "$real_status" -eq 0 ]; then
  echo "  ok   real repo passes the guard (expected pass)"
  PASS=$((PASS + 1))
else
  echo "  FAIL real repo does not pass the guard — status=$real_status" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "check-type-program-not-vacuous.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
