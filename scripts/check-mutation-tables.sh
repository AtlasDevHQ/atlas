#!/usr/bin/env bash
# check-mutation-tables.sh — CI gate that keeps the GENERATED mutation tables
# under packages/api/scripts/mutations/*.md in step with their specs (#5077).
#
# `scripts/mutate.ts --check` existed and worked from the day #5060 landed the
# runner. Nothing ran it, so the tables drifted exactly the way the runner was
# built to stop: four were found stale on `main` during #5032 (`object-cmp.md`
# 58 vs 59 tests, `cardinality.md` 47 vs 70 plus a dead anchor), and
# `mutation-core.md` — the runner's OWN table — carried an ANCHOR failure after
# #5060/#4389 rewrote the escape it pointed at. A table nobody re-runs is back
# to being a hand-written claim that happens to be formatted like a measurement,
# which is the entire thing #5060 was an investment against.
#
# ## Why this gate is conditional on TEST_DATABASE_URL, and why that is not a hole
#
# Several specs target `*-pg.test.ts`, which self-skip without a live Postgres.
# A skipped test cannot be killed by a mutation, so running `--check` without
# one would compare against systematically deflated numbers and report every
# such table as stale, forever — and the obvious "just regenerate it" response
# would COMMIT the zeros over real measurements. That is the footgun #5077 was
# filed for.
#
# The runner now refuses that outright: `mutate.ts` fails at the baseline if any
# target reported skips (see its guardrail 4), so a zeroed table can no longer
# be produced at all, by this gate or by hand. This script therefore does not
# need to police correctness — only to decide whether it can measure. With
# TEST_DATABASE_URL it verifies every spec; without one it SKIPS LOUDLY, the
# same posture ci-local.sh already takes for the -pg suites themselves. CI sets
# the variable (ci.yml's api-tests job has the postgres service), so the gate
# genuinely runs where it counts.
#
# ⚠️ The skip path prints and exits 0 deliberately. A gate that fails on every
# developer machine without Postgres gets disabled within a week, and a disabled
# gate is worth less than a conditional one that runs in CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT/packages/api"

SPECS=(scripts/mutations/*.mutations.ts)
if [ ${#SPECS[@]} -eq 0 ] || [ ! -e "${SPECS[0]}" ]; then
  echo "check-mutation-tables: no specs found under packages/api/scripts/mutations/ — did the directory move?" >&2
  exit 1
fi

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "check-mutation-tables: SKIPPED — TEST_DATABASE_URL unset."
  echo "  ${#SPECS[@]} spec(s) not verified. Several target *-pg.test.ts, which self-skip"
  echo "  without a live Postgres; measuring them anyway would compare real numbers against"
  echo "  deflated ones. Run 'bun run db:up' and export TEST_DATABASE_URL to verify locally."
  exit 0
fi

echo "check-mutation-tables: verifying ${#SPECS[@]} generated table(s) against their specs…"
echo "  (each spec re-runs its suites under every mutation — this is minutes, not seconds)"

STALE=()
for spec in "${SPECS[@]}"; do
  if bun run scripts/mutate.ts "$spec" --check >/tmp/mutate-check.log 2>&1; then
    echo "  OK    $spec"
  else
    echo "  STALE $spec"
    sed 's/^/        /' /tmp/mutate-check.log | tail -20
    STALE+=("$spec")
  fi
done

if [ ${#STALE[@]} -gt 0 ]; then
  echo ""
  echo "ERROR: ${#STALE[@]} generated mutation table(s) are stale or unmeasurable." >&2
  echo "A stale table is a hand-written claim wearing a measurement's formatting." >&2
  echo "" >&2
  echo "To fix, per spec:" >&2
  for spec in "${STALE[@]}"; do
    echo "  cd packages/api && bun run scripts/mutate.ts $spec" >&2
  done
  exit 1
fi

echo "check-mutation-tables: all ${#SPECS[@]} table(s) current."
