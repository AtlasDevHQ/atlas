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
# ⚠️ The logs below are SYNTHETIC but every line is transcribed from a REAL
# crash captured while measuring the rate for #5401 (bun 1.4.0, 24k lines,
# 4.8 MB). That transcription is not decoration — it is what caught two detector
# bugs the first cut of these fixtures could not see:
#
#   • bun stamps THREE marker wordings, not one — 243 × "aborted: worker
#     panicked", 31 × "aborted: sibling worker panicked", 1 × "worker crashed:
#     SIGABRT". Keyed on the "sibling" wording alone the count came out 31 of
#     275, i.e. 244 invented failures.
#   • bun WRAPS the panic sentence sometimes and not others. Both shapes appear
#     below for that reason.
#
# write_bun_abort_log <file> <sibling_markers> <reported_fail|NONE> [signal] [wrap]
#   wrap=wrapped  the sentence spans two lines (the shape quoted in #5401)
#   wrap=oneline  the sentence is one line (the shape measured here)
#
# The crash-site file gets its own `(worker crashed: SIG…)` line, exactly as bun
# emits, so the aborted total is <sibling_markers> + 1.
write_bun_abort_log() {
  local out="$1" siblings="$2" reported="$3" sig="${4:-SIGABRT}" wrap="${5:-oneline}" i
  local site="src/lib/db/__tests__/learned-pattern-injections-pg.test.ts"
  {
    echo "bun test v1.4.0"
    echo ""
    echo "src/lib/billing/__tests__/agent-gate.test.ts:"
    echo "✓ agent gate > allows a paying workspace [3.10ms]"
    echo "panic(main thread): abort() called"
    echo "oh no: Bun has crashed. This indicates a bug in Bun, not your code."
    echo "✗ $site (worker crashed: $sig)"
    if [ "$wrap" = "wrapped" ]; then
      echo "error: a test worker process crashed with $sig while running"
      echo "  $site."
    else
      echo "error: a test worker process crashed with $sig while running $site."
    fi
    echo "This indicates a bug in Bun or in a native addon, not in the test itself. Aborting."
    # Both sibling wordings, interleaved — bun emits both in one run.
    for ((i = 0; i < siblings; i++)); do
      if (( i % 8 == 0 )); then
        echo "✗ src/api/__tests__/sibling-$i.test.ts (aborted: sibling worker panicked)"
      else
        echo "✗ src/api/__tests__/sibling-$i.test.ts (aborted: worker panicked)"
      fi
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

# abort_case NAME EXPECTED_EXIT EXPECTED_SUBSTR WRITER [SCOPE] — one failing
# `test` gate whose log is written by the caller into $ABORT_LOG, plus a green
# `lint` gate.
#
# ⚠️ SCOPE defaults to `result`, and that default is load-bearing. The first cut
# of these fixtures grepped the WHOLE REPORT, so a case named "the FAIL line
# names the concurrent abort" passed while asserting nothing about the FAIL line
# — the string it found was in the ▼ body. `/ci`'s protocol quotes the RESULT
# line, so a claim about that line has to be tested against that line. Pass
# `report` only where the assertion is deliberately about the narrated body.
ABORT_LOG=""
abort_case() {
  local name="$1" exp_exit="$2" exp_sub="$3" writer="$4" scope="${5:-result}"
  local tmp out rc n_result haystack problems=""
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
  if [ "$scope" = "result" ]; then
    haystack="$(printf '%s\n' "$out" | grep '^RESULT:')"
  else
    haystack="$out"
  fi

  [ "$n_result" = "1" ] || problems="$problems; expected exactly 1 RESULT line, got $n_result"
  [ "$rc" = "$exp_exit" ] || problems="$problems; expected exit $exp_exit, got $rc"
  printf '%s\n' "$haystack" | grep -qF "$exp_sub" || problems="$problems; $scope missing '$exp_sub'"

  if [ -z "$problems" ]; then
    echo "  ok    $name (exit $rc, 1 RESULT line)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name —${problems#;}"
    printf '%s\n' "$out" | grep -E '^(RESULT:|▼)' | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# 6. The all-collateral shape: every reported failure is an aborted sibling.
w_clean_abort() { write_bun_abort_log "$ABORT_LOG" 284 285; }
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
write_bun_abort_log "$tmp/test.log" 284 285
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

# 7. ⚠️ THE MEASURED SHAPE, and the case the first cut of this fix got WRONG.
#
# #5401 recorded 285 reported `fail` against 284 `aborted:` markers — bun counts
# the crashed file ITSELF in its total without stamping it aborted, so a residual
# of 1 is the NORMAL shape of a real abort, not an edge case. That residual keeps
# the gate in `failed` (correctly — a real red outranks the abort), and the first
# implementation read the annotation only from `aborted`, so it rendered a bare
#
#   RESULT: FAIL — 1 of 2 gates failed: test
#
# for the very run that filed the issue. Both assertions below are scoped to the
# RESULT LINE; asserting against the whole report is what hid this.
w_residual() { write_bun_abort_log "$ABORT_LOG" 283 285; }
abort_case "a residual failure alongside an abort still FAILS" \
  1 "RESULT: FAIL" w_residual
abort_case "the FAIL LINE itself carries the split (the measured 285/284 shape)" \
  1 "284 aborted (sibling worker panicked), 1 failed" w_residual

# A gate genuinely red WHILE A DIFFERENT gate aborted — the FAIL line must name
# both facts, since the failing gate's own log carries no panic at all.
tmp="$(mktemp -d)"
printf '0' >"$tmp/lint.exit";  printf '7' >"$tmp/lint.secs";  echo l >"$tmp/lint.log"
printf '1' >"$tmp/type.exit";  printf '4' >"$tmp/type.secs";  echo "TS2307: boom" >"$tmp/type.log"
printf '1' >"$tmp/test.exit";  printf '9' >"$tmp/test.secs"
write_bun_abort_log "$tmp/test.log" 284 285
GATE_NAMES=(lint type test); LOG_DIR="$tmp"; NO_TEST=0; FAIL_TAIL=5
ci_local_classify_gates
result_line="$(render_report | grep '^RESULT:')"
problems=""
printf '%s\n' "$result_line" | grep -qF "1 of 3 gates failed: type" || problems="names the real failure"
printf '%s\n' "$result_line" | grep -qF "test: 285 aborted (sibling worker panicked), 0 failed" \
  || problems="${problems:+$problems + }names the concurrent abort"
if [ -z "$problems" ]; then
  echo "  ok    a red gate beside an aborted gate — the RESULT line names both"; PASS=$((PASS + 1))
else
  echo "  FAIL  a red gate beside an aborted gate — RESULT line fails to: $problems"
  printf '        %s\n' "$result_line"; FAIL=$((FAIL + 1))
fi
rm -rf "$tmp"

# Bun can die before printing totals. That run verified nothing, so it is an
# abort — never a green — but the report must not invent a residual count.
w_no_totals() { write_bun_abort_log "$ABORT_LOG" 39 NONE; }
abort_case "an abort with no totals is ABORTED with an unknown residual" \
  3 "40 aborted (sibling worker panicked), ? failed" w_no_totals

# Multiple signals in one run (measured: SIGSEGV ×3 + SIGABRT) are all named.
w_two_signals() {
  write_bun_abort_log "$ABORT_LOG" 99 100 SIGSEGV wrapped
  {
    echo "error: a test worker process crashed with SIGABRT while running"
    echo "  src/lib/billing/__tests__/agent-gate.test.ts."
  } >>"$ABORT_LOG"
}
abort_case "every signal seen in the run is named" \
  3 "crashed with SIGABRT SIGSEGV" w_two_signals report

# ⚠️ A COLOURED LOG. Bun keeps ANSI when it believes it has a TTY, and the strip
# in `ci_local_abort_stats` exists for exactly that — but until this case, no
# fixture wrote an escape sequence, so the one line whose purpose is "the marker
# must not hide behind colour" was never falsified.
#
# ⚠️ It does NOT cover the portability half of that line, and saying so is the
# point: `\x1b` inside a sed script is a GNU extension, and on GNU sed — every
# machine that runs this suite today — both spellings work identically. So this
# case would stay green if someone reverted to `\x1b`, and only a BSD/macOS run
# would catch it. The strip uses `$(printf '\033')` for that reason; this fixture
# is not the thing holding it there.
w_coloured() {
  local esc i
  esc="$(printf '\033')"
  {
    echo "${esc}[31merror${esc}[0m: a test worker process crashed with ${esc}[1mSIGABRT${esc}[0m while running"
    echo "  src/lib/db/__tests__/learned-pattern-injections-pg.test.ts."
    for ((i = 0; i < 12; i++)); do
      echo "${esc}[31m✗${esc}[0m src/api/__tests__/sib-$i.test.ts (aborted: sibling worker panicked)"
    done
    echo " ${esc}[31m12 fail${esc}[0m"
  } >"$ABORT_LOG"
}
abort_case "a colour-escaped log is still detected as an abort" \
  3 "test: 12 aborted (sibling worker panicked), 0 failed" w_coloured

# ⚠️ A MULTI-MEGABYTE LOG, and this is the most important case in the file
# because it is the one every other case here is structurally blind to.
#
# The detector read the stripped log into a shell variable and tested it with
# `printf '%s\n' "$plain" | grep -qF …`. `grep -q` exits at the FIRST match and
# closes the pipe; `printf` then takes SIGPIPE; and `set -o pipefail` (set at the
# top of ci-local.sh) turns that into status 141, so the `|| return 1` fired and
# the abort went UNDETECTED.
#
# It only reproduces once the log is big enough that printf is still writing when
# grep leaves. Every other fixture here is a few KB and passed happily. The REAL
# suite log is 4.8 MB — so the detector worked on 100% of its tests and failed on
# 100% of real runs, which is worse than having no detector, because the report
# then says FAIL with full confidence.
#
# Found by running the thing for real (#5401 AC1), not by reading it.
w_huge() {
  local i
  {
    echo "bun test v1.4.0"
    echo "✗ src/lib/db/__tests__/tenant-pool.test.ts (worker crashed: SIGABRT)"
    echo "error: a test worker process crashed with SIGABRT while running src/lib/db/__tests__/tenant-pool.test.ts."
    echo "This indicates a bug in Bun or in a native addon, not in the test itself. Aborting."
    for ((i = 0; i < 24; i++)); do
      echo "✗ src/api/__tests__/sib-$i.test.ts (aborted: worker panicked)"
    done
    # ~2 MB of trailing noise, exactly like the pino output a real suite emits
    # after the panic. The marker sits ABOVE it, which is the worst case for the
    # SIGPIPE bug and so the most reliable reproduction.
    awk 'BEGIN { for (i = 0; i < 20000; i++)
      print "{\"level\":30,\"msg\":\"padding line to make this log realistically large\",\"i\":" i "}" }'
    echo " 25 fail"
  } >"$ABORT_LOG"
}
abort_case "a MULTI-MEGABYTE log is still detected (no SIGPIPE under pipefail)" \
  3 "test: 25 aborted (sibling worker panicked), 0 failed" w_huge

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

# ---------------------------------------------------------------------------
# 9. `ci_local_test_verdict` — the TEST_DATABASE_URL decline (#5410)
# ---------------------------------------------------------------------------
#
# ⚠️ The rule this covers is the one that used to be absent: a `test` gate that
# passed WITHOUT TEST_DATABASE_URL had self-skipped all 87 *-pg.test.ts files and
# still reported PASS, exit 0 — measured at 1,432 assertions that never ran. It
# is a two-branch predicate guarding a release gate, so it gets a fixture rather
# than a docstring.
#
# It is tested HERE, against the sourced library, because ci-local.sh cannot be
# invoked from a fixture: `g_gate_fixtures` runs every scripts/__tests__/*.test.sh
# and the call would recurse. That constraint is why the predicate lives in the
# lib at all.
verdict_case() {
  local name="$1" rc_in="$2" url="$3" expected="$4" got
  got="$(ci_local_test_verdict "$rc_in" "$url")"
  if [ "$got" = "$expected" ]; then
    echo "  ok    $name (→ $got)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name — expected $expected, got $got"; FAIL=$((FAIL + 1))
  fi
}

echo ":: ci_local_test_verdict fixtures (#5410)"

# ⚠️ The decline sentence is PER GATE, and both halves are asserted because the
# regression here is silent: flattening them to one wording still emits a valid
# RESULT line, still exits 3, and still passes every case_check above — it just
# tells the operator something false about one of the two gates. `verified
# nothing` must survive for `mutation-tables` (it is what stops exit 3 reading as
# a near-pass) and must NOT be said of `test`, which by then has run ~20,800
# assertions.
case_check "a declined mutation-tables still says it verified NOTHING" \
  3 "mutation-tables verified nothing" 0 lint:0 mutation-tables:3
case_check "a declined test does NOT claim it verified nothing" \
  3 "test ran but exercised none of the real-Postgres suites" 0 lint:0 test:3

verdict_case "green + TEST_DATABASE_URL set → PASS" \
  0 "postgresql://atlas:atlas@localhost:5432/atlas" 0

verdict_case "green + TEST_DATABASE_URL unset → DECLINED, not PASS" \
  0 "" 3

# ⚠️ NEGATIVE CONTROL, and the one that matters most. A decline must never mask
# a red: without this, "downgrade a pass to 3" could be written as "return 3
# whenever the URL is unset" and would swallow every genuine test failure on the
# default local path — turning a fix for a false green into a false amber.
verdict_case "NEGATIVE CONTROL — a real failure outranks the decline (url unset)" \
  1 "" 1

verdict_case "NEGATIVE CONTROL — a real failure is still a failure (url set)" \
  1 "postgresql://atlas:atlas@localhost:5432/atlas" 1

# A non-1 failure code must be passed through unchanged rather than normalised.
verdict_case "an aborted run's exit 3 survives unchanged" \
  3 "postgresql://atlas:atlas@localhost:5432/atlas" 3

# ---------------------------------------------------------------------------
# 10. `g_test` captures the SUITE's status, not a `local`'s — a STATIC guard
# ---------------------------------------------------------------------------
#
# ⚠️ THE PREDICATE ABOVE WAS CORRECT AND THE GATE WAS STILL A FALSE GREEN, WHICH
# IS WHY THIS CASE EXISTS SEPARATELY. The first cut of `g_test` read:
#
#     bun run test
#     local rc verdict     # `local` SUCCEEDS, resetting $?
#     rc=$?                # captures the `local`, not the suite
#
# so every genuinely failing suite was captured as rc=0 and — with
# TEST_DATABASE_URL set — reported PASS. That is a worse false green than the one
# #5410 set out to remove, introduced by the fix for it, and no amount of
# testing `ci_local_test_verdict` can see it: the predicate was handed a 0 and
# correctly returned 0. The defect is in the CAPTURE.
#
# It is checked STATICALLY, by reading the bytes, because `g_test` cannot be
# sourced — ci-local.sh runs 42 gates at source time — and because the dynamic
# alternative is a 2-minute suite run. `rc=$?` must be the FIRST statement after
# the command whose status it reads; anything between them resets `$?`.
CI_LOCAL="$SCRIPT_DIR/ci-local.sh"
if [ ! -f "$CI_LOCAL" ]; then
  echo "  FAIL  g_test status-capture guard — ci-local.sh not found at $CI_LOCAL"
  FAIL=$((FAIL + 1))
else
  # The line immediately after `bun run test` inside g_test().
  after_cmd="$(awk '/^g_test\(\) \{/,/^\}/' "$CI_LOCAL" \
    | grep -A1 -x '  bun run test' | tail -1 | sed 's/^[[:space:]]*//')"
  if [ "$after_cmd" = "rc=\$?" ]; then
    echo "  ok    g_test captures the suite's exit status on the very next line"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  g_test status-capture guard — expected 'rc=\$?' immediately after"
    echo "        'bun run test'; got '$after_cmd'. Anything between them (a"
    echo "        \`local\`, an \`echo\`) resets \$? and turns a failing suite green."
    FAIL=$((FAIL + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 11. `g_test` end-to-end — the REAL body, a stubbed suite (#5410)
# ---------------------------------------------------------------------------
#
# ⚠️ This is the case that would have caught the status-capture bug on its own,
# and it is worth having ALONGSIDE the static guard above rather than instead of
# it. The static guard names the offending line; this one proves the BEHAVIOUR,
# including the one path that matters most — a RED suite must stay red. Under
# the original bug, "suite RED + URL set" returned 0 instead of 1.
#
# `g_test` still cannot be sourced (ci-local.sh runs 42 gates at source time), so
# the function body is extracted with awk and eval'd on its own, and `bun` is
# shadowed by a shell function standing in for `bun run test`. That keeps the
# assertion against the REAL bytes of g_test — a hand-copied duplicate here would
# drift from the file it claims to test, which is the failure mode this whole
# suite exists to refuse.
echo ":: g_test end-to-end fixtures — real body, stubbed suite (#5410)"

if [ ! -f "$CI_LOCAL" ]; then
  echo "  FAIL  g_test end-to-end — ci-local.sh not found at $CI_LOCAL"
  FAIL=$((FAIL + 1))
else
  # Subshell: `eval`ing g_test and shadowing `bun` must not leak into the cases
  # above, and `unset TEST_DATABASE_URL` must not disturb the caller's env.
  gtest_out="$(
    # BOTH functions, not just g_test: the decline path calls `pg_suite_count`
    # for the number it prints. Extracting only g_test leaves that undefined,
    # and because ci-local.sh runs under `set -uo pipefail` (no `-e`) the missing
    # command is a stderr line, not a failure — the exit code would still be 3
    # and this fixture would pass while the operator-facing warning said
    # "the  *-pg.test.ts files will SELF-SKIP" with an empty count.
    eval "$(awk '/^pg_suite_count\(\) \{/,/^$/' "$CI_LOCAL")"
    eval "$(awk '/^g_test\(\) \{/,/^\}/' "$CI_LOCAL")"
    RC_TO_RETURN=0
    bun() { return "$RC_TO_RETURN"; }
    run_one() {
      local rc_in="$2" url="$3" expect="$4" got
      RC_TO_RETURN="$rc_in"
      if [ -n "$url" ]; then export TEST_DATABASE_URL="$url"; else unset TEST_DATABASE_URL; fi
      g_test >/dev/null 2>&1
      got=$?
      [ "$got" = "$expect" ] && echo "ok|$1|$got" || echo "no|$1|expected $expect, got $got"
    }
    run_one "suite green + URL set → PASS"                 0 "postgresql://x" 0
    run_one "suite green + URL unset → DECLINED"           0 ""               3
    run_one "suite RED + URL set → FAIL"                   1 "postgresql://x" 1
    run_one "suite RED + URL unset → FAIL (no masked red)" 1 ""               1

    # The decline's message must name a REAL count. An empty or zero one still
    # exits 3, so the exit-code cases above cannot see it — and the number is the
    # entire persuasive content of the warning.
    RC_TO_RETURN=0
    unset TEST_DATABASE_URL
    msg="$(g_test 2>/dev/null)"
    if printf '%s' "$msg" | grep -qE '^ +[1-9][0-9]* \*-pg\.test\.ts files self-skipped'; then
      echo "ok|the decline names a non-zero pg-suite count|$(pg_suite_count)"
    else
      echo "no|the decline names a non-zero pg-suite count|got: $(printf '%s' "$msg" | grep -F 'self-skipped' | sed 's/^ *//')"
    fi
  )"
  while IFS='|' read -r verdict label detail; do
    [ -z "$verdict" ] && continue
    if [ "$verdict" = "ok" ]; then
      echo "  ok    $label (→ $detail)"; PASS=$((PASS + 1))
    else
      echo "  FAIL  $label — $detail"; FAIL=$((FAIL + 1))
    fi
  done <<< "$gtest_out"
fi

echo ":: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
