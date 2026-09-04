#!/usr/bin/env bash
# Adversarial fixtures for scripts/check-test-file-references.sh.
#
# ⚠️ "There is a test" is not the bar — *this mutant turns it red* is
# (docs/agents/practices.md). Every mutation below was APPLIED to the gate and
# OBSERVED, then reverted, on 2026-09-04:
#
#   mutation                                        →  observed
#   ──────────────────────────────────────────────     ──────────────────────────
#   the PROVENANCE_RE check is dropped                 case 3 FAIL — a correct
#                                                        "formerly X" note reported
#                                                        as rot, which is the shape
#                                                        that makes a gate get
#                                                        routed around
#   the context window shrinks to the matched line     case 4 FAIL — exit 1 on a
#     only                                               provenance marker that
#                                                        wrapped onto the line above
#   the ±3 window becomes backward-only                case 5 FAIL — exit 1 on a
#                                                        marker sitting BELOW the
#                                                        name (the real shape in
#                                                        alias-proposal.mutations.ts)
#   the comment-line filter is dropped                 case 6 FAIL — a real import
#                                                        of a real file reported,
#                                                        because the name resolves
#                                                        through a path the gate
#                                                        does not model
#   the glob guard is dropped from the extractor       case 7 FAIL — `*-pg.test.ts`
#                                                        in prose read as a filename
#   the `$`/`{` guard is dropped                       case 8 FAIL — `$1.test.ts`
#                                                        in a shell script read as
#                                                        a filename
#
# Cases 1 and 2 are the load-bearing pair: 1 pins that the REAL repo is clean, 2
# pins that planting one dangling name turns it red. Without 2, every "pass" in
# this file is compatible with a gate that reports nothing at all.
#
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-test-file-references.sh"

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

# The gate reads the tracked file set through git and resolves the gate script
# by its own path, so each case is a throwaway git tree with the gate copied in.
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/scripts" "$TREE/src/__tests__"
  cp "$GATE" "$TREE/scripts/check-test-file-references.sh"
  echo 'test("real", () => {});' > "$TREE/src/__tests__/real.test.ts"
  ( cd "$TREE" && git init -q . && git add -A ) >/dev/null 2>&1
}

run_gate() { ( cd "$TREE" && bash scripts/check-test-file-references.sh 2>&1 ); }

# ── case 1 — the real repo is clean ────────────────────────────────────────
out="$(cd "$REPO_ROOT" && bash "$GATE" 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then pass "1  the real repo has no dangling test-file references"
else fail "1  the real repo should be clean, got exit $rc"; printf '%s\n' "$out" | head -5; fi

# ── case 2 — a dangling name is caught (the positive control for all of it) ─
new_tree
echo '// Coverage lives in gone-suite.test.ts' >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "gone-suite.test.ts"; then
  pass "2  a comment naming a nonexistent suite is reported"
else fail "2  expected exit 1 naming gone-suite.test.ts, got exit $rc"; fi

# ── case 3 — a provenance note is NOT rot ──────────────────────────────────
new_tree
echo '// Formerly gone-suite.test.ts — merged here.' >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "3  'formerly X' is exempt"
else fail "3  provenance note wrongly reported, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 4 — the marker wraps onto the line ABOVE the name ─────────────────
new_tree
{ echo '/**'; echo ' * These cases were moved'; echo ' * here from gone-suite.test.ts, same harness.'; echo ' */'; } \
  >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "4  a marker on a preceding line is seen (comments wrap)"
else fail "4  wrapped provenance wrongly reported, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 5 — the marker sits BELOW the name ────────────────────────────────
# This is the real shape in packages/api/scripts/mutations/alias-proposal.mutations.ts:
# the name, then "which this / slice does not add" on the next line.
new_tree
{ echo '/**'; echo ' * Falsifying it needs a gone-suite.test.ts on the sibling'; echo " * pattern, which this slice does not add."; echo ' */'; } \
  >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "5  a 'does not add' marker BELOW the name is seen"
else fail "5  forward context not honoured, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 6 — a real import of a real file is not prose ──────────────────────
new_tree
echo 'import { x } from "./real.test.ts";' >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "6  a name that DOES exist is never reported"
else fail "6  existing file wrongly reported, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 7 — a glob in prose is not a filename ─────────────────────────────
new_tree
echo '// Every *-pg.test.ts self-skips without TEST_DATABASE_URL.' >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "7  a '*-pg.test.ts' glob is not read as a filename"
else fail "7  glob wrongly reported, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 8 — a shell variable is not a filename ────────────────────────────
new_tree
printf '#!/bin/bash\n# check surfaces/$1.test.ts exists\nif [ -f "$D/$1.test.ts" ]; then :; fi\n' > "$TREE/scripts/run.sh"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "8  '\$1.test.ts' is not read as a filename"
else fail "8  shell variable wrongly reported, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 9 — an illustrative placeholder is exempt ─────────────────────────
new_tree
echo '// Run a single file: bun test path/to/one.test.ts' >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -eq 0 ]; then pass "9  'one.test.ts' in an example invocation is exempt"
else fail "9  placeholder wrongly reported, exit $rc"; printf '%s\n' "$out" | head -3; fi

# ── case 10 — the placeholder list does NOT swallow a specific name ────────
# The exemption in case 9 must stay generic-only, or it becomes a way to hide
# real rot behind a plausible-looking filename.
new_tree
echo '// Covered by admin-connections-resource-limit.test.ts' >> "$TREE/src/__tests__/real.test.ts"
( cd "$TREE" && git add -A ) >/dev/null 2>&1
out="$(run_gate)"; rc=$?
if [ $rc -ne 0 ]; then pass "10 a SPECIFIC dangling name is still reported"
else fail "10 specific name wrongly exempted, exit $rc"; fi

echo ""
echo "check-test-file-references fixtures: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
