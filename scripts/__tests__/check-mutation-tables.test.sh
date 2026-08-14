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
# So each fixture builds a throwaway packages/api tree with ONE two-test target
# and ONE spec, points the gate at it via MUTATION_SPEC_GLOB, and runs the real
# script end to end — the real `mutate.ts`, the real git plumbing, no mocks.
#
# Locks in, in the order they would hurt:
#   1. a hand-edited generated table is CAUGHT             (the #5060 threat model)
#   2. a target carrying `.skip` is REFUSED                (guardrail 4, #5077)
#   3. an unresolvable base WIDENS rather than passing     (the fail-safe)
#   4. TEST_DATABASE_URL unset exits 3, not 0              (SKIP, never PASS)
#   5. POSITIVE CONTROL: a current table passes            (or the above is vacuous)
#   6. HEAD == base exits 3, and HEAD-ahead still exits 0  (#5151, a PAIR)
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

echo ":: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
