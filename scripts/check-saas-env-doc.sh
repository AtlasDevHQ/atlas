#!/usr/bin/env bash
# check-saas-env-doc.sh — CI check that the generated SaaS env-var table in
# the operator reference is in sync with the SAAS_ENV_KEYS SSOT (#3707).
#
# SAAS_ENV_KEYS in packages/api/src/lib/effect/saas-env.ts is the
# compile-time-exhaustive list of every env var the SaaS-mode boot contract
# reads. The authoritative table in
# apps/docs/content/docs/platform-ops/saas-environment-variables.mdx is
# machine-generated from it by scripts/generate-saas-env-doc.ts.
#
# This script runs the generator in `--check` mode: it regenerates the table
# in memory and fails (non-zero) if the on-disk generated block does not match,
# without writing and without consulting git. That means it catches a var
# added/removed/renamed in SAAS_ENV_KEYS (or KEY_META) that wasn't regenerated,
# but does NOT spuriously fail on in-progress edits to the curated prose
# *outside* the auto-generated markers (which the generator never touches).
#
# The generator also hard-fails if KEY_META and SAAS_ENV_KEYS diverge (a new
# SSOT key with no description) or if a cell contains an unescaped `|`, so this
# gate catches "forgot to add a description" and "forgot to regenerate" alike.
#
# Run locally: bash scripts/check-saas-env-doc.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

echo ":: Verifying SaaS env table against SAAS_ENV_KEYS..."
# The generator exits non-zero (with an actionable message) when the generated
# block is stale; `set -e` propagates that as the gate failure.
bun scripts/generate-saas-env-doc.ts --check

echo "SaaS env doc check passed — operator table is in sync with SAAS_ENV_KEYS."
