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
# Two sample sets, each read off real CI runs rather than estimated:
#   - #5077, EIGHT specs:    832s
#   - #5061, THIRTEEN specs: 908-1859s across nine runs, median ~950s
#
# ⚠️ Do not quote a single figure. That spread is the same thirteen specs on the
# same runner class, so any one-decimal number implies precision this
# measurement does not have — an earlier draft here reasoned from a single 948s
# point to "the relationship is not linear", and the 14% delta that argument
# rested on is inside the run-to-run noise. Re-read the range off the
# `mutation-tables` job on your own PR before relying on it.
#
# The argument does not depend on the digits: `/ci` is ~10 minutes in total, so
# an always-full gate would MORE THAN DOUBLE the pre-PR loop — and a gate that
# doubles the loop gets commented out inside a week. A disabled gate catches
# nothing, so cost is a correctness property here, not an optimisation.
#
#   --affected [base]   Verify only the specs whose dependency set the branch
#                       touched. The common PR touches none and the gate is
#                       instant. This is what ci-local.sh runs.
#   --all               Every spec. Every push to main.
#   --shard I/N         Only this shard's slice, round-robin by position over the
#                       spec glob, 1-based. CI runs four in parallel; the slices
#                       are disjoint and their union is the whole selection.
#   --list-only         Print the selection and exit 3 without verifying. Seam
#                       for `scripts/__tests__/check-mutation-tables.test.sh`.
#
# ⚠️ This gate is NOT free, and where the cost lands is narrower than it looks.
# It is paid in full whenever the sweep is at `--all`: every push to main, and
# any PR touching a spec's targets. On a PR that touches none, `--affected`
# selects nothing and the job is under a minute. Cost and the retired "it runs
# inside the docs image's shadow" claim: the `mutation-tables` job in
# `.github/workflows/ci.yml`.
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
# ⚠️ Initialised, not merely assigned under the shard branch. `PRE_SHARD_COUNT`
# and `SHARD_OWNED` are written inside `if [ -n "$SHARD_TOTAL" ]` and read below
# it; that was safe only by an argument about which paths can reach the read,
# and one of the two supporting branches turned out to be unreachable. Under
# `set -u` an unbound read exits 1 — which is this script's code for STALE, so a
# config crash would have rendered as a drifted table.
PRE_SHARD_COUNT=0
SHARD_OWNED=0
SHARD_RESIDUE=0
SHARD_RESIDUE_OF=1
SHARD_LABEL="1/1"
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
      if [ -n "$SHARD_TOTAL" ]; then
        echo "check-mutation-tables: --shard given twice; the second would silently win." >&2; exit 1
      fi
      # ⚠️ ANCHORED, and BOUNDED, and `[[ =~ ]]` rather than a `case` glob.
      #
      # The first cut used `case "$1" in [1-9]*/[1-9]*)`, where `*` matches any
      # run of characters INCLUDING a slash, so it constrained one character per
      # field and nothing else. `1x/4` passed it, then `[ 1x -gt 4 ]` returned
      # status 2 — inside an `if` CONDITION, where set -e does not fire — which
      # bash read as false, and the run carried on with every spec and exit 0.
      # `1/4/9` became a 9-way partition because `##*/` takes the last field.
      #
      # The `{0,3}` bound closes the SAME mechanism one class over: anchoring
      # constrained syntax but not magnitude, so `1/99999999999999999999` still
      # overflowed `[`, still returned status 2 in a condition, and still
      # bypassed the range check below. Bounding the digits here is structural;
      # a second `[` whose status-2 arm nobody reads would not be.
      if ! [[ "$1" =~ ^[1-9][0-9]{0,3}/[1-9][0-9]{0,3}$ ]]; then
        echo "check-mutation-tables: --shard expects I/N, both integers 1-9999 (got '$1')" >&2; exit 1
      fi
      SHARD_INDEX="${1%%/*}"; SHARD_TOTAL="${1##*/}"
      if [ "$SHARD_INDEX" -gt "$SHARD_TOTAL" ]; then
        echo "check-mutation-tables: --shard $1 — index exceeds total." >&2; exit 1
      fi
      # ⚠️ Normalise ONCE, here, the way packages/api/scripts/test-isolated.ts
      # does. The 1-based CLI value and the 0-based residue used by the modulo
      # were previously converted at two separate sites — the predicate and the
      # operator-facing message — so the two could drift and the message would
      # misreport which residue class was empty. Below this line there is no
      # shard arithmetic, only these names.
      SHARD_RESIDUE=$(( SHARD_INDEX - 1 ))
      SHARD_RESIDUE_OF="$SHARD_TOTAL"
      SHARD_LABEL="$SHARD_INDEX/$SHARD_TOTAL"
      shift
      ;;
    # Print the selection and exit without verifying. Seam for the partition
    # fixture; same reasoning as MUTATION_SPEC_GLOB.
    --list-only) LIST_ONLY=1; shift ;;
    *) echo "check-mutation-tables: unknown argument: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT/packages/api"

# ⚠️ A SEAM, so the adversarial fixture can point this at a throwaway tree.
# `scripts/__tests__/check-mutation-tables.test.sh` needs to prove the gate
# CATCHES a hand-edited table and a skipped target; without an override it could
# only ever be run against the real specs, which is a multi-minute assertion.
SPECS=(${MUTATION_SPEC_GLOB:-scripts/mutations/*.mutations.ts})
# ⚠️ Shard ownership is a spec's POSITION in this list, so the ORDER is part of
# the partition's contract and must not depend on the ambient locale. Glob
# expansion is collated: under glibc's en_US.UTF-8 punctuation carries no
# primary weight, so `vocabulary.mutations.ts` and `vocabulary-rekey.mutations.ts`
# compare as `vocabularymutationsts` vs `vocabularyrekeymutationsts` and swap
# against C, where `-` (0x2D) sorts before `.` (0x2E). Two of the fourteen specs
# change shard between the two collations.
#
# Sorted here rather than by exporting LC_ALL for the whole process: the locale
# is scoped to the one command whose order matters, ordering becomes a function
# of the file set rather than of the environment, and nothing else in the script
# — git, grep, realpath, or the suites `mutate.ts` spawns — changes behaviour.
if [ ${#SPECS[@]} -gt 0 ]; then
  mapfile -t SPECS < <(printf '%s\n' "${SPECS[@]}" | LC_ALL=C sort)
fi
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
      # ⚠️ Another instance of this twin in this one file, which is why the
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
    if [ "$MODE" = "all" ]; then
      # ⚠️ A widen above already decided every table is in scope. Without this
      # arm, execution fell straight into the selector below, which can exit 0
      # with "nothing to verify" — so the gate ANNOUNCED a widen and then did
      # the opposite. Only the base-diff widen worked, because it skips this
      # whole `else`; the working-tree and untracked widens were dead. Measured
      # with a git shim failing `git diff --name-only --no-renames HEAD` against
      # an uncommitted target edit: "falling back to --all" followed by "nothing
      # to verify", exit 0.
      :
    elif [ "$RUNNER_TOUCHED" -eq 1 ]; then
      echo "check-mutation-tables: the runner/renderer changed — every table's bytes are in scope."
      MODE="all"
    else
      for spec in "${SPECS[@]}"; do
        # ⚠️ ANOTHER INSTANCE OF THIS TWIN IN THIS SELECTOR, and one that the
        # earlier sweeps missed. The three above widen on a failing git call; this one is a
        # bare `$(...)` in an assignment under `set -e`, so a non-zero `--files`
        # aborts the whole script with status 1 — which is this script's code for
        # STALE. The operator then regenerates tables that never drifted, and the
        # real fault sits in a log tail. `--files` can now fail: it reads the
        # seeds' source to walk their imports, and `existsSync` is true for a
        # directory, so a `target.file` that has become one throws EISDIR.
        # ⚠️ STDERR CAPTURED SEPARATELY, not merged and not discarded. Merging it
        # would put diagnostics into a list every line of which is read as a
        # dependency path; discarding it would hide `--files`' own warnings —
        # and those warnings are the ONLY signal that a seed was unreadable and
        # its imports are therefore missing from the list. A quietly shorter
        # dependency list is this gate's one unacceptable failure.
        DEP_ERR=$(mktemp)
        if ! DEP_OUT=$(bun run scripts/mutate.ts "$spec" --files 2>"$DEP_ERR"); then
          echo "check-mutation-tables: cannot list dependencies for $spec — falling back to --all."
          sed 's/^/  /' "$DEP_ERR"
          rm -f "$DEP_ERR"
          MODE="all"
          SELECTED=()
          break
        fi
        if [ -s "$DEP_ERR" ]; then
          # ⚠️ WIDENS, and the first cut of this arm only ANNOUNCED. The comment
          # above calls a quietly shorter dependency list this gate's one
          # unacceptable failure — and then this arm echoed and fell through, so
          # an unreadable corpus produced a short list, no spec was selected, and
          # the gate exited 0 with "nothing to verify". A green PASS row for the
          # exact edit shape the import hop was added to catch.
          #
          # ⚠️ It cannot tell a NARROWING warning (an unreadable seed) from a
          # WIDENING one (`statCandidate`'s "I could not stat it, so I am
          # including it"), because both land in this sink. A reader that cannot
          # distinguish them must assume the worst — which is the same
          # widen-never-narrow rule the three git arms above follow.
          #
          # ⚠️ Widening HERE while the empty-by-construction arm below DECLINES is
          # not an inconsistency, and the difference is worth stating: declining
          # there is right because the full sweep would re-verify a SHA remote CI
          # already covers, buying no coverage for minutes of cost. Here the
          # dependency GRAPH is unreadable, so we do not know which tables are at
          # risk — the sweep buys real coverage.
          echo "check-mutation-tables: $spec's dependency list is INCOMPLETE — falling back to --all."
          sed 's/^/  /' "$DEP_ERR"
          rm -f "$DEP_ERR"
          MODE="all"
          SELECTED=()
          break
        fi
        rm -f "$DEP_ERR"
        DEPS="$spec"$'\n'"$DEP_OUT"
        while IFS= read -r dep; do
          [ -z "$dep" ] && continue
          # ⚠️ NORMALISE. A spec may legitimately reach outside packages/api —
          # `bundle-identity` mutates `../types/src/migration.ts` — and naive
          # prefixing produced `packages/api/../types/src/migration.ts`, which
          # git never emits, so that dependency could NEVER select its spec.
          # Silently, and only for the cross-package case.
          # ⚠️ ANOTHER INSTANCE of the twin this file repeats throughout its
          # selector, and one the round-1 sweep missed while numbering the others.
          # (The ordinals are gone: they contradicted each other — two sites both
          # claimed "fourth", and the one claiming "fifth" sat before one of them —
          # and a comment asserting a position in a sequence rots on every
          # insertion. It rotted twice on one branch.)
          # A `realpath` without GNU coreutils (BSD, busybox) has no
          # `--relative-to`, exits non-zero, and `set -e` kills the script with 1 —
          # this script's code for STALE. The operator then regenerates tables that
          # never drifted while the real fault sits in a log tail.
          if ! rel=$(cd "$ROOT/packages/api" && realpath -m --relative-to="$ROOT" "$dep" 2>&1); then
            echo "check-mutation-tables: cannot normalise dependency '$dep' ($rel) — falling back to --all."
            MODE="all"
            SELECTED=()
            break 2
          fi
          if printf '%s\n' "$CHANGED" | grep -qxF "$rel"; then
            SELECTED+=("$spec"); break
          fi
        done <<< "$DEPS"
      done
      # ⚠️ A widen inside the loop above already decided every table is in scope,
      # exactly as the base-diff / working-tree / untracked widens do. Without
      # this arm, execution falls into the empty-selection block below and can
      # `exit 3` or `exit 0` — so the gate would ANNOUNCE a widen and then do the
      # opposite. That is the same dead-widen defect measured earlier in this
      # file, one door over.
      if [ "$MODE" = "all" ]; then
        :
      elif [ ${#SELECTED[@]} -eq 0 ]; then
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
        # sweep runs in the minutes-not-seconds range the header gives with its
        # spread (do not re-quote a single figure from it — the header says why),
        # more than the rest of ci-local.sh combined,
        # and remote CI already runs --all on every push to main, so widening
        # would re-verify the same SHA at the highest cost for no new coverage.
        # What was missing was not coverage, it was an honest verdict.
        HEAD_SHA=$(cd "$ROOT" && git rev-parse HEAD 2>&1) || HEAD_SHA=""
        BASE_SHA=$(cd "$ROOT" && git rev-parse "$BASE" 2>&1) || BASE_SHA=""
        if [ -z "$HEAD_SHA" ] || [ -z "$BASE_SHA" ]; then
          # Widen, never narrow — the same twin again.
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
      else
        echo "check-mutation-tables: ${#SELECTED[@]} of ${#SPECS[@]} spec(s) affected by this branch."
      fi
    fi
  fi
fi
if [ "$MODE" = "all" ]; then SELECTED=("${SPECS[@]}"); fi

# --- Shard ------------------------------------------------------------------
# AFTER selection, deliberately. Sharding spends the same work on more machines;
# it must not change WHICH specs are in scope, and every widen-never-narrow and
# exit-3 decision above stays the sole authority on that.
#
# ⚠️ OWNERSHIP IS COMPUTED FROM `SPECS`, NOT `SELECTED`, and that is the whole
# correctness argument. `SELECTED` is the selector's output, and the selector
# widens on a transient failure of any of four git calls — per process, so one
# runner can widen while three do not. Partitioning `SELECTED` makes a slice
# depend on that decision: widening one shard RENUMBERS the positions, and a
# spec drops through the gap. Measured on a fixture tree — affected set
# {s11,s12}, shard 2 widened, s12 owned by nobody, all four shards exit 0.
# Widen-never-narrow becomes narrow-the-union the moment its output is the
# thing being cut.
#
# `SPECS` is the sorted glob: identical in every process, so ownership is a pure
# function of (position, N). Intersecting afterwards means a widen can only ever
# make one shard verify MORE, never move work out of a sibling's slice. Both
# properties then hold by construction rather than by fixture.
#
# Round-robin by position, so the matrix is N fixed entries and never names a
# spec. A shard list of spec names would leave a NEWLY ADDED spec on no shard —
# verified by nothing, green forever, the same defect as the four stale tables
# in this file's header.
#
# Balance is lumpy: cost tracks a spec's mutation COUNT and round-robin ignores
# it. Measured 2026-08-16 by generated table rows (288 mutations over 14 specs):
# the four shards carry 87 / 75 / 91 / 35, so the long pole is ~32% of the sweep
# against a ~18% floor set by the heaviest single spec (vocabulary-decide, 53).
# Weighted assignment would close part of that; going under the floor needs
# mutate.ts to partition its own mutation list.
#
# ⚠️ This census exists a SECOND time, in the mutation-tables job comment in
# .github/workflows/ci.yml, and the two drifted apart the moment a spec was added
# (#5229 updated that copy and left this one saying 266 / 13). If you re-measure,
# change both — or delete one and point at the other. That block also records why
# mutation COUNT is the wrong unit for the newest spec.
if [ -n "$SHARD_TOTAL" ]; then
  PRE_SHARD_COUNT=${#SELECTED[@]}
  SHARDED=()
  for i in "${!SPECS[@]}"; do
    [ $(( i % SHARD_RESIDUE_OF )) -eq "$SHARD_RESIDUE" ] || continue
    SHARD_OWNED=$(( SHARD_OWNED + 1 ))
    for s in ${SELECTED[@]+"${SELECTED[@]}"}; do
      if [ "$s" = "${SPECS[$i]}" ]; then SHARDED+=("$s"); break; fi
    done
  done
  echo "check-mutation-tables: shard $SHARD_LABEL — ${#SHARDED[@]} of $PRE_SHARD_COUNT selected spec(s)."
  SELECTED=(${SHARDED[@]+"${SHARDED[@]}"})
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  for spec in ${SELECTED[@]+"${SELECTED[@]}"}; do echo "SELECTED $spec"; done
  echo "check-mutation-tables: --list-only — ${#SELECTED[@]} spec(s) listed, nothing verified."
  # ⚠️ 3, not 0, for the reason stated at the top of this file: this run declined
  # to verify. Exiting 0 would put a green PASS row in ci-local.sh's table for a
  # gate that measured nothing, which is the defect class the whole file refuses.
  # It is a documented flag, so anyone can reach it — not just the fixture.
  exit 3
fi

if [ ${#SELECTED[@]} -eq 0 ]; then
  if [ -z "$SHARD_TOTAL" ]; then
    # No shard in play, so there are no siblings to have covered it. Every
    # legitimate empty selection above already exited with its own verdict, so
    # reaching here means the selector produced nothing for a reason this script
    # cannot name — "cannot tell", which never renders as a green PASS.
    echo "check-mutation-tables: empty selection with no shard in play — declining." >&2
    exit 3
  fi
  # ⚠️ THE TEST IS ON OWNERSHIP, NOT ON THE SELECTION COUNT.
  #
  # Round-robin partitions `SPECS`, so shard I owns position I-1 whenever there
  # are at least N specs — that is arithmetic and cannot fail. `SELECTED` is
  # then a FILTER over those positions, and a filter may legitimately empty any
  # slice no matter how many specs it kept.
  #
  # The first cut compared `SHARD_TOTAL` against the selected count, which is
  # the pre-fix mental model: correct while ownership came from `SELECTED`,
  # wrong the moment it came from `SPECS`. Measured — 4 specs, a commit touching
  # positions 1 and 3, `--shard 2/2`: a CORRECT partition exited 1 with "the
  # partition is wrong". Any PR with >= 4 affected specs that misses a residue
  # class would have reddened a shard. It was also inert on the common 1-3 spec
  # PR, where a genuinely mangled divisor still exited 0 — off where it was
  # needed, on where it was not.
  #
  # ⚠️ NO FIXTURE COVERS THIS ARM, and that is honest rather than an omission.
  # Validation already forces 1 <= I <= N, so with N <= #SPECS position I-1
  # always exists and SHARD_OWNED is always >= 1: no CLI input can reach here.
  # Deleting the whole arm leaves the suite green, and a fixture claiming to
  # cover it would be asserting nothing — the shape this file deleted two
  # earlier fixtures for. It stays as a backstop against a future edit to the
  # residue arithmetic, which is exactly the edit that would otherwise produce
  # four green jobs having verified nothing.
  if [ "$SHARD_OWNED" -eq 0 ] && [ "${#SPECS[@]}" -ge "$SHARD_TOTAL" ]; then
    echo "check-mutation-tables: shard $SHARD_LABEL owns no position among ${#SPECS[@]} spec(s)." >&2
    echo "  With specs >= shards every shard owns at least one position, so the divisor or index is wrong." >&2
    exit 1
  fi
  # Says only what this process knows. Whether the other slices ran is a
  # property of the matrix wiring, not something this run can observe.
  echo "check-mutation-tables: shard $SHARD_LABEL — no selected spec at positions congruent to $SHARD_RESIDUE (mod $SHARD_RESIDUE_OF) among ${#SPECS[@]} spec(s)."
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
