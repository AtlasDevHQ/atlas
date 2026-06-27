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
