#!/bin/bash
# Adversarial fixture suite for scripts/check-enforcement-parity.sh (#3997).
#
# Locks in that the enforcement-leg drift guard can't silently no-op: it PASSES
# on the committed tree (every SSOT feature gated or recorded pending) and FAILS
# when the SSOT ↔ pending-allowlist ↔ route-gate triangle is tampered with. The
# pure mapping correctness is covered by the unit test
# packages/api/src/lib/billing/__tests__/enforcement-parity.test.ts; this proves
# the *gate wired into CI* actually fires on real on-disk drift.
#
# Each fixture mutates a single committed file, runs the gate, asserts the
# expected status, then restores — so a failing case can't leave the tree dirty.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-enforcement-parity.sh"
PENDING="$ROOT/packages/api/src/lib/billing/enforcement-parity.ts"
SSO_ROUTE="$ROOT/packages/api/src/api/routes/admin-sso.ts"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi
for f in "$PENDING" "$SSO_ROUTE"; do
  if [ ! -f "$f" ]; then
    echo "::error::expected file not found at $f" >&2
    exit 2
  fi
done

PASS=0
FAIL=0

check() {
  local expected="$1" name="$2"
  local status=0
  bash "$SCRIPT" > /dev/null 2>&1 || status=$?
  if { [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; } ||
     { [ "$expected" = "fail" ] && [ "$status" -ne 0 ]; }; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi
}

# Back the mutated files up so we always restore the committed versions, even
# on error.
PENDING_BAK="$(mktemp)"; cp "$PENDING" "$PENDING_BAK"
SSO_BAK="$(mktemp)"; cp "$SSO_ROUTE" "$SSO_BAK"
restore() {
  cp "$PENDING_BAK" "$PENDING"; rm -f "$PENDING_BAK"
  cp "$SSO_BAK" "$SSO_ROUTE"; rm -f "$SSO_BAK"
}
trap restore EXIT

# --- committed tree passes --------------------------------------------------
check pass "committed tree: every SSOT feature gated or pending"

# --- rule 1: an ungated, unacknowledged feature fails -----------------------
# Drop `masking` from ENFORCEMENT_PENDING. It's in the SSOT and has no route
# gate yet (#3984), so the guard must catch the now-silently-open ladder.
# (`scim`/`custom_roles`/`ip_allowlist`/`approvals` are no longer usable here —
# #3987 gated them, so dropping their pending entry creates no drift.)
cp "$PENDING_BAK" "$PENDING"
perl -0pi -e 's/^\s*masking:\s*"#3984",\n//m' "$PENDING"
check fail "removing a pending entry for an ungated feature trips the gate"
cp "$PENDING_BAK" "$PENDING"

# --- rule 3: a phantom pending entry fails ----------------------------------
# Add a pending entry for a feature that isn't in the SSOT.
cp "$PENDING_BAK" "$PENDING"
perl -0pi -e 's/(export const ENFORCEMENT_PENDING[^{]*\{)/$1\n  ghost_feature: "#0000",/' "$PENDING"
check fail "a phantom pending entry (not in the SSOT) trips the gate"
cp "$PENDING_BAK" "$PENDING"

# --- rule 2: a stale pending entry (feature now enforced) fails -------------
# Simulate `masking` getting wired: add a route-layer gate call for it AND leave
# it in ENFORCEMENT_PENDING. The guard must flag the stale allowlist entry.
# (Use a still-pending feature — `scim` et al. are already enforced + removed
# from pending by #3987, so they can't fake a stale-pending state.)
cp "$SSO_BAK" "$SSO_ROUTE"
perl -0pi -e 's/(yield\* requireFeatureEntitlement\(orgId, "sso"\);)/$1\n    yield* requireFeatureEntitlement(orgId, "masking");/' "$SSO_ROUTE"
check fail "a feature that is enforced but still listed pending trips the gate"
cp "$SSO_BAK" "$SSO_ROUTE"

# --- restored tree passes again ---------------------------------------------
check pass "restored tree is in sync again"

echo ""
echo "check-enforcement-parity.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
