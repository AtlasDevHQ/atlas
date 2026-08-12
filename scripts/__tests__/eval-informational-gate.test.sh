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
  # ⚠️ `SCRIPT_UNDER_TEST` (not `$SCRIPT` directly) so the tolerance cases can
  # aim the SAME assertions at the populated mutant. With the real list empty
  # (#5039), running them against `$SCRIPT` would assert nothing about
  # tolerance — they would pass for the wrong reason.
  OUTPUT="$(EVENT_NAME="$event" PR_NUMBER="" bash "${SCRIPT_UNDER_TEST:-$SCRIPT}" "$@" 2>&1)" || status=$?
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
if [ -z "${TOLERANT[*]-}" ]; then
  echo "  ok   NO job is exempt from the skipped-is-fatal rule"
  PASS=$((PASS + 1))
else
  echo "  FAIL skip-tolerant list is now '${TOLERANT[*]-}', expected it to be EMPTY." >&2
  echo "       #5039 removed the last exemption (eval-mcp-llm) once AI_GATEWAY_API_KEY" >&2
  echo "       was wired and the job was observed running for real. Granting a new" >&2
  echo "       exemption is deliberate: state the reason in the script and update" >&2
  echo "       this assertion." >&2
  FAIL=$((FAIL + 1))
fi

# ⚠️ THIS MUTANT IS INVERTED FROM WHAT IT WAS, and the inversion is the point.
# It used to EMPTY the list, because an empty list was the end state #5039 was
# aimed at and the edit most likely to break the script rather than the policy
# (an empty array under `set -u`). #5039 has now landed, so the real script IS
# empty — and a mutant that empties an already-empty list is a no-op asserting
# nothing. The `set -u` property it guarded is now covered by every other case
# in this file, all of which run the real, empty script.
#
# So the discriminating direction reversed: what is no longer exercised is that
# the exemption MECHANISM still works at all. A `SKIP_IS_PASS` lookup that
# silently stopped matching would leave every test here green — they all expect
# fatal — while a future exemption added in good faith would do nothing. The
# mutant now POPULATES the list and asserts that label becomes tolerated.
POPULATED="$(mktemp)"
trap 'rm -f "$POPULATED"' EXIT
perl -0pe 's/^SKIP_TOLERANT_LABELS=\(\n\)$/SKIP_TOLERANT_LABELS=(\n  eval-mcp-llm\n)/ms' "$SCRIPT" > "$POPULATED"
if grep -qF 'eval-mcp-llm' "$POPULATED"; then
  populated_status=0
  populated_out="$(EVENT_NAME=push PR_NUMBER="" bash "$POPULATED" eval-mcp-llm skipped 2>&1)" || populated_status=$?
  if [ "$populated_status" -eq 0 ]; then
    echo "  ok   a populated list still exempts its label (the mechanism works)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL a listed label should be skip-tolerant — got exit $populated_status" >&2
    echo "$populated_out" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL could not populate SKIP_TOLERANT_LABELS — has its format changed?" >&2
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

run_case 1 "the SAME outcome under the ex-tolerant label now blocks too" push eval-mcp-llm skipped
expect_output "  ...and it is diagnosed as a non-run" "eval-mcp-llm did not run"

run_case 1 "a skip among successes is still fatal" push canonical-mcp-eval success skipped
run_case 1 "the deterministic job is fail-closed too (deliberate)" push canonical-eval skipped

# --- the tolerance MECHANISM, aimed at the populated mutant -----------------
#
# ⚠️ These four run against `$POPULATED`, not the real script. With the real
# list empty (#5039) there is no tolerant label left, so pointing them at
# `$SCRIPT` would make every one of them pass because NOTHING is tolerant —
# the "cancelled still blocks" case especially, which would then assert the
# opposite of what its name claims and could never fail. The mechanism still
# has to work: a future exemption added in good faith must actually take
# effect, and only these cases would notice if it silently stopped.
SCRIPT_UNDER_TEST="$POPULATED"

run_case 0 "a tolerant label's skipped step passes" push eval-mcp-llm skipped
expect_output "  ...and the pass is announced as a non-run" "proved nothing on this run"
run_case 0 "tolerance covers a mixed run" push eval-mcp-llm success skipped

# Tolerance is skip-only. `cancelled` was never a pass and must not become
# one by riding the exemption.
run_case 1 "a tolerant job's cancelled step still blocks" push eval-mcp-llm cancelled

# An unlisted label is still fatal even on the populated copy — proves the
# mutant grants ONE exemption rather than disabling the rule wholesale.
run_case 1 "the populated copy still blocks an unlisted label" push canonical-eval skipped

SCRIPT_UNDER_TEST=""

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
