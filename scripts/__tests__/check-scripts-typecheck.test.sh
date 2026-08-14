#!/usr/bin/env bash
# Adversarial fixture suite for the scripts/ type + lint gate (#5173).
#
# The gate is not a script — it is three edits that put scripts/ inside gates
# that already block merges: `type:scripts` inside `bun run type`, and
# `scripts/` appended to the `lint` and `lint:type-aware` path lists. That
# shape is cheap and correct, and it is also invisible: nothing about it
# announces itself if a future edit takes it back out. Three ways it can
# silently stop working, all of them one character of diff:
#
#   1. `tsconfig.scripts.json`'s `include` narrows (say back to
#      `scripts/check-*.ts`) and the un-included files go unchecked again.
#   2. `strict` weakens, so the program still runs and still passes while
#      catching nothing. #5169's defect — `Map.has()` does not narrow
#      `Map.get()` — is only an error under `strictNullChecks`.
#   3. `scripts/` is dropped from a lint path list, or `type:scripts` from
#      `bun run type`, and every finding disappears at once.
#
# Case 2 is the one this file exists for and the one that cannot be checked
# by reading: it is asserted by REINTRODUCING #5169's exact defect into a real
# `scripts/` file and requiring the gate to go red on it. A gate believed to
# catch a defect and a gate measured catching it are different claims.
#
# The probes write a file into scripts/ and trap-remove it. That is why this
# suite belongs in ci-local.sh's Stage 2 (serial, tree-writing) alongside the
# other fixture suites that rewrite tracked source — a probe on disk while a
# Stage 1 gate is scanning would go red on a line nobody wrote. In remote CI
# the `drift` job runs on its own runner, so there is no overlap at all.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TSCONFIG="$REPO_ROOT/tsconfig.scripts.json"
if [ ! -f "$TSCONFIG" ]; then
  echo "::error::tsconfig.scripts.json not found at $TSCONFIG" >&2
  exit 2
fi

TSGO="$REPO_ROOT/node_modules/.bin/tsgo"
OXLINT="$REPO_ROOT/node_modules/.bin/oxlint"
for bin in "$TSGO" "$OXLINT"; do
  if [ ! -x "$bin" ]; then
    echo "::error::$bin not found or not executable — run bun install first" >&2
    exit 2
  fi
done

# A fixed name, not mktemp: the probe must live INSIDE scripts/ to be claimed
# by the real `include` glob, and a predictable name is one a human can grep
# for and delete if a run is killed between write and trap.
PROBE="$REPO_ROOT/scripts/zz-typecheck-probe.fixture.ts"
cleanup() { rm -f "$PROBE"; }
trap cleanup EXIT

# Refuse to start if the probe already exists — an earlier interrupted run's
# leftover would be silently overwritten and then deleted, and the developer
# would never learn a stray file had been sitting in a gated directory.
if [ -e "$PROBE" ]; then
  echo "::error::$PROBE already exists — a previous run left it behind. Inspect and delete it, then re-run." >&2
  exit 2
fi

PASS=0
FAIL=0

pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

# probe_case EXPECTED NAME EXPECTED_CODE BODY — write BODY into the probe
# file, run the real type gate, and assert pass/fail. For fail-cases,
# EXPECTED_CODE must appear in the output, so a case cannot drift into
# tripping a DIFFERENT error (or a harness fault) while staying green — a
# bare non-zero exit is not attributable.
probe_case() {
  local expected="$1" name="$2" code="$3" body="$4"
  local status=0 out
  printf '%s' "$body" > "$PROBE"
  out="$("$TSGO" --noEmit -p "$TSCONFIG" 2>&1)" || status=$?
  rm -f "$PROBE"
  if [ "$expected" = pass ] && [ "$status" -eq 0 ]; then
    pass "$name (expected pass)"
  elif [ "$expected" = fail ] && [ "$status" -ne 0 ] && grep -qF "$code" <<<"$out"; then
    pass "$name (expected fail: $code)"
  else
    fail "$name — expected $expected${code:+ ($code)}, got status=$status, output:"
    sed 's/^/    /' <<<"$out" >&2
  fi
}

echo "check-scripts-typecheck.test.sh — scripts/ type + lint gate (#5173)"

# --- the real tree ------------------------------------------------------------

# Sanity: scripts/ type-checks clean today. If this fails, everything below is
# reporting on a tree that is already broken.
status=0
out="$("$TSGO" --noEmit -p "$TSCONFIG" 2>&1)" || status=$?
if [ "$status" -eq 0 ]; then
  pass "real scripts/ tree type-checks clean"
else
  fail "real scripts/ tree does not type-check — status=$status, output:"
  sed 's/^/    /' <<<"$out" >&2
fi

# --- the harness can be green -------------------------------------------------

# A probe that SHOULD compile must compile. Without this, every expected-fail
# case below would still pass on a gate that rejects literally everything.
probe_case pass "a clean probe compiles (harness is not always-red)" "" \
'const m = new Map<string, { n: number }>();
export function go(k: string): number {
  const real = m.get(k);
  return real === undefined ? 0 : real.n;
}
'

# --- #5169, reintroduced ------------------------------------------------------

# THE acceptance criterion. `Map.has()` does not narrow `Map.get()`, so `real`
# is `{ n: number } | undefined` and `.n` is an error under strictNullChecks.
# This is the exact shape that landed in check-docs-brain-snippets.ts with 9
# instances and was invisible until a reviewer ran tsc by hand.
probe_case fail "#5169: Map.has() does not narrow Map.get() — undefined arm" "TS18048" \
'const m = new Map<string, { n: number }>();
export function go(k: string): number {
  if (!m.has(k)) return 0;
  const real = m.get(k);
  return real.n;
}
'

# Same defect where the map value is itself nullable: a different diagnostic
# code (TS18049 covers "null or undefined"), the same missing narrowing. Both
# arms are asserted because a config change that re-admitted one could leave
# the other tripping and look half-green.
probe_case fail "#5169: nullable map value read via has()+get() — null arm" "TS18049" \
'const m = new Map<string, { n: number } | null>();
export function go(k: string): number {
  if (!m.has(k)) return 0;
  const real = m.get(k);
  return real.n;
}
'

# `strict` is more than strictNullChecks. An implicit `any` parameter must also
# be rejected, or "no explicit any" is enforced in scripts/ while an IMPLICIT
# one walks straight through.
probe_case fail "strict rejects an implicit any parameter" "TS7006" \
'export function go(x) {
  return String(x);
}
'

# --- non-vacuity: the glob covers what it claims -------------------------------

# The failure this catches is the one that looks like success: narrowing
# `include` makes the gate green by checking less. Compare the program''s file
# list against what is actually on disk, so shrinking the glob fails the suite
# instead of quietly shrinking the gate.
missing=""
program_files="$("$TSGO" --noEmit --listFiles -p "$TSCONFIG" 2>/dev/null || true)"
for f in "$REPO_ROOT"/scripts/*.ts; do
  [ -e "$f" ] || continue
  grep -qxF "$f" <<<"$program_files" || missing="$missing $f"
done
if [ -z "$missing" ]; then
  pass "every scripts/*.ts on disk is in the type program"
else
  fail "these scripts/*.ts files are NOT in the type program (include glob narrowed?):$missing"
fi

# --- non-vacuity: lint still names scripts/ ------------------------------------

# `type:scripts` and the two lint path lists are the whole gate. A grep is a
# weak instrument in general, but here the thing being asserted IS a literal
# path in a command string, so there is nothing stronger to reach for.
for key in '"lint"' '"lint:type-aware"'; do
  line="$(grep -F "    $key: \"oxlint" package.json || true)"
  if [ -n "$line" ] && grep -qF " scripts/" <<<"$line"; then
    pass "package.json $key lints scripts/"
  else
    fail "package.json $key no longer lints scripts/ — line: ${line:-<not found>}"
  fi
done

line="$(grep -F '"type":' package.json || true)"
if grep -qF "bun run type:scripts" <<<"$line"; then
  pass "package.json type runs type:scripts"
else
  fail "package.json type no longer runs type:scripts — line: ${line:-<not found>}"
fi

# --- non-vacuity: type-aware lint actually ROUTES scripts/ ---------------------

# Naming a directory in the path list is not the same as tsgolint being able to
# build a program for it. If routing fails, oxlint reports nothing for those
# files and exits 0 — a green that means "not checked". Probe it with a
# `no-floating-promises` violation, which .oxlintrc.json rates "error".
printf '%s' 'async function thing(): Promise<void> {}
export function go(): void {
  thing();
}
' > "$PROBE"
status=0
out="$("$OXLINT" --type-aware --config "$REPO_ROOT/.oxlintrc.json" scripts/ 2>&1)" || status=$?
rm -f "$PROBE"
if [ "$status" -ne 0 ] && grep -qF "no-floating-promises" <<<"$out"; then
  pass "type-aware lint routes scripts/ into a program (probe caught)"
else
  fail "type-aware lint did not flag a floating promise in scripts/ — status=$status, output:"
  sed 's/^/    /' <<<"$out" >&2
fi

echo ""
echo "check-scripts-typecheck.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
