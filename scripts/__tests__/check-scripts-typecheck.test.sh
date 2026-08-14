#!/usr/bin/env bash
# Adversarial fixture suite for the scripts/ type + lint gate (#5173).
#
# The gate is package.json wiring: a `type:scripts` script called from
# `bun run type`, plus `scripts/` in the two lint path lists. That shape is cheap
# and correct, and it is also invisible — nothing about it announces itself if a
# later edit takes it back out. Ways it can silently stop working, all one
# character of diff:
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
# ⚠️ Every probe runs a SHIPPED command — `bun run type:scripts`, `bun run lint`,
# `bun run lint:type-aware`. Re-implementing the gate is the failure this file
# exists to catch, one level up, and an earlier revision that hand-rolled
# `tsgo -p …` and `oxlint --config … scripts/` was measured failing it twice:
# rewriting `type:scripts` to `echo skipped` left every case green, and adding
# `--ignore-pattern 'scripts/**'` to both lint scripts turned linting of
# `scripts/` completely off while the suite still reported no failures. The
# shipped suite fails 3 and 2 cases on those. The one hand-rolled invocation
# that remains is `--listFiles`, which is not a flag `type:scripts` passes —
# hence the separate case pinning `type:scripts` at this same config.
#
# No fail-case rests on "the token appears somewhere in the output". The type
# program spans ~2000 files and the lint scans are repo-wide, so a pre-existing
# diagnostic satisfies that on a run that compiled or linted nothing. The type
# cases use `names_on_one_line` (tsgo's format is stable); the lint cases
# compare against a probe-free baseline, because oxlint's is not — see
# `lint_probe`.
#
# The probes write a file into scripts/ and trap-remove it. That is why this
# suite belongs in ci-local.sh's Stage 2 (serial, tree-writing) alongside the
# other fixture suites that rewrite tracked source — a probe on disk while a
# Stage 1 gate is scanning makes it go red on a line nobody wrote. In remote CI
# the `drift` job runs on its own runner.
#
# Stage-2 serialisation does NOT cover two agents in two worktrees of one
# checkout, which is this repo's normal working mode. While this suite runs, a
# concurrent `bun run type` or `bun run lint` in the same worktree will go red on
# a probe. There is no lock yet; if you are bisecting a mystery red, look for a
# `scripts/zz-*` file first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TSCONFIG="$REPO_ROOT/tsconfig.scripts.json"
if [ ! -f "$TSCONFIG" ]; then
  echo "::error::tsconfig.scripts.json not found at $TSCONFIG" >&2
  exit 2
fi

TSGO="$REPO_ROOT/node_modules/.bin/tsgo"
# OXLINT is a pre-flight existence check only — the lint cases reach oxlint
# through the shipped `bun run lint…` scripts, not through this path.
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
# ⚠️ TWO names, because the two tools disagree about `.gitignore`. oxlint honours
# it — measured, an ignored probe yields zero findings and exit 0, so both lint
# cases would measure nothing (and fail). tsgo does not, so the type probe can be
# ignored and still be type-checked. The type probe is therefore gitignored,
# which keeps a leftover — whose last-written body is deliberately broken — from
# being staged by an errant `git add -A`; the lint probe must stay visible to
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
# `|| true` on the signal traps: `cleanup` is the left operand of `||` in the
# EXIT trap, which suspends `set -e` for its body, but a bare `cleanup;` in a
# signal trap runs with `-e` live — a failing `rm` would kill the shell before
# `exit 130` and the signal-attributable code would be lost.
trap 'cleanup || exit 2' EXIT
trap 'cleanup || true; exit 130' INT
trap 'cleanup || true; exit 143' TERM

PASS=0
FAIL=0

pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

# ─── two helpers the probe cases share ────────────────────────────────────────
#
# Both are helpers rather than inline greps because writing them by hand
# recurred: each was fixed at one site and reintroduced at the next site
# written. A helper is the only form a new site cannot get wrong.

# names_on_one_line FILE TOKEN < output — TOKEN must appear on a line that also
# names FILE. Two independent greps are NOT this: the program spans ~2000 files
# and the lint scan spans the repo, so "the probe appears somewhere" plus "the
# code appears somewhere" is satisfied by two unrelated diagnostics, and the
# case then passes having compiled or linted nothing.
names_on_one_line() {
  local file="$1" token="$2"
  grep -qE "${file//./\\.}[:(][0-9]+.*${token//./\\.}"
}

# capture_status VAR_OUT VAR_STATUS CMD… — run CMD, keep BOTH its output and its
# exit status. Every caller must branch on the status FIRST, before inferring
# anything from the content: an empty or truncated output from a crashed tool
# otherwise reads as a meaningful measurement. `2>/dev/null || true` is the
# shape this replaces, and it produced a confident, wrong diagnosis every time.
capture_status() {
  local -n _out="$1" _st="$2"
  shift 2
  _st=0
  _out="$("$@" 2>&1)" || _st=$?
}

# Run the gate exactly as CI runs it. `--silent` keeps bun's own `$ …` echo out
# of the output the assertions grep.
run_gate() { bun run --silent type:scripts 2>&1; }

# probe_case EXPECTED NAME EXPECTED_CODE BODY — write BODY into the probe file,
# run the real gate, assert pass/fail. Fail-cases go through names_on_one_line,
# so a case cannot drift into tripping a different error, a different file, or a
# harness fault while staying green.
probe_case() {
  local expected="$1" name="$2" code="$3" body="$4"
  local status=0 out
  printf '%s' "$body" > "$PROBE_TYPE"
  out="$(run_gate)" || status=$?
  rm -f "$PROBE_TYPE"
  if [ "$expected" = pass ] && [ "$status" -eq 0 ]; then
    pass "$name (expected pass)"
  elif [ "$expected" = fail ] && [ "$status" -ne 0 ] &&
    names_on_one_line "$PROBE_TYPE_BASE" "$code" <<<"$out"; then
    pass "$name (expected fail: $code in $PROBE_TYPE_BASE)"
  else
    fail "$name — expected $expected${code:+ ($code in $PROBE_TYPE_BASE)}, got status=$status, output:"
    sed 's/^/    /' <<<"$out" >&2
  fi
}

# lint_probe NAME BODY RULE CMD… — run a shipped lint script twice, once without
# the probe and once with it, and require that the probe CAUSED a new diagnostic
# of RULE and flipped the exit status.
#
# CMD is `bun run --silent lint…`. A hand-rolled `oxlint --config … scripts/` is
# blind to everything about the shipped command except the presence of the token
# `scripts/` in its path list — see the `--ignore-pattern` measurement in the
# file header.
#
# The assertion compares against a probe-free baseline rather than grepping one
# line, because oxlint's output format is not stable. On the runner it emits
# GitHub annotations — `::error file=<path>,line=N,…,title=eslint(<rule>)::<msg>`
# — where the path is followed by `,line=` rather than `:N:`, so
# `names_on_one_line`'s `<file>[:(]<digits>` anchor cannot match even though the
# probe WAS caught. That is how this suite went green locally and red on the
# runner. (Not reproducible locally by setting `GITHUB_ACTIONS` or `CI`; the
# runner's detection does something else.)
#
# The baseline comparison is format-independent, and it measures what the
# same-line form only approximated: that THIS probe produced THIS finding.
#
# Cost is two whole-repo runs per probe — ~2s each for `lint` and ~11s each for
# `lint:type-aware`, measured 2026-08.
lint_probe() {
  local name="$1" body="$2" rule="$3"
  shift 3
  local base_status=0 base_out base_hits
  base_out="$("$@" 2>&1)" || base_status=$?
  # `grep -c` exits 1 for zero matches, which is the value being counted rather
  # than a failure; `|| true` keeps that from aborting under `set -e`.
  base_hits="$(grep -cF "$rule" <<<"$base_out" || true)"

  local status=0 out hits
  printf '%s' "$body" > "$PROBE_LINT"
  out="$("$@" 2>&1)" || status=$?
  rm -f "$PROBE_LINT"
  hits="$(grep -cF "$rule" <<<"$out" || true)"

  if [ "$base_status" -eq 0 ] && [ "$status" -ne 0 ] && [ "$hits" -gt "$base_hits" ]; then
    pass "$name (probe caused a new '$rule' from the shipped command)"
  else
    fail "$name — expected a probe-free baseline to be clean and the probe to add a '$rule'; got baseline status=$base_status hits=$base_hits, with-probe status=$status hits=$hits. With-probe output:"
    sed 's/^/    /' <<<"$out" >&2
  fi
}

echo "check-scripts-typecheck.test.sh — scripts/ type + lint gate (#5173)"

# --- the real tree ------------------------------------------------------------

# Sanity, and it is FATAL rather than a countable failure: every case below
# assumes a clean baseline, so continuing past a dirty one reports on a tree
# that invalidates the whole run.
#
# ⚠️ The DIAGNOSIS must name where the errors are, and it must show them. A
# weakened `strict` reds this program with ~356 diagnostics of which ZERO are in
# `scripts/` — reported as "the scripts/ tree does not type-check", it sends a
# reader into a directory with nothing wrong in it, while the three cases
# actually written to measure strictness never run.
status=0
out="$(run_gate)" || status=$?
if [ "$status" -ne 0 ]; then
  # Same-line, but NOT via names_on_one_line — that helper's first argument is a
  # FILE and its anchor is `<file>[:(]<digits>`, which an error code can never
  # satisfy. Written that way it was a dead branch carried entirely by this grep.
  if grep -qE 'error TS2307:.*@useatlas/' <<<"$out"; then
    echo "::error::the scripts/ type program cannot resolve @useatlas/* — those resolve through each package's BUILT dist/. Run 'bun install' (which builds @useatlas/types and @useatlas/plugin-sdk via their prepare scripts). @useatlas/sdk and @useatlas/react have NO prepare script — if one of those is unresolved, build it explicitly: bun run --filter '<pkg>' build." >&2
    head -20 <<<"$out" | sed 's/^/    /' >&2
  elif ! grep -qE '(^|/)scripts/[^:(]*[:(][0-9]+' <<<"$out"; then
    echo "::error::the scripts/ type PROGRAM is red but NO diagnostic names a scripts/ file. This is a repo-wide breakage or a weakened compilerOption (strict / strictNullChecks), not a scripts/ defect — the program reaches packages/api, ee/ and apps/docs transitively. First 20 lines:" >&2
    head -20 <<<"$out" | sed 's/^/    /' >&2
  else
    echo "::error::the real scripts/ tree does not type-check; fix that before this suite can measure anything. Diagnostics naming a scripts/ file:" >&2
    grep -E '(^|/)scripts/[^:(]*[:(][0-9]+' <<<"$out" | sed 's/^/    /' >&2
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
capture_status program_files lf_status "$TSGO" --noEmit --listFiles -p "$TSCONFIG"
if [ "$lf_status" -ne 0 ]; then
  # Status FIRST. `--listFiles` streams paths as it loads them, so a fault
  # partway through leaves a list that still contains scripts/ entries and would
  # route into the comparison below — passing or misdiagnosing on a program that
  # never finished.
  fail "tsgo --listFiles failed (status=$lf_status) — harness fault, not a narrowed glob:"
  sed 's/^/    /' <<<"$program_files" >&2
elif ! grep -qF "$REPO_ROOT/scripts/" <<<"$program_files"; then
  fail "tsgo --listFiles exited 0 but named no scripts/ file at all — harness fault, not a narrowed glob:"
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
# to full coverage. `ee-stub` is type-checked by the Symlink Stub Build job; no
# other `scripts/` subdirectory holds TypeScript today, so anything appearing
# there is unchecked.
#
# `.tsx` is in this pattern because `.tsx` is in the include glob. An earlier
# revision widened the coverage loop above and not this one, which reopened the
# defect one directory down: a `scripts/<dir>/*.tsx` carrying #5169's shape
# passed the whole suite.
#
# ⚠️ The parentheses are load-bearing — without them `find` binds `-not -path`
# to the last `-name` only, and `ee-stub/**/*.ts` gets falsely flagged.
capture_status stray find_status \
  find "$REPO_ROOT/scripts" -mindepth 2 \
  \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/ee-stub/*'
if [ "$find_status" -ne 0 ]; then
  fail "find over scripts/ failed (status=$find_status) — harness fault, not a clean tree:"
  sed 's/^/    /' <<<"$stray" >&2
elif [ -z "$stray" ]; then
  pass "no scripts/ subdirectory .ts/.tsx file sits outside the type program"
else
  fail "scripts/ subdirectory .ts/.tsx files are outside the one-level include glob:$stray"
fi

# --- non-vacuity: the package.json wiring --------------------------------------

# Read the VALUES, not the file. A grep over package.json is satisfied by any
# line that happens to contain the string — including a sibling script — and it
# is hostage to indentation. Word-anchored so narrowing `scripts/` to
# `scripts/__tests__/` (a directory with no .ts source) fails instead of
# prefix-matching its way to green. Measured: with a substring grep, that
# narrowing left all ten cases passing.
read_script() {
  SCRIPT_KEY="$1" bun -e 'const p = JSON.parse(await Bun.file("package.json").text()); console.log(p.scripts?.[Bun.env.SCRIPT_KEY] ?? "")' || {
    echo "::error::could not read package.json scripts.$1 — package.json is unparseable or bun failed. This suite cannot verify the wiring." >&2
    exit 2
  }
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

# The --listFiles and stray-subdirectory cases measure $TSCONFIG DIRECTLY
# (--listFiles is not a flag `type:scripts` passes), so if `type:scripts` were
# repointed at another config they would go on validating an orphaned file
# forever. Nothing else asserts the two are the same file.
value="$(read_script type:scripts)"
if grep -qF "tsconfig.scripts.json" <<<"$value"; then
  pass "type:scripts points at the config this suite audits"
else
  fail "type:scripts no longer points at tsconfig.scripts.json — value: ${value:-<missing>}; the --listFiles and stray cases are auditing a config nothing runs"
fi

# --- non-vacuity: lint reaches scripts/ ----------------------------------------

# Two probes, because the two lint gates fail independently — and both run the
# SHIPPED script, so a change to the invocation (a swapped `--config`, an added
# `--ignore-pattern`, a wrapper binary) is caught rather than only a change to
# the path list. The `read_script` assertions above cannot see any of that.

# Plain `lint`. A `correctness`-category rule is an error, so this also pins
# that nothing has scoped the category off for scripts/ or added the directory
# to `ignorePatterns`.
lint_probe "lint reaches scripts/" \
  'const dup = { a: 1, a: 2 };
export const out = dup;
' "no-dupe-keys" bun run --silent lint

# Type-aware lint. Naming a directory in the path list is not the same as
# tsgolint being able to build a program for it; if routing fails, oxlint
# reports nothing for those files and exits 0 — a green that means "not
# checked". `no-floating-promises` is rated "error" in .oxlintrc.json.
lint_probe "type-aware lint routes scripts/ into a program" \
  'async function thing(): Promise<void> {}
export function go(): void {
  thing();
}
' "no-floating-promises" bun run --silent lint:type-aware

# --- the gated scripts still behave --------------------------------------------

# `saas-env-fixture.ts` is the file this gate surfaced 25 errors in, and
# `--database-url` is now mandatory; this pins that. There is no unit-test lane
# for `scripts/*.ts`, so it lives here rather than standing one up.
status=0
out="$(bun run "$REPO_ROOT/scripts/saas-env-fixture.ts" --database-url 2>&1)" || status=$?
if [ "$status" -ne 0 ] && grep -qF "expects a Postgres URL" <<<"$out"; then
  pass "saas-env-fixture rejects --database-url with no value"
else
  fail "saas-env-fixture did not reject a valueless --database-url — status=$status, output:"
  sed 's/^/    /' <<<"$out" >&2
fi

echo ""
echo "check-scripts-typecheck.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
