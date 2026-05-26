#!/bin/bash
# Adversarial fixture suite for scripts/check-twenty-resolver-imports.sh.
#
# Mirrors scripts/__tests__/check-ee-imports.test.sh: the two gates
# share the same comment-stripping logic, so they share the same bug
# classes (same-line block comment hiding a real import, JSDoc
# false-positive, etc.). The fixtures here lock in the Twenty gate's
# allow-list (ee/src/saas-crm/ + plugins/twenty/src|__tests__) and the
# `\b`-bounded pattern (`resolveOperatorCredentials` matches, but a
# lookalike like `resolveOperatorCredentialsFromCache` must not).
#
# Each fixture lives in a temporary mirror of the repo layout so the
# script can run against it without touching the real codebase.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-twenty-resolver-imports.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# run_fixture EXPECTED FIXTURE_PATH FIXTURE_CONTENT
#   EXPECTED:        "pass" — gate exits 0; "fail" — gate exits nonzero.
#   FIXTURE_PATH:    relative path under the tmp repo, e.g.
#                    "packages/api/src/lib/violator.ts" or
#                    "ee/src/saas-crm/allowed.ts".
#   FIXTURE_CONTENT: file body.
run_fixture() {
  local expected="$1"
  local fixture_path="$2"
  local fixture_content="$3"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  local dir
  dir="$(dirname "$fixture_path")"
  mkdir -p "$tmp/$dir"
  echo "$fixture_content" > "$tmp/$fixture_path"

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

echo "Adversarial fixtures for scripts/check-twenty-resolver-imports.sh"
echo "================================================================="

# --- Positive fixtures (the gate MUST flag) ----------------------------

run_fixture fail "packages/api/src/lib/violator.ts" \
  'import { resolveOperatorCredentials } from "@useatlas/twenty";'

run_fixture fail "packages/api/src/lib/try-violator.ts" \
  'import { tryResolveOperatorCredentials } from "@useatlas/twenty";'

# Legacy `@deprecated` aliases must also be confined to the allowed
# dirs — they re-export the operator function, so a caller using the
# old name lands in the same env-only code path and can leak just as
# much as a caller using the new name.
run_fixture fail "packages/api/src/lib/legacy-from-env.ts" \
  'import { resolveCredentialsFromEnv } from "@useatlas/twenty";'

run_fixture fail "packages/api/src/lib/legacy-try-from-env.ts" \
  'import { tryResolveCredentialsFromEnv } from "@useatlas/twenty";'

run_fixture fail "packages/api/src/lib/same-line-block-comment.ts" \
  '/* TODO: revisit */ import { resolveOperatorCredentials } from "@useatlas/twenty";'

run_fixture fail "packages/api/src/lib/jsdoc-then-import-same-line.ts" \
  '/** explain */ import { resolveOperatorCredentials } from "@useatlas/twenty";'

run_fixture fail "packages/api/src/lib/dynamic-import.ts" \
  'const { resolveOperatorCredentials } = await import("@useatlas/twenty");'

run_fixture fail "packages/api/src/lib/trailing-block-comment.ts" \
  'import { resolveOperatorCredentials } from "@useatlas/twenty"; /* old */'

run_fixture fail "ee/src/somewhere-else/violator.ts" \
  'import { resolveOperatorCredentials } from "@useatlas/twenty";'

# --- Negative fixtures (the gate MUST NOT flag) ------------------------

# Allowed dirs: ee/src/saas-crm/, plugins/twenty/src/, plugins/twenty/__tests__/.
run_fixture pass "ee/src/saas-crm/index.ts" \
  'import { resolveOperatorCredentials, tryResolveOperatorCredentials } from "@useatlas/twenty";'

run_fixture pass "plugins/twenty/src/credential-resolver.ts" \
  'export function resolveOperatorCredentials() { return null; }'

run_fixture pass "plugins/twenty/__tests__/credential-resolver.test.ts" \
  'import { resolveOperatorCredentials } from "../src/credential-resolver";'

# Comment-only mention must not trip the gate.
run_fixture pass "packages/api/src/lib/line-comment.ts" \
  '// resolveOperatorCredentials is platform-only (#2850).'

run_fixture pass "packages/api/src/lib/multi-line-block-comment.ts" \
  '/* this references resolveOperatorCredentials for history; * the production code uses resolveWorkspaceCredentials. */'

# Lookalike must NOT match due to the trailing `\b` word boundary.
run_fixture pass "packages/api/src/lib/lookalike-suffix.ts" \
  'import { resolveOperatorCredentialsFromCache } from "@some/other/pkg";'

# Empty file (no pattern anywhere) is fine.
run_fixture pass "packages/api/src/lib/empty.ts" \
  '// no Twenty references here'

# --- Summary -----------------------------------------------------------

echo "-----------------------------------------------------------------"
echo "Passed: $PASS  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
