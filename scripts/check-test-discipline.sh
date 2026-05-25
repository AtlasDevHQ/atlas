#!/bin/bash
# Verify that test files are self-contained — no OS-level state mutation
# at module top level. Lays the groundwork for swapping the custom
# subprocess-per-file runner (`packages/*/scripts/test-isolated.ts`) for
# native `bun test --parallel` in 1.5.4 slice 6 (issue #2802).
#
# Bun's `--parallel` runner reuses worker processes across multiple test
# files. JS-global state is reset between files via `--isolate`, but
# OS-level state (env, cwd, file handles, signal handlers, listeners) is
# NOT — that persists across the worker's lifetime. The custom runner
# has been silently doing process isolation; once we cut over to native,
# every implicit coupling becomes a real failure.
#
# Three rules, each independently allowlisted in
# `scripts/test-discipline-allowlist.txt` so slices 1/2/(3-4-5) can land
# in any order and each clears its own category by deleting its lines:
#
#   env   — top-level `process.env.X = ...` assignment. Fix: wrap in
#           `beforeAll` + save/restore in `afterAll`. Exception: when a
#           top-level import itself reads env, use a hoisted
#           `process.env.X ??= ...` block with an explanatory comment.
#   chdir — top-level `process.chdir(...)`. Fix: move into `beforeAll`.
#   mock  — file uses `mock.module(...)` but has neither `mock.restore`
#           nor an `afterAll(` hook. Slice 5 (#2801) will empirically
#           verify what bun's `--isolate` actually resets and either
#           drop this rule or sweep the offenders.
#
# Why a single allowlist file (not three): one file = one place to grep
# when wondering "is this expected?" The `<rule>\t<path>` format lets
# `grep -v "^<rule>"` clear a rule wholesale without touching the others.

set -euo pipefail

ALLOWLIST="scripts/test-discipline-allowlist.txt"

if [ ! -f "$ALLOWLIST" ]; then
  echo "::error::allowlist not found at $ALLOWLIST" >&2
  exit 2
fi

# Build the candidate file list once (fast path), then run the three
# rule greps. `--exclude-dir` covers vendored deps and build artifacts.
TEST_FILES=$(grep -rln '' --include='*.test.ts' \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=.next \
  --exclude-dir=.turbo \
  --exclude-dir=coverage \
  . 2>/dev/null | sed 's|^\./||' | sort -u || true)

# Strip comments + the allowlist into a normalized lookup. The lookup
# is a sorted list of `<rule>\t<path>` lines; both `comm -23` (rule
# diff) and plain grep work against it.
ALLOWED=$(grep -vE '^\s*#|^\s*$' "$ALLOWLIST" | sort -u || true)

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

# ---- Rule: mock ----
# A file is OK if it has no `mock.module(`, OR it has at least one of
# `mock.restore` / `afterAll(`. Heuristic — slice 5 will refine.
MOCK_OFFENDERS=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if grep -qE 'mock\.module\(' "$f" \
    && ! grep -qE 'mock\.restore|afterAll\(' "$f"; then
    MOCK_OFFENDERS="${MOCK_OFFENDERS}mock	${f}"$'\n'
  fi
done <<<"$TEST_FILES"

ALL_OFFENDERS=$(printf "%s%s%s" "$ENV_OFFENDERS" "$CHDIR_OFFENDERS" "$MOCK_OFFENDERS" | sed '/^$/d' | sort -u || true)

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
  echo "  mock  — pair every \`mock.module()\` with \`mock.restore()\` in \`afterAll\`,"
  echo "          or migrate to a test-scoped Effect Layer (see #2799/#2800/#2801)."
fi

if [ -n "$STALE" ]; then
  EXIT=1
  echo "::error::$ALLOWLIST has stale entries — files no longer match the rule."
  echo ""
  echo "Each slice (#2797-#2801) must delete its allowlist lines as the offenders"
  echo "are fixed. A stale line here means the gate is no longer guarding what it"
  echo "thinks it is."
  echo ""
  echo "Remove these lines from $ALLOWLIST:"
  echo "$STALE" | sed 's/^/  /'
fi

if [ "$EXIT" -eq 0 ]; then
  ENV_COUNT=$(printf "%s" "$ENV_OFFENDERS" | grep -c '^env	' || true)
  CHDIR_COUNT=$(printf "%s" "$CHDIR_OFFENDERS" | grep -c '^chdir	' || true)
  MOCK_COUNT=$(printf "%s" "$MOCK_OFFENDERS" | grep -c '^mock	' || true)
  echo "Test discipline check passed — env: $ENV_COUNT allowlisted, chdir: $CHDIR_COUNT allowlisted, mock: $MOCK_COUNT allowlisted."
  echo "Track removal in milestone 1.5.4 (#53)."
fi

exit "$EXIT"
