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
BILLING_DOC="$ROOT/apps/docs/content/docs/guides/billing-and-plans.mdx"
ENV_DOC="$ROOT/apps/docs/content/docs/reference/environment-variables.mdx"
SETTINGS="$ROOT/packages/api/src/lib/settings.ts"

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
for f in "$BILLING_DOC" "$ENV_DOC" "$SETTINGS"; do
  if [ ! -f "$f" ]; then
    echo "::error::non-www base-price surface not found at $f" >&2
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

# Back every mutated file up so we always restore the committed files, even on
# error (the artifact for the SSOT-mirror fixtures, llms.txt + the three
# non-www surfaces for the static base-price fixtures).
BACKUP="$(mktemp)"
LLMS_BACKUP="$(mktemp)"
BILLING_BACKUP="$(mktemp)"
ENV_BACKUP="$(mktemp)"
SETTINGS_BACKUP="$(mktemp)"
cp "$ARTIFACT" "$BACKUP"
cp "$LLMS" "$LLMS_BACKUP"
cp "$BILLING_DOC" "$BILLING_BACKUP"
cp "$ENV_DOC" "$ENV_BACKUP"
cp "$SETTINGS" "$SETTINGS_BACKUP"
restore() {
  cp "$BACKUP" "$ARTIFACT"
  cp "$LLMS_BACKUP" "$LLMS"
  cp "$BILLING_BACKUP" "$BILLING_DOC"
  cp "$ENV_BACKUP" "$ENV_DOC"
  cp "$SETTINGS_BACKUP" "$SETTINGS"
  rm -f "$BACKUP" "$LLMS_BACKUP" "$BILLING_BACKUP" "$ENV_BACKUP" "$SETTINGS_BACKUP"
}
trap restore EXIT

# Shared-worktree race tripwire (CLAUDE.md: this repo is a shared working tree).
# This suite mutates tracked files IN PLACE and trap-restores them, so it must
# not run concurrently against the same tree. If a concurrent run had a surface
# mid-mutation when we backed it up above, our restore() would later write the
# WRONG baseline back — reintroducing drift into a source file (settings.ts).
# Best-effort tripwire: assert each non-www backup captured the in-sync $39
# Starter price (the value our own fail-fixtures regress FROM), so the common
# poisoning — a concurrent run regressing Starter's price away from $39 — exits
# LOUDLY (code 2 + ::error::) here rather than being silently persisted. (The
# EXIT trap still fires, so a poisoned backup is restored either way; the point
# is that it is surfaced in CI / git diff, never a silent pass. A swap that
# keeps $39 present elsewhere in the file would slip this presence check — an
# accepted limit, since CI runs in isolated checkouts where the race can't occur.)
for bk in "$BILLING_BACKUP" "$ENV_BACKUP" "$SETTINGS_BACKUP"; do
  if ! grep -q '\$39' "$bk"; then
    echo "::error::a non-www surface backup is missing the in-sync \$39 Starter price — a concurrent run may have mutated the working tree mid-backup. Failing loudly so drift can't be silently persisted." >&2
    exit 2
  fi
done

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

# Stale base price in the customer-facing Plan Tiers table (#4061): regress
# Starter $39 → $29 in the billing-and-plans Price row. The artifact stays in
# sync, so only the non-www table-parity step can catch this.
sed -i 's#| \$39 / seat / mo #| $29 / seat / mo #' "$BILLING_DOC"
check fail "a stale base price in billing-and-plans.mdx trips the gate"
cp "$BILLING_BACKUP" "$BILLING_DOC"

# Tier/price swap in the Plan Tiers table (#4061): exchange the Starter and Pro
# columns, keeping {39,69,149} intact. The positional contiguous-run check must
# catch that the columns are now out of order.
sed -i 's#\$39 / seat / mo | \$69 / seat / mo#$69 / seat / mo | $39 / seat / mo#' "$BILLING_DOC"
check fail "a tier/price swap in billing-and-plans.mdx trips the gate"
cp "$BILLING_BACKUP" "$BILLING_DOC"

# Header-column reorder in the Plan Tiers table (#4061): swap the Starter and
# Pro header labels while leaving the price row intact. The positional price run
# still matches, so only the header-order pin can catch that each column now
# advertises the wrong tier's price.
sed -i 's#| Starter | Pro | Business | Self-Hosted |#| Pro | Starter | Business | Self-Hosted |#' "$BILLING_DOC"
check fail "a header-column reorder in billing-and-plans.mdx trips the gate"
cp "$BILLING_BACKUP" "$BILLING_DOC"

# Stale base price in the env-var reference Stripe price-ID description (#4061):
# regress Starter $39 → $29. Only the tier-label-bound prose check catches it.
sed -i 's#Starter plan (monthly, \$39/seat)#Starter plan (monthly, $29/seat)#' "$ENV_DOC"
check fail "a stale base price in environment-variables.mdx trips the gate"
cp "$ENV_BACKUP" "$ENV_DOC"

# Tier/price swap in the env-var Stripe descriptions (#4061): exchange Starter's
# and Pro's per-seat prices, keeping {39,69,149} intact. A membership-only check
# would pass; the tier-label-bound prose grep must catch that Starter no longer
# reads $39/seat. (settings.ts shares the identical grep logic — the same prose
# loop greps both surfaces; its stale-price case is fixtured separately below.)
sed -i 's#Starter plan (monthly, \$39/seat)#Starter plan (monthly, $69/seat)#; s#Pro plan (monthly, \$69/seat)#Pro plan (monthly, $39/seat)#' "$ENV_DOC"
check fail "a tier/price swap in environment-variables.mdx trips the gate"
cp "$ENV_BACKUP" "$ENV_DOC"

# Stale base price in the settings.ts setting description (#4061): regress
# Starter $39 → $29. Only the tier-label-bound prose check catches it.
sed -i 's#Starter plan (monthly, \$39/seat)#Starter plan (monthly, $29/seat)#' "$SETTINGS"
check fail "a stale base price in settings.ts trips the gate"
cp "$SETTINGS_BACKUP" "$SETTINGS"

# --- restored files pass again ----------------------------------------------
check pass "restored artifact + llms.txt + non-www surfaces are in sync again"

echo ""
echo "check-pricing-parity.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
