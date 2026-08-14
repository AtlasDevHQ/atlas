#!/bin/bash
# Adversarial fixture suite for scripts/check-mutation-tables.sh (#5077).
#
# The gate's whole value is a NEGATIVE — "it does not silently verify nothing" —
# and every one of its false-clean paths is reachable only under conditions
# nobody hits by accident: an unresolvable base ref, an empty selection, a
# dependency the selector cannot see. None of that is exercised by running the
# gate against the real repo, where the honest answer takes ~16 minutes
# (`check-mutation-tables.sh`'s header carries the measurements).
#
# So the fixtures build throwaway packages/api trees and point the gate at them
# via MUTATION_SPEC_GLOB. Most carry ONE two-test target and ONE spec and run the
# real script end to end — the real `mutate.ts`, the real git plumbing, no mocks.
# The partition fixtures carry only empty spec files, because the paths they
# exercise decide ownership before any spec is loaded.
#
# Locks in, in the order they would hurt:
#   1. a hand-edited generated table is CAUGHT             (the #5060 threat model)
#   2. a target carrying `.skip` is REFUSED                (guardrail 4, #5077)
#   3. an unresolvable base WIDENS rather than passing     (the fail-safe)
#   4. TEST_DATABASE_URL unset exits 3, not 0              (SKIP, never PASS)
#   5. POSITIVE CONTROL: a current table passes            (or the above is vacuous)
#   6. HEAD == base exits 3, and HEAD-ahead still exits 0  (#5151, a PAIR)
#   7. every spec lands on exactly one shard               (the partition)
#   8. a malformed --shard is a hard error                 (never a silent no-op)
#   9. an empty shard is honest, an impossible one is not  (the exit-0 path)
#  10. --affected + --shard still covers the affected set  (what CI runs on a PR)
#
# ⚠️ EVERY fixture here was proven sensitive by DELETING the guard it pins and
# confirming it goes red. Two more (`.todo` refused, dead anchor refused) were
# written, measured VACUOUS — their trees generate no table, so `--check` exits
# 1 with "is stale" whether or not the guard exists — and REMOVED rather than
# shipped green. They need a tree carrying a committed tombstone, and
# `check()` needs to assert on a discriminating phrase rather than on an exit
# code five failure modes share. Tracked in #5097.
#
# ⚠️ The numbers above are the ONLY numbering. The per-fixture comments below
# are ordered to match them; an earlier draft kept labels from a seven-fixture
# scheme, and one of those labels claimed the `.todo` bucket that this header
# says was removed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-mutation-tables.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# A throwaway packages/api containing a real runnable target + spec.
#   $1 target body   $2 the mutation's oldString   $3 extra setup run in the api dir
make_tree() {
  local target_body="$1" old_string="$2" extra="${3:-}"
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/packages/api/src"
  # ⚠️ COPY the runner, never symlink it. `mutate.ts` derives its ROOT from
  # `import.meta.dir`, which resolves THROUGH a symlink back to the real
  # packages/api — so a symlinked runner looks for the fixture spec in the real
  # tree, fails to load it, and every fixture below then "fails" for the wrong
  # reason. Measured: six of seven fixtures passed green while asserting
  # nothing but `Cannot find module`. An assertion that cannot fail is not an
  # assertion, and this comment is here because the first cut of this file was
  # exactly that.
  cp "$REPO_ROOT/packages/api/scripts/mutate.ts"        "$tmp/packages/api/scripts/"
  cp "$REPO_ROOT/packages/api/scripts/mutation-core.ts" "$tmp/packages/api/scripts/"
  cp "$REPO_ROOT/packages/api/scripts/mutation-spec.ts" "$tmp/packages/api/scripts/"
  cp "$REPO_ROOT/packages/api/scripts/signal-retry.ts"  "$tmp/packages/api/scripts/"
  ln -s "$REPO_ROOT/node_modules"                       "$tmp/node_modules"
  mkdir -p "$tmp/scripts"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"

  cat >"$tmp/packages/api/src/subject.ts" <<'TS'
export function answer(): number {
  return 42;
}
TS
  printf '%s\n' "$target_body" >"$tmp/packages/api/src/subject.test.ts"

  cat >"$tmp/packages/api/scripts/mutations/f.mutations.ts" <<SPEC
import type { MutationSpec } from "../mutation-spec";
const spec: MutationSpec = {
  title: "fixture",
  out: "scripts/mutations/f.md",
  targets: [{ name: "subject", file: "src/subject.test.ts" }],
  mutations: [
    { label: "answer returns the wrong number", edits: [{ file: "src/subject.ts", oldString: ${old_string}, newString: "  return 0;" }] },
  ],
};
export default spec;
SPEC

  ( cd "$tmp" && git init --quiet -b main && git config user.email t@t.t && git config user.name t \
      && git add -A >/dev/null && git commit --quiet -m base )
  if [ -n "$extra" ]; then ( cd "$tmp/packages/api" && eval "$extra" ); fi
  echo "$tmp"
}

# ⚠️ THREE tests, only two of which depend on `answer()`. With 2-of-2 the
# mutation takes the WHOLE suite, `isWholeSuite` flags it, and the cell renders
# `2 ⚠️` rather than `2` — so the hand-edit fixtures below silently sed nothing
# and pass while asserting nothing. 2-of-3 stays under the ratio.
GOOD_TARGET='import { expect, test } from "bun:test";
import { answer } from "./subject";
test("a", () => { expect(answer()).toBe(42); });
test("b", () => { expect(answer()).toBe(42); });
test("c", () => { expect(1).toBe(1); });'

check() { # check EXPECTED_EXIT NAME TREE [ARGS...]
  local expected="$1" name="$2" tmp="$3"; shift 3
  local rc=0 out
  out=$( cd "$tmp" && TEST_DATABASE_URL="${TEST_DATABASE_URL:-x}" \
         MUTATION_SPEC_GLOB="scripts/mutations/f.mutations.ts" \
         bash scripts/check-mutation-tables.sh "$@" 2>&1 ) || rc=$?
  if [ "$rc" = "$expected" ]; then
    echo "  ok    $name (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name — expected exit $expected, got $rc"; echo "$out" | sed 's/^/        /' | tail -12
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

echo ":: check-mutation-tables.sh adversarial fixtures"

# 5. POSITIVE CONTROL, run first — everything below is vacuous without it.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1')
check 0 "POSITIVE CONTROL — a freshly generated table passes" "$T" --all

# 1. The #5060 threat model: a hand-edited number.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1; grep -q "| 2 |" scripts/mutations/f.md && sed -i "s/| 2 |/| 99 |/" scripts/mutations/f.md')
check 1 "a hand-edited generated table is caught" "$T" --all

# 2. Guardrail 4, the `.skip` bucket ONLY. A skipped test cannot be killed, so
# the count deflates. ⚠️ bun does not fold `todo` into `skip`, and the `.todo`
# fixture that would pin that second bucket was measured vacuous and removed
# (see the header, and #5097) — so nothing in this suite covers it.
SKIP_TARGET='import { expect, test } from "bun:test";
import { answer } from "./subject";
test("a", () => { expect(answer()).toBe(42); });
test.skip("b", () => { expect(answer()).toBe(42); });'
T=$(make_tree "$SKIP_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1 || true')
check 1 "a target carrying .skip is REFUSED" "$T" --all

# 3. The fail-safe. An unresolvable base must WIDEN to --all (and then catch the
# hand-edit), never quietly select nothing and exit 0.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1; grep -q "| 2 |" scripts/mutations/f.md && sed -i "s/| 2 |/| 99 |/" scripts/mutations/f.md')
check 1 "an unresolvable base WIDENS to --all rather than passing" "$T" --affected origin/nope

# 4. Declining to verify is not passing.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' 'true')
rc=0
out=$( cd "$T" && env -u TEST_DATABASE_URL MUTATION_SPEC_GLOB="scripts/mutations/f.mutations.ts" \
       bash scripts/check-mutation-tables.sh --all 2>&1 ) || rc=$?
if [ "$rc" = "3" ]; then
  echo "  ok    TEST_DATABASE_URL unset exits 3 (SKIP), not 0 (PASS) (exit $rc)"; PASS=$((PASS + 1))
else
  echo "  FAIL  TEST_DATABASE_URL unset — expected exit 3, got $rc"; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# 6. Empty-by-construction is not "nothing changed" (#5151). These two run as a
# PAIR and the pair is the assertion: both reach the same empty-selection
# branch, and the gate must return a DIFFERENT verdict for each. A fixture that
# only pinned the 3 would still pass if the gate declined unconditionally —
# which would make every ordinary PR's instant no-op read as unverified.
#
# ⚠️ These are also the first fixtures in this file to exercise the selector
# loop itself (`mutate.ts --files` per spec). Fixtures 1/2/5 pass --all, and 3
# widens on an unresolvable base before the loop is reached.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' 'true')
check 3 "HEAD == base exits 3 (SKIP) — the affected set is empty BY CONSTRUCTION" "$T" --affected main

# The negative control. HEAD is one commit ahead of the base and that commit
# touches nothing any spec depends on, so the empty selection is a real answer
# rather than an artefact of there being no delta at all — exit 0 is honest here.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'git branch base-ref HEAD && echo note > ../../notes.md && git add -A >/dev/null && git commit --quiet -m irrelevant')
check 0 "HEAD ahead of base, no spec dep touched — still a genuine PASS" "$T" --affected base-ref

# 7. The shard partition is TOTAL and DISJOINT.
#
# The threat is a spec that lands on no shard: verified by nothing, green
# forever — the same outcome as the four stale tables in check-mutation-tables.sh's header,
# reached through a new door. Enumerating spec names in the CI matrix would
# produce exactly that the next time someone adds a spec, which is why the
# partition is round-robin by position and why this fixture exists to hold it.
#
# `--list-only` prints the selection without running a mutation, so this costs
# milliseconds; proving the property against the real specs would cost a full
# sweep per shard, and a test that expensive is one nobody runs.
#
# The assertion is on the UNION: 13 selections, 13 distinct. An off-by-one in
# the modulo drops a whole residue class, which shows up as a short union. 13 is
# the fixture's own count, chosen not to divide by 4 so an uneven split is
# exercised too; it does not have to track the real spec count.
make_spec_tree() { # $1 = how many empty spec files
  local n="$1" tmp i; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/scripts"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"
  for i in $(seq 1 "$n"); do : >"$tmp/packages/api/scripts/mutations/s$i.mutations.ts"; done
  echo "$tmp"
}

shard_selection() { # $1 tree  $2 shard  $3 total
  # ⚠️ Capture first, THEN filter. `--list-only` exits 3 ("declined to verify"),
  # and piping it straight into sed under `pipefail` aborts this whole suite at
  # the first call — which looked like the fixture had vanished rather than
  # failed. `|| true` is correct here and only here: 3 is the expected status.
  local out
  out=$( cd "$1" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
         bash scripts/check-mutation-tables.sh --all --list-only --shard "$2/$3" 2>/dev/null ) || true
  printf '%s\n' "$out" | sed -n 's/^SELECTED //p'
}

SPEC_N=13
SHARD_N=4
T=$(make_spec_tree "$SPEC_N")
UNION=""
for s in $(seq 1 "$SHARD_N"); do UNION="${UNION}$(shard_selection "$T" "$s" "$SHARD_N")"$'\n'; done
TOTAL=$(printf '%s' "$UNION" | grep -c . || true)
DISTINCT=$(printf '%s' "$UNION" | sort -u | grep -c . || true)
if [ "$TOTAL" = "$SPEC_N" ] && [ "$DISTINCT" = "$SPEC_N" ]; then
  echo "  ok    shard partition is total and disjoint ($SPEC_N specs over $SHARD_N shards)"; PASS=$((PASS + 1))
else
  echo "  FAIL  shard partition — expected $SPEC_N selections and $SPEC_N distinct, got $TOTAL and $DISTINCT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# 8. A malformed --shard is a hard error. See the validation comment in the
# script for why a fall-through is a false-clean.
#
# ⚠️ Each case asserts a DISCRIMINATING PHRASE, not a bare exit 1. Five paths in
# this script exit 1 — no specs found, unknown argument, --shard missing its
# value, the pattern rejection, and the STALE verdict — so an exit-code-only
# assertion cannot tell "the guard fired" from "my fixture tree was broken."
# Measured: the first cut of this fixture asserted `rc == 1` for `9/4` and
# reported "ok" against a tree containing NO spec files at all, where the 1 came
# from "no specs found". The file header already names that as why two earlier
# fixtures were deleted rather than shipped green.
#
# The first three cases below all passed the original `[1-9]*/[1-9]*` glob:
# `1a/4` and `1/4x` ran every spec with exit 0, and `1/4/9` silently became a
# 9-way partition.
shard_reject() { # $1 label  $2 shard-arg  $3 phrase the stderr must contain
  local tmp; tmp=$(make_spec_tree 5)
  local rc=0 out
  out=$( cd "$tmp" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
         bash scripts/check-mutation-tables.sh --all --list-only --shard "$2" 2>&1 ) || rc=$?
  # `--` before the pattern: every phrase here starts with `--shard`, and grep
  # reads that as an option otherwise.
  if [ "$rc" = "1" ] && printf '%s' "$out" | grep -qF -- "$3"; then
    echo "  ok    --shard $2 rejected ($1)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  --shard $2 ($1) — expected exit 1 containing '$3', got $rc"
    printf '%s' "$out" | sed 's/^/        /' | tail -6
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

shard_reject "trailing junk in the index" "1a/4"  "--shard expects I/N"
shard_reject "trailing junk in the total" "1/4x" "--shard expects I/N"
shard_reject "three fields"               "1/4/9" "--shard expects I/N"
shard_reject "zero index"                 "0/4"   "--shard expects I/N"
shard_reject "no slash"                   "4"     "--shard expects I/N"
shard_reject "index past total"           "9/4"   "index exceeds total"

# 9. The empty-shard exit 0, which `--list-only` STRUCTURALLY CANNOT REACH — it
# returns before this branch — so fixture 7 can never cover it however far it is
# extended. It is also the common case in production: an affected set of 1-3
# specs against a 4-shard matrix empties at least one shard on most PRs.
T=$(make_spec_tree 2)
rc=0
out=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
       bash scripts/check-mutation-tables.sh --all --shard 4/4 2>&1 ) || rc=$?
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -qF "no spec at positions"; then
  echo "  ok    an empty shard (2 specs, 4 shards) exits 0 and says so"; PASS=$((PASS + 1))
else
  echo "  FAIL  empty shard — expected exit 0 naming the empty residue class, got $rc"
  printf '%s' "$out" | sed 's/^/        /' | tail -6; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# The negative half of the pair. With MORE specs than shards, round-robin gives
# every shard at least one, so an empty slice means the partition is broken —
# and every path that produces one otherwise ends in green jobs having verified
# nothing. A fixture asserting only the 0 above would pass a script that always
# returned an empty shard.
#
# ⚠️ Assert on the PHRASE, not the exit code. These trees hold empty spec files,
# so a shard that receives work proceeds to verification and exits 1 STALE — the
# same 1 the impossible-empty guard uses. An exit-code assertion here would pass
# for the wrong reason, which is the defect this whole fixture block was
# rewritten to remove.
T=$(make_spec_tree 8)
rc=0
out=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
       bash scripts/check-mutation-tables.sh --all --shard 1/2 2>&1 ) || rc=$?
if ! printf '%s' "$out" | grep -qF "is empty, but"; then
  echo "  ok    8 specs over 2 shards never reports an impossible empty shard"; PASS=$((PASS + 1))
else
  echo "  FAIL  8 specs over 2 shards reported an impossible empty shard"
  printf '%s' "$out" | sed 's/^/        /' | tail -6; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# 10. OWNERSHIP COMES FROM `SPECS`, NOT `SELECTED` — the fix for the defect that
# makes widen-never-narrow narrow the union.
#
# `SELECTED` is the selector's output and the selector widens per process, so
# one runner can widen while three do not. If ownership were computed from
# `SELECTED`, widening one shard would RENUMBER the positions and a spec would
# fall through the gap, verified by nobody, all shards green.
#
# The falsifier: build three real specs, make only the THIRD affected. Its
# position in the glob is 2, so shard 3 of 4 must own it. If ownership were
# taken from `SELECTED` it would sit at position 0 of a one-element list and
# shard 1 would claim it. Asserting the OWNER — not merely that some shard has
# it — is what discriminates the two implementations.
make_multi_spec_tree() { # builds 3 real specs; only c is touched
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/packages/api/src" "$tmp/scripts"
  for f in mutate.ts mutation-core.ts mutation-spec.ts signal-retry.ts; do
    cp "$REPO_ROOT/packages/api/scripts/$f" "$tmp/packages/api/scripts/"
  done
  ln -s "$REPO_ROOT/node_modules" "$tmp/node_modules"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"
  local n
  for n in a b c; do
    cat >"$tmp/packages/api/src/$n.ts" <<TS
export function v$n(): number {
  return 1;
}
TS
    cat >"$tmp/packages/api/src/$n.test.ts" <<TS
import { expect, test } from "bun:test";
import { v$n } from "./$n";
test("x", () => { expect(v$n()).toBe(1); });
test("y", () => { expect(v$n()).toBe(1); });
test("z", () => { expect(1).toBe(1); });
TS
    cat >"$tmp/packages/api/scripts/mutations/$n.mutations.ts" <<SPEC
import type { MutationSpec } from "../mutation-spec";
const spec: MutationSpec = {
  title: "$n",
  out: "scripts/mutations/$n.md",
  targets: [{ name: "$n", file: "src/$n.test.ts" }],
  mutations: [
    { label: "$n wrong", edits: [{ file: "src/$n.ts", oldString: "  return 1;", newString: "  return 0;" }] },
  ],
};
export default spec;
SPEC
  done
  ( cd "$tmp" && git init --quiet -b main && git config user.email t@t.t && git config user.name t \
      && git add -A >/dev/null && git commit --quiet -m base && git branch base-ref HEAD \
      && echo "// touched" >> packages/api/src/c.ts && git add -A >/dev/null \
      && git commit --quiet -m "touch c only" )
  echo "$tmp"
}

T=$(make_multi_spec_tree)
OWNER=""
UNION=""
for s in 1 2 3 4; do
  raw=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
         bash scripts/check-mutation-tables.sh --affected base-ref --shard "$s/4" --list-only 2>/dev/null ) || true
  got=$( printf '%s\n' "$raw" | sed -n 's/^SELECTED //p' )
  if [ -n "$got" ]; then OWNER="$s"; UNION="${UNION}${got}"$'\n'; fi
done
COVERED=$(printf '%s' "$UNION" | grep -c 'c.mutations.ts' || true)
if [ "$OWNER" = "3" ] && [ "$COVERED" = "1" ]; then
  echo "  ok    the affected spec is owned by its SPECS position (shard 3), not its SELECTED position"
  PASS=$((PASS + 1))
else
  echo "  FAIL  affected-spec ownership — expected sole owner shard 3 and exactly one covering, got owner='$OWNER' covered=$COVERED"
  FAIL=$((FAIL + 1))
fi
rm -rf "$T"

echo ":: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
