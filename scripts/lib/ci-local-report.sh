#!/usr/bin/env bash
# ci-local-report.sh — the verdict half of scripts/ci-local.sh.
#
# ⚠️ SOURCED, never executed, and it lives in its own file for exactly one
# reason: ci-local.sh's `g_gate_fixtures` gate runs EVERY
# scripts/__tests__/*.test.sh, so a test that invoked ci-local.sh to check its
# verdict would recurse into itself. Sourcing the real bytes lets
# scripts/__tests__/ci-local-verdict.test.sh drive all four verdict states from
# synthetic .exit files without running a single gate — the wrapper was the only
# gate script in the repo with no fixture suite, and the bug it shipped (#5151)
# was in precisely the branch a fixture would have covered.
#
# Caller contract — set these before calling:
#   LOG_DIR      dir holding <gate>.exit / <gate>.secs / <gate>.log
#   GATE_NAMES   array of gate names, in table order
#   NO_TEST      "1" when Stage 3 was skipped
#   FAIL_TAIL    lines of a failed gate's log to quote
#
# Provides: ci_local_classify_gates (sets `failed`, `aborted`, `skipped`,
#           `total`), render_report, ci_local_exit_code, ci_local_test_verdict.

# ci_local_test_verdict <rc> <test_database_url> — the exit code the `test` gate
# reports, given the raw `bun run test` status and the TEST_DATABASE_URL value.
#
# ⚠️ IT LIVES HERE, NOT IN `g_test`, FOR THE REASON AT THE TOP OF THIS FILE.
# `g_gate_fixtures` runs every scripts/__tests__/*.test.sh, so a fixture that
# invoked ci-local.sh to check this rule would recurse into itself. Sourcing the
# real bytes lets the fixture drive all three cases without running a suite —
# and this rule is a two-branch predicate guarding a RELEASE gate, which is
# exactly the shape that ships wrong when nothing covers it (#5151, #5410).
#
# The order is the contract:
#   rc != 0            → rc     a real failure outranks a decline, always
#   rc == 0, url set   → 0      the pg suites actually ran; a true pass
#   rc == 0, url unset → 3      passed having self-skipped every pg suite
ci_local_test_verdict() {
  local rc="$1" url="${2:-}"
  if [ "$rc" -ne 0 ]; then echo "$rc"
  elif [ -n "$url" ]; then echo 0
  else echo 3; fi
}

# ci_local_decline_reason <gate> — what THAT gate's exit 3 actually means, for
# the RESULT line. See the comment at the `skipped` branch of render_report:
# "verified nothing" is true of `mutation-tables` and false of `test`, and a
# verdict line that overstates one case teaches the reader to discount both.
# The default is the conservative one, so a gate added later reads as the
# stronger claim until someone deliberately narrows it.
ci_local_decline_reason() {
  case "$1" in
    test) printf 'ran but exercised none of the real-Postgres suites (TEST_DATABASE_URL unset)' ;;
    *)    printf 'verified nothing' ;;
  esac
}

# ---------------------------------------------------------------------------
# Native worker abort (#5401)
# ---------------------------------------------------------------------------
#
# ⚠️ **AN ABORTED RUN AND A FAILING RUN ARE DIFFERENT FACTS.** A bun test worker
# can die of a NATIVE SIGNAL (SIGABRT/SIGSEGV) partway through `bun test
# --parallel`. Bun then takes the whole run down and stamps every still-running
# sibling file:
#
#     ✗ src/api/__tests__/chat.test.ts (aborted: sibling worker panicked)
#
# rolling all of them into its `N fail` summary. Measured on a clean `main` at
# 33f45fccd: 285 "failures", 284 of them collateral, on a SHA remote CI was green
# on. Nothing in this report distinguished that from a 285-test regression — you
# had to grep the log to learn the gate had DECLINED TO VERIFY rather than found
# a defect, and it nearly cost the v0.2.16 release.
#
# ⚠️ **THE FILE BUN NAMES IS NOT THE FAULTY FILE.** It is whichever worker was
# unlucky; it moves run to run and passes in isolation. Bun disclaims the crash
# itself ("a bug in Bun or in a native addon, not in the test itself"), so this
# code reports the crash and deliberately blames nothing — quarantining the named
# file would only relocate the crash.
#
# Same shape as #5395 (a CANCELLED CI run whose conclusion renders as failure)
# reached by a different mechanism, which is why it gets its own verdict here
# rather than a louder FAIL.

# Bun's own sentence. Matching the sentence rather than the bare signal name is
# what keeps an ordinary test that PRINTS the word SIGABRT from being excused.
#
# Named MARKER, not RE: both are matched with `grep -F`, so they are fixed
# strings and calling them regexes would invite someone to put a metacharacter
# in one.
CI_LOCAL_PANIC_MARKER='a test worker process crashed with SIG'

# The markers bun stamps on the files the crash took down.
#
# ⚠️ THREE VARIANTS, and this list was WRONG until it was checked against a real
# crash log. Measured in one run (bun 1.4.0, 24k lines): 243 × "aborted: worker
# panicked", 31 × "aborted: sibling worker panicked", 1 × "worker crashed:
# SIGABRT". Keyed on the "sibling" wording alone, the count came out 31 instead
# of 275 — so the report would have claimed 244 genuine failures that did not
# exist, which is the misread this whole change exists to remove, arriving from
# inside the fix.
#
# ⚠️ THE CRASH-SITE FILE COUNTS AS ABORTED, not as a residual failure. It is the
# `(worker crashed: SIG…)` line, and bun says of it in the very next sentence:
# "This indicates a bug in Bun or in a native addon, **not in the test itself**."
# Counting the victim as a defect would contradict bun on the one point it is
# unambiguous about, and it is what makes `275 reported = 275 aborted + 0 failed`
# come out right.
CI_LOCAL_ABORTED_RE='\(aborted: (sibling )?worker panicked\)|\(worker crashed: SIG[A-Z]+\)'

# One-entry memo. `ci_local_abort_phrase` and `ci_local_abort_block` are called
# back-to-back for the same gate, and a full-log `sed` per call is wasted work on
# a suite log that can run to tens of thousands of lines. Safe because every log
# is complete before `ci_local_classify_gates` is ever called.
_ci_local_abort_memo=""
abort_memo_hit=0

# ci_local_abort_stats <gate> — scan one gate's log for a native worker abort.
#
# Returns 0 and sets the globals below when bun's panic sentence is present;
# returns 1 and leaves them at their empty defaults otherwise.
#
#   abort_signals        signals seen, e.g. "SIGABRT SIGSEGV"
#   abort_files          the file(s) bun named as the crash site (victims)
#   abort_count          how many siblings were aborted
#   abort_reported_fail  the `N fail` bun printed, or "" if unparseable
#   abort_residual       reported_fail - aborted, or "unknown"
ci_local_abort_stats() {
  local logfile="$LOG_DIR/$1.log" plain
  # `$LOG_DIR` is part of the key: the fixture suite drives many gates named
  # `test` in different temp dirs, and a name-only key would serve one run's
  # numbers for the next one's log.
  local key="$LOG_DIR/$1"
  if [ "$key" = "$_ci_local_abort_memo" ]; then
    [ "$abort_memo_hit" = "1" ] && return 0
    return 1
  fi
  _ci_local_abort_memo="$key"
  abort_memo_hit=0
  abort_signals=""; abort_files=""; abort_count=0
  abort_reported_fail=""; abort_residual="unknown"
  [ -f "$logfile" ] || return 1

  # ⚠️ THE STRIPPED LOG GOES TO A FILE, NOT A SHELL VARIABLE, and that is a
  # correctness fix rather than a style choice.
  #
  # It was `plain="$(sed …)"` followed by `printf '%s\n' "$plain" | grep -qF …`.
  # `grep -q` exits at the FIRST match and closes the pipe; `printf` then takes
  # SIGPIPE; and under `set -o pipefail` (set at the top of ci-local.sh) the
  # pipeline's status becomes 141, so the `|| return 1` fired and the abort went
  # UNDETECTED. It only happens when the log is big enough that printf is still
  # writing when grep leaves — every fixture here is a few KB and passed; the
  # real suite log is 4.8 MB and failed. A size-dependent detector that works on
  # every test and fails on every real run is worse than no detector.
  #
  # Reading a file has no pipe, so it cannot SIGPIPE, and one `sed` now feeds
  # five cheap greps instead of re-piping a multi-megabyte variable five times.
  plain="$(mktemp)" || return 1
  # Strip ANSI: bun keeps colour when it believes it has a TTY, and an escape
  # sequence between "with" and "SIGABRT" would hide the marker.
  #
  # ⚠️ `$(printf '\033')`, NOT `\x1b` inside the sed script. `\x1b` is a GNU-sed
  # extension; BSD/macOS sed reads it as a literal `x1b`, so the strip would
  # quietly no-op and every coloured abort would revert to FAIL — the one line
  # whose whole purpose is this failure mode failing silently.
  sed -e "s/$(printf '\033')\\[[0-9;]*[A-Za-z]//g" "$logfile" >"$plain"
  if ! grep -qF "$CI_LOCAL_PANIC_MARKER" "$plain"; then
    rm -f "$plain"
    return 1
  fi

  abort_signals="$(grep -oE 'crashed with SIG[A-Z]+' "$plain" \
    | grep -oE 'SIG[A-Z]+' | sort -u | tr '\n' ' ')"
  abort_signals="${abort_signals% }"
  # Bun sometimes WRAPS the sentence, putting the file on the NEXT line, and
  # sometimes keeps it on one — both shapes are real (the wrapped one is quoted
  # in #5401, the one-line one was measured here). `-A1` covers both.
  abort_files="$(grep -A1 -F "$CI_LOCAL_PANIC_MARKER" "$plain" \
    | grep -oE '[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?' | sort -u | tr '\n' ' ')"
  abort_files="${abort_files% }"
  abort_count="$(grep -cE "$CI_LOCAL_ABORTED_RE" "$plain")"

  # Bun's own summary line, e.g. " 285 fail". Last one wins — that is the run's
  # total rather than any per-file line above it.
  abort_reported_fail="$(grep -oE '^[[:space:]]*[0-9]+ fail' "$plain" \
    | tail -1 | grep -oE '[0-9]+')"
  rm -f "$plain"
  if [ -n "$abort_reported_fail" ]; then
    abort_residual="$(( abort_reported_fail - abort_count ))"
    [ "$abort_residual" -lt 0 ] && abort_residual=0
  fi
  abort_memo_hit=1
  return 0
}

# ci_local_gate_aborted <gate> — true when the gate died to a native worker
# crash AND nothing in its log is attributable to a real test failure.
#
# ⚠️ A residual failure OUTRANKS the abort: `abort_residual > 0` keeps the gate
# in `failed`, so a native crash can never become a way for a genuine red to read
# as "declined". The abort is narrated either way.
#
# An UNPARSEABLE summary (the crash beat bun to its own totals) counts as
# aborted: a run with no totals has verified nothing, and exit 3 says exactly
# that without claiming green.
ci_local_gate_aborted() {
  ci_local_abort_stats "$1" || return 1
  [ "$abort_residual" = "unknown" ] && return 0
  [ "$abort_residual" -eq 0 ]
}

# ci_local_abort_phrase <gate> — the one-line split, for a RESULT line.
#
# ⚠️ THE TWO COUNTS SIDE BY SIDE ARE THE FIX (#5401), so this is shared by BOTH
# verdicts rather than written twice. A run with a residual failure — the NORMAL
# shape, since bun counts the crashed file itself in its `N fail` — renders FAIL,
# and that FAIL line has to carry the split too. Without it the exact run that
# filed the issue (285 reported, 284 collateral) still reads as a 285-test
# regression on the one line `/ci`'s protocol quotes.
ci_local_abort_phrase() {
  local name="$1"
  ci_local_abort_stats "$name" || return 0
  if [ -n "$abort_reported_fail" ]; then
    printf '%s: %s aborted (sibling worker panicked), %s failed' "$name" "$abort_count" "$abort_residual"
  else
    printf '%s: %s aborted (sibling worker panicked), ? failed (bun printed no totals)' "$name" "$abort_count"
  fi
}

# ci_local_abort_block <gate> — the narrated evidence for one aborted gate.
# Printed for an ABORTED gate and, unchanged, for a FAILED gate whose log also
# carries a panic — the residual is real there, but the operator still needs to
# know most of the count is collateral.
ci_local_abort_block() {
  local name="$1"
  ci_local_abort_stats "$name" || return 0
  echo "▼ $name  ABORTED — a native worker crash took the run down (#5401)"
  echo "    bun: a test worker process crashed with ${abort_signals:-a native signal}"
  [ -n "$abort_files" ] && echo "    crash site (VICTIM, not suspect): $abort_files"
  if [ -n "$abort_reported_fail" ]; then
    echo "    $abort_count aborted (sibling worker panicked), $abort_residual failed — of $abort_reported_fail bun reported as \`fail\`"
  else
    echo "    $abort_count aborted (sibling worker panicked), ? failed — bun printed no totals"
  fi
  echo "    ⚠️  ABORTED IS NOT FAILED. Bun disclaims the crash (\"a bug in Bun or in"
  echo "       a native addon, not in the test itself\") and the file it names moves"
  echo "       run to run — it passes in isolation. This gate DECLINED TO VERIFY."
  echo "    Re-run \`bun run test\`; cross-check remote CI on the same SHA before"
  echo "    reading it as a regression. Full log: .ci-local/$name.log"
  echo ""
}

# Partition the gates by their recorded exit code.
#
# ⚠️ `skipped` is tracked SEPARATELY from `failed`, because the headline has to
# say so. The row rendered SKIP correctly and the summary line still read "all N
# gates green" — and TEST_DATABASE_URL unset is the DEFAULT local state, so that
# was nearly every local run. `/ci`'s protocol tells the agent that RESULT's
# contents ARE the report, so a false green there is read as a clean pre-PR pass.
# Same defect as the row, moved one screen down.
#
# ⚠️ `aborted` is tracked separately for the same reason one level down: a gate
# killed by a native worker crash (#5401) did not fail, it declined — see the
# block above.
ci_local_classify_gates() {
  local name rc
  failed=()
  aborted=()
  skipped=()
  for name in "${GATE_NAMES[@]}"; do
    rc="$(cat "$LOG_DIR/$name.exit" 2>/dev/null || echo 1)"
    if [ "$rc" = "3" ]; then skipped+=("$name")
    elif [ "$rc" != "0" ]; then
      if ci_local_gate_aborted "$name"; then aborted+=("$name")
      else failed+=("$name"); fi
    fi
  done
  total="${#GATE_NAMES[@]}"
}

# ci_local_in_list <needle> <haystack...> — membership test for the classified
# arrays. `[[ " ${arr[*]} " == *" $x "* ]]` is subtly wrong for names carrying
# spaces; gate names never do, but a substring test that silently agrees on a
# prefix is not worth the two lines it saves.
ci_local_in_list() {
  local needle="$1" item; shift
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

render_report() {
  local name rc secs
  echo ""
  printf '%-28s %-7s %5s\n' "GATE" "RESULT" "TIME"
  printf '%s\n' "------------------------------------------------"
  for name in "${GATE_NAMES[@]}"; do
    rc="$(cat "$LOG_DIR/$name.exit" 2>/dev/null || echo 1)"
    secs="$(cat "$LOG_DIR/$name.secs" 2>/dev/null || echo '?')"
    if [ "$rc" = "3" ]; then
      # ⚠️ Exit 3 means "declined to verify", and it is NOT PASS. A gate that
      # cannot tell "verified" from "did not run" in its own summary line is the
      # same defect class as the deflated table `mutation-tables` exists to
      # refuse — and the compact table is what the /ci agent protocol reads.
      printf '%-28s %-7s %4ss\n' "$name" "SKIP" "$secs"
    elif [ "$rc" = "0" ]; then
      printf '%-28s %-7s %4ss\n' "$name" "PASS" "$secs"
    elif ci_local_in_list "$name" ${aborted[@]+"${aborted[@]}"}; then
      # ⚠️ ABORT, not FAIL. The row is what the /ci agent protocol reads, and a
      # native worker crash rendered FAIL is indistinguishable from a real
      # regression of the same size (#5401).
      printf '%-28s %-7s %4ss\n' "$name" "ABORT" "$secs"
    else
      printf '%-28s %-7s %4ss\n' "$name" "FAIL" "$secs"
    fi
  done
  printf '%s\n' "------------------------------------------------"

  # ⚠️ EXACTLY ONE `RESULT:` line per run, and the FAIL line is reachable only
  # when `failed` is non-empty. This was an if/elif chain in which the DECLINED
  # branch fell THROUGH to the FAIL line below it — the clean-PASS branch had a
  # `return` and DECLINED did not — so a declined run wrote BOTH
  #   RESULT: PASS with 1 DECLINED — mutation-tables verified nothing; …
  #   RESULT: FAIL — 0 of 34 gates failed:
  # into the same file, the second self-contradictory on its face, and then
  # exited 0. Three signals, three different verdicts, for one run (#5151).
  # `.ci-local/RESULT` is documented as THE trustworthy completion signal
  # precisely because the exit code isn't, so a RESULT that can hold two
  # verdicts removes the only reliable one.
  # Branching on `failed` FIRST is what makes the empty-set FAIL
  # unrepresentable rather than merely unreached — restoring the missing
  # `return` alone would fix this instance and leave the next fall-through free
  # to reintroduce the class.
  if [ "${#failed[@]}" -gt 0 ]; then
    # ⚠️ A panic is named ON the FAIL line, and it is scanned from the FAILED
    # gates too — not only from `aborted`.
    #
    # This is where the first cut of this fix was wrong, and wrong in exactly
    # the measured case. A gate with a RESIDUAL failure stays in `failed` (by
    # design — a real red must outrank the abort), so reading only `aborted`
    # here left the annotation off every run that had one. And a residual is the
    # NORMAL shape: bun counts the crashed file itself in its `N fail`, so
    # `reported = aborted + 1` is what the issue actually measured — 285 vs 284.
    # The run that filed #5401 would still have rendered a bare
    # "RESULT: FAIL — 1 of 42 gates failed: test", which is the whole defect.
    local also="" name_
    local panicked=()
    for name_ in "${failed[@]}" ${aborted[@]+"${aborted[@]}"}; do
      ci_local_abort_stats "$name_" && panicked+=("$(ci_local_abort_phrase "$name_")")
    done
    if [ "${#panicked[@]}" -gt 0 ]; then
      also=" — ⚠️ a native worker crash is in this run (#5401), so the count above is NOT all defects: ${panicked[*]}"
    fi
    echo "RESULT: FAIL — ${#failed[@]} of $total gates failed: ${failed[*]}$also"
    echo ""
    for name in "${failed[@]}"; do
      # A FAILED gate can still carry a panic — that is the residual case, where
      # the abort is real but so is at least one genuine failure. Narrate the
      # split first so the tail below is read for the right number of lines.
      ci_local_abort_block "$name"
      echo "▼ $name  (.ci-local/$name.log — last $FAIL_TAIL lines)"
      tail -n "$FAIL_TAIL" "$LOG_DIR/$name.log" 2>/dev/null | sed 's/^/    /'
      echo ""
    done
    for name in ${aborted[@]+"${aborted[@]}"}; do
      ci_local_abort_block "$name"
    done
    echo "Full logs: .ci-local/<gate>.log   Re-run one gate, e.g.: bash scripts/check-schema-drift.sh"
    echo "Note: a 'type' failure can cascade into openapi-drift/test (incomplete SDK dist) — fix type first."
    return
  fi

  # ⚠️ ABOVE `skipped` and below `failed`, deliberately. An abort is a decline,
  # so it must never outrank a real red; but it carries evidence a bare SKIP
  # does not, so it gets its own verdict line rather than being folded in.
  if [ "${#aborted[@]}" -gt 0 ]; then
    # The two counts side by side ARE the fix: "284 aborted (sibling worker
    # panicked), 0 failed" is the sentence that stops a crash reading as a
    # 284-test regression, and it belongs on the one line that gets quoted.
    # Same phrase helper as the FAIL branch — one wording, so the two verdicts
    # cannot drift on the sentence that carries the whole point.
    local counts=""
    for name in "${aborted[@]}"; do
      counts="$counts $(ci_local_abort_phrase "$name");"
    done
    echo "RESULT: ABORTED — ${#aborted[@]} of $total gates were killed by a native worker crash, NOT by a defect (#5401):$counts verified nothing — re-run before reading it as a regression."
    echo ""
    for name in "${aborted[@]}"; do
      ci_local_abort_block "$name"
    done
    return
  fi

  if [ "${#skipped[@]}" -gt 0 ]; then
    # ⚠️ THE PHRASE IS PER GATE, because the two declines are not the same fact
    # and one wording cannot be true of both.
    #
    # `mutation-tables` declining really does mean it verified NOTHING, and that
    # sentence is load-bearing — it is what stops an operator reading exit 3 as a
    # near-pass. But since #5410 the `test` gate also declines (TEST_DATABASE_URL
    # unset), and by then it has run ~20,800 assertions: it verified plenty, just
    # not the real-Postgres suites it was asked to. A first cut flattened both to
    # "declined to verify", which weakened a true statement for `mutation-tables`
    # to accommodate the new case. Naming each gate's own reason costs one `case`
    # and keeps both sentences true, which is the whole point of a verdict line.
    local phrases="" name_
    for name_ in "${skipped[@]}"; do
      phrases="$phrases $name_ $(ci_local_decline_reason "$name_");"
    done
    echo "RESULT: PASS with ${#skipped[@]} DECLINED —${phrases} not a clean pre-PR pass."
    return
  fi

  if [ "$NO_TEST" = "1" ]; then
    echo "RESULT: PASS (tests skipped — Stage 2 not run; not a clean pre-PR pass)"
    return
  fi

  echo "RESULT: PASS — all $total gates green."
}

# ⚠️ The exit code AGREES with the RESULT verdict. DECLINED gets its OWN code
# rather than being folded into either neighbour: exiting 0 was how a run that
# verified nothing read as a clean pre-PR pass, and exiting 1 would make it
# indistinguishable from a real gate failure. 3 is the same code the gates
# themselves already use for "declined to verify" (check-mutation-tables.sh), so
# the meaning is consistent at both layers. Documented in .claude/commands/ci.md.
#
# Deliberately NOT extended to NO_TEST: `CI_LOCAL_NO_TEST=1` is an operator
# opting into a gates-only pass, not a gate failing to measure something it was
# asked to. Its RESULT line already says "not a clean pre-PR pass"; the exit
# stays 0 because the operator chose the narrower run.
#
# A NATIVE ABORT (#5401) shares code 3 with DECLINED rather than taking a fourth
# of its own. Both mean the same thing to a caller — *this run verified nothing,
# do not read it as a pass* — and the RESULT line already says which one
# happened. A new code would only make every existing `-eq 3` check wrong about
# a case it already handles correctly.
ci_local_exit_code() {
  if [ "${#failed[@]}" -gt 0 ]; then echo 1
  elif [ "${#aborted[@]}" -gt 0 ]; then echo 3
  elif [ "${#skipped[@]}" -gt 0 ]; then echo 3
  else echo 0; fi
}
