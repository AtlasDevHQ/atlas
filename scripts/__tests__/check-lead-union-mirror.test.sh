#!/bin/bash
# Adversarial fixture suite for scripts/check-lead-union-mirror.sh (#3653).
#
# The gate guards a single load-bearing line in ee/src/saas-crm/index.ts:
#   const _leadUnionsAreMirrors: ExactType<SaasCrmLeadInput, AtlasLeadEvent> = true;
# These fixtures lock in that it (a) passes when the assertion + bivariance
# ExactType definition are present, and (b) fails on every way the guarantee
# can silently evaporate: line deleted, commented out, ExactType neutered to a
# trivial alias, wrong type args, or the SSOT file missing entirely.
#
# Each fixture runs in a temporary mirror of the repo layout so the gate runs
# against it without touching the real codebase.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-lead-union-mirror.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# A valid ExactType definition + assertion, reused by the positive fixtures.
EXACTTYPE_DEF='type ExactType<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;'
VALID_ASSERTION='const _leadUnionsAreMirrors: ExactType<SaasCrmLeadInput, AtlasLeadEvent> = true;'

# run_fixture EXPECTED FIXTURE_PATH FIXTURE_CONTENT
#   EXPECTED:        "pass" — gate exits 0; "fail" — gate exits nonzero.
#   FIXTURE_PATH:    relative path under the tmp repo. Use a NON-target path to
#                    exercise the "SSOT file missing" branch.
run_fixture() {
  local expected="$1"
  local fixture_path="$2"
  local fixture_content="$3"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  mkdir -p "$tmp/$(dirname "$fixture_path")"
  printf '%s\n' "$fixture_content" > "$tmp/$fixture_path"

  local status=0
  (cd "$tmp" && bash "$SCRIPT" > /dev/null 2>&1) || status=$?

  if [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; then
    echo "  ok   $fixture_path (expected pass)"
    PASS=$((PASS + 1))
  elif [ "$expected" = "fail" ] && [ "$status" -ne 0 ]; then
    echo "  ok   $fixture_path (expected fail)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $fixture_path — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$tmp"
  trap - RETURN
}

echo "Adversarial fixtures for scripts/check-lead-union-mirror.sh"
echo "=========================================================="

# --- Positive fixtures (the gate MUST pass) ----------------------------

run_fixture pass "ee/src/saas-crm/index.ts" \
  "$EXACTTYPE_DEF
$VALID_ASSERTION
void _leadUnionsAreMirrors;"

# Whitespace tolerance — extra spacing around the type args must still pass.
run_fixture pass "ee/src/saas-crm/index.ts" \
  "$EXACTTYPE_DEF
const _leadUnionsAreMirrors :  ExactType< SaasCrmLeadInput , AtlasLeadEvent >  =  true ;"

# --- Negative fixtures (the gate MUST flag) ----------------------------

# Assertion deleted entirely (only the ExactType def remains).
run_fixture fail "ee/src/saas-crm/index.ts" \
  "$EXACTTYPE_DEF
// the mirror assertion was removed in a careless refactor"

# Assertion commented out (line-comment) — must not satisfy the gate.
run_fixture fail "ee/src/saas-crm/index.ts" \
  "$EXACTTYPE_DEF
// $VALID_ASSERTION"

# Assertion commented out (block comment).
run_fixture fail "ee/src/saas-crm/index.ts" \
  "$EXACTTYPE_DEF
/* $VALID_ASSERTION */"

# ExactType neutered to a trivial always-true alias (fails open) — assertion
# present but the definition no longer enforces equality.
run_fixture fail "ee/src/saas-crm/index.ts" \
  "type ExactType<A, B> = true;
$VALID_ASSERTION"

# Wrong type args — a guard pointed at the wrong unions must not pass.
run_fixture fail "ee/src/saas-crm/index.ts" \
  "$EXACTTYPE_DEF
const _leadUnionsAreMirrors: ExactType<SomeOther, ThingEntirely> = true;"

# SSOT file missing entirely (the file moved / was deleted).
run_fixture fail "ee/src/saas-crm/other-file.ts" \
  "$EXACTTYPE_DEF
$VALID_ASSERTION"

# --- Summary -----------------------------------------------------------

echo "----------------------------------------------------------"
echo "Passed: $PASS  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
