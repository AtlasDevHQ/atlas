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
# ⚠️ The skip path exits **3**, not 0 — `ci-local.sh` renders that as SKIP rather
# than PASS. A green row for a gate that verified nothing is the same defect
# class as the deflated table this exists to refuse, and the compact table is
# what the /ci agent protocol reads. CI sets the variable, so the gate genuinely
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

# ⚠️ A SEAM, so the adversarial fixture can point this at a throwaway tree.
# `scripts/__tests__/check-mutation-tables.test.sh` needs to prove the gate
# CATCHES a hand-edited table and a skipped target; without an override it could
# only ever be run against the real specs, which is a 14-minute assertion.
SPECS=(${MUTATION_SPEC_GLOB:-scripts/mutations/*.mutations.ts})
if [ ${#SPECS[@]} -eq 0 ] || [ ! -e "${SPECS[0]}" ]; then
  echo "check-mutation-tables: no specs found under packages/api/scripts/mutations/ — did the directory move?" >&2
  exit 1
fi

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "check-mutation-tables: SKIPPED — TEST_DATABASE_URL unset."
  echo "  ${#SPECS[@]} spec(s) not verified. Several target *-pg.test.ts, which self-skip"
  echo "  without a live Postgres; their counts would be deflated. Run 'bun run db:up' and"
  echo "  export TEST_DATABASE_URL to verify locally."
  # ⚠️ 3, not 0. `ci-local.sh` renders 3 as SKIP; exiting 0 put a green PASS row
  # in the compact table for a gate that verified NOTHING — which the /ci agent
  # protocol reads as a clean pre-PR pass. A gate unable to distinguish
  # "verified" from "declined to verify" is the same defect class as the
  # deflated table this whole change exists to refuse.
  exit 3
fi

# --- Narrow to the affected specs -------------------------------------------
SELECTED=()
if [ "$MODE" = "affected" ]; then
  # ⚠️ `--no-renames` on BOTH diffs, which the comment below claimed and the code
  # did not. git reports only the NEW path for a rename (diff.renames has
  # defaulted true since 2.9), so a target still listed in a spec under its old
  # path never matched — measured: a committed rename broke a spec and the gate
  # exited 0 with "nothing to verify". Stderr is captured, not discarded, so the
  # widen prints its reason.
  if ! CHANGED=$(cd "$ROOT" && git diff --name-only --no-renames "$BASE"...HEAD 2>&1); then
    # ⚠️ Widen, never narrow, when the base is unresolvable (a shallow clone, a
    # detached HEAD, a deleted branch). Silently verifying NOTHING is the one
    # outcome this gate must never produce, and it is indistinguishable from a
    # clean run in the log.
    echo "check-mutation-tables: cannot diff against '$BASE' ($CHANGED) — falling back to --all."
    MODE="all"
  else
    # ⚠️ Uncommitted work counts too — pre-PR is exactly when a table goes stale
    # — and this MIRRORS the base-diff handling above rather than swallowing the
    # failure. The first cut wrote `2>/dev/null || true` here, six lines under
    # the comment forbidding exactly that: an index lock or a corrupt index then
    # yielded an empty append, the branch's own work became invisible, and the
    # gate printed "nothing to verify" and exited 0 — indistinguishable from
    # clean. Widen, never narrow.
    if ! UNCOMMITTED=$(cd "$ROOT" && git diff --name-only --no-renames HEAD 2>&1); then
      echo "check-mutation-tables: cannot diff the working tree ($UNCOMMITTED) — falling back to --all."
      MODE="all"
    else
      # Untracked files too — a brand-new corpus or spec is invisible to `git
      # diff`, and that narrows silently.
      # ⚠️ The THIRD instance of this twin in this one file, which is why the
      # sweep has to be mechanical rather than remembered. Same command family,
      # same failure modes (index.lock, EACCES, an unreadable excludesFile), same
      # consequence: an empty result narrows the selector, a brand-new spec or
      # corpus goes invisible, and the gate prints "nothing to verify" and exits
      # 0. No `|| true` anywhere in this selector.
      if ! UNTRACKED=$(cd "$ROOT" && git ls-files --others --exclude-standard 2>&1); then
        echo "check-mutation-tables: cannot list untracked files ($UNTRACKED) — falling back to --all."
        MODE="all"
        UNTRACKED=""
      fi
      CHANGED="$CHANGED
$UNCOMMITTED
$UNTRACKED"
    fi
    RUNNER_TOUCHED=0
    # signal-retry.ts decides how EVERY suite is spawned, so it belongs here with
    # the runner and the renderer — it was missing from the first cut.
    for f in scripts/mutate.ts scripts/mutation-core.ts scripts/mutation-spec.ts scripts/signal-retry.ts; do
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
          # ⚠️ NORMALISE. A spec may legitimately reach outside packages/api —
          # `bundle-identity` mutates `../types/src/migration.ts` — and naive
          # prefixing produced `packages/api/../types/src/migration.ts`, which
          # git never emits, so that dependency could NEVER select its spec.
          # Silently, and only for the cross-package case.
          rel=$(cd "$ROOT/packages/api" && realpath -m --relative-to="$ROOT" "$dep")
          if printf '%s\n' "$CHANGED" | grep -qxF "$rel"; then
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

# ⚠️ mktemp, not a fixed /tmp path. This runs from a parallel harness, and a
# pre-existing root-owned or symlinked `/tmp/mutate-check.log` makes the redirect
# fail — which the `if` reads as STALE, a false red on a healthy table.
LOG=$(mktemp)

# ⚠️ **AN INTERRUPT HERE LEAVES MUTATED SOURCE IN THE TREE UNLESS THIS TRAP
# EXISTS, and it is not hypothetical — it happened twice in one session.**
#
# `mutate.ts` REWRITES SOURCE FILES in place and restores them when it finishes;
# it installs its own SIGINT/SIGTERM handler for exactly this reason. But that
# handler only helps if the signal REACHES it. Kill this script — or the
# `ci-local.sh` above it — and bash dies immediately while the `bun` child keeps
# running, gets re-parented to init, and marches on through the remaining specs,
# rewriting files the whole way. The operator sees the harness "stop", then finds
# modified sources appearing in `git status` minutes later, from a process no
# longer in any obvious process tree. A `git commit -o` in that window commits a
# DELIBERATE FAULT INJECTION as production code — one such mutant strips a
# `timedOut` guard from a circuit breaker.
#
# So: run the child in the background, record its PID, and forward the signal to
# it rather than dying alone. `wait` lets its own restore handler run to
# completion before this script exits — the whole point is to give it that
# chance, so do NOT `kill -9` here and do not skip the wait.
CHILD_PID=""
cleanup() {
  local sig="${1:-}"
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    # Bounded, because an unbounded wait on a wedged child would hang the very
    # interrupt the operator reached for. 15s is generous for a restore, which
    # is a handful of file writes.
    for _ in $(seq 1 150); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CHILD_PID" 2>/dev/null; then
      kill -KILL "$CHILD_PID" 2>/dev/null || true
      echo "" >&2
      echo "WARNING: mutate.ts did not restore within 15s and was killed hard." >&2
      echo "  RUN \`git status\` — a mutated source file may be left in the tree." >&2
    fi
  fi
  rm -f "$LOG"
  if [ -n "$sig" ]; then
    echo "" >&2
    echo "interrupted — sources restored." >&2
    # 128 + signal number, the shell convention, matching mutate.ts's own exit.
    case "$sig" in
      INT) exit 130 ;;
      *) exit 143 ;;
    esac
  fi
}
trap 'cleanup INT' INT
trap 'cleanup TERM' TERM
trap 'cleanup' EXIT

STALE=()
for spec in "${SELECTED[@]}"; do
  bun run scripts/mutate.ts "$spec" --check >"$LOG" 2>&1 &
  CHILD_PID=$!
  # `set -e` is on, so a non-zero `wait` would abort the loop before the STALE
  # arm could report which spec failed; `|| rc=$?` keeps the status.
  rc=0
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  if [ "$rc" -eq 0 ]; then
    echo "  OK    $spec"
  else
    echo "  STALE $spec"
    sed 's/^/        /' "$LOG" | tail -20
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
