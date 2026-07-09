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
#   4. TEST-CHECK FLOOR — the test-check program (#4450's gate) shrinking
#      below its own test-file floor trips.
#   5. TSGO LOOKUP — no resolvable tsgo binary fails loudly, never green.
#
# Every expected-fail case also greps the guard's stderr for that branch's
# specific FAIL message, so a case can't drift into tripping a DIFFERENT
# branch (or a harness error like a bad interpreter lookup) while staying
# green — bare non-zero exit is not attributable.
#
# Fixtures point the guard at a scaffolded temp tree via
# TYPE_PROGRAM_GUARD_ROOT (+ TYPE_PROGRAM_GUARD_MIN / _TEST_MIN for
# fixture-sized floors), so they never touch the real packages/web tsconfigs;
# the suite ends with one real-repo sanity case that runs the guard
# un-overridden.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/packages/web/scripts/check-type-program-not-vacuous.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

# Resolve bash NOW: the tsgo-lookup case empties PATH, and a `PATH=... bash`
# prefix assignment applies to the lookup of `bash` itself — invoking via an
# absolute interpreter is what keeps that case exercising the GUARD's lookup
# branch instead of failing before the guard ever runs.
BASH_BIN="$(command -v bash)"

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
# files that excludes tests, referencing a composite test-only project, plus
# the non-composite test-check sibling (#4450). Returns the tree path.
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
  cat > "$tmp/tsconfig.test-check.json" <<'EOF'
{
  "extends": "./tsconfig.test.json",
  "compilerOptions": { "composite": false, "noEmit": true }
}
EOF
  printf '%s' "$tmp"
}

# run_case EXPECTED NAME MIN TEST_MIN MSG TREE — run the guard against TREE
# with the given floors, assert pass/fail, and for fail-cases assert stderr
# carries MSG (the branch-specific FAIL text). Cleans up TREE.
run_case() {
  local expected="$1" name="$2" min="$3" test_min="$4" msg="$5" tree="$6"
  local status=0 stderr_file
  # Refuse to run against an unbuilt fixture: an empty ROOT would make the
  # guard fall back to the real packages/web (`:-` treats "" as unset), which
  # would silently turn a fail-case into a result about the live tree.
  if [ -z "$tree" ] || [ ! -d "$tree" ]; then
    echo "  FAIL $name — scaffold produced no usable tree (got '$tree')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  stderr_file="$(mktemp)"
  (PATH="$TSGO_PATH:$PATH" TYPE_PROGRAM_GUARD_ROOT="$tree" \
    TYPE_PROGRAM_GUARD_MIN="$min" TYPE_PROGRAM_GUARD_TEST_MIN="$test_min" \
    "$BASH_BIN" "$SCRIPT" >/dev/null 2>"$stderr_file") || status=$?
  if [ "$expected" = pass ] && [ "$status" -eq 0 ]; then
    echo "  ok   $name (expected pass)"
    PASS=$((PASS + 1))
  elif [ "$expected" = fail ] && [ "$status" -ne 0 ] && grep -qF "$msg" "$stderr_file"; then
    echo "  ok   $name (expected fail: '$msg')"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected('$msg'), got status=$status, stderr:" >&2
    sed 's/^/    /' "$stderr_file" >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tree" "$stderr_file"
}

# --- healthy tree ------------------------------------------------------------

# 5 src files / 1 test file, floors 3/1: both programs populated, artifact loads.
run_case pass "healthy tree passes" 3 1 "" "$(scaffold 5)"

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
run_case fail "broadened test include vacuates the main program (#4447)" 3 1 \
  "re-vacuated the program" "$tree"

# --- floor -------------------------------------------------------------------

# A structurally healthy program below the floor still trips (partial
# vacuation looks exactly like this: hundreds of files silently gone).
run_case fail "src count below the floor trips" 6 1 \
  "in the type program (expected >= 6)" "$(scaffold 5)"

# --- routing artifact (#4443) --------------------------------------------------

# Main program healthy, but tsconfig.test.json no longer loads as a program:
# the guard's routing assertion (tsgolint file->program routing) must trip.
tree="$(scaffold 5)"
cat > "$tree/tsconfig.json" <<'EOF'
{
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "types": [] },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
EOF
printf '{ this is not json\n' > "$tree/tsconfig.test.json"
run_case fail "unloadable tsconfig.test.json trips the routing assertion" 3 1 \
  "no longer loads as a program" "$tree"

# --- test-check floor (#4450) ---------------------------------------------------

# The test-check program shrinking below its test-file floor trips — include
# rot must not quietly degrade the gate back to the pre-#4450 state. The
# scaffold has 1 test file; a floor of 2 simulates the shrink.
run_case fail "test-check program below the test-file floor trips (#4450)" 3 2 \
  "test files in the test-check program (expected >= 2)" "$(scaffold 5)"

# --- tsgo lookup ---------------------------------------------------------------

# No tsgo anywhere (tree has no node_modules, PATH has none): the guard's
# lookup branch must fail loudly instead of skipping the check. Invoked via
# $BASH_BIN so the emptied PATH hits the GUARD's `command -v tsgo`, not the
# suite's own interpreter lookup; the message grep pins it to that branch.
tree="$(scaffold 5)"
empty_path="$(mktemp -d)"
stderr_file="$(mktemp)"
status=0
(PATH="$empty_path" TYPE_PROGRAM_GUARD_ROOT="$tree" TYPE_PROGRAM_GUARD_MIN=3 \
  TYPE_PROGRAM_GUARD_TEST_MIN=1 \
  "$BASH_BIN" "$SCRIPT" >/dev/null 2>"$stderr_file") || status=$?
if [ "$status" -ne 0 ] && grep -qF "tsgo not found" "$stderr_file"; then
  echo "  ok   missing tsgo fails loudly (expected fail: 'tsgo not found')"
  PASS=$((PASS + 1))
else
  echo "  FAIL missing tsgo — status=$status, stderr:" >&2
  sed 's/^/    /' "$stderr_file" >&2
  FAIL=$((FAIL + 1))
fi
rm -rf "$tree" "$empty_path" "$stderr_file"

# --- non-numeric floor override --------------------------------------------------

# A typo'd floor must fail the guard, not skip the comparison and exit green.
tree="$(scaffold 5)"
stderr_file="$(mktemp)"
status=0
(PATH="$TSGO_PATH:$PATH" TYPE_PROGRAM_GUARD_ROOT="$tree" \
  TYPE_PROGRAM_GUARD_MIN="45O" TYPE_PROGRAM_GUARD_TEST_MIN=1 \
  "$BASH_BIN" "$SCRIPT" >/dev/null 2>"$stderr_file") || status=$?
if [ "$status" -ne 0 ] && grep -qF "non-numeric TYPE_PROGRAM_GUARD_MIN" "$stderr_file"; then
  echo "  ok   non-numeric floor override fails loudly (expected fail)"
  PASS=$((PASS + 1))
else
  echo "  FAIL non-numeric floor override — status=$status, stderr:" >&2
  sed 's/^/    /' "$stderr_file" >&2
  FAIL=$((FAIL + 1))
fi
rm -rf "$tree" "$stderr_file"

# --- real tree sanity ----------------------------------------------------------

# The actual repo must pass with no overrides (default ROOT + 450/200 floors).
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
