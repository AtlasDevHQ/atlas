#!/bin/bash
# Adversarial fixture suite for scripts/check-docs-brain-snippets.ts (#5165).
#
# The gate compares published `Brain*` contract snippets in apps/docs against the
# real declarations under packages/*/src and ee/src. This suite proves it can
# actually FAIL — the guard exists because the drift it catches (a required
# `audience` member missing from a page that calls itself "the contract") sat in
# the tree unnoticed, so a green-but-vacuous guard would be worse than none.
#
# ## The 19 FAILURE fixtures each assert a MARKER, not just a non-zero exit
#
# `bun` exits 1 on an uncaught exception too, so an exit code alone cannot tell
# "the arm I meant reported a violation" from "the guard crashed" or "a DIFFERENT
# arm fired". Each `check fail` below names a substring only its own arm prints,
# on `scripts/__tests__/check-docs-links.test.sh`'s precedent. Without this, a
# review measured nine of the then-eleven fixtures satisfied by `process.exit(3)`
# at the top of the guard — and it is load-bearing beyond that: five of the nine
# mutations still exit 1 (they fall through to the vacuity floor), so ONLY the
# marker distinguishes them.
#
# The other 2 of the 21 are `check pass` fixtures, which assert exit 0 and
# structurally cannot name a marker. Those are the two a no-op guard would satisfy
# — which is exactly what the 19 exist to rule out.
#
# ## Every mutation is asserted to have LANDED
#
# Each `sed` is anchored to exact committed text. A pattern that matches nothing
# leaves the file untouched, and the fixture would then be asserting that the
# guard fails on the PRISTINE tree — a false green that reads as "the guard
# stopped detecting X". `mutate()` refuses to continue if the file did not change,
# and `require_line()` refuses an anchor that resolves to nothing, which is the
# same defect one layer up (an empty sed ADDRESS applies file-wide).
#
# ## Coverage: three directions plus the arms that only a fixture can reach
#
#   • doc side  — the page drifts while the code moves on (the #5165 defect);
#   • code side — the interface grows a member or an arm and the page is not
#                 updated (the same defect from the other direction, and the one a
#                 feature PR actually produces);
#   • vacuity   — the page stops publishing a floored contract, or the fence
#                 scanner stops reading it, which is the failure mode a
#                 discovered-both-sides guard is uniquely exposed to;
#   • plus the arms a review proved were unfalsified. Three are refusal branches
#     whose design claim is "loud, never a skip" (an opaque real declaration, an
#     opaque published snippet, an interface/union mismatch) and each could be
#     turned into a bare `continue` with the suite still green. The other two
#     failed differently: an INVENTED member survived deleting the `extra` arm,
#     and BOTH globs survived being collapsed to literal paths.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-docs-brain-snippets.ts"
DOC="$ROOT/apps/docs/content/shared/guides/brain-connector-authoring.mdx"
TYPES="$ROOT/packages/api/src/lib/brain/ingest/types.ts"
# A throwaway second doc file, so the DOCS_GLOB half of "both sides are
# discovered" is falsifiable. Removed by restore().
EXTRA_DOC="$ROOT/apps/docs/content/shared/guides/__fixture-brain-snippets-probe.mdx"

if [ ! -f "$GUARD" ]; then
  echo "::error::guard under test not found at $GUARD" >&2
  exit 2
fi
for f in "$DOC" "$TYPES"; do
  if [ ! -f "$f" ]; then
    echo "::error::fixture target not found at $f" >&2
    exit 2
  fi
done
if [ -e "$EXTRA_DOC" ]; then
  echo "::error::$EXTRA_DOC already exists — refusing to overwrite. A previous run may have been SIGKILLed; delete it." >&2
  exit 2
fi

run_guard() { (cd "$ROOT" && bun "$GUARD") 2>&1; }

# ── Baseline, established BEFORE any backup and BEFORE the trap ──────────────
#
# CLAUDE.md: this repo is a SHARED working tree, and this suite rewrites tracked
# files in place. Every fixture regresses FROM a tree the guard passes on, so a
# backup taken while a concurrent run had a file mid-mutation would be written
# back by restore() as the "good" baseline — persisting drift silently, which is
# the one outcome worse than the drift this guard catches.
#
# The check is the GUARD ITSELF rather than a substring grep. The old greps said
# nothing about a renamed member, a dropped union arm, or the code-side probe —
# all three leave `readonly audience:` intact — so they covered 2 of the 9
# windows. Running the guard covers every window this suite can create, because
# each fixture is defined by the guard failing on it.
#
# Not "content-addressed" — it is a semantic-equivalence check, and its
# completeness rests on an assumption worth naming: the only plausible concurrent
# writer is another instance of THIS suite, every one of whose states the guard
# refuses. A concurrent edit to a part of either file the guard does not compare
# would pass here and be reverted by `restore()` (see the residual below).
#
# It runs before `trap restore EXIT` is installed, so this exit cannot restore a
# poisoned backup over a good file — the previous version installed the trap
# first, and its own message claimed the opposite.
#
# Residuals, stated rather than implied. Two, and the second is the wider one:
#   • a concurrent run can mutate a file between this check and the `cp` below —
#     milliseconds, and not closable without locking;
#   • `restore()` writes the START-OF-RUN backup at the END (~30s and 22 guard
#     spawns later), so any concurrent edit made DURING the run is reverted and
#     reported as a successful restore. That window is the whole run, not
#     milliseconds.
# CI runs in an isolated checkout, where neither can occur.
if ! baseline="$(run_guard)"; then
  echo "::error::the guard does NOT pass on the current tree, so no trustworthy baseline can be captured." >&2
  echo "::error::Refusing to run (no backups taken, nothing mutated). Either the tree has real drift, or a concurrent run has a fixture target mid-mutation." >&2
  printf '%s\n' "$baseline" | sed 's/^/::error::  | /' >&2
  exit 2
fi

PASS=0
FAIL=0

# The BACKUPS are checked too, and that is not paranoia about `cp`. The
# verification in `restore()` compares the file against the backup it was just
# written from, so it can detect a failed restore but NEVER a bad backup: with a
# full or read-only TMPDIR, `mktemp` succeeds, the `cp` fails, every restore then
# writes a zero-byte file over a tracked page, and `cmp` reports success
# (empty == empty) before deleting the evidence. Content-address against git so a
# truncated or partial backup cannot masquerade as a good one.
DOC_BACKUP="$(mktemp)" || exit 2
TYPES_BACKUP="$(mktemp)" || exit 2
DOC_SHA="$(git hash-object "$DOC")" || exit 2
TYPES_SHA="$(git hash-object "$TYPES")" || exit 2
for pair in "$DOC:$DOC_BACKUP" "$TYPES:$TYPES_BACKUP"; do
  src="${pair%:*}"; dst="${pair##*:}"
  if ! cp "$src" "$dst" || ! cmp -s "$src" "$dst"; then
    echo "::error::could not take a verified backup of $src (TMPDIR full or read-only?). Refusing to run — nothing has been mutated." >&2
    rm -f "$DOC_BACKUP" "$TYPES_BACKUP"
    exit 2
  fi
done

# Restore must be TOTAL and VERIFIED. The previous version was a bare sequence of
# `cp`s under `set -e`, so a failing first `cp` aborted the function and left the
# `types.ts` mutation — a required member added to `BrainSourceConnector` — in the
# tree, with `cp`'s stderr as the only signal. `set -e` is off in this file and
# every step is checked explicitly instead, including the two inter-fixture
# helpers below.
#
# Verified against the GIT OBJECT ID taken above, not against the backup, for the
# reason in the backup block.
#
# `--preserve=timestamps` so a restored file does not read as `M` in `git status`
# through stat-cache staleness, which in a shared worktree looks exactly like the
# suite having left something behind.
restore() {
  # Idempotent: the INT/TERM traps below run it and then exit, but bash also runs
  # the EXIT trap on the way out. Without this, the second pass would `cp` from
  # backups the first pass deleted.
  [ -f "$DOC_BACKUP" ] || return 0
  local rc=0
  cp --preserve=timestamps "$DOC_BACKUP" "$DOC" || rc=1
  cp --preserve=timestamps "$TYPES_BACKUP" "$TYPES" || rc=1
  rm -f "$EXTRA_DOC" || rc=1
  if [ "$rc" -ne 0 ] ||
     [ "$(git hash-object "$DOC")" != "$DOC_SHA" ] ||
     [ "$(git hash-object "$TYPES")" != "$TYPES_SHA" ]; then
    echo "::error::RESTORE FAILED — a fixture mutation may still be in the tree." >&2
    echo "::error::Backups KEPT. Recover NON-DESTRUCTIVELY first:" >&2
    echo "::error::  cp '$DOC_BACKUP' '$DOC' && cp '$TYPES_BACKUP' '$TYPES' && rm -f '$EXTRA_DOC'" >&2
    echo "::error::Only if those are gone: git checkout -- '$DOC' '$TYPES'  (discards any unrelated uncommitted edits to them)" >&2
    return 1
  fi
  rm -f "$DOC_BACKUP" "$TYPES_BACKUP"
}

# ⚠️ `trap restore EXIT` is NOT enough, and both halves of this were measured.
#
# A non-zero RETURN from an EXIT trap does not become the script's exit status —
# bash discards it. So the whole restore-verification above was decoration: on the
# path it was written for, the suite printed "RESTORE FAILED — a fixture mutation
# may still be in the tree" and then exited 0, `g_gate_fixtures` recorded a PASS,
# and CI went green with a required member added to `BrainSourceConnector` still in
# `packages/api`. `|| exit 2` is what makes the verification mean anything.
#
# And an INT/TERM handler that merely returns lets the script CONTINUE: the old
# `trap restore EXIT INT TERM` restored, deleted both backups, then ran the
# remaining fixtures with no backups at all — `cmp` against a missing file reads as
# "the sed landed", and every later restore silently did nothing. The explicit
# `exit` is what actually stops the run.
trap 'restore || exit 2' EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM

# check <pass|fail> <name> [marker]
#
# `fail` asserts exit status 1 — the guard's own violation code — AND that the
# output contains `marker`. Anything else (a crash, a different arm firing) is a
# fixture failure, and the guard's output is printed so the reason is visible
# instead of a bare `got status=1`.
check() {
  local expected="$1" name="$2" marker="${3:-}"
  local status=0 out
  out="$(run_guard)" || status=$?

  local ok=1
  if [ "$expected" = "pass" ]; then
    [ "$status" -eq 0 ] || ok=0
  else
    [ "$status" -eq 1 ] || ok=0
    printf '%s' "$out" | grep -qF '[docs-brain-snippets] FAIL' || ok=0
    if [ -n "$marker" ]; then
      printf '%s' "$out" | grep -qF -- "$marker" || ok=0
    fi
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

# mutate <file> <backup> <sed-script> — apply and prove it landed.
mutate() {
  local file="$1" backup="$2" script="$3"
  sed -i "$script" "$file"
  if cmp -s "$file" "$backup"; then
    echo "::error::fixture sed matched nothing: $script" >&2
    echo "::error::The anchored pattern has drifted from the committed text of $file, so the fixture below would assert that the guard fails on the PRISTINE tree. Update the pattern." >&2
    exit 2
  fi
}
# Checked, because these are the only writes between fixtures: an unchecked `cp`
# failing here leaves the PREVIOUS fixture's mutation live for every fixture after
# it, and with `set -e` off nothing would say so.
restore_doc() {
  cp --preserve=timestamps "$DOC_BACKUP" "$DOC" || { echo "::error::inter-fixture restore of $DOC failed" >&2; exit 2; }
}
restore_types() {
  cp --preserve=timestamps "$TYPES_BACKUP" "$TYPES" || { echo "::error::inter-fixture restore of $TYPES failed" >&2; exit 2; }
}

# The fence fixtures need to address FENCE lines, which carry no distinguishing
# text of their own — every one of them is exactly "```". Resolving them by
# content-relative position rather than by a hard-coded line number is not a
# stylistic choice: an earlier draft used literal line numbers, and they went stale
# the moment a Callout was added to this page mid-review. `mutate()` caught it,
# which is the point — but a fixture that needs re-numbering on every prose edit is
# a fixture that eventually gets deleted instead of fixed.
#
# ⚠️ EVERY resolution is checked, and this is not defensive habit — it is the
# defect `mutate()` was added to catch, arriving one layer up. An unresolved anchor
# printed the empty string, and `set -u` does not fire because the variable IS
# assigned. `sed -i "s/^X$/Y/"` with an EMPTY address applies to every matching
# line in the file, and `mutate()`'s "did the file change?" test passes happily —
# so three fence fixtures would have indented, blanked or relabelled EVERY fence on
# the page and still reported `ok` for a reason they do not name. `awk -v start=""`
# likewise matches from line 1. Measured, all three.
#
# The trigger is licensed by the guard's own design: type parameters are not
# compared, so the page is free to drop `<S extends EpisodeSource = EpisodeSource>`
# — at which point `^interface BrainSourceConnector<` resolves to nothing, the
# guard still PASSes so the baseline is clean, and the suite goes green having
# tested something else entirely.
require_line() {
  local n="$1" what="$2"
  case "$n" in
    "" | *[!0-9]*)
      echo "::error::anchor did not resolve to a line number: $what" >&2
      echo "::error::The committed text has drifted from this fixture's pattern, so the sed below would be UNADDRESSED and apply file-wide. Update the pattern." >&2
      exit 2
      ;;
  esac
  echo "$n"
}
line_of()      { require_line "$(grep -n -- "$1" "$DOC" | head -n1 | cut -d: -f1)" "first match of: $1"; }
last_line_of() { require_line "$(grep -n -- "$1" "$DOC" | tail -n1 | cut -d: -f1)" "last match of: $1"; }
# The fence that OPENS the block declaring $1 — the line above the declaration.
fence_open_above() {
  local decl; decl="$(line_of "$1")" || exit 2
  require_line "$((decl - 1))" "fence opening above: $1"
}
# The first bare closing fence at or after line $1.
fence_close_after() {
  require_line "$(awk -v start="$1" 'NR >= start && /^```[[:space:]]*$/ { print NR; exit }' "$DOC")" \
    "closing fence at or after line $1"
}

# --- the committed tree is in sync ------------------------------------------
check pass "committed snippets match their declarations"

# --- doc side: the #5165 defect, reproduced ---------------------------------
# Delete the `audience` line from the published interface snippet. This
# reproduces main's MEMBER SET exactly — the axis this gate compares. (main's
# snippet was also non-generic; type parameters are outside the comparison by
# design, so that difference is invisible here.)
mutate "$DOC" "$DOC_BACKUP" '/^  readonly audience: BrainSourceAudienceFor<S>;$/d'
check fail "a snippet missing the required \`audience\` member trips the gate" \
  "MISSING from the snippet (member the real declaration has): readonly audience"
restore_doc

# Show a required member as OPTIONAL. A membership-only comparison would pass
# this, and "you may omit audience" is the same lie as not mentioning it.
mutate "$DOC" "$DOC_BACKUP" 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  readonly audience?: BrainSourceAudienceFor<S>;/'
check fail "a required member published as optional trips the gate" \
  "readonly audience?"
restore_doc

# Drop the `readonly` modifier. A snippet that says a field is mutable is the
# same class of lie as one that says it is optional.
mutate "$DOC" "$DOC_BACKUP" 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  audience: BrainSourceAudienceFor<S>;/'
check fail "a readonly member published as mutable trips the gate" \
  "MISSING from the snippet (member the real declaration has): readonly audience"
restore_doc

# Rename a member in the snippet. An author copying the page writes a connector
# that does not compile.
mutate "$DOC" "$DOC_BACKUP" 's/^  readonly catalogId: string;$/  readonly catalogID: string;/'
check fail "a misspelled member name in a snippet trips the gate" \
  "readonly catalogID"
restore_doc

# INVENT a member while keeping every real one. This is the only fixture that
# exercises the `extra` direction ALONE — every other one produces `missing` at
# the same time, so without this, deleting the `extra.length === 0` arm of the
# guard leaves the suite green (measured).
mutate "$DOC" "$DOC_BACKUP" 's/^  readonly source: S;$/  readonly source: S;\n  readonly retriesInventedByFixture: number;/'
check fail "a snippet inventing a member the real declaration lacks trips the gate" \
  "NOT IN the real declaration (member the snippet invents): readonly retriesInventedByFixture"
restore_doc

# Drop one arm of the published `BrainSourceAudience` union — the second half of
# the #5165 finding, which the member comparison alone cannot see.
mutate "$DOC" "$DOC_BACKUP" '/^  | { readonly kind: "externally-synced" };$/d'
check fail "a published union missing an arm trips the gate" \
  'MISSING from the snippet (arm the real declaration has): readonly kind:"externally-synced"'
restore_doc

# --- code side: the interface moves, the page does not -----------------------
# The direction a feature PR actually produces.
mutate "$TYPES" "$TYPES_BACKUP" 's#^  readonly audience: BrainSourceAudienceFor<S>;$#  readonly audience: BrainSourceAudienceFor<S>;\n  readonly probeAddedByFixture: string;#'
check fail "a new member on the real interface with no page update trips the gate" \
  "MISSING from the snippet (member the real declaration has): readonly probeAddedByFixture"
restore_types

# Add a third arm to the real union and leave the page alone.
mutate "$TYPES" "$TYPES_BACKUP" 's#^  | { readonly kind: "externally-synced" };$#  | { readonly kind: "externally-synced" }\n  | { readonly kind: "probe-added-by-fixture" };#'
check fail "a new union arm on the real declaration with no page update trips the gate" \
  'MISSING from the snippet (arm the real declaration has): readonly kind:"probe-added-by-fixture"'
restore_types

# --- the REFUSAL arms: "loud, never a skip" is the guard's design claim ------
# The REAL declaration becomes a shape the gate cannot read, while the page still
# publishes a snippet for it. Replacing all three refusal bodies with `continue`
# left the suite green before these three fixtures existed.
# ⚠️ The marker must name THIS arm. `"is a shape this gate cannot compare"` appears
# in the declared-opaque message too, so it could not tell the two apart — and a
# fixture that passes on the wrong arm asserts something false.
mutate "$TYPES" "$TYPES_BACKUP" 's#^  | { readonly kind: "externally-synced" };$#  | AudienceReverifier;#'
check fail "an opaque REAL declaration behind a published snippet trips the gate" \
  "whose real declaration in"
restore_types

# The PAGE rewrites its union into a form the gate cannot read, so the published
# arms silently stop being checked.
mutate "$DOC" "$DOC_BACKUP" 's/^  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }$/  | ReverifiedAudienceAlias/'
check fail "an opaque published snippet trips the gate" \
  "snippet is a shape this gate cannot compare"
restore_doc

# The page publishes an INTERFACE where the real declaration is a union.
mutate "$DOC" "$DOC_BACKUP" 's/^type BrainSourceAudience =$/interface BrainSourceAudience {}\ntype BrainSourceAudienceUnusedByFixture =/'
check fail "an interface published against a real union trips the gate" \
  "is declared as an interface, but"
restore_doc

# A snippet for a declaration that does not exist in source must FAIL rather
# than be skipped — a page documenting a deleted interface is still wrong.
mutate "$DOC" "$DOC_BACKUP" 's/^interface BrainSourceVendorClient {$/interface BrainSourceGoneClient {/'
check fail "a snippet for a nonexistent Brain* declaration trips the gate" \
  "is not an exported Brain* declaration"
restore_doc

# --- discovery: BOTH globs, not one hard-coded pair of paths -----------------
# Collapsing SOURCE_GLOBS and DOCS_GLOB to the two literal paths these fixtures
# use left the suite green, so the header's headline claim was unfalsified.
#
# ⚠️ ONE fixture pins BOTH globs, and the choice of declaration is what does it.
# A second doc FILE pins `DOCS_GLOB`. Declaring `BrainToolReason` — which lives in
# `packages/api/src/lib/tools/search-brain.ts`, OUTSIDE `lib/brain/**` — pins
# `SOURCE_GLOBS`: narrow the source side back to `lib/brain` and this snippet stops
# resolving, so the gate reports "not an exported Brain* declaration" instead of a
# drift and the marker below no longer matches. An earlier version declared
# `BrainEpisodeRecord`, which lives in the one file every other fixture already
# uses — so `SOURCE_GLOBS` collapsed to a literal path stayed green, and the
# commit claiming both globs were pinned was half true.
cat > "$EXTRA_DOC" <<'PROBE_EOF'
---
title: Fixture probe
description: Throwaway page written by check-docs-brain-snippets.test.sh; removed on exit.
---

```ts
type BrainToolReason =
  | { readonly kind: "invented-by-fixture" };
```
PROBE_EOF
# The marker names the SOURCE FILE the declaration resolved to, which is what makes
# this pin the source glob: narrow `SOURCE_GLOBS` back to `lib/brain` and the
# message becomes "is not an exported Brain* declaration", which does not contain
# that path. A marker naming only the probe FILENAME would match either way and
# would pin the docs glob alone.
check fail "a snippet in a SECOND doc file, for a declaration OUTSIDE lib/brain, trips the gate" \
  "whose real declaration in packages/api/src/lib/tools/search-brain.ts"
rm -f "$EXTRA_DOC"

# --- the fence scanner: every silent-skip hole gets a fixture ---------------
# An INDENTED fence (the convention inside a numbered step or a JSX child) was
# skipped entirely by the first cut's column-anchored regex — the guard printed
# PASS with a drifted union live on the page. This tree already has indented `ts`
# fences, and this page now carries Callouts.
#
# Indent the contract fence AND drift it in the same mutation. Asserting `fail`
# with the drift marker proves the indented fence is still both READ and
# COMPARED — an indent-only mutation would be satisfied by the vacuity floor and
# so could not tell "read" from "floored".
CONTRACT_FENCE="$(fence_open_above '^interface BrainSourceConnector<')"
mutate "$DOC" "$DOC_BACKUP" "${CONTRACT_FENCE}s/^\`\`\`ts\$/  \`\`\`ts/"
mutate "$DOC" "$DOC_BACKUP" '/^  readonly audience: BrainSourceAudienceFor<S>;$/d'
check fail "an INDENTED contract fence is still read and compared" \
  "MISSING from the snippet (member the real declaration has): readonly audience"
restore_doc

# A MERGED fenced block — one closing fence blanked, so the prose that follows
# lands inside the body. TypeScript error-recovers past it, so this used to drop
# `BrainSourceVendorClient` from the comparison with the gate printing PASS, and
# the per-file fence COUNT still agreed so the arithmetic floor could not see it
# either. Caught now by reconciling the parser's output against the body text.
mutate "$DOC" "$DOC_BACKUP" "$(fence_close_after "$(line_of '^interface BrainSourceConnector<')")s/^\`\`\`\$//"
check fail "a MERGED fenced block does not silently drop a declaration" \
  "and does not parse"
restore_doc

# A genuinely UNTERMINATED fence — the last closing fence on the page removed, so
# nothing closes it. Reported as a malformed page rather than swallowing the rest
# of the file as one snippet body.
mutate "$DOC" "$DOC_BACKUP" "$(last_line_of '^```$')s/^\`\`\`\$//"
check fail "an unterminated fence is reported, not silently swallowed" \
  "opened and never closed"
restore_doc

# --- vacuity: the gate must not pass by comparing nothing --------------------
# Relabel the contract fence away from ```ts. Every comparison is DISCOVERED, so
# without the floor this leaves the gate green having compared everything except
# the snippet that matters.
mutate "$DOC" "$DOC_BACKUP" "$(fence_open_above '^interface BrainSourceConnector<')s/^\`\`\`ts\$/\`\`\`text/"
check fail "relabelling the contract fence away from \`\`\`ts trips the vacuity floor" \
  "no published snippet was compared for: BrainSourceConnector"
restore_doc

# Rename the published interface so no `BrainSourceConnector` snippet exists.
# A plausible partial page: the fence is still ```ts and still parses, so only
# the floor can catch that the contract page stopped publishing its contract.
mutate "$DOC" "$DOC_BACKUP" 's/^interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {$/interface ConnectorSketch {/'
check fail "a contract snippet renamed out of the Brain* namespace trips the vacuity floor" \
  "no published snippet was compared for: BrainSourceConnector"
restore_doc

# The SECOND floored name. Deleting the whole `BrainSourceAudience` fence left the
# gate green when only BrainSourceConnector was floored — so the union half of
# #5165 was unguarded by the mechanism credited with guarding it.
AUDIENCE_OPEN="$(fence_open_above '^type BrainSourceAudience =$')"
AUDIENCE_CLOSE="$(fence_close_after "$AUDIENCE_OPEN")"
mutate "$DOC" "$DOC_BACKUP" "${AUDIENCE_OPEN},${AUDIENCE_CLOSE}d"
check fail "deleting the whole BrainSourceAudience fence trips the vacuity floor" \
  "no published snippet was compared for: BrainSourceAudience"
restore_doc

# --- restored tree passes again ---------------------------------------------
check pass "restored doc + types are in sync again"

echo ""
echo "check-docs-brain-snippets.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
