#!/bin/bash
# Fixture suite for the verdict half of scripts/ci-local.sh (#5151).
#
# `ci-local.sh` was the only gate wrapper in the repo with no fixtures, and the
# bug it shipped lived exactly where fixtures would have looked: an if/elif
# chain whose DECLINED branch had no `return`, so it fell through into the FAIL
# branch. A single declined run wrote TWO `RESULT:` lines — "PASS with 1
# DECLINED" and a self-contradictory "FAIL — 0 of 34 gates failed:" with an
# empty failure list — and then exited 0. Three signals, three verdicts, one
# run. `.ci-local/RESULT` is documented as THE trustworthy completion signal
# precisely because the exit code isn't, so a RESULT holding two verdicts
# removed the only reliable one.
#
# ⚠️ These drive scripts/lib/ci-local-report.sh directly rather than invoking
# ci-local.sh. That is not a convenience: `g_gate_fixtures` inside ci-local.sh
# runs every scripts/__tests__/*.test.sh, so a fixture that executed the wrapper
# would recurse into itself. Sourcing the real bytes is what makes the verdict
# testable in milliseconds instead of 25 minutes.
#
# Locks in, in the order they would hurt:
#   1. DECLINED emits ONE RESULT line and never the word FAIL   (the #5151 bug)
#   2. DECLINED exits 3 — not 0 (false green), not 1 (a real failure)
#   3. a real failure still wins over a concurrent decline
#   4. FAIL is unrepresentable with an empty failure set
#   5. POSITIVE CONTROL: all-green is still one line and exit 0
#   6. a NATIVE WORKER ABORT reads as ABORTED, not FAIL, and states the two
#      counts separately: "N aborted (sibling worker panicked), M failed" (#5401)
#   7. a residual failure alongside an abort still FAILS — the crash is never a
#      way for a genuine red to read as "declined"
#   8. NEGATIVE CONTROL: an ordinary red that merely PRINTS "SIGABRT" is a FAIL
#
# ⚠️ EVERY case below asserts the RESULT-line COUNT, not just its content. The
# shipped bug printed a correct "PASS with 1 DECLINED" line — asserting only
# that substring would have passed green on the broken script. The count is the
# assertion; the substring merely says which verdict won.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$SCRIPT_DIR/lib/ci-local-report.sh"

if [ ! -f "$LIB" ]; then
  echo "::error::library under test not found at $LIB" >&2
  exit 2
fi
# shellcheck source=../lib/ci-local-report.sh
. "$LIB"

PASS=0
FAIL=0

# case_check NAME EXPECTED_EXIT EXPECTED_SUBSTR NO_TEST_VALUE gate:rc [gate:rc...]
case_check() {
  local name="$1" exp_exit="$2" exp_sub="$3" no_test="$4"; shift 4
  local tmp pair g r out rc n_result problems=""
  tmp="$(mktemp -d)"

  GATE_NAMES=()
  for pair in "$@"; do
    g="${pair%%:*}"; r="${pair##*:}"
    # `MISSING` writes NO .exit file at all — the gate never recorded an
    # outcome, which is what a wrapper that died mid-gate leaves behind. Writing
    # the literal string would test string parsing instead of an absent file.
    [ "$r" = "MISSING" ] || printf '%s' "$r" >"$tmp/$g.exit"
    printf '%s' "7"         >"$tmp/$g.secs"
    printf 'tail of %s\n' "$g" >"$tmp/$g.log"
    GATE_NAMES+=("$g")
  done
  LOG_DIR="$tmp"
  NO_TEST="$no_test"
  FAIL_TAIL=5

  ci_local_classify_gates
  out="$(render_report)"
  rc="$(ci_local_exit_code)"
  n_result="$(printf '%s\n' "$out" | grep -c '^RESULT:')"

  [ "$n_result" = "1" ] || problems="$problems; expected exactly 1 RESULT line, got $n_result"
  [ "$rc" = "$exp_exit" ] || problems="$problems; expected exit $exp_exit, got $rc"
  printf '%s\n' "$out" | grep -qF "$exp_sub" || problems="$problems; RESULT line missing '$exp_sub'"

  if [ -z "$problems" ]; then
    echo "  ok    $name (exit $rc, 1 RESULT line)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name —${problems#;}"
    printf '%s\n' "$out" | grep '^RESULT:' | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

echo ":: ci-local.sh verdict fixtures"

# 5. POSITIVE CONTROL, run first — everything below is vacuous without it.
case_check "POSITIVE CONTROL — all green is one line, exit 0" \
  0 "RESULT: PASS — all 3 gates green." 0 lint:0 type:0 test:0

# 1 + 2. The shipped bug. `mutation-tables` declines (exit 3) while every other
# gate passes: exactly the state of a bare local run with TEST_DATABASE_URL
# unset, which is the DEFAULT. Before the fix this printed two RESULT lines and
# exited 0.
case_check "one DECLINED gate — single RESULT line, exit 3" \
  3 "RESULT: PASS with 1 DECLINED" 0 lint:0 type:0 mutation-tables:3

# The word FAIL must not appear ANYWHERE in a declined run's report body — the
# fall-through emitted a whole FAIL section, not just a line.
tmp="$(mktemp -d)"
GATE_NAMES=(lint mutation-tables)
printf '0' >"$tmp/lint.exit";            printf '7' >"$tmp/lint.secs";            echo l >"$tmp/lint.log"
printf '3' >"$tmp/mutation-tables.exit"; printf '7' >"$tmp/mutation-tables.secs"; echo m >"$tmp/mutation-tables.log"
LOG_DIR="$tmp"; NO_TEST=0; FAIL_TAIL=5
ci_local_classify_gates
if render_report | grep -q 'RESULT: FAIL'; then
  echo "  FAIL  a declined run emits no FAIL verdict — found one"; FAIL=$((FAIL + 1))
else
  echo "  ok    a declined run emits no FAIL verdict"; PASS=$((PASS + 1))
fi
rm -rf "$tmp"

# 3. A real failure outranks a concurrent decline — declining must never mask
# a red gate.
case_check "FAIL wins over a concurrent DECLINE" \
  1 "RESULT: FAIL — 1 of 3 gates failed: type" 0 lint:0 type:1 mutation-tables:3

# 4. FAIL is unrepresentable with an empty failure set. The broken script
# rendered literally "FAIL — 0 of 34 gates failed:" with nothing after the colon.
case_check "no gate failed — the verdict is never FAIL" \
  3 "RESULT: PASS with 2 DECLINED" 0 lint:0 mutation-tables:3 eval-lane:3

# CI_LOCAL_NO_TEST is an operator choice, not a gate declining to measure — it
# stays exit 0 and says so.
case_check "NO_TEST=1 with all gates green — flagged, but exit 0" \
  0 "RESULT: PASS (tests skipped" 1 lint:0 type:0

# A missing .exit file means the gate never recorded an outcome. That is a
# failure, not a decline — the wrapper died mid-gate.
case_check "a gate with no .exit file counts as FAILED" \
  1 "RESULT: FAIL — 1 of 2 gates failed: ghost" 0 lint:0 ghost:MISSING

# ── Native worker abort (#5401) ──────────────────────────────────────────────
#
# A bun worker dying of SIGABRT/SIGSEGV takes the whole `--parallel` run down and
# stamps every still-running sibling `(aborted: sibling worker panicked)`, rolling
# all of them into its `N fail` total. Measured on a clean `main` at 33f45fccd:
# 285 "failures", 284 collateral, on a SHA remote CI was green on. The old report
# rendered that identically to a 285-test regression, and it nearly cost the
# v0.2.16 release.
#
# ⚠️ The logs below are SYNTHETIC but quote bun's real sentences verbatim,
# including the line WRAP that puts the crashed file on the following line. A
# fixture that wrote the sentence on one line would pass against a detector that
# never finds a filename in the wild.

# write_bun_abort_log <file> <aborted_siblings> <reported_fail|NONE> [signal]
write_bun_abort_log() {
  local out="$1" siblings="$2" reported="$3" sig="${4:-SIGABRT}" i
  {
    echo "bun test v1.4.0"
    echo ""
    echo "src/lib/billing/__tests__/agent-gate.test.ts:"
    echo "✓ agent gate > allows a paying workspace [3.10ms]"
    echo "error: a test worker process crashed with $sig while running"
    echo "  src/lib/db/__tests__/learned-pattern-injections-pg.test.ts."
    echo "This indicates a bug in Bun or in a native addon, not in the test itself. Aborting."
    for ((i = 0; i < siblings; i++)); do
      echo "✗ src/api/__tests__/sibling-$i.test.ts (aborted: sibling worker panicked)"
    done
    if [ "$reported" != "NONE" ]; then
      echo ""
      echo " 17081 pass"
      echo " 12 skip"
      echo " $reported fail"
      echo "Ran 17081 tests across 690 files. [129.00s]"
    fi
  } >"$out"
}

# abort_case NAME EXPECTED_EXIT EXPECTED_SUBSTR — one failing `test` gate whose
# log is written by the caller into $ABORT_LOG, plus a green `lint` gate.
ABORT_LOG=""
abort_case() {
  local name="$1" exp_exit="$2" exp_sub="$3" writer="$4"
  local tmp out rc n_result problems=""
  tmp="$(mktemp -d)"
  printf '0' >"$tmp/lint.exit"; printf '7' >"$tmp/lint.secs"; echo l >"$tmp/lint.log"
  printf '1' >"$tmp/test.exit"; printf '9' >"$tmp/test.secs"
  ABORT_LOG="$tmp/test.log"
  "$writer"
  GATE_NAMES=(lint test); LOG_DIR="$tmp"; NO_TEST=0; FAIL_TAIL=5

  ci_local_classify_gates
  out="$(render_report)"
  rc="$(ci_local_exit_code)"
  n_result="$(printf '%s\n' "$out" | grep -c '^RESULT:')"

  [ "$n_result" = "1" ] || problems="$problems; expected exactly 1 RESULT line, got $n_result"
  [ "$rc" = "$exp_exit" ] || problems="$problems; expected exit $exp_exit, got $rc"
  printf '%s\n' "$out" | grep -qF "$exp_sub" || problems="$problems; report missing '$exp_sub'"

  if [ -z "$problems" ]; then
    echo "  ok    $name (exit $rc, 1 RESULT line)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name —${problems#;}"
    printf '%s\n' "$out" | grep -E '^(RESULT:|▼)' | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# 6. The measured case: 285 reported, 284 collateral, 1 residual would be a real
# failure — so use the all-collateral shape here (285 reported, 285 aborted).
w_clean_abort() { write_bun_abort_log "$ABORT_LOG" 285 285; }
abort_case "native abort with no residual — ABORTED, exit 3" \
  3 "RESULT: ABORTED" w_clean_abort
abort_case "the two counts are stated separately on the RESULT line" \
  3 "test: 285 aborted (sibling worker panicked), 0 failed" w_clean_abort

# ⚠️ The word FAIL must not be the verdict of an aborted run. This is the
# assertion that would have caught the old behaviour: before the fix, `test`
# exiting 1 landed in `failed` and rendered "RESULT: FAIL — 1 of 2 gates failed".
tmp="$(mktemp -d)"
printf '0' >"$tmp/lint.exit"; printf '7' >"$tmp/lint.secs"; echo l >"$tmp/lint.log"
printf '1' >"$tmp/test.exit"; printf '9' >"$tmp/test.secs"
write_bun_abort_log "$tmp/test.log" 285 285
GATE_NAMES=(lint test); LOG_DIR="$tmp"; NO_TEST=0; FAIL_TAIL=5
ci_local_classify_gates
report="$(render_report)"
if printf '%s\n' "$report" | grep -q '^RESULT: FAIL'; then
  echo "  FAIL  an aborted run emits no FAIL verdict — found one"; FAIL=$((FAIL + 1))
else
  echo "  ok    an aborted run emits no FAIL verdict"; PASS=$((PASS + 1))
fi
# The table row must say ABORT too — the row is what the /ci protocol reads.
if printf '%s\n' "$report" | grep -qE '^test +ABORT'; then
  echo "  ok    the table row renders ABORT, not FAIL"; PASS=$((PASS + 1))
else
  echo "  FAIL  the table row does not render ABORT"; FAIL=$((FAIL + 1))
fi
# It must name the crash site AND say it is a victim — quarantining it is the
# named non-answer in #5401, and the file moves run to run.
if printf '%s\n' "$report" | grep -qF "(VICTIM, not suspect): src/lib/db/__tests__/learned-pattern-injections-pg.test.ts"; then
  echo "  ok    the crash site is named and marked a victim"; PASS=$((PASS + 1))
else
  echo "  FAIL  the crash site is not named as a victim"; FAIL=$((FAIL + 1))
fi
rm -rf "$tmp"

# 7. A residual failure OUTRANKS the abort. 285 reported vs 284 aborted means one
# test really failed, and a crash must never launder that into "declined".
w_residual() { write_bun_abort_log "$ABORT_LOG" 284 285; }
abort_case "a residual failure alongside an abort still FAILS" \
  1 "RESULT: FAIL" w_residual
abort_case "the FAIL line names the concurrent abort" \
  1 "284 aborted (sibling worker panicked), 1 failed" w_residual

# Bun can die before printing totals. That run verified nothing, so it is an
# abort — never a green — but the report must not invent a residual count.
w_no_totals() { write_bun_abort_log "$ABORT_LOG" 40 NONE; }
abort_case "an abort with no totals is ABORTED with an unknown residual" \
  3 "40 aborted (sibling worker panicked), ? failed" w_no_totals

# Multiple signals in one run (measured: SIGSEGV ×3 + SIGABRT) are all named.
w_two_signals() {
  write_bun_abort_log "$ABORT_LOG" 100 100 SIGSEGV
  {
    echo "error: a test worker process crashed with SIGABRT while running"
    echo "  src/lib/billing/__tests__/agent-gate.test.ts."
  } >>"$ABORT_LOG"
}
abort_case "every signal seen in the run is named" \
  3 "crashed with SIGABRT SIGSEGV" w_two_signals

# 8. NEGATIVE CONTROL — without this the detector could excuse any red whose log
# mentions a signal, which would be strictly worse than the bug being fixed.
w_mentions_signal() {
  {
    echo "✗ src/lib/proc/__tests__/signals.test.ts > forwards SIGABRT to the child"
    echo "  Expected: SIGABRT  Received: SIGTERM"
    echo " 1 fail"
  } >"$ABORT_LOG"
}
abort_case "NEGATIVE CONTROL — a test that merely prints SIGABRT is a FAIL" \
  1 "RESULT: FAIL — 1 of 2 gates failed: test" w_mentions_signal

echo ":: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
