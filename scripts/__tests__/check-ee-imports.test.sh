#!/bin/bash
# Adversarial fixture suite for scripts/check-ee-imports.sh.
#
# Pre-#2594 the gate's comment-stripping sed deleted any line containing
# both `/*` and `*/`, so a same-line block comment followed by a real
# EE import passed silently. This suite locks in the fix + flags any
# future regression.
#
# Each fixture lives in a temporary mirror of the repo layout so the
# script can run against it without touching the real codebase.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-ee-imports.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# `expect_pass FIXTURE_FILE` — the gate should exit 0 against this fixture.
# `expect_fail FIXTURE_FILE` — the gate should exit 1 and list FIXTURE_FILE.
run_fixture() {
  local expected="$1"      # "pass" or "fail"
  local fixture_name="$2"
  local fixture_content="$3"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # Mirror the layout the script expects: CORE_DIR + ALLOWED_FILE.
  mkdir -p "$tmp/packages/api/src/lib/effect" "$tmp/packages/api/src/lib"
  cat > "$tmp/packages/api/src/lib/effect/enterprise-layer.ts" <<EOF
// Allowed-file placeholder for the fixture suite.
EOF
  # Write the fixture (escape any nested $).
  echo "$fixture_content" > "$tmp/packages/api/src/lib/$fixture_name.ts"

  # Run the gate; capture status without aborting the suite.
  local status=0
  (cd "$tmp" && bash "$SCRIPT" > /dev/null 2>&1) || status=$?

  if [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; then
    echo "  ok   $fixture_name (expected pass)"
    PASS=$((PASS + 1))
  elif [ "$expected" = "fail" ] && [ "$status" -ne 0 ]; then
    echo "  ok   $fixture_name (expected fail)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $fixture_name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$tmp"
  trap - RETURN
}

echo "Adversarial fixtures for scripts/check-ee-imports.sh"
echo "===================================================="

# --- Positive fixtures (the gate must flag) -------------------------

run_fixture fail "bare-import" \
  'import { foo } from "@atlas/ee/something";'

run_fixture fail "same-line-block-comment-then-import" \
  '/* TODO: revisit */ import { foo } from "@atlas/ee/something";'

run_fixture fail "jsdoc-then-import-same-line" \
  '/** explain */ import { foo } from "@atlas/ee/something";'

run_fixture fail "dynamic-import" \
  'const mod = await import("@atlas/ee/something");'

run_fixture fail "require-cjs" \
  'const mod = require("@atlas/ee/something");'

run_fixture fail "trailing-block-comment-on-import-line" \
  'import { foo } from "@atlas/ee/something"; /* old */'

# --- Negative fixtures (the gate must NOT flag) ---------------------

run_fixture pass "line-comment-with-pattern" \
  '// Inverts await import("@atlas/ee/something")'

run_fixture pass "multi-line-block-comment-with-pattern" \
  '/* this references await import("@atlas/ee/something") for history; * the production code uses yield* Tag instead. */'

run_fixture pass "empty-file" \
  '// no EE references here'

# --- Summary --------------------------------------------------------

echo "----------------------------------------------------"
echo "Passed: $PASS  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
