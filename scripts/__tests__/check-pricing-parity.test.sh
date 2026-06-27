#!/bin/bash
# Adversarial fixture suite for scripts/check-pricing-parity.sh (WS4 #3996).
#
# Locks in that the drift guard can't silently no-op: it PASSES on the
# committed (in-sync) artifact and FAILS when the generated artifact is
# tampered with — a stale/edited mirror of FEATURE_ENTITLEMENTS. The mirror's
# mapping correctness is covered by the unit test
# packages/api/src/lib/billing/__tests__/pricing-entitlement-artifact.test.ts;
# this proves the *gate wired into CI* actually fires on drift.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-pricing-parity.sh"
ARTIFACT="$ROOT/apps/www/src/app/pricing/entitlements.generated.ts"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi
if [ ! -f "$ARTIFACT" ]; then
  echo "::error::generated artifact not found at $ARTIFACT" >&2
  exit 2
fi

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

# Back the artifact up so we always restore the committed file, even on error.
BACKUP="$(mktemp)"
cp "$ARTIFACT" "$BACKUP"
restore() { cp "$BACKUP" "$ARTIFACT"; rm -f "$BACKUP"; }
trap restore EXIT

# --- in-sync artifact passes ------------------------------------------------
check pass "committed artifact is in sync with the SSOT"

# --- tampered artifact fails ------------------------------------------------
printf '\n// drift injected by the adversarial fixture\n' >> "$ARTIFACT"
check fail "appended content trips the gate"
cp "$BACKUP" "$ARTIFACT"

# Flip a granted cell off — a mirror that lies about what a tier unlocks.
sed -i 's/business: true/business: false/' "$ARTIFACT"
check fail "a flipped entitlement cell trips the gate"
cp "$BACKUP" "$ARTIFACT"

# Simulate what a Pro re-tier WOULD look like if the artifact were edited but
# the SSOT wasn't: flip one row's `pro` cell on. The gate must catch this —
# it's the column-level drift (page advertises a tier the SSOT doesn't grant)
# the mirror exists to prevent.
sed -i '0,/pro: false, business: true/{s/pro: false, business: true/pro: true, business: true/}' "$ARTIFACT"
check fail "an injected Pro-column over-claim trips the gate"
cp "$BACKUP" "$ARTIFACT"

# --- restored artifact passes again -----------------------------------------
check pass "restored artifact is in sync again"

echo ""
echo "check-pricing-parity.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
