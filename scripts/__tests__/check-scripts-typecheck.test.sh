#!/usr/bin/env bash
# Adversarial fixture suite for the scripts/ type + lint gate (#5173).
#
# The gate is not a script — it is three lines of wiring in package.json:
# `type:scripts` called from `bun run type`, and `scripts/` appended to the
# `lint` and `lint:type-aware` path lists. That shape is cheap and correct, and
# it is also invisible: nothing about it announces itself if a later edit takes
# it back out. Ways it can silently stop working, all one character of diff:
#
#   1. `tsconfig.scripts.json`'s `include` narrows, or a file lands somewhere
#      the glob does not reach, and those files go unchecked again.
#   2. `strict` (or just `strictNullChecks`) weakens, so the program still runs
#      and still passes while catching nothing. #5169's defect — `Map.has()`
#      does not narrow `Map.get()` — is only an error under strictNullChecks.
#   3. A path list drops `scripts/`, or `type:scripts` stops pointing at this
#      config, and every finding disappears at once.
#
# Case 2 is the one that cannot be checked by reading, and it is asserted by
# REINTRODUCING #5169's exact defect into a real `scripts/` file and requiring
# the gate to go red on it.
#
# ⚠️ Every probe runs the SHIPPED command — `bun run type:scripts`, not a
# hand-rolled `tsgo -p …`. Re-implementing the gate is the failure this file
# exists to catch, one level up: with a direct tsgo call, rewriting
# `type:scripts` to `echo skipped` left all ten cases green. Measured.
#
# ⚠️ Fail-cases require the PROBE'S OWN PATH in the diagnostic, not just the
# error code. This program spans ~2000 files, so a pre-existing TS18048
# anywhere in it would otherwise satisfy a fail-case that compiled nothing.
#
# The probes write a file into scripts/ and trap-remove it. That is why this
# suite belongs in ci-local.sh's Stage 2 (serial, tree-writing) alongside the
# other fixture suites that rewrite tracked source — a probe on disk while a
# Stage 1 gate is scanning makes it go red on a line nobody wrote, and
# `oxlint --type-aware` has been observed panicking outright on exactly that
# collision. In remote CI the `drift` job runs on its own runner.

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

# Fixed names, not mktemp: a probe must live INSIDE scripts/ to be claimed by
# the real glob and the real lint path list, and a predictable name is one a
# human can grep for and delete if a run is killed between write and cleanup.
#
# ⚠️ TWO names, because gitignoring the lint probe would SILENTLY DISABLE it.
# The type probe is gitignored — tsgo does not consult `.gitignore`, so it is
# still type-checked, and a leftover (whose last-written body is deliberately
# broken) can never be staged by an errant `git add -A`. oxlint DOES honour
# `.gitignore`: measured, a gitignored probe produced zero findings and exit 0
# from both lint probes — a green that means "not scanned", which is the exact
# failure those probes exist to detect. So the lint probe must stay visible to
# git, and its leftover risk is carried by the guards below instead.
PROBE_TYPE="$REPO_ROOT/scripts/zz-typecheck-probe.fixture.ts"
PROBE_LINT="$REPO_ROOT/scripts/zz-lint-probe.ts"
PROBE_TYPE_BASE="$(basename "$PROBE_TYPE")"
PROBE_LINT_BASE="$(basename "$PROBE_LINT")"

# ⚠️ The pre-existence guard runs BEFORE the trap is installed, and the order is
# the whole point. With the trap first, this `exit 2` fires it and deletes the
# leftover the message tells you to inspect — so the evidence is destroyed and
# the re-run is silently green. The sibling suite
# `check-docs-brain-snippets.test.sh` carries the same ordering for the same
# measured reason.
for existing in "$PROBE_TYPE" "$PROBE_LINT"; do
  if [ -e "$existing" ]; then
    echo "::error::$existing already exists — a previous run left it behind. Inspect and delete it, then re-run." >&2
    exit 2
  fi
done

# A cleanup that fails must SAY so. Bash discards a non-zero return from an
# EXIT trap, so `trap cleanup EXIT` alone would leave a probe in a gated
# directory and still exit green; `|| exit 2` is what makes the check mean
# anything. INT/TERM are trapped separately because EXIT's behaviour on a
# signal is bash-version-dependent, and a cancelled CI run must not leave the
# tree dirty.
cleanup() {
  local rc=0 p
  rm -f "$PROBE_TYPE" "$PROBE_LINT"
  for p in "$PROBE_TYPE" "$PROBE_LINT"; do
    if [ -e "$p" ]; then
      echo "::error::failed to remove $p — a probe is still in scripts/. Delete it before re-running." >&2
      rc=1
    fi
  done
  return "$rc"
}
trap 'cleanup || exit 2' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

PASS=0
FAIL=0

pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

# Run the gate exactly as CI runs it. `--silent` keeps bun's own `$ …` echo out
# of the output the assertions grep.
run_gate() { bun run --silent type:scripts 2>&1; }

# probe_case EXPECTED NAME EXPECTED_CODE BODY — write BODY into the probe file,
# run the real gate, assert pass/fail. Fail-cases must name the probe file AND
# the expected code ON THE SAME LINE, so a case cannot drift into tripping a
# different error, a different file, or a harness fault while staying green.
probe_case() {
  local expected="$1" name="$2" code="$3" body="$4"
  local status=0 out
  printf '%s' "$body" > "$PROBE_TYPE"
  out="$(run_gate)" || status=$?
  rm -f "$PROBE_TYPE"
  if [ "$expected" = pass ] && [ "$status" -eq 0 ]; then
    pass "$name (expected pass)"
  elif [ "$expected" = fail ] && [ "$status" -ne 0 ] &&
    grep -qE "${PROBE_TYPE_BASE//./\\.}\(.*$code" <<<"$out"; then
    pass "$name (expected fail: $code in $PROBE_TYPE_BASE)"
  else
    fail "$name — expected $expected${code:+ ($code in $PROBE_TYPE_BASE)}, got status=$status, output:"
    sed 's/^/    /' <<<"$out" >&2
  fi
}

echo "check-scripts-typecheck.test.sh — scripts/ type + lint gate (#5173)"

# --- the real tree ------------------------------------------------------------

# Sanity, and it is FATAL rather than a countable failure: every case below
# assumes a clean baseline, so continuing past a dirty one reports on a tree
# that invalidates the whole run.
status=0
out="$(run_gate)" || status=$?
if [ "$status" -ne 0 ]; then
  if grep -qF "TS2307" <<<"$out" && grep -qF "@useatlas/" <<<"$out"; then
    echo "::error::the scripts/ type program cannot resolve @useatlas/* — those resolve through each package's built dist/, produced by bun install's prepare scripts. Run 'bun install' and re-run." >&2
  else
    echo "::error::the real scripts/ tree does not type-check; fix that before this suite can measure anything:" >&2
    sed 's/^/    /' <<<"$out" >&2
  fi
  exit 2
fi
pass "real scripts/ tree type-checks clean"

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
# arms are asserted because a config change that re-admitted one could leave the
# other tripping and look half-green.
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
# `include` makes the gate green by checking less. Compare the program's file
# list against what is actually on disk, so shrinking the glob fails the suite
# instead of quietly shrinking the gate.
#
# `--listFiles` needs the config directly; it is not a flag `type:scripts`
# passes. A tsgo fault here must NOT be reported as a narrowed glob — an empty
# file list would otherwise produce a confident, wrong diagnosis with the real
# error discarded.
lf_status=0
program_files="$("$TSGO" --noEmit --listFiles -p "$TSCONFIG" 2>&1)" || lf_status=$?
if ! grep -qF "$REPO_ROOT/scripts/" <<<"$program_files"; then
  fail "tsgo --listFiles produced no scripts/ entries (status=$lf_status) — harness fault, not a narrowed glob:"
  sed 's/^/    /' <<<"$program_files" >&2
else
  missing=""
  for f in "$REPO_ROOT"/scripts/*.ts "$REPO_ROOT"/scripts/*.tsx; do
    [ -e "$f" ] || continue
    grep -qxF "$f" <<<"$program_files" || missing="$missing $f"
  done
  if [ -z "$missing" ]; then
    pass "every top-level scripts/*.ts and *.tsx is in the type program"
  else
    fail "these scripts/ files are NOT in the type program (include glob narrowed?):$missing"
  fi
fi

# The glob is one level deep, so a file in a subdirectory is invisible to both
# the program AND to the comparison above — under-coverage that looks identical
# to full coverage. `ee-stub` is type-checked by the Symlink Stub Build job and
# `__tests__` holds only .sh, so anything else appearing there is unchecked.
stray="$(find "$REPO_ROOT/scripts" -mindepth 2 -name '*.ts' -not -path '*/ee-stub/*' 2>/dev/null || true)"
if [ -z "$stray" ]; then
  pass "no scripts/ subdirectory .ts file sits outside the type program"
else
  fail "scripts/ subdirectory .ts files are outside the one-level include glob:$stray"
fi

# --- non-vacuity: the package.json wiring --------------------------------------

# Read the VALUES, not the file. A grep over package.json is satisfied by any
# line that happens to contain the string — including a sibling script — and it
# is hostage to indentation. Word-anchored so narrowing `scripts/` to
# `scripts/__tests__/` (a directory with no .ts source) fails instead of
# prefix-matching its way to green. Measured: with a substring grep, that
# narrowing left all ten cases passing.
read_script() {
  SCRIPT_KEY="$1" bun -e 'const p = JSON.parse(await Bun.file("package.json").text()); console.log(p.scripts?.[Bun.env.SCRIPT_KEY] ?? "")'
}

for key in lint lint:type-aware; do
  value="$(read_script "$key")"
  if grep -qE '(^| )scripts/( |$|")' <<<"$value"; then
    pass "package.json $key lints scripts/ (exactly, not a subdirectory)"
  else
    fail "package.json $key no longer lints scripts/ — value: ${value:-<missing>}"
  fi
done

value="$(read_script type)"
if grep -qF "bun run type:scripts" <<<"$value"; then
  pass "package.json type runs type:scripts"
else
  fail "package.json type no longer runs type:scripts — value: ${value:-<missing>}"
fi

# --- non-vacuity: lint reaches scripts/ ----------------------------------------

# Two probes, because the two lint gates fail independently. Both assert the
# diagnostic names the probe file: a real violation elsewhere in scripts/ would
# otherwise make either probe permanently green.

# Plain `lint`. A `correctness`-category rule is an error, so this also pins
# that nothing has scoped the category off for scripts/ or added the directory
# to `ignorePatterns`.
printf '%s' 'const dup = { a: 1, a: 2 };
export const out = dup;
' > "$PROBE_LINT"
status=0
out="$("$OXLINT" --config "$REPO_ROOT/.oxlintrc.json" scripts/ 2>&1)" || status=$?
rm -f "$PROBE_LINT"
if [ "$status" -ne 0 ] && grep -qF "$PROBE_LINT_BASE" <<<"$out" &&
  grep -qF "no-dupe-keys" <<<"$out"; then
  pass "lint reaches scripts/ (probe caught)"
else
  fail "oxlint did not flag a correctness violation in scripts/ — status=$status, output:"
  sed 's/^/    /' <<<"$out" >&2
fi

# Type-aware lint. Naming a directory in the path list is not the same as
# tsgolint being able to build a program for it; if routing fails, oxlint
# reports nothing for those files and exits 0 — a green that means "not
# checked". `no-floating-promises` is rated "error" in .oxlintrc.json.
printf '%s' 'async function thing(): Promise<void> {}
export function go(): void {
  thing();
}
' > "$PROBE_LINT"
status=0
out="$("$OXLINT" --type-aware --config "$REPO_ROOT/.oxlintrc.json" scripts/ 2>&1)" || status=$?
rm -f "$PROBE_LINT"
if [ "$status" -ne 0 ] && grep -qF "$PROBE_LINT_BASE" <<<"$out" &&
  grep -qF "no-floating-promises" <<<"$out"; then
  pass "type-aware lint routes scripts/ into a program (probe caught)"
else
  fail "type-aware lint did not flag a floating promise in scripts/ — status=$status, output:"
  sed 's/^/    /' <<<"$out" >&2
fi

echo ""
echo "check-scripts-typecheck.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
