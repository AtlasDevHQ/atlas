#!/bin/bash
# Adversarial fixture suite for scripts/check-no-admin-plugin.sh (#3159).
#
# Locks in: the gate FAILS when the Better Auth admin plugin / adminClient /
# getAdminApi / admin-permissions.ts is reintroduced, and PASSES on the
# legitimate post-removal shape — including the false-positive traps
# (`customSession`, `adminAuth`, a comment that merely mentions the plugin).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-no-admin-plugin.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# run_fixture EXPECTED  API_FILE_CONTENT  WEB_FILE_CONTENT  [EXTRA_SETUP_CMD]
run_fixture() {
  local expected="$1" name="$2" api_content="$3" web_content="$4" extra="${5:-}"
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/src/lib/auth" "$tmp/packages/web/src/lib/auth"
  echo "$api_content" > "$tmp/packages/api/src/lib/auth/server.ts"
  echo "$web_content" > "$tmp/packages/web/src/lib/auth/client.ts"
  [ -n "$extra" ] && (cd "$tmp" && eval "$extra")

  local status=0
  (cd "$tmp" && bash "$SCRIPT" > /dev/null 2>&1) || status=$?

  if { [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; } ||
     { [ "$expected" = "fail" ] && [ "$status" -ne 0 ]; }; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

CLEAN_API='import { bearer, organization, jwt, customSession } from "better-auth/plugins";
export function buildPlugins() { return [bearer(), organization({})]; }'
CLEAN_WEB='import { organizationClient } from "better-auth/client/plugins";
export const authClient = { plugins: [organizationClient()] };'

# --- legitimate post-removal shape -----------------------------------------
run_fixture pass "clean post-removal tree" "$CLEAN_API" "$CLEAN_WEB"

# customSession / adminAuth must not trip the admin() import matcher.
run_fixture pass "customSession + adminAuth are not the admin plugin" \
  'import { bearer, customSession } from "better-auth/plugins";
   function adminAuth() {} // local middleware, unrelated' \
  "$CLEAN_WEB"

# A comment that mentions the plugin (this file documents its own history).
run_fixture pass "comment mentioning admin() plugin is stripped" \
  '// historically: import { admin } from "better-auth/plugins"
   import { bearer } from "better-auth/plugins";' \
  "$CLEAN_WEB"

# --- reintroduction must fail ----------------------------------------------
run_fixture fail "admin imported from better-auth/plugins (leading)" \
  'import { admin, bearer } from "better-auth/plugins";' "$CLEAN_WEB"
run_fixture fail "admin imported from better-auth/plugins (trailing)" \
  'import { bearer, admin } from "better-auth/plugins";' "$CLEAN_WEB"
run_fixture fail "admin imported from better-auth/plugins (multiline, formatter-friendly)" \
  'import {
  bearer,
  admin,
  organization,
} from "better-auth/plugins";' "$CLEAN_WEB"
# customSession across multiple lines must NOT trip (no bare `admin`).
run_fixture pass "multiline import without admin is clean" \
  'import {
  bearer,
  customSession,
  organization,
} from "better-auth/plugins";' "$CLEAN_WEB"
run_fixture fail "adminClient reintroduced in web" \
  "$CLEAN_API" 'import { adminClient } from "better-auth/client/plugins";'
run_fixture fail "getAdminApi reintroduced in api" \
  'async function getAdminApi() { return null; }' "$CLEAN_WEB"
run_fixture fail "admin-permissions.ts mirror recreated (api)" \
  "$CLEAN_API" "$CLEAN_WEB" \
  'echo "export const x = 1;" > packages/api/src/lib/auth/admin-permissions.ts'
run_fixture fail "admin-permissions.ts mirror recreated (web)" \
  "$CLEAN_API" "$CLEAN_WEB" \
  'echo "export const x = 1;" > packages/web/src/lib/auth/admin-permissions.ts'

echo ""
echo "check-no-admin-plugin.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
