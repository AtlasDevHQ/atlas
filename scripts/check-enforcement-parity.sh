#!/usr/bin/env bash
# check-enforcement-parity.sh — the enforcement leg of the pricing-parity drift
# guard (WS1/WS4 of #3984 / #3997).
#
# #3996 shipped check-pricing-parity.sh, which proves the marketing pricing
# table mirrors the FEATURE_ENTITLEMENTS SSOT (the page-claims ↔ SSOT leg).
# This sibling adds the third leg the parent PRD asks for: that every gated
# capability in the SSOT is actually ENFORCED — i.e. a route handler consults
# `requireFeatureEntitlement(orgId, "<feature>")` so a below-tier workspace is
# denied at the API boundary, not just hidden in the UI.
#
# It fails (non-zero) when the SSOT, the reviewed not-yet-wired allowlist
# (ENFORCEMENT_PENDING in packages/api/src/lib/billing/enforcement-parity.ts),
# and the actual route-layer gates disagree — so the page can never advertise a
# tier-gated feature that the API silently leaves open to every tier.
#
# Run locally: bash scripts/check-enforcement-parity.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

echo ":: Verifying entitlement SSOT is enforced at the route layer..."
# The runner scans packages/api/src/api/routes/** for requireFeatureEntitlement
# call sites and exits non-zero (with an actionable message) on any drift;
# `set -e` propagates that as the gate failure.
bun scripts/check-enforcement-parity.ts

echo "Pricing-parity enforcement check passed — the entitlement SSOT is enforced (or explicitly pending) at the route layer."
