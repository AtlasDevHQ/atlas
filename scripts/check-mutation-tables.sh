#!/usr/bin/env bash
# check-mutation-tables.sh — CI gate that keeps the GENERATED mutation tables
# under packages/api/scripts/mutations/*.md in step with their specs (#5077).
#
# `scripts/mutate.ts --check` existed and worked from the day #5060 landed the
# runner. Nothing ran it, so the tables drifted exactly the way the runner was
# built to stop. Measured on `main` at the time this gate was written: FOUR of
# eight were stale — cardinality, identity-corpus, object-cmp, and
# mutation-core, the runner's OWN table, whose `escapeCell` row had been a dead
# ANCHOR since #5060/#4389 rewrote the escape it pointed at. A table nobody
# re-runs is back to being a hand-written claim that happens to be formatted
# like a measurement, which is the whole thing #5060 was an investment against.
#
# ## Two modes, because the full sweep is 832 SECONDS
#
# Measured, not estimated: verifying all eight specs takes ~14 minutes, because
# each one re-runs every target suite once per mutation. `/ci` is ~10 minutes in
# total, so an always-full gate would MORE THAN DOUBLE the pre-PR loop — and a
# gate that doubles the loop gets commented out inside a week. A disabled gate
# catches nothing, so cost is a correctness property here, not an optimisation.
#
#   --affected [base]   Verify only the specs whose dependency set the branch
#                       touched. The common PR touches none and the gate is
#                       instant. This is what ci-local.sh runs.
#   --all               Every spec. What CI runs, where 14 minutes is FREE:
#                       jobs run in parallel and the docs image already takes
#                       ~25 minutes, so this finishes inside the existing
#                       critical path and costs nothing in wall clock.
#
# A spec's dependencies come from `mutate.ts --files` — the loaded spec's own
# target and edit paths — rather than from a grep, because they sit behind
# `SOURCE`-style consts a regex would miss, and a dependency list that silently
# misses a file is a gate that silently stops gating. Changing the runner or the
# renderer (`mutate.ts`, `mutation-core.ts`, `mutation-spec.ts`) marks EVERY spec
# affected: those decide the output bytes for all of them.
#
# ## Why TEST_DATABASE_URL gates the whole thing
#
# Several specs target `*-pg.test.ts`, which self-skip without a live Postgres.
# A skipped test cannot be killed by a mutation, so their counts would be
# deflated — and the obvious "just regenerate" response would COMMIT zeros over
# real measurements. That is the footgun #5077 was filed for. `mutate.ts` now
# refuses at the baseline when any target reports skips, so a zeroed table can
# no longer be produced at all; this script therefore only has to decide whether
# it can measure, not whether the numbers are honest.
#
# ⚠️ The skip path exits 0 deliberately, matching ci-local.sh's existing posture
# for the -pg suites themselves. CI sets the variable, so the gate genuinely
# runs where it counts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

MODE="all"
BASE="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --all) MODE="all"; shift ;;
    --affected)
      MODE="affected"; shift
      if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then BASE="$1"; shift; fi
      ;;
    *) echo "check-mutation-tables: unknown argument: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT/packages/api"

SPECS=(scripts/mutations/*.mutations.ts)
if [ ${#SPECS[@]} -eq 0 ] || [ ! -e "${SPECS[0]}" ]; then
  echo "check-mutation-tables: no specs found under packages/api/scripts/mutations/ — did the directory move?" >&2
  exit 1
fi

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "check-mutation-tables: SKIPPED — TEST_DATABASE_URL unset."
  echo "  ${#SPECS[@]} spec(s) not verified. Several target *-pg.test.ts, which self-skip"
  echo "  without a live Postgres; their counts would be deflated. Run 'bun run db:up' and"
  echo "  export TEST_DATABASE_URL to verify locally."
  exit 0
fi

# --- Narrow to the affected specs -------------------------------------------
SELECTED=()
if [ "$MODE" = "affected" ]; then
  if ! CHANGED=$(cd "$ROOT" && git diff --name-only "$BASE"...HEAD 2>/dev/null); then
    # ⚠️ Widen, never narrow, when the base is unresolvable (a shallow clone, a
    # detached HEAD, a deleted branch). Silently verifying NOTHING is the one
    # outcome this gate must never produce, and it is indistinguishable from a
    # clean run in the log.
    echo "check-mutation-tables: cannot diff against '$BASE' — falling back to --all."
    MODE="all"
  else
    # Uncommitted work counts too: pre-PR is exactly when the table goes stale.
    CHANGED="$CHANGED
$(cd "$ROOT" && git diff --name-only HEAD 2>/dev/null || true)"
    RUNNER_TOUCHED=0
    for f in scripts/mutate.ts scripts/mutation-core.ts scripts/mutation-spec.ts; do
      if printf '%s\n' "$CHANGED" | grep -qxF "packages/api/$f"; then RUNNER_TOUCHED=1; fi
    done
    if [ "$RUNNER_TOUCHED" -eq 1 ]; then
      echo "check-mutation-tables: the runner/renderer changed — every table's bytes are in scope."
      MODE="all"
    else
      for spec in "${SPECS[@]}"; do
        DEPS="$spec"$'\n'"$(bun run scripts/mutate.ts "$spec" --files)"
        while IFS= read -r dep; do
          [ -z "$dep" ] && continue
          if printf '%s\n' "$CHANGED" | grep -qxF "packages/api/$dep"; then
            SELECTED+=("$spec"); break
          fi
        done <<< "$DEPS"
      done
      if [ ${#SELECTED[@]} -eq 0 ]; then
        echo "check-mutation-tables: no spec's targets or sources changed vs $BASE — nothing to verify."
        echo "  (CI runs --all regardless, so a table that drifted for another reason is still caught.)"
        exit 0
      fi
      echo "check-mutation-tables: ${#SELECTED[@]} of ${#SPECS[@]} spec(s) affected by this branch."
    fi
  fi
fi
if [ "$MODE" = "all" ]; then SELECTED=("${SPECS[@]}"); fi

echo "check-mutation-tables: verifying ${#SELECTED[@]} generated table(s)…"
echo "  (each spec re-runs its suites under every mutation — minutes, not seconds)"

STALE=()
for spec in "${SELECTED[@]}"; do
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

echo "check-mutation-tables: all ${#SELECTED[@]} verified table(s) current."
