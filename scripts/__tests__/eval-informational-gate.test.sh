#!/usr/bin/env bash
# Adversarial fixture suite for scripts/eval-informational-gate.sh (#5040).
#
# The property under test is the one #5040 exists to establish: a job whose
# steps were SKIPPED fails the gate, unless its label is on the script's
# explicit skip-tolerant list. `eval-mcp-llm` spent its whole life green
# without ever running because the old gate spelled `success | skipped) ;;`
# — so the prohibition here (a skipped step must fail) is paired throughout
# with the firing control (the SAME outcomes under a tolerant label must
# still pass), which is what proves the script reads the label at all
# rather than failing everything.
#
# The suite also pins the tolerant list's exact contents, so granting a new
# exemption is a deliberate edit in two files rather than one quiet line.
#
# No `gh` calls are reachable from any case: the PR-arm cases leave
# PR_NUMBER unset, which is the branch that skips the comment upsert.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/eval-informational-gate.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0
OUTPUT=""

# run_case EXPECTED_STATUS NAME EVENT_NAME ARGS... — run the gate with no PR
# number (so the comment path is unreachable), assert the exit status, and
# leave the combined output in $OUTPUT for a following expect_output.
run_case() {
  local expected="$1" name="$2" event="$3"
  shift 3
  local status=0
  OUTPUT="$(EVENT_NAME="$event" PR_NUMBER="" bash "$SCRIPT" "$@" 2>&1)" || status=$?
  if [ "$status" -eq "$expected" ]; then
    echo "  ok   $name (exit $status)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected exit $expected, got $status" >&2
    echo "$OUTPUT" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  fi
}

# expect_output NAME NEEDLE — assert the last run_case said NEEDLE.
expect_output() {
  local name="$1" needle="$2"
  if grep -qF -- "$needle" <<<"$OUTPUT"; then
    echo "  ok   $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — output did not contain '$needle'" >&2
    echo "$OUTPUT" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  fi
}

# refute_output NAME NEEDLE — assert the last run_case did NOT say NEEDLE.
refute_output() {
  local name="$1" needle="$2"
  if grep -qF -- "$needle" <<<"$OUTPUT"; then
    echo "  FAIL $name — output unexpectedly contained '$needle'" >&2
    echo "$OUTPUT" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  else
    echo "  ok   $name"
    PASS=$((PASS + 1))
  fi
}

# --- the tolerant list is exactly what this suite believes it is ------------

echo "== skip-tolerant list =="

mapfile -t TOLERANT < <(
  sed -n '/^SKIP_TOLERANT_LABELS=(/,/^)/p' "$SCRIPT" |
    grep -oE '^[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*$' |
    tr -d '[:space:]'
)
if [ "${TOLERANT[*]-}" = "eval-mcp-llm" ]; then
  echo "  ok   exactly one job is exempt from the skipped-is-fatal rule"
  PASS=$((PASS + 1))
else
  echo "  FAIL skip-tolerant list is now '${TOLERANT[*]-}', expected 'eval-mcp-llm'." >&2
  echo "       Granting an exemption is deliberate: state the reason in the script" >&2
  echo "       and update this assertion. Dropping one (e.g. after #5039 wires the" >&2
  echo "       secret) is the same edit in reverse." >&2
  FAIL=$((FAIL + 1))
fi

# The end state this design is aimed at: #5039 removes the one exemption and
# the list goes empty. That is the edit most likely to break the script
# rather than the policy (an empty array under `set -u`), so it is exercised
# here against a copy — the failure would otherwise land in the change that
# hardens the gate.
EMPTIED="$(mktemp)"
trap 'rm -f "$EMPTIED"' EXIT
perl -0pe 's/^SKIP_TOLERANT_LABELS=\(.*?^\)$/SKIP_TOLERANT_LABELS=()/ms' "$SCRIPT" > "$EMPTIED"
if grep -q '^SKIP_TOLERANT_LABELS=()$' "$EMPTIED"; then
  emptied_status=0
  emptied_out="$(EVENT_NAME=push PR_NUMBER="" bash "$EMPTIED" eval-mcp-llm skipped 2>&1)" || emptied_status=$?
  if [ "$emptied_status" -eq 1 ] && grep -qF "did not run" <<<"$emptied_out"; then
    echo "  ok   an emptied list is fatal for every label, and does not abort on set -u"
    PASS=$((PASS + 1))
  else
    echo "  FAIL emptying the list should make every label skip-fatal — got exit $emptied_status" >&2
    echo "$emptied_out" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL could not empty SKIP_TOLERANT_LABELS — has its format changed?" >&2
  FAIL=$((FAIL + 1))
fi

# --- skipped is fatal, and the label is what decides -----------------------
#
# The prohibition and its control differ ONLY in the label, so a script that
# ignored the label — failing everything, or passing everything — fails one
# of the two.

echo "== skipped is fatal by default (tag push) =="

run_case 1 "an unlisted job's skipped step blocks a tag" push brain-identity-eval skipped
expect_output "  ...and the diagnosis is 'did not run', not 'failed'" "brain-identity-eval did not run"
refute_output "  ...and it does not call a non-run a regression" "canonical regression"

run_case 0 "the SAME outcome passes under the one tolerant label" push eval-mcp-llm skipped
expect_output "  ...and the pass is announced as a non-run" "proved nothing on this run"

run_case 1 "a skip among successes is still fatal" push canonical-mcp-eval success skipped
run_case 1 "the deterministic job is fail-closed too (deliberate)" push canonical-eval skipped
run_case 0 "tolerance covers a mixed run" push eval-mcp-llm success skipped

# Tolerance is skip-only. `cancelled` was never a pass and must not become
# one by riding the exemption.
run_case 1 "a tolerant job's cancelled step still blocks" push eval-mcp-llm cancelled

# --- the PR arm keeps the informational-but-visible split ------------------

echo "== fatal skip on a PR stays green but visible =="

run_case 0 "a fatal skip on a PR exits 0" pull_request brain-identity-eval skipped
expect_output "  ...with an ::error annotation" "::error::brain-identity-eval did not run"
expect_output "  ...naming the tag consequence" "WILL block the next release tag"

run_case 0 "a real failure on a PR still reads as 'failed'" pull_request brain-identity-eval failure
expect_output "  ...and not as a non-run" "brain-identity-eval failed"

# --- everything the gate already did, unchanged ----------------------------

echo "== unchanged behaviour =="

run_case 0 "all-success passes" push canonical-eval success
run_case 1 "a failure blocks a tag" push canonical-eval failure
expect_output "  ...as a regression" "A canonical regression must not ship"
run_case 0 "a failure on a PR is non-blocking" pull_request canonical-eval failure
run_case 1 "a label with no outcomes is a usage error" push canonical-eval
run_case 1 "no arguments at all is a usage error" push

# --- summary ---------------------------------------------------------------

echo
echo "eval-informational-gate fixtures: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
