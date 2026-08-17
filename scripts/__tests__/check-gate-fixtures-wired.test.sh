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
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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
# A tree with two fixture suites, one workflow running only the first.
new_tree() { # new_tree WIRE_SECOND
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/scripts/__tests__" "$TREE/.github/workflows"
  : >"$TREE/scripts/__tests__/check-alpha.test.sh"
  : >"$TREE/scripts/__tests__/check-beta.test.sh"
  {
    echo "name: ci"
    echo "jobs:"
    echo "  drift:"
    echo "    steps:"
    echo "      - run: bash scripts/__tests__/check-alpha.test.sh"
    if [ "${1:-no}" = "yes" ]; then
      echo "      - run: bash scripts/__tests__/check-beta.test.sh"
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

# 2. POSITIVE CONTROL on a synthetic tree, so case 3's red is not the only signal.
new_tree yes
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qF "all 2 fixture suite(s) are run"; then
  pass "a synthetic tree with both suites wired passes"
else
  fail "synthetic wired tree — expected exit 0 naming 2 suites, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 3. THE DEFECT: a suite that ci-local.sh's glob would run and no workflow does.
new_tree no
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "check-beta.test.sh" \
   && printf '%s' "$OUT" | grep -qF "NEVER runs in CI"; then
  pass "an unwired suite is caught and named (exit $RC)"
else
  fail "unwired suite — expected exit 1 naming check-beta.test.sh, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4. ⚠️ A COMMENT IS NOT A RUN — asserted with a FULL REPO-RELATIVE PATH, which is
# the case that mattered and the case the first cut could not fail on.
#
# That version appended a BASENAME mention and passed, so it established only "a
# basename in a comment does not count" while its name claimed the stronger
# property. The stronger property was FALSE: the gate grepped the whole file, and
# `image-scan.yml` and `lighthouse.yml` both carry a comment with the full path to
# a real suite. Deleting either `run:` step left the gate green.
new_tree no
echo "      # see also scripts/__tests__/check-beta.test.sh for the beta gate" >>"$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "check-beta.test.sh"; then
  pass "a comment carrying the FULL PATH does not count as running it"
else
  fail "full-path comment mention — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4b. …and the basename form too, which is the weaker case the first cut tested.
new_tree no
echo "      # see also check-beta.test.sh for the beta gate" >>"$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "1" ]; then
  pass "a BASENAME mention in a comment likewise does not count"
else
  fail "basename comment mention — expected exit 1, got $RC"
fi

# 5. ANY workflow counts, not just ci.yml — `scan-image.test.sh` really does live
# in image-scan.yml, so hardcoding one file would be wrong.
new_tree no
{
  echo "name: other"
  echo "jobs:"
  echo "  x:"
  echo "    steps:"
  echo "      - run: bash scripts/__tests__/check-beta.test.sh"
} >"$TREE/.github/workflows/other.yml"
run_gate
if [ "$RC" = "0" ]; then
  pass "a suite wired from a DIFFERENT workflow counts"
else
  fail "second workflow — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6-7. VACUITY FLOORS. A gate whose product is "every suite is wired" must not
# emit it after finding no suites — or no workflows to check them against.
new_tree yes
rm -f "$TREE/scripts/__tests__"/*.test.sh
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "verified NOTHING"; then
  pass "no fixture suites at all exits 2, not a clean sweep (exit $RC)"
else
  fail "empty fixture dir — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

new_tree yes
rm -f "$TREE/.github/workflows"/*.yml
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "for the wrong reason"; then
  pass "no workflow files exits 2 rather than calling every suite unwired"
else
  fail "empty workflow dir — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8. A missing tree is an environment fault.
TREE="$TMPROOT/does-not-exist"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "cannot verify anything"; then
  pass "a missing tree exits 2"
else
  fail "missing tree — expected exit 2, got $RC"
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason its siblings carry one.
EXPECTED_CASES=9
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "expected $EXPECTED_CASES cases, $TOTAL ran — a case was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "check-gate-fixtures-wired.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
