#!/usr/bin/env bash
# run-gate-fixtures.sh — run every adversarial fixture suite under
# scripts/__tests__/, serially, each in its own log group.
#
# ## One runner, two callers
#
# ci.yml's `gate-fixtures` job and ci-local.sh's `gate-fixtures` row both call
# this, so the roster is the DIRECTORY LISTING in both places. Before this
# existed ci.yml enumerated every suite as a named step (30 of them) while
# ci-local.sh globbed the directory — the drift `check-gate-fixtures-wired.sh`
# (#5296) was built to catch. With a glob on both sides that class cannot
# occur; that gate now guards the one thing a glob cannot, the suites this
# runner SKIPS (see `--all` below).
#
# ## Serial, deliberately
#
# Several suites rewrite TRACKED SOURCE in place and trap-restore it —
# check-pricing-parity, check-brain-settings-doc, check-enforcement-parity —
# and check-scripts-typecheck writes an untracked probe file into a directory
# the lint gates scan. Run in parallel they would race each other on those
# files. Serial is the correctness choice, not a speed one; the speed choice is
# that this runs as its own CI job beside `drift` rather than inside it.
#
# ## --all
#
# `scripts/gate-fixtures-exclude.txt` lists suites the CI runner skips because
# it lacks a tool they need (trivy, say); each runs from the workflow that
# installs the tool, and check-gate-fixtures-wired.sh requires that it does.
# `--all` runs them anyway — ci-local.sh passes it, and a suite whose tool is
# absent declines on its own.
#
# ## Seams
#
#   GATE_FIXTURES_ROOT   tree to run from (default: this repo)
#
# Exit codes: 0 every suite passed · 1 one or more failed · 2 nothing to run
# (no suites found — a green over zero suites is the vacuity this repo's gates
# refuse), or the tree is missing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${GATE_FIXTURES_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FIXTURE_DIR="$ROOT/scripts/__tests__"
EXCLUDE_FILE="$ROOT/scripts/gate-fixtures-exclude.txt"

ALL=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    *) echo "usage: $0 [--all]" >&2; exit 2 ;;
  esac
done

die() { echo "::error::[run-gate-fixtures] $1" >&2; exit 2; }

[ -d "$FIXTURE_DIR" ] || die "missing $FIXTURE_DIR — nothing to run."

EXCLUDED=()
if [ -f "$EXCLUDE_FILE" ]; then
  while IFS= read -r line; do
    entry="$(printf '%s' "$line" | sed 's/#.*//' | tr -d '[:space:]')"
    [ -n "$entry" ] && EXCLUDED+=("$entry")
  done <"$EXCLUDE_FILE"
fi

in_list() { local needle="$1" item; shift; for item in "$@"; do [ "$item" = "$needle" ] && return 0; done; return 1; }

shopt -s nullglob
SUITES=("$FIXTURE_DIR"/*.test.sh)
shopt -u nullglob
[ "${#SUITES[@]}" -gt 0 ] || die "no *.test.sh under $FIXTURE_DIR — this run verified NOTHING."

RAN=0; SKIPPED=0
FAILED=()
for suite in "${SUITES[@]}"; do
  name="$(basename "$suite")"
  if [ "$ALL" -eq 0 ] && in_list "$name" ${EXCLUDED[@]+"${EXCLUDED[@]}"}; then
    echo "  skip $name (listed in scripts/gate-fixtures-exclude.txt; runs from its own workflow)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  echo "::group::$name"
  start="$(date +%s)"
  if (cd "$ROOT" && bash "$suite"); then
    echo "::endgroup::"
    echo "  ok   $name ($(( $(date +%s) - start ))s)"
  else
    rc=$?
    echo "::endgroup::"
    echo "  FAIL $name (exit $rc, $(( $(date +%s) - start ))s)" >&2
    FAILED+=("$name")
  fi
  RAN=$((RAN + 1))
done

echo ""
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAIL: ${#FAILED[@]} of $RAN fixture suite(s) failed:" >&2
  for f in "${FAILED[@]}"; do echo "  - scripts/__tests__/$f" >&2; done
  exit 1
fi
[ "$RAN" -gt 0 ] || die "every suite was excluded — this run verified NOTHING."
echo "run-gate-fixtures.sh: $RAN fixture suite(s) passed, $SKIPPED skipped."
