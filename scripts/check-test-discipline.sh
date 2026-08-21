#!/bin/bash
# Verify that test files are self-contained — no OS-level state mutation
# at module top level.
#
# ⚠️ WHAT THIS GATE PROTECTS IS THE NON-`--parallel` MODES. Measured — do not
# re-derive it from first principles. An earlier version of this header
# asserted the opposite, confidently and at length, and was wrong.
#
# The claim it used to make: bun reuses worker PROCESSES, so OS-level state
# (env, cwd, file handles, signal handlers, listeners) persists across files in
# a worker, and every allowlist entry is a file that can break a SIBLING.
#
# That is false under `bun test --parallel` on bun 1.4.0. 32 probe files x 3
# reps, `taskset -c 0`, up to 17 files packed into ONE worker pid:
#
#   env leaks: 0   ATLAS_ leaks: 0   cwd leaks: 0
#   exitListeners: [1,1,1,1,1,1]   fds: [26,26,26,26,26,26]   globalThis: none
#
# `cwd` is the load-bearing control — one per process via syscall, so no module
# registry reset explains it away — and a sibling in the same pid still does not
# observe it. Positive control: the writes DO land (`probe1` reads back its own
# `env=probe1`, `cwd=/tmp`; `probe2`, same pid, sees a clean slate).
#
# But that isolation is a property of `--isolate`, NOT of bun. Same probe, same
# files, three invocation modes:
#
#   --parallel      files=4  pids=3  envLeaks=0  seq=[None, None, None, None]
#   (bare)          files=4  pids=1  envLeaks=3  seq=[None, probe1, probe2, probe3]
#   --no-isolate    files=4  pids=1  envLeaks=3  seq=[None, probe1, probe2, probe3]
#
# So a top-level `process.env` write leaks exactly as the old header feared —
# under bare `bun test` and `--no-isolate`, both of which CLAUDE.md forbids for
# multi-file runs. This gate is what keeps that prohibition from being the only
# thing between us and a silent cross-file coupling: it holds the tree in a
# shape where the forbidden modes are merely slower, not wrong.
#
# The consequence for the allowlist: the 9 `env` entries are NOT the live hazard
# the old header described, and they are not clearable by the fix it prescribed
# either — every one is a file whose top-level IMPORT reads env at module-load
# time, so `beforeAll` runs too late by construction. They are a settled
# exemption with a real reason, not debt to burn down. #5368 carries the full
# measurement and the open question of whether these rules should survive.
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
