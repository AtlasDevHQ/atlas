#!/usr/bin/env bash
# Adversarial fixtures for scripts/check-gate-fixtures-wired.sh (#5296).
#
# ⚠️ THIS SUITE IS ITS OWN SUBJECT. The gate asserts that every
# `scripts/__tests__/*.test.sh` is run by some workflow — and this file is one of
# them, so a gate that verified nothing would report itself wired. Case 1 pins the
# real repo (where the answer must be "all of them"); every other case builds a
# throwaway tree, because the interesting answers are the ones the real repo
# cannot produce.
#
# The gate's shape: a suite is wired when some workflow invokes
# `scripts/run-gate-fixtures.sh` (the glob runner) outside a comment, UNLESS the
# suite is listed in `scripts/gate-fixtures-exclude.txt`, in which case some
# workflow must name the suite itself. Cases cover both arms and their stale
# forms.
#
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$SCRIPT_DIR/check-gate-fixtures-wired.sh"

[ -f "$GATE" ] || { echo "::error::gate under test not found at $GATE" >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

CASE_N=0
TREE=""
# A tree with two fixture suites and a ci.yml that invokes the runner.
new_tree() { # new_tree [norunner]
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/scripts/__tests__" "$TREE/.github/workflows"
  : >"$TREE/scripts/__tests__/check-alpha.test.sh"
  : >"$TREE/scripts/__tests__/check-beta.test.sh"
  {
    echo "name: ci"
    echo "jobs:"
    echo "  gate-fixtures:"
    echo "    steps:"
    if [ "${1:-}" = "norunner" ]; then
      echo "      - run: echo nothing"
    else
      echo "      - run: bash scripts/run-gate-fixtures.sh"
    fi
  } >"$TREE/.github/workflows/ci.yml"
}

run_gate() { # run_gate -> sets RC and OUT
  RC=0
  OUT=$(GATE_FIXTURES_ROOT="$TREE" bash "$GATE" 2>&1) || RC=$?
}

echo "check-gate-fixtures-wired.test.sh — adversarial fixtures (#5296)"

# 1. THE REAL REPO. This is the assertion that matters in practice, and the one
# the gate was written for: every suite on disk is run by a workflow.
rc_real=0
out_real=$(bash "$GATE" 2>&1) || rc_real=$?
if [ "$rc_real" = "0" ] && printf '%s' "$out_real" | grep -qF "are run by a workflow"; then
  pass "the real repo has every fixture suite wired to a workflow"
else
  fail "the real repo — expected exit 0, got $rc_real"
  printf '%s\n' "$out_real" | sed 's/^/       | /' >&2
fi

# 2. POSITIVE CONTROL on a synthetic tree: the runner is invoked, so both suites
# are wired through it.
new_tree
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qF "all 2 fixture suite(s) are run" \
   && printf '%s' "$OUT" | grep -qF "via scripts/run-gate-fixtures.sh"; then
  pass "a synthetic tree whose ci.yml invokes the runner passes via the runner"
else
  fail "synthetic wired tree — expected exit 0 naming 2 suites via the runner, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 3. THE DEFECT: no workflow invokes the runner, so EVERY suite is unwired at once.
new_tree norunner
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "check-alpha.test.sh" \
   && printf '%s' "$OUT" | grep -qF "check-beta.test.sh" \
   && printf '%s' "$OUT" | grep -qF "no workflow under .github/workflows/ runs scripts/run-gate-fixtures.sh"; then
  pass "a tree where nothing invokes the runner reports every suite unwired (exit $RC)"
else
  fail "no runner — expected exit 1 naming both suites, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4. ⚠️ A COMMENT IS NOT A RUN — the runner's full path in a comment does not
# wire anything. This is the case the first cut of this gate could not fail on.
new_tree norunner
echo "      # the suites run via scripts/run-gate-fixtures.sh locally" >>"$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "runner wired by: NOTHING"; then
  pass "the runner's path in a comment does not count as invoking it"
else
  fail "runner in comment — expected exit 1 with runner unwired, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 5. An EXCLUDED suite is wired by a different workflow naming it — the
# scan-image.test.sh / image-scan.yml shape.
new_tree
echo "check-beta.test.sh  # needs a tool the runner's job lacks" >"$TREE/scripts/gate-fixtures-exclude.txt"
printf 'name: other\njobs:\n  x:\n    steps:\n      - run: bash scripts/__tests__/check-beta.test.sh\n' >"$TREE/.github/workflows/other.yml"
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qE "check-beta.test.sh +other.yml \(excluded from the runner\)"; then
  pass "an excluded suite named by another workflow counts, and is credited to that workflow"
else
  fail "excluded + wired elsewhere — expected exit 0 crediting other.yml, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6. An EXCLUDED suite that no workflow names is the runner's blind spot made
# real: the glob skips it and nothing else runs it.
new_tree
echo "check-beta.test.sh  # needs a tool the runner's job lacks" >"$TREE/scripts/gate-fixtures-exclude.txt"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "check-beta.test.sh is excluded from scripts/run-gate-fixtures.sh and no workflow" \
   && ! printf '%s' "$OUT" | grep -qF "check-alpha.test.sh is excluded"; then
  pass "an excluded suite no workflow names is caught, and the non-excluded sibling is not"
else
  fail "excluded + unwired — expected exit 1 naming only check-beta, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6b. …and a comment naming the excluded suite's full path does not wire it.
new_tree
echo "check-beta.test.sh  # needs a tool" >"$TREE/scripts/gate-fixtures-exclude.txt"
printf 'name: other\njobs:\n  x:\n    steps:\n      # see scripts/__tests__/check-beta.test.sh\n      - run: echo nothing\n' >"$TREE/.github/workflows/other.yml"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "check-beta.test.sh is excluded"; then
  pass "a comment carrying an excluded suite's FULL PATH does not count as running it"
else
  fail "excluded + comment mention — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 7. A STALE exclusion — the suite it names is gone — fails rather than sitting
# in the file forever.
new_tree
echo "check-gone.test.sh  # deleted last month" >"$TREE/scripts/gate-fixtures-exclude.txt"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "check-gone.test.sh is excluded but scripts/__tests__/ has no such suite"; then
  pass "a stale exclusion entry fails and names itself"
else
  fail "stale exclusion — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8. A malformed exclusion entry is a usage fault, not a silent skip.
new_tree
echo "scripts/__tests__/check-beta.test.sh  # a path, not a basename" >"$TREE/scripts/gate-fixtures-exclude.txt"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "is not a *.test.sh basename"; then
  pass "a malformed exclusion entry exits 2"
else
  fail "malformed exclusion — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 9-10. VACUITY FLOORS. A gate whose product is "every suite is wired" must not
# emit it after finding no suites — or no workflows to check them against.
new_tree
rm -f "$TREE/scripts/__tests__"/*.test.sh
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "verified NOTHING"; then
  pass "no fixture suites at all exits 2, not a clean sweep (exit $RC)"
else
  fail "empty fixture dir — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

new_tree
rm -f "$TREE/.github/workflows"/*.yml
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "for the wrong reason"; then
  pass "no workflow files exits 2 rather than calling every suite unwired"
else
  fail "empty workflow dir — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 11. A missing tree is an environment fault.
TREE="$TMPROOT/does-not-exist"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "cannot verify anything"; then
  pass "a missing tree exits 2"
else
  fail "missing tree — expected exit 2, got $RC"
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason its siblings carry one.
EXPECTED_CASES=12
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "expected $EXPECTED_CASES cases, $TOTAL ran — a case was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "check-gate-fixtures-wired.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
