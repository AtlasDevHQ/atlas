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
# Provides: ci_local_classify_gates (sets `failed`, `skipped`, `total`),
#           render_report, ci_local_exit_code.

# Partition the gates by their recorded exit code.
#
# ⚠️ `skipped` is tracked SEPARATELY from `failed`, because the headline has to
# say so. The row rendered SKIP correctly and the summary line still read "all N
# gates green" — and TEST_DATABASE_URL unset is the DEFAULT local state, so that
# was nearly every local run. `/ci`'s protocol tells the agent that RESULT's
# contents ARE the report, so a false green there is read as a clean pre-PR pass.
# Same defect as the row, moved one screen down.
ci_local_classify_gates() {
  local name rc
  failed=()
  skipped=()
  for name in "${GATE_NAMES[@]}"; do
    rc="$(cat "$LOG_DIR/$name.exit" 2>/dev/null || echo 1)"
    if [ "$rc" = "3" ]; then skipped+=("$name")
    elif [ "$rc" != "0" ]; then failed+=("$name"); fi
  done
  total="${#GATE_NAMES[@]}"
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
    echo "RESULT: FAIL — ${#failed[@]} of $total gates failed: ${failed[*]}"
    echo ""
    for name in "${failed[@]}"; do
      echo "▼ $name  (.ci-local/$name.log — last $FAIL_TAIL lines)"
      tail -n "$FAIL_TAIL" "$LOG_DIR/$name.log" 2>/dev/null | sed 's/^/    /'
      echo ""
    done
    echo "Full logs: .ci-local/<gate>.log   Re-run one gate, e.g.: bash scripts/check-schema-drift.sh"
    echo "Note: a 'type' failure can cascade into openapi-drift/test (incomplete SDK dist) — fix type first."
    return
  fi

  if [ "${#skipped[@]}" -gt 0 ]; then
    echo "RESULT: PASS with ${#skipped[@]} DECLINED — ${skipped[*]} verified nothing; not a clean pre-PR pass."
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
ci_local_exit_code() {
  if [ "${#failed[@]}" -gt 0 ]; then echo 1
  elif [ "${#skipped[@]}" -gt 0 ]; then echo 3
  else echo 0; fi
}
