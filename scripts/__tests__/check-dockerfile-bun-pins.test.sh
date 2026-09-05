#!/usr/bin/env bash
# Adversarial fixtures for scripts/check-dockerfile-bun-pins.sh.
#
# The gate was extracted from two inline copies (ci.yml's drift job and
# ci-local.sh's `g_dockerfile_pins`) that had no fixtures in either place, so
# this is the first time any of its arms is shown to go red. Case 1 pins the real
# repo; every other case builds a throwaway tree under `mktemp -d`, so the suite
# never writes tracked source.
#
# `set -uo pipefail`, no `-e`: a failing case must not abort the tally.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$SCRIPT_DIR/check-dockerfile-bun-pins.sh"

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
# A tree whose ci.yml declares BUN_VERSION 1.4.0 and carries two Dockerfiles,
# both pinned to it. Cases then break one thing each.
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  mkdir -p "$TREE/.github/workflows" "$TREE/deploy/api" "$TREE/deploy/web"
  printf 'name: CI\nenv:\n  BUN_VERSION: "1.4.0"\n' >"$TREE/.github/workflows/ci.yml"
  printf 'FROM oven/bun:1.4.0 AS base\n' >"$TREE/deploy/api/Dockerfile"
  printf 'FROM oven/bun:1.4.0-alpine\n' >"$TREE/deploy/web/Dockerfile"
}

run_gate() { # run_gate [ENV=VALUE ...] -> sets RC and OUT
  RC=0
  OUT=$(env DOCKERFILE_PINS_ROOT="$TREE" "$@" bash "$GATE" 2>&1) || RC=$?
}

echo "check-dockerfile-bun-pins.test.sh — adversarial fixtures"

# 1. THE REAL REPO: every Dockerfile pins the workflow's BUN_VERSION.
rc_real=0
out_real=$(bash "$GATE" 2>&1) || rc_real=$?
if [ "$rc_real" = "0" ] && printf '%s' "$out_real" | grep -qE "all [0-9]+ Dockerfile\(s\) pin bun"; then
  pass "the real repo passes (every Dockerfile pins BUN_VERSION)"
else
  fail "the real repo — expected exit 0, got $rc_real"
  printf '%s\n' "$out_real" | sed 's/^/       | /' >&2
fi

# 2. POSITIVE CONTROL on a synthetic tree, counting what it checked.
new_tree
run_gate
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qF "all 2 Dockerfile(s) pin bun 1.4.0"; then
  pass "a synthetic tree with both pins matching passes and counts 2"
else
  fail "synthetic matching tree — expected exit 0 counting 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 3. THE DEFECT: one Dockerfile pins a different version.
new_tree
printf 'FROM oven/bun:1.3.9 AS base\n' >"$TREE/deploy/api/Dockerfile"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "deploy/api/Dockerfile" \
   && printf '%s' "$OUT" | grep -qF "pins bun '1.3.9', expected 1.4.0"; then
  pass "a stale pin is caught, named, and both versions are printed (exit $RC)"
else
  fail "stale pin — expected exit 1 naming deploy/api/Dockerfile, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 4. `Dockerfile*`, NOT `Dockerfile` — the #2802 shape. A `Dockerfile.sidecar`
# with a stale pin must be found.
new_tree
printf 'FROM oven/bun:1.2.0\n' >"$TREE/deploy/api/Dockerfile.sidecar"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "Dockerfile.sidecar"; then
  pass "a stale Dockerfile.sidecar is caught (the exact-name form missed it, #2802)"
else
  fail "Dockerfile.sidecar — expected exit 1 naming it, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 5. A pin with NO digits at all is reported, not read as a match.
new_tree
printf 'FROM oven/bun: AS base\n' >"$TREE/deploy/api/Dockerfile"
run_gate
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "pins bun '<none>'"; then
  pass "a bare oven/bun: with no version is reported as <none>, not skipped"
else
  fail "digitless pin — expected exit 1 reporting <none>, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 6. EXPECTED_BUN in the environment wins over the workflow's value.
new_tree
run_gate EXPECTED_BUN=9.9.9
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -qF "expected 9.9.9"; then
  pass "EXPECTED_BUN overrides the workflow value"
else
  fail "EXPECTED_BUN override — expected exit 1 against 9.9.9, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 7. node_modules is out of scope.
new_tree
mkdir -p "$TREE/node_modules/somepkg"
printf 'FROM oven/bun:0.1.0\n' >"$TREE/node_modules/somepkg/Dockerfile"
run_gate
if [ "$RC" = "0" ]; then
  pass "a Dockerfile under node_modules is ignored"
else
  fail "node_modules — expected exit 0, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 8-9. VACUITY FLOORS: no expectation to read, and nothing to check against it.
new_tree
rm -f "$TREE/.github/workflows/ci.yml"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "to read it from"; then
  pass "no ci.yml and no EXPECTED_BUN exits 2, not a clean sweep"
else
  fail "missing expectation — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

new_tree
printf 'FROM node:24\n' >"$TREE/deploy/api/Dockerfile"
printf 'FROM node:24\n' >"$TREE/deploy/web/Dockerfile"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "verified NOTHING"; then
  pass "no Dockerfile pinning oven/bun exits 2 rather than passing over zero files"
else
  fail "no bun pins — expected exit 2, got $RC"
  printf '%s\n' "$OUT" | sed 's/^/       | /' >&2
fi

# 10. A missing tree is an environment fault.
TREE="$TMPROOT/does-not-exist"
run_gate
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -qF "cannot verify anything"; then
  pass "a missing tree exits 2"
else
  fail "missing tree — expected exit 2, got $RC"
fi

# ⚠️ AN ABSOLUTE LITERAL, for the reason its siblings carry one.
EXPECTED_CASES=10
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "expected $EXPECTED_CASES cases, $TOTAL ran — a case was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "check-dockerfile-bun-pins.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
