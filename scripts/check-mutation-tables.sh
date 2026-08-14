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
# ## Two modes, because the full sweep is MINUTES, not seconds
#
# Two measurements, each read off a real CI run rather than estimated:
#   - #5077, EIGHT specs:    832s (~14 min)
#   - #5061, THIRTEEN specs: 948s (15m48s), PR #5222
#
# ⚠️ RE-MEASURE WHEN YOU ADD A SPEC; do not scale the number in your head. The
# two points above are 1.6x the suite-runs apart and only 14% apart in wall
# clock, so the relationship is not linear and extrapolating from a spec count
# will mislead you. Both digits are hand-typed and nothing regenerates them;
# read the duration off the `mutation-tables` job on your own PR.
#
# The argument does not depend on the digits: `/ci` is ~10 minutes in total, so
# an always-full gate would MORE THAN DOUBLE the pre-PR loop — and a gate that
# doubles the loop gets commented out inside a week. A disabled gate catches
# nothing, so cost is a correctness property here, not an optimisation.
#
#   --affected [base]   Verify only the specs whose dependency set the branch
#                       touched. The common PR touches none and the gate is
#                       instant. This is what ci-local.sh runs.
#   --all               Every spec. What CI runs.
#   --shard I/N         Only this shard's slice of the selection, round-robin by
#                       position, 1-based. CI runs four in parallel; the slices
#                       are disjoint and their union is the whole selection.
#   --list-only         Print the selection and exit 0 without verifying. A seam
#                       for testing the partition — see the fixture suite.
#
# ⚠️ The "still FREE" claim that stood here was already conditional on `Built
# image (docs)` running, and that condition does NOT hold on an ordinary PR: the
# docs image is path-gated and skips, which this job's own run-step comment says
# in the workflow. Measured on four PRs from this batch — 15.6, 15.9, 18.4 and
# 31.0 minutes for `mutation-tables`, against 3.9 for the next slowest job in
# the same runs. It was not free; it was the entire critical path. Hence the
# shard: the work is unchanged and spread over four machines. Re-read those
# numbers off a real run before trusting them again.
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
SHARD_INDEX=""
SHARD_TOTAL=""
LIST_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --all) MODE="all"; shift ;;
    --affected)
      MODE="affected"; shift
      if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then BASE="$1"; shift; fi
      ;;
    --shard)
      shift
      if [ $# -eq 0 ]; then echo "check-mutation-tables: --shard needs I/N (1-based)" >&2; exit 1; fi
      # ⚠️ Validate LOUDLY. A malformed --shard that fell through to "no
      # sharding" would run every spec on every shard — slow but green, so
      # nobody would notice; one that fell through to "empty" would verify
      # NOTHING on every shard and still exit 0. Both are false-cleans of the
      # exact class this whole file exists to refuse, so an unparseable value
      # is a hard error rather than a default.
      case "$1" in
        [1-9]*/[1-9]*) : ;;
        *) echo "check-mutation-tables: --shard expects I/N with I,N >= 1 (got '$1')" >&2; exit 1 ;;
      esac
      SHARD_INDEX="${1%%/*}"; SHARD_TOTAL="${1##*/}"
      if [ "$SHARD_INDEX" -gt "$SHARD_TOTAL" ]; then
        echo "check-mutation-tables: --shard $1 — index exceeds total." >&2; exit 1
      fi
      shift
      ;;
    # Print the selection and exit without running any mutation. The partition
    # below has to be TOTAL — every spec on exactly one shard — and proving that
    # against the real specs would cost a full sweep per shard, so the property
    # gets a seam of its own rather than going untested. Same reasoning as
    # MUTATION_SPEC_GLOB.
    --list-only) LIST_ONLY=1; shift ;;
    *) echo "check-mutation-tables: unknown argument: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT/packages/api"

# ⚠️ A SEAM, so the adversarial fixture can point this at a throwaway tree.
# `scripts/__tests__/check-mutation-tables.test.sh` needs to prove the gate
# CATCHES a hand-edited table and a skipped target; without an override it could
# only ever be run against the real specs, which is a ~16-minute assertion.
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
        # ⚠️ TWO different states reach here and they are NOT the same verdict.
        # Collapsing them into `exit 0` was the last false-green left in this
        # file, and it fired at the worst possible moment (#5151).
        #
        #   HEAD != BASE — the branch genuinely touches no spec's dependencies.
        #     "Nothing to verify" is the true answer and a green PASS is honest.
        #
        #   HEAD == BASE — there is no committed delta AT ALL, so the affected
        #     set is empty BY CONSTRUCTION. This gate cannot verify anything via
        #     --affected here no matter what state the tables are in. That is
        #     exactly where `/ci` sits when run from `main` immediately before
        #     `/release` — the one moment CLAUDE.md makes the full run mandatory
        #     — so the gate reported a green PASS for a check it had structurally
        #     declined to perform, precisely when it was most wanted.
        #
        # Declining (3) rather than widening to --all is deliberate: the full
        # sweep is 948s MEASURED at thirteen specs (see the header), more
        # than the rest of ci-local.sh combined,
        # and remote CI already runs --all on every push to main, so widening
        # would re-verify the same SHA at the highest cost for no new coverage.
        # What was missing was not coverage, it was an honest verdict.
        HEAD_SHA=$(cd "$ROOT" && git rev-parse HEAD 2>&1) || HEAD_SHA=""
        BASE_SHA=$(cd "$ROOT" && git rev-parse "$BASE" 2>&1) || BASE_SHA=""
        if [ -z "$HEAD_SHA" ] || [ -z "$BASE_SHA" ]; then
          # Widen, never narrow — the fourth instance of this twin in this file.
          # An unresolvable ref here cannot prove the set is non-empty by
          # construction, and "cannot tell" must never render as a green PASS.
          echo "check-mutation-tables: cannot resolve HEAD or '$BASE' to compare them — declining."
          echo "  An empty affected set that MIGHT be empty by construction is not a verification."
          exit 3
        fi
        if [ "$HEAD_SHA" = "$BASE_SHA" ]; then
          echo "check-mutation-tables: HEAD == $BASE, so the affected set is empty BY CONSTRUCTION —"
          echo "  ${#SPECS[@]} spec(s) not verified. This gate cannot check anything via --affected here."
          echo "  Coverage for this SHA is remote CI's --all job on the push to $BASE."
          echo "  To verify locally instead: bash scripts/check-mutation-tables.sh --all  (~16 min — see the header)."
          exit 3
        fi
        echo "check-mutation-tables: no spec's targets or sources changed vs $BASE — nothing to verify."
        echo "  (push: main runs --all, so a table that drifted for another reason is still caught there.)"
        exit 0
      fi
      echo "check-mutation-tables: ${#SELECTED[@]} of ${#SPECS[@]} spec(s) affected by this branch."
    fi
  fi
fi
if [ "$MODE" = "all" ]; then SELECTED=("${SPECS[@]}"); fi

# --- Shard ------------------------------------------------------------------
# AFTER selection, deliberately. Sharding is a way to spend the same work on
# more machines; it must not change WHICH specs are in scope, and every
# widen-never-narrow and exit-3 decision above stays the sole authority on that.
#
# Round-robin by position, so the matrix is N fixed entries and never names a
# spec. A shard list that enumerated spec names would leave a NEWLY ADDED spec
# on no shard at all — verified by nothing, green forever — which is the same
# defect as the four stale tables in this file's header, arriving by a new door.
# `SPECS` is a sorted glob, so position is stable within a run.
#
# Balance is lumpy on purpose: cost tracks a spec's mutation COUNT, not its
# existence, so the long pole is whichever single spec has the most mutations
# and no assignment can beat it. Sharding finer than "by spec" needs mutate.ts
# to partition its own mutation list.
if [ -n "$SHARD_TOTAL" ]; then
  SHARDED=()
  for i in "${!SELECTED[@]}"; do
    if [ $(( i % SHARD_TOTAL )) -eq $(( SHARD_INDEX - 1 )) ]; then SHARDED+=("${SELECTED[$i]}"); fi
  done
  echo "check-mutation-tables: shard $SHARD_INDEX/$SHARD_TOTAL — ${#SHARDED[@]} of ${#SELECTED[@]} selected spec(s)."
  SELECTED=(${SHARDED[@]+"${SHARDED[@]}"})
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  for spec in ${SELECTED[@]+"${SELECTED[@]}"}; do echo "SELECTED $spec"; done
  echo "check-mutation-tables: --list-only, ${#SELECTED[@]} spec(s) listed, nothing verified."
  exit 0
fi

# An empty shard is honest work: the specs exist and another shard has them.
# This is NOT the empty-affected-set case above, which exits 3 because nothing
# anywhere would verify them.
if [ ${#SELECTED[@]} -eq 0 ]; then
  echo "check-mutation-tables: shard ${SHARD_INDEX:-1}/${SHARD_TOTAL:-1} has no specs — verified by its siblings."
  exit 0
fi

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
