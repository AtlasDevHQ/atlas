#!/bin/bash
# Adversarial fixture suite for scripts/check-brain-settings-doc.ts (#5161).
#
# The guard holds the "## Company Atlas" env-var table to the settings registry
# it describes. It exists because a prose claim outlived its own subject: #5159
# added two rows and corrected the count, while the two new keys did not carry
# `saasVisible: false` — so the "all N are hidden … a workspace admin cannot
# read or write any of them" sentence became false of its enlarged set with the
# number still right.
#
# ⚠️ The mutations below are anchored on the COMMITTED sentence, so every PR
# that adds a Company Atlas key re-anchors them — the script fails loudly with
# "fixture sed matched nothing" rather than going quietly blind, which is the
# whole point and is how #5213 found this line.
#
# ## Why this suite exists AT ALL
#
# A guard nobody has proved can fail is worth less than no guard, because it
# reads as coverage. That is not hypothetical here: review empirically falsified
# TWO arms of the first draft. `Three of them are **workspace-scoped**` and
# `3 are **workspace-scoped**` each disabled the workspace-scope check silently,
# at exit 0, with no output — while the identical shapes in the hidden-count
# check failed loudly, because that check pushes a failure when its sentence is
# missing or unreadable and the workspace one did not. Fixtures W-REWORD and
# W-DIGITS below pin those two shapes so the asymmetry cannot come back.
#
# ## Every FAILURE fixture asserts a MARKER, not just a non-zero exit
#
# `bun` exits 1 on an uncaught exception too, so an exit code alone cannot tell
# "the arm I meant fired" from "the guard crashed" or "a different arm fired" —
# and several mutations below legitimately trip more than one arm. Each `check
# fail` names a substring only its own arm prints. The three PASS fixtures are
# all a no-op guard would satisfy, which is exactly what the failure fixtures
# rule out.
#
# ## Coverage: both directions, plus the vacuity floor
#
#   • doc side     — the prose drifts from the registry (the #5159 defect);
#   • registry side — a key changes visibility or writability under a page that
#                     claims neither (the #5161 defect itself, and its
#                     split-axis variant, which the first draft did not check);
#   • closure      — a registry key that never reached the table, invisible to
#                    every doc-driven check because they all iterate `documented`;
#   • vacuity      — the section, the table shape, or the registry namespace
#                    moves and the guard stops selecting anything, which is the
#                    failure mode a regex-over-prose gate is uniquely exposed
#                    to. The last of those mutates the GUARD, because a
#                    locator's floor can only be proved by making the locator
#                    select nothing — which is why the guard is backed up too.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-brain-settings-doc.ts"
DOC="$ROOT/apps/docs/content/shared/reference/environment-variables.mdx"
REG="$ROOT/packages/api/src/lib/settings.ts"
GUIDE="$ROOT/apps/docs/content/shared/guides/atlas-vocabulary.mdx"

if [ ! -f "$GUARD" ]; then
  echo "::error::guard under test not found at $GUARD" >&2
  exit 2
fi
for f in "$DOC" "$REG"; do
  if [ ! -f "$f" ]; then
    echo "::error::fixture target not found at $f" >&2
    exit 2
  fi
done

run_guard() { (cd "$ROOT" && bun "$GUARD") 2>&1; }

# ── Baseline BEFORE any backup and BEFORE the trap ───────────────────────────
#
# This repo is a SHARED working tree and this suite rewrites tracked files in
# place. Every fixture regresses FROM a tree the guard passes on, so a backup
# taken while a concurrent run had a file mid-mutation would be written back by
# restore() as the "good" baseline — persisting drift silently, which is worse
# than the drift the guard catches. The check is the GUARD ITSELF, because it is
# the only predicate that covers every state this suite can create.
#
# It runs before the EXIT trap is installed, so this exit cannot restore a
# poisoned backup over a good file.
if ! baseline="$(run_guard)"; then
  echo "::error::the guard does NOT pass on the current tree, so no trustworthy baseline can be captured." >&2
  echo "::error::Refusing to run (no backups taken, nothing mutated). Either the tree has real drift, or a concurrent run has a fixture target mid-mutation." >&2
  printf '%s\n' "$baseline" | sed 's/^/::error::  | /' >&2
  exit 2
fi

PASS=0
FAIL=0

# Backups are content-addressed against git, not merely `cp`-ed. `restore()`
# compares the file against the backup it was written from, so it can detect a
# failed restore but never a BAD backup: with a full or read-only TMPDIR
# `mktemp` succeeds, `cp` fails, every restore then writes a zero-byte file over
# a tracked page, and `cmp` reports success (empty == empty).
DOC_BACKUP="$(mktemp)" || exit 2
REG_BACKUP="$(mktemp)" || exit 2
# The GUARD itself is backed up too, because one fixture mutates it: both of its
# locators (the section heading, the registry key prefix) select a whole check's
# subject, and the only way to prove a locator's vacuity floor fires is to make
# the locator select nothing.
GUARD_BACKUP="$(mktemp)" || exit 2
DOC_SHA="$(git -C "$ROOT" hash-object "$DOC")" || exit 2
REG_SHA="$(git -C "$ROOT" hash-object "$REG")" || exit 2
GUARD_SHA="$(git -C "$ROOT" hash-object "$GUARD")" || exit 2
# Check 4's subject is a GUIDE, not the reference page — the drift it exists to
# catch is a default restated in prose somewhere the table-parsing checks above
# never look.
GUIDE_BACKUP="$(mktemp)" || exit 2
GUIDE_SHA="$(git -C "$ROOT" hash-object "$GUIDE")" || exit 2
for pair in "$DOC:$DOC_BACKUP" "$REG:$REG_BACKUP" "$GUARD:$GUARD_BACKUP" "$GUIDE:$GUIDE_BACKUP"; do
  src="${pair%:*}"; dst="${pair##*:}"
  if ! cp "$src" "$dst" || ! cmp -s "$src" "$dst"; then
    echo "::error::could not take a verified backup of $src (TMPDIR full or read-only?). Refusing to run — nothing has been mutated." >&2
    rm -f "$DOC_BACKUP" "$REG_BACKUP" "$GUARD_BACKUP" "$GUIDE_BACKUP"
    exit 2
  fi
done

# Restore must be TOTAL and VERIFIED, against the git object id rather than the
# backup. `set -e` is off here and every step is checked explicitly, because a
# bare sequence of `cp`s aborts on the first failure and leaves the remaining
# mutation — a registry key with its `saasVisible: false` deleted — in the tree.
#
# `--preserve=timestamps` so a restored file does not read as `M` in git status
# through stat-cache staleness, which in a shared worktree looks exactly like
# the suite having left something behind.
RESTORED=0
restore() {
  # Idempotent via an explicit flag, NOT via "does a backup file still exist".
  # That test conflates "already restored, nothing to do" with "my backup
  # vanished" — and the second is total silence: the trap returns 0, the two
  # backups it never consulted are ignored, and a mutated registry and guard
  # stay in the tree behind a green run.
  [ "$RESTORED" -eq 1 ] && return 0
  local b
  for b in "$DOC_BACKUP" "$REG_BACKUP" "$GUARD_BACKUP" "$GUIDE_BACKUP"; do
    if [ ! -f "$b" ]; then
      echo "::error::backup $b vanished before restore — the tree may still hold a fixture mutation." >&2
      echo "::error::Recover with: git checkout -- '$DOC' '$REG' '$GUARD' '$GUIDE'" >&2
      return 1
    fi
  done
  local rc=0
  cp --preserve=timestamps "$DOC_BACKUP" "$DOC" || rc=1
  cp --preserve=timestamps "$REG_BACKUP" "$REG" || rc=1
  cp --preserve=timestamps "$GUARD_BACKUP" "$GUARD" || rc=1
  cp --preserve=timestamps "$GUIDE_BACKUP" "$GUIDE" || rc=1
  if [ "$rc" -ne 0 ] ||
     [ "$(git -C "$ROOT" hash-object "$DOC")" != "$DOC_SHA" ] ||
     [ "$(git -C "$ROOT" hash-object "$REG")" != "$REG_SHA" ] ||
     [ "$(git -C "$ROOT" hash-object "$GUARD")" != "$GUARD_SHA" ] ||
     [ "$(git -C "$ROOT" hash-object "$GUIDE")" != "$GUIDE_SHA" ]; then
    echo "::error::RESTORE FAILED — a fixture mutation may still be in the tree." >&2
    echo "::error::Backups KEPT. Recover NON-DESTRUCTIVELY first:" >&2
    echo "::error::  cp '$DOC_BACKUP' '$DOC' && cp '$REG_BACKUP' '$REG' && cp '$GUARD_BACKUP' '$GUARD' && cp '$GUIDE_BACKUP' '$GUIDE'" >&2
    echo "::error::Only if those are gone: git checkout -- '$DOC' '$REG' '$GUARD' '$GUIDE'  (discards any unrelated uncommitted edits to them)" >&2
    return 1
  fi
  RESTORED=1
  rm -f "$DOC_BACKUP" "$REG_BACKUP" "$GUARD_BACKUP" "$GUIDE_BACKUP"
}

# ⚠️ `trap restore EXIT` alone is NOT enough. A non-zero RETURN from an EXIT
# trap is discarded by bash, so the verification above would be decoration: the
# suite would print "RESTORE FAILED" and still exit 0, and CI would record a
# PASS with a mutated registry in the tree. `|| exit 2` is what makes it mean
# something. An INT/TERM handler that merely returns lets the script CONTINUE
# with its backups already deleted, so those exit explicitly.
trap 'restore || exit 2' EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM

# check <pass|fail> <name> <marker-if-fail>
#
# The marker is MANDATORY on `fail`, enforced rather than documented: an
# optional one degrades silently to "exit 1 and the output says FAIL", which
# several unrelated arms satisfy, so a fixture written without it would measure
# roughly nothing while reading as a passing fixture. That is the same
# quiet-zero shape this suite exists to rule out, one layer up.
check() {
  local expected="$1" name="$2" marker="${3:-}"
  local status=0 out

  if [ "$expected" = "fail" ] && [ -z "$marker" ]; then
    echo "::error::fixture '$name' is a 'fail' check with no marker — see check()'s contract." >&2
    exit 2
  fi

  out="$(run_guard)" || status=$?

  local ok=1
  if [ "$expected" = "pass" ]; then
    [ "$status" -eq 0 ] || ok=0
  else
    [ "$status" -eq 1 ] || ok=0
    printf '%s' "$out" | grep -qF 'FAIL' || ok=0
    printf '%s' "$out" | grep -qF -- "$marker" || ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    if [ -n "$marker" ]; then echo "       marker sought: $marker" >&2; fi
    printf '%s' "$out" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  fi
}

# mutate <file> <backup> <sed-script> — apply and PROVE it landed. A pattern
# that matches nothing leaves the file untouched, and the fixture would then be
# asserting the guard fails on the PRISTINE tree — a false green reading as "the
# guard stopped detecting X".
mutate() {
  local file="$1" backup="$2" script="$3"
  sed -i "$script" "$file"
  if cmp -s "$file" "$backup"; then
    echo "::error::fixture sed matched nothing: $script" >&2
    echo "::error::The anchored pattern has drifted from the committed text of $file. Update the pattern." >&2
    exit 2
  fi
}
# Verified against the git object id, exactly as `restore()` is. `mutate()`'s
# proof-it-landed is `cmp` against the BACKUP — a relative test — so an
# inter-fixture restore that wrote wrong content would make the next `mutate`
# see a difference, declare its sed landed, and assert against a leftover
# mutation. The arm-specific markers backstop that, but there is no reason for
# the weaker check.
restore_verified() {
  local file="$1" backup="$2" sha="$3"
  cp --preserve=timestamps "$backup" "$file" || { echo "::error::inter-fixture restore of $file failed" >&2; exit 2; }
  if [ "$(git -C "$ROOT" hash-object "$file")" != "$sha" ]; then
    echo "::error::inter-fixture restore of $file did not reproduce its committed content" >&2
    exit 2
  fi
}
restore_doc() {
  restore_verified "$DOC" "$DOC_BACKUP" "$DOC_SHA"
}
restore_guide() {
  restore_verified "$GUIDE" "$GUIDE_BACKUP" "$GUIDE_SHA"
}
restore_reg() {
  restore_verified "$REG" "$REG_BACKUP" "$REG_SHA"
}
restore_guard() {
  restore_verified "$GUARD" "$GUARD_BACKUP" "$GUARD_SHA"
}

echo "check-brain-settings-doc.test.sh: adversarial fixtures"

# --- the pristine tree passes ------------------------------------------------
check pass "the committed tree is in sync"

# --- registry side: the #5161 defect itself ----------------------------------
# The `saasVisible: false` line sits directly under a comment unique to it, so
# the anchor cannot drift onto another key.
mutate "$REG" "$REG_BACKUP" '/still platform-admin-only on Cloud\./{n;d}'
check fail "a documented key losing saasVisible: false is caught" \
  "resolves saasVisible=true"
restore_reg

# --- registry side: the SPLIT-AXIS variant the first draft missed ------------
# `saasVisible: false, saasWritable: true` is legitimate elsewhere in this
# registry (keys managed by a dedicated admin page), which is exactly why it is
# dangerous here: it satisfies the read half of the sentence while making the
# write half false, and the guard checked only the read half.
mutate "$REG" "$REG_BACKUP" '/still platform-admin-only on Cloud\./{n;a\
    saasWritable: true,
}'
check fail "a documented key made Cloud-WRITABLE while staying hidden is caught" \
  "resolves saasWritable=true"
restore_reg

# --- closure: a registry key that never reached the table --------------------
# Every other check iterates `documented`, so this direction is invisible to all
# of them — the #5161 defect one level over.
mutate "$DOC" "$DOC_BACKUP" '/^| `ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS`/d'
check fail "a registry brain key with no doc row is caught" \
  "is in the settings registry but has no row"
restore_doc

# --- doc side: the hidden-count sentence -------------------------------------
mutate "$DOC" "$DOC_BACKUP" 's/All fifteen are hidden/All fourteen are hidden/'
check fail "a stale hidden-count is caught" \
  'but the table lists'
restore_doc

mutate "$DOC" "$DOC_BACKUP" 's/All fifteen are hidden from the generic settings page/All of them are concealed from the generic settings page/'
check fail "REWORDING the hidden-count sentence fails loudly rather than going blind" \
  '"all N are hidden" sentence is gone'
restore_doc

# The hidden-count sentence's UNREADABLE arm. Its workspace twin has W-REWORD;
# leaving this one unfixtured would recreate, inside the fixture suite, the very
# asymmetry between the two checks that this suite exists because of.
mutate "$DOC" "$DOC_BACKUP" 's/All fifteen are hidden from the generic settings page/All keys are hidden from the generic settings page/'
check fail "an unreadable hidden-count fails loudly" \
  'as a number word in the hidden-count sentence'
restore_doc

# The doc→registry direction: a row naming a key the registry does not have.
# This is the mirror of the closure check, and the arm that catches a typo'd
# key name in the table. It also trips the count arm, so the marker is what
# makes the fixture discriminate.
mutate "$DOC" "$DOC_BACKUP" '/^| `ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS`/i\| `ATLAS_BRAIN_NOT_REAL` | `1` | fixture row |'
check fail "a doc row naming a key the registry lacks is caught" \
  'is documented in'
restore_doc

# --- doc side: the workspace-scoped sentence ---------------------------------
# ⚠️ W-REWORD and W-DIGITS are the two review empirically falsified. Before the
# fix both exited 0 with no output, silently disabling the workspace check while
# the run still reported PASS.
mutate "$DOC" "$DOC_BACKUP" 's/Five are \*\*workspace-scoped\*\*/Five of them are **workspace-scoped**/'
check fail "W-REWORD: the reword that used to disable this check now fails loudly" \
  'Could not read "them" as a count in the workspace-scoped sentence'
restore_doc

# The other half: the sentence removed outright rather than reworded. Different
# arm, different marker — a reword still MATCHES the pattern (capturing a
# non-count word), so only a deletion reaches the missing-sentence branch.
mutate "$DOC" "$DOC_BACKUP" 's/ Five are \*\*workspace-scoped\*\* — meaning each can hold a different value per workspace, set by a platform admin: `ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED`, `ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED`, `ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED` and the two alias auto-approval keys.//'
check fail "W-MISSING: deleting the workspace sentence fails loudly rather than going blind" \
  'workspace-scoped**" sentence is gone'
restore_doc

mutate "$DOC" "$DOC_BACKUP" 's/Five are \*\*workspace-scoped\*\*/Six are **workspace-scoped**/'
check fail "a stale workspace-scoped count is caught" \
  'are workspace-scoped" but'
restore_doc

# W-DIGITS is a PASS fixture: digits are a legitimate reword, and the first
# draft treated them as "unreadable" and fell through to silence. The count is
# still verified — `5` is the true number, so this must pass for the right
# reason, which the next fixture pins by making the digit WRONG.
mutate "$DOC" "$DOC_BACKUP" 's/Five are \*\*workspace-scoped\*\*/5 are **workspace-scoped**/'
check pass "W-DIGITS: a digit count is read, not silently skipped"
restore_doc

mutate "$DOC" "$DOC_BACKUP" 's/Five are \*\*workspace-scoped\*\*/7 are **workspace-scoped**/'
check fail "W-DIGITS is not vacuous — a WRONG digit count is caught" \
  'are workspace-scoped" but'
restore_doc

# --- vacuity floor -----------------------------------------------------------
mutate "$DOC" "$DOC_BACKUP" 's/^## Company Atlas$/## Company Atlas Settings/'
check fail "renaming the section fails rather than silently checking nothing" \
  'section in'
restore_doc

# Reorder the table so the variable is no longer the first cell: the rows still
# exist, but the row regex matches none of them. A guard that reported success
# here would be reporting on zero keys.
mutate "$DOC" "$DOC_BACKUP" 's/^| `ATLAS_BRAIN_/| x | `ATLAS_BRAIN_/'
check fail "a table shape change that parses zero rows trips the vacuity floor" \
  'parsed zero variable rows'
restore_doc

# --- the OTHER locator's vacuity floor ---------------------------------------
# The registry-side selector is the twin of the section heading: a hardcoded
# string choosing check 1b's whole subject. A fix-vs-finding pass on the commit
# that added that check found it had no floor — it would have measured the empty
# set and passed, which is the defect the heading anchor had just been fixed for.
# Mutating the prefix is the only way to make the selector select nothing.
mutate "$GUARD" "$GUARD_BACKUP" 's/^const BRAIN_KEY_PREFIX = "ATLAS_BRAIN_";$/const BRAIN_KEY_PREFIX = "ATLAS_CEREBRUM_";/'
check fail "a stale registry-key prefix trips its own vacuity floor" \
  'no settings-registry keys start with'
restore_guard

# --- check 4: a default RESTATED IN A GUIDE ----------------------------------
# Checks 1-3 parse the reference TABLE. A guide that repeats a default in prose
# is invisible to all of them, and the guide is what a reader acts on. Both arms
# below were run by hand against the commit that added check 4; they live here
# so the next change to the registry has to face them.
mutate "$GUIDE" "$GUIDE_BACKUP" 's/which ships as `1`/which ships as `0.9`/'
check fail "a guide restating a STALE default is caught" \
  'ships as `0.9`, but the registry default is `1`'
restore_guide

# The vacuity twin, on this file's standing rule: the matcher is phrase-pinned,
# so a legitimate reword empties its subject. It must fail loudly rather than
# scan the whole docs tree and report success.
mutate "$GUIDE" "$GUIDE_BACKUP" 's/which ships as/which is shipped as/g'
check fail "REWORDING every shipped-default phrase fails loudly rather than going blind" \
  'no longer carries a'
restore_guide

# ⚠️ THE GRANULARITY ARM, and the one the first cut of check 4 failed. The
# fixture above rewords BOTH claims, which is the only shape an aggregate
# `length === 0` floor can detect — so it proved a floor existed and could not
# falsify its granularity. Rewording ONE claim is the realistic copy edit, and
# it used to leave that claim silently unguarded while the other kept the run
# green. Anchored on THRESHOLD specifically so the SOURCES claim still matches.
mutate "$GUIDE" "$GUIDE_BACKUP" 's/which ships as `1`/whose shipped value is `1`/'
check fail "rewording ONE claim is caught — the floor is per-claim, not aggregate" \
  'ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD` … ships as `value`'
restore_guide

# The MISPAIRING arm: the spans must not cross another backticked token, or a
# sentence naming two keys binds the first to the second's value and skips the
# real pair. Fails as a registry mismatch (`warehouse_key` != `1`) rather than
# silently — and would NOT fail if the regex used `[^\n]`.
# With the loose `[^\n]` spans, SOURCES would bind to THRESHOLD's `1` and fail
# as a mismatch; with `[^`\n]` it cannot reach past THRESHOLD's backticks, so
# each key binds to its own value and the run stays green.
mutate "$GUIDE" "$GUIDE_BACKUP" 's/^3\. The proposal.s confidence clears/3. Unlike `ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES`, the confidence clears/'
check pass "a sentence naming two keys binds each to its OWN value, not the neighbour's"
restore_guide

# --- restored tree passes again ----------------------------------------------
check pass "restored doc + registry + guard are in sync again"

echo ""
echo "check-brain-settings-doc.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
