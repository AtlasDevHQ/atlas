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

# --- non-www base-price parity (#4061) --------------------------------------
# Sibling of the llms.txt block above: three more surfaces advertise the same
# per-seat base price but can't import the generated mirror, so they could
# silently drift from plans.ts — the exact #4060 bug class, this time on
# docs.useatlas.dev (customer-facing) and the settings registry. They split
# into two binding shapes:
#   • tier-label-adjacent prose — the Stripe price-ID row descriptions in the
#     env-var reference AND the matching settings.ts setting `description`
#     strings, both reading "Starter plan (monthly, $39/seat)". Price is bound
#     to its tier label on the line, so a per-tier grep catches a swap.
#   • the billing-and-plans Plan Tiers table — prices are positional table
#     columns, so the column ORDER is pinned via the header row and the Price
#     row is asserted to carry the three prices in that order (see below).
echo ":: Verifying non-www base-price surfaces against the artifact..."

BILLING_DOC="apps/docs/content/docs/guides/billing-and-plans.mdx"
ENV_DOC="apps/docs/content/shared/reference/environment-variables.mdx"
SETTINGS="packages/api/src/lib/settings.ts"

# Re-read each tier price from the same artifact line proven current above.
# intentionally ignored: a no-match leaves the price empty; the combined -z
# guard below converts that into an actionable exit 1 (never a silent skip).
read_tier_price() {
  printf '%s' "$price_line" | grep -oE "$1: [0-9]+" | grep -oE '[0-9]+' || true
}
starter_price="$(read_tier_price starter)"
pro_price="$(read_tier_price pro)"
business_price="$(read_tier_price business)"
# Reject an empty read once, before either consumer — so neither the prose
# loop nor the table check can build a degenerate pattern from a missing price,
# independent of the order they run in.
if [ -z "$starter_price" ] || [ -z "$pro_price" ] || [ -z "$business_price" ]; then
  echo "Could not read one or more tier prices (starter/pro/business) from $ARTIFACT — has TIER_MONTHLY_PRICE moved?" >&2
  exit 1
fi

# Stripe price-ID descriptions (env-var doc + settings.ts share the wording).
for pair in "Starter:$starter_price" "Pro:$pro_price" "Business:$business_price"; do
  label="${pair%%:*}"
  price="${pair##*:}"
  # ERE: `${label} plan \(monthly, \$${price}/seat` → e.g.
  # `Starter plan \(monthly, \$39/seat` (literal paren + dollar), binding the
  # price to its tier label in the price-ID description line. `monthly,` keeps
  # it off the adjacent `..._ANNUAL_PRICE_ID` "(annual)" rows.
  for surface in "$ENV_DOC" "$SETTINGS"; do
    if ! grep -qE "${label} plan \(monthly, \\\$${price}/seat" "$surface"; then
      echo "$surface: the ${label} Stripe price-ID description must read \$${price}/seat (from $ARTIFACT) — it has drifted from plans.ts." >&2
      echo "Update the ${label} '(monthly, \$N/seat)' annotation in $surface so it reads \$${price}/seat." >&2
      exit 1
    fi
  done
done

# Plan Tiers table: prices are positional columns, so binding price→tier takes
# two steps, each anchored to ITS table row (not a whole-file substring — a
# stray correct copy elsewhere in the doc must not be able to satisfy a check
# while the real table has drifted).
#
# (1) Pin the column ORDER via the header ROW (a line that starts `| | …`).
# Without this a header reorder would silently remap each column's price to the
# wrong tier — the positional run alone is blind to the labels, unlike the
# llms.txt line-binding.
if ! grep -qE '^\| +\| Starter \| Pro \| Business \| Self-Hosted \|' "$BILLING_DOC"; then
  echo "$BILLING_DOC: the Plan Tiers header row must read '| | Starter | Pro | Business | Self-Hosted |' — the positional price check binds to that column order." >&2
  exit 1
fi
# (2) Read the actual `**Price**` row, anchored to its row label.
# intentionally ignored: no match → empty; the -z guard below converts that to
# an actionable exit 1 (never a silent skip).
price_row="$(grep -E '^\| \*\*Price\*\* \|' "$BILLING_DOC" | head -n1 || true)"
if [ -z "$price_row" ]; then
  echo "$BILLING_DOC: could not find the Plan Tiers '**Price**' row — has the table format changed?" >&2
  exit 1
fi
# Assert that row carries the three prices in column order, ANCHORED to the row
# label so column position is absolute: the expected string includes the leading
# `| **Price** |` cell, binding $starter_price to the FIRST data column (a
# one-column shift like `| **Price** | Free | $39 …` can't pass). Shell `\$`
# builds the literal string; `grep -qF` matches it verbatim, so the `|`/`$`/`/`
# need no GREP-regex escaping (the `\$` here is shell-level escaping, distinct
# from the ERE `\(`/`\$` in the prose block above).
expected_price_row="| **Price** | \$${starter_price} / seat / mo | \$${pro_price} / seat / mo | \$${business_price} / seat / mo"
if ! printf '%s' "$price_row" | grep -qF "$expected_price_row"; then
  echo "$BILLING_DOC: the Plan Tiers Price row must read '$expected_price_row | …' (Starter|Pro|Business per-seat, from $ARTIFACT) — it has drifted from plans.ts." >&2
  exit 1
fi

echo "Non-www base-price surfaces match the drift-checked artifact."
