#!/usr/bin/env bash
# check-pricing-parity.sh — CI check that the pricing-page entitlement
# artifact is in sync with the FeatureEntitlement SSOT (WS4 of #3984 / #3996).
#
# FEATURE_ENTITLEMENTS in packages/api/src/lib/billing/feature-entitlement.ts
# is the single source of truth mapping every gated capability to the minimum
# plan tier that unlocks it — the same map the request-time enforcement guard
# reads. The marketing site (@atlas/www) is a standalone Next.js app that must
# not import @atlas/api (CLAUDE.md: the frontend is a pure HTTP client), so the
# pricing comparison table renders from a generated mirror:
# apps/www/src/app/pricing/entitlements.generated.ts.
#
# This script runs the generator in `--check` mode: it regenerates the
# artifact in memory and fails (non-zero) if the on-disk file does not match,
# without writing and without consulting git. That catches a feature
# added/removed/re-tiered in the SSOT (or a label/section added to
# FEATURE_DISPLAY) that wasn't regenerated, so the page's per-tier feature
# columns can never silently diverge from what the code actually enforces —
# while never spuriously failing on unrelated working-tree edits.
#
# The generator also hard-fails (via assertDisplayExhaustive) if FEATURE_DISPLAY
# and FEATURE_ENTITLEMENTS diverge (a new gated feature with no label/section),
# so this gate catches "forgot to label a feature" and "forgot to regenerate"
# alike.
#
# Run locally: bash scripts/check-pricing-parity.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

echo ":: Verifying pricing entitlement artifact against FEATURE_ENTITLEMENTS..."
# The generator exits non-zero (with an actionable message) when the artifact
# is stale; `set -e` propagates that as the gate failure.
bun scripts/generate-pricing-entitlements.ts --check

echo "Pricing-parity drift check passed — entitlement artifact is in sync with FEATURE_ENTITLEMENTS."

# --- static llms.txt base-price parity (#4060) ------------------------------
# apps/www/public/llms.txt is a static marketing asset: it can't import the
# generated mirror (it's not TS), so its per-seat prices are hand-maintained
# and could silently drift from plans.ts — the exact #4060 bug class, in the
# one surface the generated mirror can't reach. The --check above already
# proved the artifact's TIER_MONTHLY_PRICE matches plans.ts, so assert llms.txt
# advertises those same per-seat prices, each BOUND TO ITS TIER LABEL on the
# line ("Starter ($39/seat/mo)") — a membership-only check would pass a
# Starter↔Pro price swap that merely preserves the set of price tokens.
echo ":: Verifying apps/www/public/llms.txt base prices against the artifact..."
ARTIFACT="apps/www/src/app/pricing/entitlements.generated.ts"
LLMS="apps/www/public/llms.txt"

# The per-column base prices live on a single generated line, e.g.
#   selfHosted: 0, starter: 39, pro: 69, business: 149,
# Entitlement-row cells render booleans (`starter: false`), so a numeric
# `selfHosted: <n>` uniquely identifies the TIER_MONTHLY_PRICE values line —
# read it once rather than grepping `<tier>: <n>` over the whole file, so the
# read stays robust if the generator ever emits other per-column numerics.
# `|| true` keeps the empty result from tripping `set -e`/`pipefail` so the
# actionable -z branch below can run instead of a bare exit.
price_line="$(grep -E 'selfHosted: [0-9]+' "$ARTIFACT" | head -n1 || true)"
if [ -z "$price_line" ]; then
  echo "Could not find the TIER_MONTHLY_PRICE values in $ARTIFACT — has the generated format changed?" >&2
  exit 1
fi

# Tier key -> the capitalized label it appears under in llms.txt.
for pair in "starter:Starter" "pro:Pro" "business:Business"; do
  key="${pair%%:*}"
  label="${pair##*:}"
  price="$(printf '%s' "$price_line" | grep -oE "${key}: [0-9]+" | grep -oE '[0-9]+' || true)"
  if [ -z "$price" ]; then
    echo "Could not read the ${key} price from $ARTIFACT — has TIER_MONTHLY_PRICE moved?" >&2
    exit 1
  fi
  # ERE: `${label} \(\$${price}/seat` → e.g. `Starter \(\$39/seat` (literal
  # paren + dollar), binding the price to its tier label on the same line.
  if ! grep -qE "${label} \(\\\$${price}/seat" "$LLMS"; then
    echo "llms.txt: ${label} must advertise \$${price}/seat (from $ARTIFACT) — it has drifted from plans.ts." >&2
    echo "Update apps/www/public/llms.txt so ${label} reads \$${price}/seat." >&2
    exit 1
  fi
done

echo "llms.txt base prices match the drift-checked artifact."
