#!/usr/bin/env bash
# Adversarial fixtures for scripts/check-ci-local-parity.sh.
#
# Case 1 pins the real repo (where the answer must be "in sync"); every other
# case builds a throwaway tree under `mktemp -d` with a two-gate ci.yml, a
# ci-local.sh, optionally a second workflow and an allowlist, and breaks one
# thing. The suite never writes tracked source.
#
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$SCRIPT_DIR/check-ci-local-parity.sh"

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
# ci.yml runs alpha + beta; ci-local.sh launches alpha + beta. In sync.
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/.github/workflows" "$TREE/scripts"
  {
    echo "name: CI"
    echo "jobs:"
    echo "  drift:"
    echo "    steps:"
    echo "      - run: bash scripts/check-alpha.sh"
    echo "      - run: bun scripts/check-beta.ts"
  } >"$TREE/.github/workflows/ci.yml"
  {
    echo "#!/usr/bin/env bash"
    echo "launch alpha  bash scripts/check-alpha.sh"
    echo "launch beta   bun scripts/check-beta.ts"
  } >"$TREE/scripts/ci-local.sh"
}

run_gate() { # -> sets RC and OUT
  RC=0
  OUT=$(CI_LOCAL_PARITY_ROOT="$TREE" bash "$GATE" 2>&1) || RC=$?
}

echo "check-ci-local-parity.test.sh — adversarial fixtures"

# 1. THE REAL REPO. The assertion this gate was written for.
rc_real=0
out_real=$(bash "$GATE" 2>&1) || rc_real=$?
if [ "$rc_real" = "0" ] && printf '%s' "$out_real" | grep -qF "is launched by ci-local.sh"; then
  pass "the real repo's ci.yml and ci-local.sh agree"
else
  fail "the real repo — expected exit 0, got $rc_real"
  printf '%s\n' "$out_real" | sed 's/^/       | /' >&2
fi

# 2. POSITIVE CONTROL on a synthetic tree.
new_tree
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qF "ci.yml's 2 check-* gate(s)"; then
  pass "a synthetic in-sync tree passes and counts both gates"
else
  fail "synthetic in-sync tree — expected exit 0 counting 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 3. THE DEFECT THIS WAS FILED FOR: ci.yml runs a gate ci-local.sh never launches.
new_tree
echo "      - run: bash scripts/check-gamma.sh" >>"$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "scripts/check-gamma.sh" \
   && printf '%s' "$OUT" | grep -qF "ci-local.sh never launches it"; then
  pass "a gate in ci.yml but not ci-local.sh is caught and named (exit $RC)"
else
  fail "CI-only gate — expected exit 1 naming check-gamma.sh, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4. The other direction: ci-local.sh launches a gate no workflow runs.
new_tree
echo "launch gamma bash scripts/check-gamma.sh" >>"$TREE/scripts/ci-local.sh"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "scripts/check-gamma.sh" \
   && printf '%s' "$OUT" | grep -qF "no workflow under .github/workflows/ runs it"; then
  pass "a gate ci-local.sh launches that no workflow runs is caught and named"
else
  fail "local-only gate — expected exit 1 naming check-gamma.sh, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 5. ANOTHER workflow satisfies the local → CI direction (the
# check-runtime-stage-upgrades.sh / image-scan.yml shape).
new_tree
echo "launch gamma bash scripts/check-gamma.sh" >>"$TREE/scripts/ci-local.sh"
printf 'name: other\njobs:\n  x:\n    steps:\n      - run: bash scripts/check-gamma.sh\n' >"$TREE/.github/workflows/image-scan.yml"
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qE "check-gamma.sh +another workflow"; then
  pass "a local gate wired from a DIFFERENT workflow counts"
else
  fail "second workflow — expected exit 0 crediting another workflow, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6. The allowlist exempts a local-only gate, with its reason on the line.
new_tree
echo "launch gamma bash scripts/check-gamma.sh" >>"$TREE/scripts/ci-local.sh"
echo "scripts/check-gamma.sh  # needs the npm registry; remote CI catches it later" >"$TREE/scripts/ci-local-parity-allowlist.txt"
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qE "check-gamma.sh +local-only \(allowlisted\)"; then
  pass "an allowlisted local-only gate passes"
else
  fail "allowlisted gate — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 7. THE RATCHET: an allowlist entry whose gate a workflow now runs is stale.
new_tree
echo "scripts/check-alpha.sh  # was local-only once" >"$TREE/scripts/ci-local-parity-allowlist.txt"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "a workflow now runs it — delete the entry"; then
  pass "a stale allowlist entry (gate now wired) fails"
else
  fail "stale allowlist (wired) — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 7b. …and one whose gate ci-local.sh no longer launches at all.
new_tree
echo "scripts/check-gamma.sh  # nothing launches this" >"$TREE/scripts/ci-local-parity-allowlist.txt"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "no longer launches it — delete the entry"; then
  pass "a stale allowlist entry (gate not launched) fails"
else
  fail "stale allowlist (unlaunched) — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8. A COMMENT IS NOT A LAUNCH. ci.yml runs gamma; ci-local.sh only mentions it
# in prose with the full path.
new_tree
echo "      - run: bash scripts/check-gamma.sh" >>"$TREE/.github/workflows/ci.yml"
echo "# gamma is covered by scripts/check-gamma.sh in stage 1" >>"$TREE/scripts/ci-local.sh"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "scripts/check-gamma.sh"; then
  pass "a full-path mention in a ci-local.sh comment does not count as launching"
else
  fail "comment in ci-local.sh — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8b. …and the mirror: ci-local.sh launches gamma; ci.yml only comments on it.
new_tree
echo "launch gamma bash scripts/check-gamma.sh" >>"$TREE/scripts/ci-local.sh"
echo "      # see scripts/check-gamma.sh, which runs locally" >>"$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "scripts/check-gamma.sh"; then
  pass "a full-path mention in a ci.yml comment does not count as running"
else
  fail "comment in ci.yml — expected exit 1, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 9. A malformed allowlist line is a usage fault, not a silent skip.
new_tree
echo "check-alpha  # not a scripts/check-*.sh path" >"$TREE/scripts/ci-local-parity-allowlist.txt"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "is not a scripts/check-*.sh|ts path"; then
  pass "a malformed allowlist entry exits 2"
else
  fail "malformed allowlist — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 10-11. VACUITY FLOORS: a side that names no gates at all.
new_tree
printf 'name: CI\njobs:\n  drift:\n    steps:\n      - run: echo nothing\n' >"$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "ci.yml names no scripts/check-* gate"; then
  pass "a ci.yml naming no gates exits 2, not a clean sweep"
else
  fail "empty ci.yml side — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

new_tree
printf '#!/usr/bin/env bash\n# launch alpha bash scripts/check-alpha.sh\n' >"$TREE/scripts/ci-local.sh"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "ci-local.sh launches no scripts/check-* gate"; then
  pass "a ci-local.sh whose only gates are commented out exits 2"
else
  fail "empty ci-local side — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 12. A missing file is an environment fault.
new_tree
rm -f "$TREE/scripts/ci-local.sh"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "cannot verify anything"; then
  pass "a missing ci-local.sh exits 2"
else
  fail "missing ci-local.sh — expected exit 2, got $RC"
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason its siblings carry one.
EXPECTED_CASES=14
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "expected $EXPECTED_CASES cases, $TOTAL ran — a case was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "check-ci-local-parity.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
