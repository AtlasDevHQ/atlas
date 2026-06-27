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
LLMS="$ROOT/apps/www/public/llms.txt"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi
if [ ! -f "$ARTIFACT" ]; then
  echo "::error::generated artifact not found at $ARTIFACT" >&2
  exit 2
fi
if [ ! -f "$LLMS" ]; then
  echo "::error::llms.txt not found at $LLMS" >&2
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

# Back both mutated files up so we always restore the committed files, even on
# error (the artifact for the SSOT-mirror fixtures, llms.txt for the static
# base-price fixture).
BACKUP="$(mktemp)"
LLMS_BACKUP="$(mktemp)"
cp "$ARTIFACT" "$BACKUP"
cp "$LLMS" "$LLMS_BACKUP"
restore() {
  cp "$BACKUP" "$ARTIFACT"
  cp "$LLMS_BACKUP" "$LLMS"
  rm -f "$BACKUP" "$LLMS_BACKUP"
}
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

# Mutate a TIER_MONTHLY_PRICE base price (#4060): regress Starter $39 → $29, the
# original drift this guard exists to prevent. The on-disk price no longer
# matches what the generator renders from plans.ts, so the gate must fail.
sed -i 's/starter: 39/starter: 29/' "$ARTIFACT"
check fail "a regressed base price in the artifact trips the gate"
cp "$BACKUP" "$ARTIFACT"

# Static llms.txt drift (#4060): change an advertised per-seat price so it no
# longer matches the artifact's SSOT-derived figure. The artifact itself stays
# in sync, so only the llms.txt parity step can catch this.
sed -i 's#\$39/seat/mo#$29/seat/mo#' "$LLMS"
check fail "a stale base price in llms.txt trips the gate"
cp "$LLMS_BACKUP" "$LLMS"

# Tier/price swap in llms.txt (#4060): exchange Starter's and Pro's prices,
# keeping the SET of price tokens {39,69,149} intact. A membership-only check
# would pass this; the tier-label-bound check must catch that Starter no longer
# reads $39/seat.
sed -i 's#Starter (\$39/seat/mo), Pro (\$69/seat/mo)#Starter ($69/seat/mo), Pro ($39/seat/mo)#' "$LLMS"
check fail "a tier/price swap in llms.txt trips the gate"
cp "$LLMS_BACKUP" "$LLMS"

# --- restored files pass again ----------------------------------------------
check pass "restored artifact + llms.txt are in sync again"

echo ""
echo "check-pricing-parity.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
