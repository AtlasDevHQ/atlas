#!/usr/bin/env bash
# Adversarial fixture suite for scripts/check-lighthouse-report-paths.sh (#5174).
#
# The gate's value is a NEGATIVE — "no copy of the report path has drifted from
# `lighthouserc.js`" — and a drift-detector that detects nothing looks exactly
# like a tree with no drift. So every case here MOVES one copy in a throwaway
# tree and requires the gate to go red naming that copy.
#
# ⚠️ `set -uo pipefail`, deliberately WITHOUT `-e`: a failing case must not abort
# the suite before it prints its tally, which is the only place a reader learns
# how many cases ran.
#
# ⚠️ THE GATE TAKES AN OPTIONAL ROOT ARGUMENT PURELY FOR THIS SUITE, so nothing
# here rewrites tracked source (#5172). Every case runs against a fresh copy of
# the five real files under `mktemp -d`.
#
# Four discipline devices, each a measured lesson from a sibling suite:
#
#   1. EVERY `sed` IS ASSERTED TO HAVE LANDED. A mutation that matched nothing
#      leaves a pristine tree, the gate passes, and the case reports "ok" having
#      tested nothing. `mutate` compares before/after and the case runner treats
#      "did not land" as a SETUP FAILURE, never a pass.
#   2. NO RESULT TRAVELS THROUGH COMMAND SUBSTITUTION. `fail` inside `$(…)`
#      increments a subshell's counter, so a suite can print FAIL and exit 0.
#      `TREE` and `MUTATED` are globals set by top-level calls.
#   3. EXIT 1 AND EXIT 2 ARE DIFFERENT VERDICTS. 1 is "a copy disagrees"; 2 is
#      "this gate could not run". Asserting only non-zero would let a broken
#      fixture tree stand in for a detected drift.
#   4. AN ABSOLUTE EXPECTED-CASE COUNT. Comparing two numbers that both move
#      leaves a suite green when a case is deleted — measured on
#      `check-docs-brain-snippets.test.sh`, which reported `40 passed, 0 failed`
#      with cases removed. The literal below is the falsifier for that.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-lighthouse-report-paths.sh"

[ -f "$GATE" ] || { echo "::error::gate under test not found at $GATE" >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

DOCS_REL="apps/docs/content/self-hosted/contributing/ci.mdx"

CASE_N=0
TREE=""
fresh_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/.github/workflows" "$TREE/.github/scripts" "$TREE/$(dirname "$DOCS_REL")"
  cp "$ROOT/lighthouserc.js" "$TREE/lighthouserc.js"
  cp "$ROOT/.gitignore" "$TREE/.gitignore"
  cp "$ROOT/.github/workflows/lighthouse.yml" "$TREE/.github/workflows/lighthouse.yml"
  cp "$ROOT/.github/scripts/lighthouse-comment.js" "$TREE/.github/scripts/lighthouse-comment.js"
  cp "$ROOT/$DOCS_REL" "$TREE/$DOCS_REL"
  MUTATED=-1
}

MUTATED=-1
# mutate REL_PATH SED_EXPR — apply and record whether it CHANGED anything.
mutate() {
  local f="$TREE/$1" expr="$2"
  cp "$f" "$f.pre"
  sed -i "$expr" "$f"
  if cmp -s "$f.pre" "$f"; then MUTATED=0; else MUTATED=1; fi
  rm -f "$f.pre"
}

# expect NAME EXPECTED_EXIT PHRASE — run the gate against $TREE.
#
# Three-way, not two: a mutation that did not land means nothing was tested, and
# reporting that as a pass is precisely the vacuity this suite exists to refuse.
expect() {
  local name="$1" want="$2" phrase="$3" rc=0 out
  if [ "$MUTATED" -eq 0 ]; then
    fail "$name — FIXTURE SETUP FAILED: the sed matched nothing, so the tree is pristine and NOTHING was tested. This is not a pass."
    return
  fi
  out=$(bash "$GATE" "$TREE" 2>&1) || rc=$?
  if [ "$rc" = "$want" ] && printf '%s' "$out" | grep -qF -- "$phrase"; then
    pass "$name (exit $rc)"
  else
    fail "$name — expected exit $want containing '$phrase', got $rc"
    printf '%s\n' "$out" | sed 's/^/       | /' >&2
  fi
}

echo "check-lighthouse-report-paths.test.sh — adversarial fixtures (#5174)"

# 1. POSITIVE CONTROL, first: every case below is vacuous if a pristine tree
# does not pass. `MUTATED` is forced to 1 because there is nothing to mutate.
fresh_tree
MUTATED=1
expect "POSITIVE CONTROL — a pristine tree passes" 0 "12 passed, 0 failed"

# 2. The SSOT itself moves. Every copy then disagrees at once, which is the
# realistic shape: someone renames the directory in the config and stops there.
fresh_tree
mutate lighthouserc.js 's#lighthouse-reports/\${formFactor}#lh-out/${formFactor}#'
expect "moving lighthouserc.js's outputDir root reds every copy" 1 \
  "does not contain 'dir=\"lh-out/\$ff\"'"

# 3. The renderer's own root drifts — the half that renders #4899's sentence on
# a green run, because the verify step is still looking in the right place.
fresh_tree
mutate .github/scripts/lighthouse-comment.js 's#^const REPORT_ROOT = "lighthouse-reports";#const REPORT_ROOT = "lh-out";#'
expect "a drifted REPORT_ROOT in the renderer is caught" 1 \
  "the renderer's REPORT_ROOT is 'lh-out'"

# 4-7. Each workflow / repo literal, one at a time.
fresh_tree
mutate .github/workflows/lighthouse.yml 's#dir="lighthouse-reports/\$ff"#dir="lh-out/$ff"#'
expect "the verify step's per-form-factor dir is pinned" 1 \
  "the verify step's per-form-factor dir does not contain"

fresh_tree
mutate .github/workflows/lighthouse.yml 's#^          path: lighthouse-reports/#          path: lh-out/#'
expect "the artifact path is pinned" 1 "the artifact path is exactly lighthouse-reports/"

fresh_tree
mutate .github/workflows/lighthouse.yml 's#find lighthouse-reports -maxdepth 2#find lh-out -maxdepth 2#'
expect "the verify step's diagnostic listing is pinned" 1 \
  "the verify step's diagnostic listing does not contain"

fresh_tree
mutate .gitignore 's#^lighthouse-reports/$#lh-out/#'
expect ".gitignore is pinned — generated reports must not be committable" 1 \
  ".gitignore has no 'lighthouse-reports/' line"

# 7b. ⚠️ AN EXTENDED ROOT IS NOT AGREEMENT, and an unanchored `grep -qF` could
# not tell the difference. `name: lighthouse-reports-desktop` and
# `path: lighthouse-reports/desktop` both CONTAIN the derived root, so both
# matched and both PASSED while disagreeing with the config — the second one
# narrowing the artifact to a single form factor, a real regression this gate
# would have blessed. The header claimed eight pinned sites; two of them were
# pinned against a moved root only.
fresh_tree
mutate .github/workflows/lighthouse.yml 's#^          name: lighthouse-reports$#          name: lighthouse-reports-desktop#'
expect "an EXTENDED artifact name is caught, not just a moved one" 1 \
  "the artifact name is exactly lighthouse-reports"

fresh_tree
mutate .github/workflows/lighthouse.yml 's#^          path: lighthouse-reports/$#          path: lighthouse-reports/desktop/#'
expect "an artifact path NARROWED to one form factor is caught" 1 \
  "the artifact path is exactly lighthouse-reports/"

# 8. The eighth copy: the claim apps/docs makes to CUSTOMERS. The issue's list
# omitted it, and #5170 already had to fix a different false claim in this file.
fresh_tree
mutate "$DOCS_REL" 's#lighthouse-reports/{desktop,mobile}/#lh-out/{desktop,mobile}/#g'
expect "the customer-facing path claim in apps/docs is pinned" 1 \
  "the documented artifact path has drifted from the config"

# 9. THE REVERSE DIRECTION, which nothing checked before this gate:
# `lighthouserc.js` rejects an UNKNOWN form factor loudly, but a profile ADDED to
# `PROFILES` gets no workflow step, no verify-loop iteration and no comment table
# — silently measured and never reported.
fresh_tree
mutate lighthouserc.js 's#^const PROFILES = {#const PROFILES = {\n  tablet: { assertions: mobileAssertions, collect: {} },#'
expect "a form factor profiled but never rendered is caught" 1 \
  "a profiled form factor with no table is measured and never reported"

# 10. …and its mirror in the workflow: the verify loop drops a form factor while
# the config still profiles it, so one form factor is measured and unverified.
fresh_tree
mutate .github/workflows/lighthouse.yml 's#for ff in desktop mobile; do#for ff in desktop; do#'
expect "narrowing the verify loop to one form factor is caught" 1 \
  "would be measured and never verified"

# 11. …and the renderer dropping one, which is the same silence at the comment.
fresh_tree
mutate .github/scripts/lighthouse-comment.js '/{ key: "mobile", label: "Mobile", outcomeEnv: "MOBILE_OUTCOME" },/d'
expect "the renderer dropping a form-factor table is caught" 1 \
  "a profiled form factor with no table is measured and never reported"

# 12. ENVIRONMENT FAULT, not a verdict: with the config's validation gone, the
# allowlist cannot be derived at all. Exit 2 — "I could not look" must never
# render as "I looked and it is fine".
fresh_tree
mutate lighthouserc.js 's#^if (!Object.hasOwn(PROFILES, formFactor)) {#if (false) {#'
expect "a lighthouserc.js with no form-factor validation exits 2, not 0" 2 \
  "could not derive the form-factor allowlist"

# 13. THE VACUITY FLOOR. One form factor makes every cross-comparison below
# trivially agree, so the gate must refuse rather than report a clean sweep.
fresh_tree
mutate lighthouserc.js '/^  mobile: {$/,/^  },$/d'
expect "a single-form-factor config exits 2 rather than verifying vacuously" 2 \
  "so this gate would be vacuous"

# 14. A missing input is an environment fault too.
fresh_tree
MUTATED=1
rm -f "$TREE/.github/scripts/lighthouse-comment.js"
expect "a missing renderer exits 2" 2 "this gate cannot verify the path closure"

# ⚠️ AN ABSOLUTE LITERAL. Deleting a case above must red this suite; a count
# derived from the cases themselves cannot notice.
EXPECTED_CASES=16
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "expected $EXPECTED_CASES cases, $TOTAL ran — a case was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "check-lighthouse-report-paths.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
