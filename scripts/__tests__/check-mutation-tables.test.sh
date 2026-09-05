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
#  2b. a target carrying `.todo` is REFUSED                (the second bucket, #5097)
#   3. an unresolvable base WIDENS rather than passing     (the fail-safe)
#   4. TEST_DATABASE_URL unset exits 3, not 0              (SKIP, never PASS)
#   5. POSITIVE CONTROL: a current table passes            (or the above is vacuous)
#   6. HEAD == base exits 3, and HEAD-ahead still exits 0  (#5151, a PAIR)
#  6b. a COMMITTED TOMBSTONE is refused, not blessed       (#5097)
#  6c. a CORPUS-ONLY commit selects its spec               (#5097)
#   7. every ROW lands on exactly one shard                (the partition)
#   8. a malformed --shard is a hard error                 (never a silent no-op)
#   9. a shard past every spec's row count is honest       (the exit-0 path)
#  10. --affected + --shard still covers the affected set  (what CI runs on a PR)
#
# ⚠️ EVERY fixture here was proven sensitive by DELETING the guard it pins and
# confirming it goes red.
#
# ⚠️ 2b, 6b and 6c are the three #5077 wrote, measured VACUOUS, and deleted
# rather than shipped green — and the reason they were vacuous was `check()`,
# not the trees. It asserted only an EXIT CODE, and exit 1 is shared by at least
# five states (STALE, a dead anchor, a deflated baseline, an unknown argument,
# no specs found), so "the guard fired" and "my fixture tree was broken" were
# indistinguishable. Deleting the entire anchor refusal left all seven fixtures
# green. `check()` now requires a DISCRIMINATING PHRASE alongside the code, 6b
# manufactures a committed tombstone with the refusal bypassed in the fixture's
# own copy of the runner, and 6c is the one fixture here whose two outcomes share
# an exit code entirely — pre-fix exit 0 "nothing to verify", post-fix exit 1
# STALE — so it could not have existed at all before the phrase argument.
#
# ⚠️ The numbers above are the ONLY numbering. The per-fixture comments below
# are ordered to match them; an earlier draft kept labels from a seven-fixture
# scheme, and one of those labels claimed the `.todo` bucket that the header then
# said was removed.

# ⚠️ `-e` here, unlike this file's three sibling suites, which drop it so a failing
# case cannot abort the tally. Kept deliberately: `make_tree`'s premise checks
# (the tombstone bypass, the corpus table) signal a BROKEN FIXTURE by exiting
# non-zero from a command substitution, and aborting loudly is the right response
# to "the tree I was about to test does not exist". The cost is real and worth
# naming: an abort skips the `EXPECTED_CASES` guard at the bottom, so the device
# that notices a DELETED case is unreachable on the failure mode most likely to
# delete one. An abort is still a non-zero exit, so it cannot read as a pass.
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
  # ⚠️ `>&2` ON THE SETUP, because make_tree's STDOUT is the return value (#5429).
  #
  # Every caller is `T=$(make_tree …)`, so anything `$extra` prints on stdout is
  # concatenated in front of the path. The setups DO print: a `git commit` that
  # finds nothing staged says "nothing to commit, working tree clean", and the
  # tombstone setup's own premise check echoes "FIXTURE PREMISE BROKEN: …". The
  # result was `check()`'s `cd "$tmp"` receiving a multi-line string and failing
  # as `cd: $'FIXTURE PREMISE BROKEN…\n/tmp/tmp.XXXX': No such file or directory`
  # — a broken premise reported as a confusing cd error, at a line number that
  # points at the assertion helper rather than at the fixture that broke.
  #
  # Diagnostics still reach the operator, on the stream that is not the value.
  if [ -n "$extra" ]; then ( cd "$tmp/packages/api" && eval "$extra" ) >&2; fi
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

# ⚠️ ASSERTS AN EXIT CODE **AND** A DISCRIMINATING PHRASE (#5097).
#
# The exit-code-only version of this helper is what made two fixtures vacuous
# and got them deleted rather than shipped. Exit 1 is shared by at least five
# states — STALE, a dead anchor, a deflated baseline, an unknown argument, and
# "no specs found" — so `rc == 1` cannot tell "the guard fired" from "my fixture
# tree was broken". Both deleted fixtures failed exactly that way: their trees
# generated no table, so `--check` exited 1 with *"is stale"* whether or not the
# guard existed, and deleting the entire anchor refusal left all seven green.
#
# The `shard_reject` helper below already had this discipline for the same
# reason; the phrase argument brings the main helper into line, and it is
# REQUIRED rather than optional so a new fixture cannot silently opt out.
check() { # check EXPECTED_EXIT PHRASE NAME TREE [ARGS...]
  local expected="$1" phrase="$2" name="$3" tmp="$4"; shift 4
  local rc=0 out
  out=$( cd "$tmp" && TEST_DATABASE_URL="${TEST_DATABASE_URL:-x}" \
         MUTATION_SPEC_GLOB="scripts/mutations/f.mutations.ts" \
         bash scripts/check-mutation-tables.sh "$@" 2>&1 ) || rc=$?
  # `--` before the pattern: a phrase may legitimately begin with `-`.
  if [ "$rc" = "$expected" ] && printf '%s' "$out" | grep -qF -- "$phrase"; then
    echo "  ok    $name (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name — expected exit $expected containing '$phrase', got $rc"
    echo "$out" | sed 's/^/        /' | tail -14
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

echo ":: check-mutation-tables.sh adversarial fixtures"

# 5. POSITIVE CONTROL, run first — everything below is vacuous without it.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1')
check 0 "verified table(s) current" \
  "POSITIVE CONTROL — a freshly generated table passes" "$T" --all

# 1. The #5060 threat model: a hand-edited number.
#
# ⚠️ The phrase is `STALE <spec>`, which only the verification loop prints. A
# bare exit 1 would also be satisfied by "no specs found" — the way the two
# deleted fixtures passed while asserting nothing.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1; grep -q "| 2 |" scripts/mutations/f.md && sed -i "s/| 2 |/| 99 |/" scripts/mutations/f.md')
check 1 "STALE scripts/mutations/f.mutations.ts" \
  "a hand-edited generated table is caught" "$T" --all

# 2. Guardrail 4, the `.skip` bucket. A skipped test cannot be killed, so the
# count deflates. bun does not fold `todo` into `skip`; fixture 2b pins that
# second bucket, which the header used to say nothing covered.
SKIP_TARGET='import { expect, test } from "bun:test";
import { answer } from "./subject";
test("a", () => { expect(answer()).toBe(42); });
test.skip("b", () => { expect(answer()).toBe(42); });'
T=$(make_tree "$SKIP_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1 || true')
check 1 "SKIPPED 1 of 2 tests" \
  "a target carrying .skip is REFUSED" "$T" --all

# 2b. THE `.todo` BUCKET — reinstated from #5077, where it was measured VACUOUS
# and deleted rather than shipped green (#5097).
#
# ⚠️ The vacuity was in the ASSERTION, not the tree. With the guard present the
# generation step refuses, no `f.md` is written, and `--check` exits 1 saying
# *"is stale"* — the same 1 the guard produces. The phrase is what discriminates:
# `marked TODO on 1 of 2 tests` can only come from the deflation arm. Measured
# by deleting that arm: the tree then generates a table, `--check` says CHECK OK,
# and this fixture goes red.
TODO_TARGET='import { expect, test } from "bun:test";
import { answer } from "./subject";
test("a", () => { expect(answer()).toBe(42); });
test.todo("b");'
T=$(make_tree "$TODO_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1 || true')
check 1 "marked TODO on 1 of 2 tests" \
  "a target carrying .todo is REFUSED — bun does not fold it into skip" "$T" --all

# 2c. ⚠️ THE PER-MUTATION REFUSAL, which had NO falsifier anywhere.
#
# Fixtures 2 and 2b deflate the BASELINE, so they exercise `baselineProblem` →
# `fail()`. Fixture 6b's tombstone reaches the refusal through `measure()`'s
# AnchorError path. NOTHING reached `mutate.ts`'s per-mutation arm — which is
# #5097's headline claim, the thing #5077 detected and then removed. Deleting
# that arm published a deflated count as an honest number and every suite in the
# repo stayed green.
#
# Here the baseline is CLEAN — 3 pass, 0 skip, since `describe.skipIf(42 !== 42)`
# does NOT skip — and the MUTATION causes the skip: `return 0` makes the predicate
# true and the gated test drops out. The phrase comes only from
# `UnmeasurableOutcome.cell`; the baseline path prints `.message`, which for this
# arm reads "SKIPPED 1 of 3 tests" and cannot contain "SKIPPED 1 —". The two
# strings are textually disjoint, which is what makes the phrase discriminate.
SKIPIF_TARGET='import { describe, expect, test } from "bun:test";
import { answer } from "./subject";
test("a", () => { expect(answer()).toBe(42); });
test("b", () => { expect(1).toBe(1); });
describe.skipIf(answer() !== 42)("gated", () => {
  test("c", () => { expect(answer()).toBe(42); });
});'
T=$(make_tree "$SKIPIF_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1 || true')
check 1 "SKIPPED 1 — count would be deflated" \
  "a MUTATION that makes the suite SKIP is refused per-mutation, not published" "$T" --all

# 2d. …and the EMPTY case, measured live on bun 1.3.13: a corpus-driven target
# whose array the mutation empties prints ` 0 pass` / ` 0 fail`, which NO other
# arm catches. `isWholeSuite(0, n)` is false, so the runner published a `0` —
# the byte the generated header defines as "the suite does not catch it" — for a
# run that registered no tests at all. #5097's own class, found in review.
EMPTY_TARGET='import { expect, test } from "bun:test";
import { answer } from "./subject";
const CORPUS = answer() === 42 ? [1, 2] : [];
for (const c of CORPUS) {
  test(`c${c}`, () => { expect(answer()).toBe(42); });
}'
T=$(make_tree "$EMPTY_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1 || true')
check 1 "ZERO tests ran — nothing was measured" \
  "a MUTATION that empties the suite is refused, not published as a 0" "$T" --all

# 2e. AN UNREADABLE SEED DOES NOT ABORT THE SELECTOR, and the gate SAYS the
# dependency list is short.
#
# ⚠️ `--files` reads each seed's source to walk its imports, which is NEW — before
# the import hop it touched no filesystem and could not fail. `existsSync` is true
# for a DIRECTORY, so a `target.file` that has become one throws EISDIR. MEASURED:
# unguarded, `--files` exits 1, and a bare `$(...)` under `set -e` then aborts the
# whole gate with status 1 — which this script's header calls its code for STALE.
# The operator regenerates tables that never drifted while the real fault (a
# rotted spec path) sits in a log tail.
#
# The phrase pins BOTH halves: the selector survived, AND the warning reached the
# log instead of being swallowed by a `2>/dev/null`.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1; git add -A >/dev/null && git commit --quiet -m generated && git branch base-ref HEAD; rm -f src/subject.test.ts && mkdir -p src/subject.test.ts && git add -A >/dev/null && git commit --quiet -m "target became a directory"')
check 1 "dependency list is INCOMPLETE" \
  "an UNREADABLE seed leaves the selector running and says the list is short" "$T" --affected base-ref

# 2f. …and when `--files` genuinely CANNOT run, the selector WIDENS rather than
# aborting. An unloadable spec is the reachable case: `loadSpec` fails before any
# of the read guarding above, so this is falsifiable independently of it.
#
# Pre-fix the script died at the assignment and printed no widen at all, so the
# phrase — not the exit code, which is 1 either way — is what discriminates.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1; printf "this is not valid typescript (((\n" > scripts/mutations/f.mutations.ts && git add -A >/dev/null && git commit --quiet -m "break the spec"')
# ⚠️ The phrase is `cannot list dependencies for`, NOT `falling back to --all`.
# FOUR gate sites emit that second string (the base diff, the working-tree diff,
# the untracked list, and this one), so it cannot say WHICH widen fired — and this
# suite's own header is an essay about exit 1 being shared by five states. The
# narrower phrase sits on the same `echo`, so it still implies the widen.
check 1 "cannot list dependencies for" \
  "an unloadable spec WIDENS the selector rather than aborting as STALE" "$T" --affected main

# 3. The fail-safe. An unresolvable base must WIDEN to --all (and then catch the
# hand-edit), never quietly select nothing and exit 0.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1; grep -q "| 2 |" scripts/mutations/f.md && sed -i "s/| 2 |/| 99 |/" scripts/mutations/f.md')
# Likewise unique to the base-diff widen, so this fixture and 2f pin DIFFERENT
# sites rather than both resting on one shared sentence.
check 1 "cannot diff against" \
  "an unresolvable base WIDENS to --all rather than passing" "$T" --affected origin/nope

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
check 3 "empty BY CONSTRUCTION" \
  "HEAD == base exits 3 (SKIP) — the affected set is empty BY CONSTRUCTION" "$T" --affected main

# The negative control. HEAD is one commit ahead of the base and that commit
# touches nothing any spec depends on, so the empty selection is a real answer
# rather than an artefact of there being no delta at all — exit 0 is honest here.
T=$(make_tree "$GOOD_TARGET" '"  return 42;"' \
   'git branch base-ref HEAD && echo note > ../../notes.md && git add -A >/dev/null && git commit --quiet -m irrelevant')
check 0 "nothing to verify" \
  "HEAD ahead of base, no spec dep touched — still a genuine PASS" "$T" --affected base-ref

# 6b. A COMMITTED TOMBSTONE is refused — the dead-anchor fixture reinstated
# from #5077, where it was measured VACUOUS and deleted rather than shipped
# (#5097).
#
# The tree it needs is the historical artefact: a table whose cell already reads
# `⚠️ ANCHOR: 0 matches`, committed. `--check` compares BYTES, so without the
# refusal the runner regenerates that tombstone, finds it identical, and says
# CHECK OK — verifying a table that measures nothing, forever.
#
# ⚠️ The artefact is manufactured with the refusal BYPASSED IN THE FIXTURE'S OWN
# COPY of the runner, which `make_tree` already keeps in the throwaway tree. That
# is the only honest way to produce bytes the shipped runner refuses to write.
# The gate then runs against the PRISTINE copy.
#
# ⚠️ And the bypass VERIFIES ITS OWN PREMISE, twice, because a silently-missed
# `sed` is how this fixture was vacuous the first time: if the refusal line moves,
# no table is written, `--check` exits 1 with "is stale", and an exit-code-only
# fixture would have reported ok. Both `grep -q` guards exit non-zero, which
# aborts the suite under `set -e` — loud, not green.
TOMBSTONE_SETUP='cp scripts/mutate.ts scripts/mutate.pristine.ts
grep -q "const unmeasured = unmeasuredRows(rows);" scripts/mutate.ts \
  || { echo "FIXTURE PREMISE BROKEN: mutate.ts has no unmeasuredRows refusal to bypass"; exit 9; }
sed -i "s/const unmeasured = unmeasuredRows(rows);/const unmeasured: { label: string; reason: string }[] = [];/" scripts/mutate.ts
bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1
mv scripts/mutate.pristine.ts scripts/mutate.ts
grep -q "ANCHOR: 0 matches" scripts/mutations/f.md \
  || { echo "FIXTURE PREMISE BROKEN: the bypass wrote no committed tombstone"; exit 9; }
git add -A >/dev/null && git commit --quiet -m tombstone'
# `return 43;` appears nowhere in subject.ts, so the anchor is dead by construction.
T=$(make_tree "$GOOD_TARGET" '"  return 43;"' "$TOMBSTONE_SETUP")
check 1 "MEASURED NOTHING" \
  "a COMMITTED TOMBSTONE (dead anchor) is refused, not blessed as current" "$T" --all

# 6c. A CORPUS-ONLY EDIT SELECTS ITS SPEC (#5097).
#
# `mutate.ts --files` listed a spec's targets and edit files and nothing they
# import — so `__tests__/identity-corpus.ts` and seven siblings were invisible to
# `--affected`. Those are the highest-risk dependencies in the set: they are
# data-driven inputs, so adding one row changes the published suite size AND
# every kill count. A corpus-only PR got "nothing to verify" and exit 0.
#
# ⚠️ THE EXIT CODE CANNOT DISCRIMINATE HERE, which is why this fixture needed
# the phrase argument to exist. Pre-fix the gate exits 0 saying "nothing to
# verify"; post-fix it exits 1 saying STALE. The commit adds a corpus ROW, so
# the table genuinely goes stale and the selection has something to find.
make_corpus_tree() {
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/packages/api/src/__tests__" "$tmp/scripts"
  for f in mutate.ts mutation-core.ts mutation-spec.ts signal-retry.ts; do
    cp "$REPO_ROOT/packages/api/scripts/$f" "$tmp/packages/api/scripts/"
  done
  ln -s "$REPO_ROOT/node_modules" "$tmp/node_modules"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"

  cat >"$tmp/packages/api/src/subject.ts" <<'TS'
export function answer(): number {
  return 42;
}
TS
  cat >"$tmp/packages/api/src/__tests__/corpus.ts" <<'TS'
export const CORPUS = [1, 2];
TS
  # ⚠️ A MULTI-LINE import, deliberately: the statement-shaped regex a reader
  # reaches for matches none of these, and that is the spelling every real
  # corpus import in this repo uses.
  cat >"$tmp/packages/api/src/subject.test.ts" <<'TS'
import { expect, test } from "bun:test";
import {
  CORPUS,
} from "./__tests__/corpus";
import { answer } from "./subject";
for (const c of CORPUS) {
  test(`corpus ${c}`, () => { expect(answer()).toBe(42); });
}
test("filler", () => { expect(1).toBe(1); });
TS
  cat >"$tmp/packages/api/scripts/mutations/f.mutations.ts" <<'SPEC'
import type { MutationSpec } from "../mutation-spec";
const spec: MutationSpec = {
  title: "corpus fixture",
  out: "scripts/mutations/f.md",
  targets: [{ name: "subject", file: "src/subject.test.ts" }],
  mutations: [
    { label: "answer returns the wrong number", edits: [{ file: "src/subject.ts", oldString: "  return 42;", newString: "  return 0;" }] },
  ],
};
export default spec;
SPEC
  ( cd "$tmp/packages/api" && bun run scripts/mutate.ts scripts/mutations/f.mutations.ts >/dev/null 2>&1 )
  grep -q '| 2 |' "$tmp/packages/api/scripts/mutations/f.md" \
    || { echo "FIXTURE PREMISE BROKEN: the corpus tree's table did not record 2 kills" >&2; exit 9; }
  ( cd "$tmp" && git init --quiet -b main && git config user.email t@t.t && git config user.name t \
      && git add -A >/dev/null && git commit --quiet -m base && git branch base-ref HEAD )
  # The ONLY change: one more corpus row. Nothing the pre-fix selector could see.
  cat >"$tmp/packages/api/src/__tests__/corpus.ts" <<'TS'
export const CORPUS = [1, 2, 3];
TS
  ( cd "$tmp" && git add -A >/dev/null && git commit --quiet -m "add a corpus row" )
  echo "$tmp"
}

# ⚠️ THE PHRASE PINS THE SELECTION, not the STALE catch, and the difference
# matters. `(1, "STALE …")` is produced by TWO paths: the corpus-following
# selector, and any of four git calls WIDENING to `--all` — which also verifies
# every spec and finds this one stale. So the pair a stale-catch phrase asserts
# is not what this fixture claims to measure. `N of M spec(s) affected by this
# branch` comes only from the affected selector's own report.
T=$(make_corpus_tree)
check 1 "1 of 1 spec(s) affected by this branch" \
  "a CORPUS-ONLY commit SELECTS its spec (not a widen), and the stale table is caught" "$T" --affected base-ref

# 7. A SHARD OWNS ROWS, and the ownership is TOTAL and DISJOINT.
#
# The threat is a row that lands on no shard: verified by nothing, green
# forever — the same outcome as the four stale tables in check-mutation-tables.sh's
# header, reached through a new door. Three rows over two shards: positions 0
# and 2 belong to shard 1, position 1 to shard 2. Each case hand-edits ONE row
# of a freshly generated table and asserts which shard goes red — the owner and
# ONLY the owner — so a partition that dropped a residue class, or one that
# measured every row on every shard, both fail here. The fourth case edits the
# title, which every shard must catch: the comparison is whole-file, and a
# shard reads the rows it did not measure back from the committed table.
#
# Real runs against a three-test suite — seconds, not the minutes a real spec
# costs. Sharding of the SELECTION (which specs) is covered by case 10 below.
make_rows_tree() { # three mutations, one target; table generated and committed
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/packages/api/src" "$tmp/scripts"
  for f in mutate.ts mutation-core.ts mutation-spec.ts signal-retry.ts; do
    cp "$REPO_ROOT/packages/api/scripts/$f" "$tmp/packages/api/scripts/"
  done
  ln -s "$REPO_ROOT/node_modules" "$tmp/node_modules"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"
  cat >"$tmp/packages/api/src/subject.ts" <<'TS'
export function one(): number {
  return 11;
}
export function two(): number {
  return 12;
}
export function three(): number {
  return 13;
}
TS
  cat >"$tmp/packages/api/src/subject.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { one, three, two } from "./subject";
test("one", () => { expect(one()).toBe(11); });
test("two", () => { expect(two()).toBe(12); });
test("three", () => { expect(three()).toBe(13); });
TS
  cat >"$tmp/packages/api/scripts/mutations/r.mutations.ts" <<'SPEC'
import type { MutationSpec } from "../mutation-spec";
const spec: MutationSpec = {
  title: "rows",
  out: "scripts/mutations/r.md",
  targets: [{ name: "subject", file: "src/subject.test.ts" }],
  mutations: [
    { label: "row 1", edits: [{ file: "src/subject.ts", oldString: "  return 11;", newString: "  return 0;" }] },
    { label: "row 2", edits: [{ file: "src/subject.ts", oldString: "  return 12;", newString: "  return 0;" }] },
    { label: "row 3", edits: [{ file: "src/subject.ts", oldString: "  return 13;", newString: "  return 0;" }] },
  ],
};
export default spec;
SPEC
  ( cd "$tmp/packages/api" && bun run scripts/mutate.ts scripts/mutations/r.mutations.ts >/dev/null 2>&1 )
  ( cd "$tmp" && git init --quiet -b main && git config user.email t@t.t && git config user.name t \
      && git add -A >/dev/null && git commit --quiet -m base )
  echo "$tmp"
}

# shard_verdict TREE SHARD -> prints "rc" of the gate's --all --shard run
shard_verdict() {
  local rc=0
  ( cd "$1" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/r.mutations.ts" \
    bash scripts/check-mutation-tables.sh --all --shard "$2" >/dev/null 2>&1 ) || rc=$?
  printf '%s' "$rc"
}

T=$(make_rows_tree)
grep -q '^| row 2 | 1 |$' "$T/packages/api/scripts/mutations/r.md" \
  || { echo "  FAIL  rows fixture premise — expected a generated '| row 2 | 1 |' line"; FAIL=$((FAIL + 1)); }
a=$(shard_verdict "$T" 1/2); b=$(shard_verdict "$T" 2/2)
if [ "$a" = "0" ] && [ "$b" = "0" ]; then
  echo "  ok    a current table passes on BOTH shards of a 2-way row split"; PASS=$((PASS + 1))
else
  echo "  FAIL  current table — expected 0/0 across shards 1/2 and 2/2, got $a/$b"; FAIL=$((FAIL + 1))
fi

( cd "$T" && sed -i 's/^| row 2 | 1 |$/| row 2 | 99 |/' packages/api/scripts/mutations/r.md )
a=$(shard_verdict "$T" 1/2); b=$(shard_verdict "$T" 2/2)
if [ "$a" = "0" ] && [ "$b" = "1" ]; then
  echo "  ok    a drifted row at position 1 reddens shard 2/2 and ONLY shard 2/2"; PASS=$((PASS + 1))
else
  echo "  FAIL  row-2 drift — expected shard 1/2 → 0, shard 2/2 → 1, got $a/$b"; FAIL=$((FAIL + 1))
fi

( cd "$T" && git checkout --quiet -- packages/api/scripts/mutations/r.md && sed -i 's/^| row 3 | 1 |$/| row 3 | 99 |/' packages/api/scripts/mutations/r.md )
a=$(shard_verdict "$T" 1/2); b=$(shard_verdict "$T" 2/2)
if [ "$a" = "1" ] && [ "$b" = "0" ]; then
  echo "  ok    a drifted row at position 2 reddens shard 1/2 and ONLY shard 1/2 (positions wrap)"; PASS=$((PASS + 1))
else
  echo "  FAIL  row-3 drift — expected shard 1/2 → 1, shard 2/2 → 0, got $a/$b"; FAIL=$((FAIL + 1))
fi

( cd "$T" && git checkout --quiet -- packages/api/scripts/mutations/r.md && sed -i 's/^# rows$/# rows (edited)/' packages/api/scripts/mutations/r.md )
a=$(shard_verdict "$T" 1/2); b=$(shard_verdict "$T" 2/2)
if [ "$a" = "1" ] && [ "$b" = "1" ]; then
  echo "  ok    a drifted TITLE reddens every shard — the comparison is whole-file"; PASS=$((PASS + 1))
else
  echo "  FAIL  title drift — expected 1/1 across both shards, got $a/$b"; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

make_spec_tree() { # $1 = how many empty spec files
  local n="$1" tmp i; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/scripts"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"
  for i in $(seq 1 "$n"); do : >"$tmp/packages/api/scripts/mutations/s$i.mutations.ts"; done
  echo "$tmp"
}

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
# Anchoring constrained syntax but not magnitude: this overflowed `[`, which
# returned status 2 inside an `if` condition, which bash read as false — so the
# range check was bypassed and the run proceeded with a bogus index. The `{0,3}`
# bound in the pattern is what closes it.
shard_reject "total out of range"         "1/99999999999999999999" "--shard expects I/N"

# 9. A shard whose index exceeds every selected spec's row count is HONEST
# and exit 0: every row is owned by a lower-numbered shard, so it verified
# nothing, and it must say so rather than print the "all current" line a shard
# that measured a hundred rows prints. Three rows, shard 5 of 8.
T=$(make_rows_tree)
rc=0
out=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/r.mutations.ts" \
       bash scripts/check-mutation-tables.sh --all --shard 5/8 2>&1 ) || rc=$?
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -qF "owns no row of any" && printf '%s' "$out" | grep -qF "NONE  scripts/mutations/r.mutations.ts"; then
  echo "  ok    a shard beyond every spec's row count exits 0 and says it verified nothing"; PASS=$((PASS + 1))
else
  echo "  FAIL  over-indexed shard — expected exit 0 naming the empty shard and the NONE row, got $rc"
  printf '%s' "$out" | sed 's/^/        /' | tail -6; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

make_multi_spec_tree() { # $1 = how many specs (default 3)  $2 = which to touch (default "c")
  local count="${1:-3}" touch_list="${2:-c}"
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/packages/api/scripts/mutations" "$tmp/packages/api/src" "$tmp/scripts"
  for f in mutate.ts mutation-core.ts mutation-spec.ts signal-retry.ts; do
    cp "$REPO_ROOT/packages/api/scripts/$f" "$tmp/packages/api/scripts/"
  done
  ln -s "$REPO_ROOT/node_modules" "$tmp/node_modules"
  cp "$SCRIPT" "$tmp/scripts/check-mutation-tables.sh"
  local names n
  names=$(printf 'a b c d e f g h' | cut -d' ' -f1-"$count")
  for n in $names; do
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
      && git add -A >/dev/null && git commit --quiet -m base && git branch base-ref HEAD )
  local t
  for t in $touch_list; do echo "// touched" >> "$tmp/packages/api/src/$t.ts"; done
  ( cd "$tmp" && git add -A >/dev/null && git commit --quiet -m "touch $touch_list" )
  echo "$tmp"
}

# 10. SHARDING NEVER NARROWS THE SELECTION. Under the spec-level partition this
# replaced, an --affected spec was owned by ONE shard and a widen on a sibling
# could renumber it out of existence. Now every shard selects every affected
# spec and partitions its rows: three specs, only the third touched, all four
# shards must list it.
T=$(make_multi_spec_tree)
OWNERS=""
for s in 1 2 3 4; do
  raw=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
         bash scripts/check-mutation-tables.sh --affected base-ref --shard "$s/4" --list-only 2>/dev/null ) || true
  if printf '%s\n' "$raw" | grep -q '^SELECTED scripts/mutations/c.mutations.ts$'; then OWNERS="${OWNERS}${s} "; fi
done
if [ "$OWNERS" = "1 2 3 4 " ]; then
  echo "  ok    every shard selects the affected spec — the partition is of rows, not of the selection"
  PASS=$((PASS + 1))
else
  echo "  FAIL  affected-spec selection under --shard — expected every shard to list c, got owners='$OWNERS'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# 11. The runner's own guards on `--shard`, since the gate is not the only
# caller: a partial measurement has no table to write, and --only/--target
# would make "which rows" ambiguous.
T=$(make_rows_tree)
rc=0
out=$( cd "$T/packages/api" && bun run scripts/mutate.ts scripts/mutations/r.mutations.ts --shard 1/2 2>&1 ) || rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -qF "only meaningful with --check"; then
  echo "  ok    mutate.ts refuses --shard without --check"; PASS=$((PASS + 1))
else
  echo "  FAIL  --shard without --check — expected exit 1, got $rc"; FAIL=$((FAIL + 1))
fi
rc=0
out=$( cd "$T/packages/api" && bun run scripts/mutate.ts scripts/mutations/r.mutations.ts --check --shard 1/2 --only "row 1" 2>&1 ) || rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -qF "cannot be combined with --only"; then
  echo "  ok    mutate.ts refuses --shard combined with --only"; PASS=$((PASS + 1))
else
  echo "  FAIL  --shard with --only — expected exit 1, got $rc"; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# 12. --list-only declines: exit 3, never 0. Both helpers above discard the
# status with `|| true`, so nothing observed the 0 -> 3 change until this.
T=$(make_spec_tree 5)
rc=0
out=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
       bash scripts/check-mutation-tables.sh --all --list-only 2>&1 ) || rc=$?
if [ "$rc" = "3" ] && printf '%s' "$out" | grep -qF "nothing verified"; then
  echo "  ok    --list-only exits 3 (declined), not 0 (verified)"; PASS=$((PASS + 1))
else
  echo "  FAIL  --list-only — expected exit 3 saying nothing verified, got $rc"; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# 13. --shard twice is an error, not last-wins.
T=$(make_spec_tree 5)
rc=0
out=$( cd "$T" && TEST_DATABASE_URL=x MUTATION_SPEC_GLOB="scripts/mutations/*.mutations.ts" \
       bash scripts/check-mutation-tables.sh --all --list-only --shard 1/4 --shard 2/4 2>&1 ) || rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -qF "given twice"; then
  echo "  ok    a repeated --shard is rejected rather than silently last-wins"; PASS=$((PASS + 1))
else
  echo "  FAIL  repeated --shard — expected exit 1 saying 'given twice', got $rc"; FAIL=$((FAIL + 1))
fi
rm -rf "$T"

# ⚠️ AN ABSOLUTE LITERAL, and this suite is the one that most needed it: its own
# recorded history is TWO fixtures deleted in #5077, and this change reinstates
# five. A count derived from the cases cannot notice a deleted case — measured on
# `check-docs-brain-snippets.test.sh`, which reported `40 passed, 0 failed` with
# cases removed. Its three sibling suites in this change all carry one; this file
# shipped without, which is exactly the asymmetry a reviewer caught.
EXPECTED_CASES=31
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  echo "  ok    all $EXPECTED_CASES cases ran"; PASS=$((PASS + 1))
else
  echo "  FAIL  expected $EXPECTED_CASES cases, $TOTAL ran — a fixture was added or deleted without updating EXPECTED_CASES"
  FAIL=$((FAIL + 1))
fi

echo ":: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
