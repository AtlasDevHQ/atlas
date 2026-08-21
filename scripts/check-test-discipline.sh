#!/bin/bash
# Verify that test files are self-contained — no OS-level state mutation
# at module top level.
#
# ⚠️ THIS GATE GOT MORE LOAD-BEARING, NOT LESS, WHEN #2802 LANDED. It was
# written as groundwork for replacing the custom subprocess-per-file runners
# (`packages/*/scripts/test-isolated.ts`) with native `bun test --parallel`.
# That cutover has now happened and the runners are deleted, so the hazard
# below is live rather than anticipated.
#
# Bun's `--parallel` runner reuses worker PROCESSES across multiple test
# files. JS-global state is reset between files via `--isolate` (which
# `--parallel` implies), but OS-level state — env, cwd, file handles, signal
# handlers, listeners — is NOT: it persists for the worker's lifetime. The
# deleted runners were silently providing process isolation by spawning a
# fresh subprocess per file, so every implicit coupling they were hiding is
# now a real failure mode.
#
# The allowlist is therefore DEBT, not a settled exemption. The 9 remaining
# `env` entries were harmless under a subprocess-per-file runner and are not
# harmless now — they simply happen not to collide with whatever file bun
# schedules next in the same worker. The full suite passes today (22,070
# tests, 0 fail), so nothing is broken; but an entry here is a file that can
# break a SIBLING when the scheduling changes, which is the hardest kind of
# failure to attribute. Clear them rather than growing them.
#
# Two rules, each independently allowlisted in
# `scripts/test-discipline-allowlist.txt` so slices 1/2 can land in any
# order and each clears its own category by deleting its lines:
#
#   env   — top-level `process.env.X = ...` assignment. Fix: wrap in
#           `beforeAll` + save/restore in `afterAll`. Exception: when a
#           top-level import itself reads env, use a hoisted
#           `process.env.X ??= ...` block with an explanatory comment.
#   chdir — top-level `process.chdir(...)`. Fix: move into `beforeAll`.
#
# A third `mock` rule existed through slices 0–5a, gating any
# `mock.module()` call lacking a paired `mock.restore` / `afterAll`.
# The empirical experiment in #2801 (slice 5a — fixtures in
# `packages/api/src/__tests__/_bun-isolation-experiment/`) proved bun's
# `--isolate` (and `--parallel`, which implies it) DOES reset module
# mocks between files in the same worker, so the 279 mock-rule entries
# were noise. Slice 5b dropped both the rule and the entries.
#
# Why a single allowlist file (not two): one file = one place to grep
# when wondering "is this expected?" The `<rule>\t<path>` format lets
# `grep -v "^<rule>"` clear a rule wholesale without touching the other.

set -euo pipefail

ALLOWLIST="scripts/test-discipline-allowlist.txt"

if [ ! -f "$ALLOWLIST" ]; then
  echo "::error::allowlist not found at $ALLOWLIST" >&2
  exit 2
fi

# Build the candidate file list once (fast path), then run the two
# rule greps. `--exclude-dir` covers vendored deps and build artifacts.
TEST_FILES=$(grep -rln '' --include='*.test.ts' --include='*.test.tsx' \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=.next \
  --exclude-dir=.turbo \
  --exclude-dir=coverage \
  . 2>/dev/null | sed 's|^\./||' | sort -u)

# Sanity check — if we found zero test files the script is running in
# the wrong place (or the repo lost its tests). Either way, silently
# passing would defeat the point of the gate (post-#2813 fix).
if [ -z "$TEST_FILES" ]; then
  echo "::error::No *.test.ts/*.test.tsx files found — running from $(pwd). Wrong cwd?" >&2
  exit 2
fi

# Strip comments + the allowlist into a normalized lookup. The lookup
# is a sorted list of `<rule>\t<path>` lines; both `comm -23` (rule
# diff) and plain grep work against it. Let `set -e` propagate any
# real read failure (corrupt allowlist, permission errors, etc.) —
# silently empty would mask offenders.
ALLOWED=$(grep -vE '^\s*#|^\s*$' "$ALLOWLIST" | sort -u)

# ---- Rule: env ----
# Matches `process.env.X = ...` at the very start of a line (no
# indentation). Indented assignments inside a function body are fine.
ENV_OFFENDERS=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if grep -qE '^process\.env\.[A-Z_][A-Z0-9_]* ?=' "$f"; then
    ENV_OFFENDERS="${ENV_OFFENDERS}env	${f}"$'\n'
  fi
done <<<"$TEST_FILES"

# ---- Rule: chdir ----
CHDIR_OFFENDERS=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if grep -qE '^process\.chdir\(' "$f"; then
    CHDIR_OFFENDERS="${CHDIR_OFFENDERS}chdir	${f}"$'\n'
  fi
done <<<"$TEST_FILES"

ALL_OFFENDERS=$(printf "%s%s" "$ENV_OFFENDERS" "$CHDIR_OFFENDERS" | sed '/^$/d' | sort -u || true)

# Diff offenders against allowlist. `comm -23 a b` = lines in a but not in b.
UNEXPECTED=$(comm -23 <(printf "%s\n" "$ALL_OFFENDERS" | sed '/^$/d') <(printf "%s\n" "$ALLOWED" | sed '/^$/d') || true)
# Also surface stale allowlist entries — slices remove offenders but
# may forget to delete the corresponding allowlist line, leaving dead
# bookkeeping. Better to fail-loud than rot.
STALE=$(comm -13 <(printf "%s\n" "$ALL_OFFENDERS" | sed '/^$/d') <(printf "%s\n" "$ALLOWED" | sed '/^$/d') || true)

EXIT=0

if [ -n "$UNEXPECTED" ]; then
  EXIT=1
  echo "::error::Test discipline violation — files mutate OS-level state at module top level."
  echo ""
  echo "These mutations leak across files in the same bun worker once we cut over"
  echo "to native \`bun test --parallel\` (1.5.4 slice 6 / #2802). Fix each one or,"
  echo "if intentional (e.g. an import-time env read), add it to $ALLOWLIST"
  echo "with a justifying comment."
  echo ""
  echo "Offenders:"
  echo "$UNEXPECTED" | sed 's/^/  /'
  echo ""
  echo "Fix patterns:"
  echo "  env   — wrap in \`beforeAll\` + save/restore in \`afterAll\` (see #2797)."
  echo "  chdir — move into \`beforeAll\` (see #2798)."
fi

if [ -n "$STALE" ]; then
  EXIT=1
  echo "::error::$ALLOWLIST has stale entries — files no longer match the rule."
  echo ""
  echo "Each slice (#2797/#2798) must delete its allowlist lines as the offenders"
  echo "are fixed. A stale line here means the gate is no longer guarding what it"
  echo "thinks it is."
  echo ""
  echo "Remove these lines from $ALLOWLIST:"
  echo "$STALE" | sed 's/^/  /'
fi

if [ "$EXIT" -eq 0 ]; then
  ENV_COUNT=$(printf "%s" "$ENV_OFFENDERS" | grep -c '^env	' || true)
  CHDIR_COUNT=$(printf "%s" "$CHDIR_OFFENDERS" | grep -c '^chdir	' || true)
  FILE_COUNT=$(printf "%s\n" "$TEST_FILES" | sed '/^$/d' | wc -l | tr -d ' ')
  echo "Test discipline check passed — scanned $FILE_COUNT test files; env: $ENV_COUNT allowlisted offender(s), chdir: $CHDIR_COUNT allowlisted offender(s)."
fi

exit "$EXIT"
