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

# Build the minimal repo layout the script requires in $tmp: both scopes
# (CORE_DIR + ALLOWED_FILE and MCP_DIR + its two allowlisted seam files) must
# exist or the script exits 2 (missing-scope guard) before scanning anything.
scaffold_scopes() {
  local tmp="$1"
  mkdir -p "$tmp/packages/api/src/lib/effect" "$tmp/packages/api/src/lib"
  cat > "$tmp/packages/api/src/lib/effect/enterprise-layer.ts" <<EOF
// Allowed-file placeholder for the fixture suite.
EOF
  mkdir -p "$tmp/packages/mcp/src"
  cat > "$tmp/packages/mcp/src/onboarding.ts" <<EOF
// Allowlisted SaaS-coupled seam placeholder for the fixture suite.
EOF
  cat > "$tmp/packages/mcp/src/actor.ts" <<EOF
// Allowlisted SaaS-coupled seam placeholder for the fixture suite.
EOF
}

# `expect_pass FIXTURE_FILE` — the gate should exit 0 against this fixture.
# `expect_fail FIXTURE_FILE` — the gate should exit 1 and list FIXTURE_FILE.
#
# Optional 4th arg = the scope-relative dir the fixture is written into
# (default "packages/api/src/lib"); use "packages/mcp/src" to exercise the
# MCP scope. The fixture name doubles as the .ts basename.
run_fixture() {
  local expected="$1"      # "pass" or "fail"
  local fixture_name="$2"
  local fixture_content="$3"
  local fixture_dir="${4:-packages/api/src/lib}"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  scaffold_scopes "$tmp"

  # Write the fixture (escape any nested $).
  mkdir -p "$tmp/$fixture_dir"
  echo "$fixture_content" > "$tmp/$fixture_dir/$fixture_name.ts"

  # Run the gate; capture status without aborting the suite.
  local status=0
  (cd "$tmp" && bash "$SCRIPT" > /dev/null 2>&1) || status=$?

  # `fail` asserts EXACTLY exit 1 (an offense), not merely "non-zero": an
  # exit-2 precondition crash (scaffold rot, a missing seam file) must not
  # masquerade as a passing offense-fixture, or the positive fixtures could be
  # silently neutered while the suite stays green. Exit-2 paths are asserted
  # separately by `expect_exit2`.
  if [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; then
    echo "  ok   $fixture_name (expected pass)"
    PASS=$((PASS + 1))
  elif [ "$expected" = "fail" ] && [ "$status" -eq 1 ]; then
    echo "  ok   $fixture_name (expected fail)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $fixture_name — expected $expected (exit $([ "$expected" = pass ] && echo 0 || echo 1)), got status=$status" >&2
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

# --- MCP scope fixtures (#3998) -------------------------------------
# A NEW @atlas/ee importer anywhere in packages/mcp/src (outside the two
# allowlisted seam files) is a regression the gate must flag.
run_fixture fail "mcp-new-importer" \
  'import { foo } from "@atlas/ee/something";' \
  "packages/mcp/src"

run_fixture fail "mcp-new-dynamic-importer" \
  'const mod = await import("@atlas/ee/governance/approval");' \
  "packages/mcp/src/lib"

# An @atlas/ee import IN an allowlisted MCP seam file is the documented,
# formally SaaS-coupled carve-out — the gate must NOT flag it. ("onboarding"
# overwrites the placeholder scaffold; the static import mirrors the real
# onboarding.ts trial-provisioning seam.)
run_fixture pass "onboarding" \
  'import { provisionTrialWorkspace } from "@atlas/ee/onboarding/provision-trial";' \
  "packages/mcp/src"

run_fixture pass "actor" \
  'const { anyApprovalRuleEnabled } = await import("@atlas/ee/governance/approval");' \
  "packages/mcp/src"

# --- Precondition guards (the gate must fail LOUD, exit 2) ----------
# The script exits 2 (not 0, not 1) when a scanned scope or an allowlisted
# seam file is missing — so a moved/renamed file can never silently pass the
# scan. These branches are the fail-closed safety net the issue cares about,
# so assert the EXACT exit code (2), distinct from an offense (exit 1).
#
# `expect_exit2 NAME` scaffolds both scopes, runs MUTATE to break one
# precondition, then asserts exit 2.
expect_exit2() {
  local name="$1"
  local mutate="$2"   # shell snippet run in $tmp to break a precondition

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  scaffold_scopes "$tmp"
  (cd "$tmp" && eval "$mutate")

  local status=0
  (cd "$tmp" && bash "$SCRIPT" > /dev/null 2>&1) || status=$?

  if [ "$status" -eq 2 ]; then
    echo "  ok   $name (expected exit 2)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected exit 2, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$tmp"
  trap - RETURN
}

# Whole MCP scope dir gone → exit 2 (never a silent skip that scans nothing).
expect_exit2 "missing-mcp-scope-dir" \
  'rm -rf packages/mcp/src'

# An allowlisted seam file moved/renamed → exit 2 (the silent-widening
# safety net: a stale MCP_ALLOWED_FILES entry must fail loud, not whitelist
# a vanished file while a new unguarded copy lives elsewhere).
expect_exit2 "moved-mcp-seam-file" \
  'rm -f packages/mcp/src/onboarding.ts'

# Same contract for the API scope's allowed boot-time composition file.
expect_exit2 "missing-api-allowed-file" \
  'rm -f packages/api/src/lib/effect/enterprise-layer.ts'

# --- Summary --------------------------------------------------------

echo "----------------------------------------------------"
echo "Passed: $PASS  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
