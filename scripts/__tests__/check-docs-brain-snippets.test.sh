#!/bin/bash
# Adversarial fixture suite for scripts/check-docs-brain-snippets.ts (#5165).
#
# The gate compares published `Brain*` contract snippets in apps/docs against the
# real declarations under packages/*/src and ee/src. This suite proves it can
# actually FAIL — the guard exists because the drift it catches (a required
# `audience` member missing from a page that calls itself "the contract") sat in
# the tree unnoticed, so a green-but-vacuous guard would be worse than none.
#
# ## Every fixture builds a THROWAWAY tree; nothing tracked is written (#5172)
#
# Each case gets a `mktemp -d` mirroring the repo layout — `packages/*/src/**`
# and `apps/docs/content/**` — and runs the guard against it via `--root`. The
# previous version had no such seam: both roots were module constants, so the
# only way to regress the guard was to REWRITE TRACKED SOURCE in place
# (`apps/docs/content/shared/guides/brain-connector-authoring.mdx` and
# `packages/api/src/lib/brain/ingest/types.ts`) and restore it on exit. That
# bought a `restore()` with a trap, an idempotence guard, git-object
# verification and an `|| exit 2` escalation — two of whose defects were found in
# review — a start-of-run baseline check, a probe page written into a tracked
# content dir, and a stage constraint in `ci-local.sh`. It still had one residual
# it could not close: `restore()` wrote the START-OF-RUN backup at the END, so a
# concurrent edit made during the run was reverted and reported as a successful
# restore. All of that is deleted here, because none of it has anything left to
# protect. `scripts/__tests__/check-docs-links.test.sh` has worked this way since
# #4480.
#
# `assert_tree_clean` pins it: `git status --porcelain` is compared against its
# start-of-run value after EVERY case, and the final fixture reports the count.
#
# ## The failure fixtures each assert a MARKER, not just a non-zero exit
#
# `bun` exits 1 on an uncaught exception too, so an exit code alone cannot tell
# "the arm I meant reported a violation" from "the guard crashed" or "a DIFFERENT
# arm fired". Each `check fail` below names a substring only its own arm prints,
# on `scripts/__tests__/check-docs-links.test.sh`'s precedent. Without this, a
# review measured nine of the then-eleven fixtures satisfied by `process.exit(3)`
# at the top of the guard — and it is load-bearing beyond that: several mutations
# still exit 1 (they fall through to the vacuity floor), so ONLY the marker
# distinguishes them.
#
# The `check pass` fixtures assert exit 0 and structurally cannot name a marker.
# Those are the ones a no-op guard would satisfy — which is exactly what the
# failure fixtures exist to rule out. `--root` is pinned by every one of them at
# once: ignore the flag and the guard scans the REAL repo, which passes, so every
# `fail` fixture goes red.
#
# ## Coverage: three directions, the arms only a fixture can reach, and the roots
#
#   • doc side  — the page drifts while the code moves on (the #5165 defect);
#   • code side — the interface grows a member or an arm and the page is not
#                 updated (the same defect from the other direction, and the one a
#                 feature PR actually produces);
#   • vacuity   — the page stops publishing a floored contract, or the fence
#                 scanner stops reading it, which is the failure mode a
#                 discovered-both-sides guard is uniquely exposed to;
#   • refusal   — three branches whose design claim is "loud, never a skip" (an
#                 opaque real declaration, an opaque published snippet, an
#                 interface/union mismatch), each of which could be turned into a
#                 bare `continue` with the suite still green;
#   • roots     — the source glob, the docs glob, and the empty-source and
#                 duplicate-declaration arms, none of which was reachable while
#                 the roots were constants.
#
# ## One arm is deliberately NOT fixtured, and injectable roots do not change that
#
# `scan.fences.length !== scan.openedTsFences` in the guard is unreachable by
# construction, not by lack of control over the roots: the only way to open a `ts`
# fence and not extract it is to leave it unterminated, which sets
# `unterminatedAt` and is reported first. It is a regression tripwire on the
# scanner, and the guard's own comment says so. A fixture claiming to reach it
# would be asserting something false.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-docs-brain-snippets.ts"

if [ ! -f "$GUARD" ]; then
  echo "::error::guard under test not found at $GUARD" >&2
  exit 2
fi

PASS=0
FAIL=0

# Repo-relative paths the seeded tree mirrors. The docs one is the real contract
# page's path and the source one is the real declaration's, so a reader can map a
# fixture onto the tree it models — but nothing here reads or writes either.
TYPES_REL="packages/api/src/lib/brain/ingest/types.ts"
TOOLS_REL="packages/api/src/lib/tools/search-brain.ts"
DOC_REL="apps/docs/content/shared/guides/brain-connector-authoring.mdx"

# ── the clean tree every fixture regresses FROM ──────────────────────────────
#
# Deliberately synthetic rather than copied from the tree. The REAL page's
# agreement with the REAL declarations is what the gate itself asserts in CI
# (`bun scripts/check-docs-brain-snippets.ts`); this suite's job is the
# orthogonal one of proving the gate can fail. Copying would re-assert the
# former and make every fixture's anchor drift with an unrelated prose edit —
# which is exactly what the line-number anchors in the previous version did.
seed_tree() {
  local dir="$1"
  mkdir -p "$dir/$(dirname "$TYPES_REL")" "$dir/$(dirname "$TOOLS_REL")" \
           "$dir/$(dirname "$DOC_REL")" || exit 2

  cat > "$dir/$TYPES_REL" <<'TYPES_EOF'
export type EpisodeSource = "chat" | "meeting";

interface AudienceReverifier {
  readonly reverifiedAt: string;
}

export interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}

export type BrainSourceAudience =
  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }
  | { readonly kind: "externally-synced" };

// Conditional, so this one is opaque to the gate — as the real declaration is.
// Nothing publishes it, so opaque is a skip rather than a failure.
export type BrainSourceAudienceFor<S extends EpisodeSource> = S extends "chat"
  ? BrainSourceAudience
  : BrainSourceAudience;

export interface BrainSourceVendorClient {
  readonly fetchEpisodes: () => Promise<readonly string[]>;
  readonly close: () => void;
}
TYPES_EOF

  # A `Brain*` contract OUTSIDE `lib/brain/**`, mirroring the real
  # `BrainToolReason` in `lib/tools/search-brain.ts`. The source glob is
  # deliberately wider than `lib/brain`, and this is what a fixture can pin.
  cat > "$dir/$TOOLS_REL" <<'TOOLS_EOF'
export type BrainToolReason =
  | { readonly kind: "grounded" }
  | { readonly kind: "speculative" };
TOOLS_EOF

  write_doc "$dir/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence
}

# ── the contract page, emitted fence by fence ────────────────────────────────
#
# Composed rather than written whole so the fence-scanner fixtures can swap ONE
# fence for a variant and leave the rest identical. The previous version had to
# resolve fence lines in a tracked page by content-relative position — every
# fence line there is exactly "```", carrying no anchor of its own — and three of
# those resolutions silently applied file-wide when the anchor drifted. A fence
# that is *emitted* by name cannot drift.
#
# write_doc <file> <emitter>... — frontmatter, then each emitter in order.
write_doc() {
  local file="$1"; shift
  {
    cat <<'HEAD_EOF'
---
title: Authoring a brain connector
description: Fixture page built by scripts/__tests__/check-docs-brain-snippets.test.sh.
---

# Authoring a brain connector

This page is the contract.
HEAD_EOF
    local emitter
    for emitter in "$@"; do "$emitter"; done
  } > "$file" || exit 2
}

doc_connector_fence() { cat <<'EOF'

```ts
interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}
```
EOF
}

# Indented three spaces, the convention inside a numbered step or a JSX child,
# and DRIFTED in the same emitter — see the fixture for why both at once.
doc_connector_fence_indented() { cat <<'EOF'

1. Declare the connector:

   ```ts
   interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
     readonly source: S;
     readonly catalogId: string;
   }
   ```
EOF
}

# The closing fence is missing, so the prose that follows lands in the body.
doc_connector_fence_unclosed() { cat <<'EOF'

```ts
interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}
EOF
}

# Tagged `text`, so the fence scanner does not read it as TypeScript at all.
doc_connector_fence_text() { cat <<'EOF'

```text
interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}
```
EOF
}

doc_audience_fence() { cat <<'EOF'

The audiences a connector may mint:

```ts
type BrainSourceAudience =
  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }
  | { readonly kind: "externally-synced" };
```
EOF
}

doc_vendor_fence() { cat <<'EOF'

And the vendor client it wraps:

```ts
interface BrainSourceVendorClient {
  readonly fetchEpisodes: () => Promise<readonly string[]>;
  readonly close: () => void;
}
```
EOF
}

# Opened and never closed, with nothing after it — a malformed page.
doc_vendor_fence_unclosed() { cat <<'EOF'

And the vendor client it wraps:

```ts
interface BrainSourceVendorClient {
  readonly fetchEpisodes: () => Promise<readonly string[]>;
  readonly close: () => void;
}
EOF
}

# A `ts` fence NESTED in a 4-backtick `md` block: that block's content, not
# published contract. Its body declares a `BrainSourceConnector` that agrees with
# nothing.
doc_nested_md_block() { cat <<'EOF'

How to write one of these blocks:

````md
```ts
interface BrainSourceConnector {
  readonly nothingLikeTheRealOne: string;
}
```
````
EOF
}

# tweak <file> <sed-script> — apply and prove it landed.
#
# The target is always a file this suite wrote seconds earlier, so an anchor
# cannot drift with an unrelated repo edit. It is still checked, because a sed
# that matches nothing would leave the fixture asserting that the guard fails on
# the CLEAN tree — a green fixture testing nothing.
tweak() {
  local file="$1" script="$2" before
  before="$(cat "$file")" || exit 2
  sed -i "$script" "$file" || exit 2
  if [ "$before" = "$(cat "$file")" ]; then
    echo "::error::fixture sed matched nothing: $script" >&2
    echo "::error::The pattern has drifted from seed_tree()'s text, so the fixture below would assert that the guard fails on the CLEAN tree. Update the pattern." >&2
    exit 2
  fi
}

# ── the tracked tree must be untouched at every checkpoint ───────────────────
#
# The whole point of #5172: no fixture may write a tracked file. Re-snapshotting
# after a divergence means one report per divergence rather than one per
# remaining case.
#
# A mismatch is not proof this suite wrote something — a concurrent session
# editing the shared checkout produces the same reading — so the message names
# both. It fails LOUD either way, which is the direction that matters: the shape
# this replaces reverted a concurrent edit silently and printed "17 passed".
TREE_SNAPSHOT="$(git -C "$ROOT" status --porcelain)" || exit 2
CHECKPOINTS=0
DIRTIED=0
assert_tree_clean() {
  local now
  now="$(git -C "$ROOT" status --porcelain)" || exit 2
  CHECKPOINTS=$((CHECKPOINTS + 1))
  if [ "$now" != "$TREE_SNAPSHOT" ]; then
    echo "::error::the working tree changed while running fixture: $1" >&2
    echo "::error::Either this suite wrote a tracked file (a regression — it must only write under mktemp -d), or a concurrent session edited the checkout." >&2
    diff <(printf '%s\n' "$TREE_SNAPSHOT") <(printf '%s\n' "$now") | sed 's/^/::error::  /' >&2
    TREE_SNAPSHOT="$now"
    DIRTIED=$((DIRTIED + 1))
  fi
}

# check <pass|fail> <name> <setup-fn> <marker> [extra guard args...]
#
# `fail` asserts exit status 1 — the guard's own violation code — AND that the
# output contains `marker`. Anything else (a crash, a different arm firing, the
# exit-2 argument parser) is a fixture failure, and the guard's output is printed
# so the reason is visible instead of a bare `got status=1`.
#
# The guard runs from `$ROOT`, not from the fixture dir, so a `--root` the guard
# ignored would scan the real repo — which passes — and every `fail` fixture
# would go red.
check() {
  local expected="$1" name="$2" setup_fn="$3" marker="$4"
  shift 4
  local tmp out status=0
  tmp="$(mktemp -d)" || exit 2
  seed_tree "$tmp"
  "$setup_fn" "$tmp" || { echo "::error::fixture setup failed: $name" >&2; rm -rf "$tmp"; exit 2; }

  out="$(cd "$ROOT" && bun "$GUARD" --root "$tmp" "$@" 2>&1)" || status=$?
  rm -rf "$tmp"

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
    # `\n`, not `%s` bare: without the trailing newline the NEXT fixture's `FAIL`
    # line is appended to this one's last output line, so a run with several
    # failures reads as one. Inherited from the previous version and measured
    # here — 21 failures printed as 1 greppable `FAIL` line.
    printf '%s\n' "$out" | sed 's/^/       | /' >&2
    FAIL=$((FAIL + 1))
  fi
  assert_tree_clean "$name"
}

noop() { :; }

# --- the seeded tree is in sync ---------------------------------------------
check pass "seeded snippets match their declarations" noop ""

# --- doc side: the #5165 defect, reproduced ---------------------------------
# Delete the `audience` line from the published interface snippet. This
# reproduces main's MEMBER SET exactly — the axis this gate compares.
doc_drop_audience() {
  tweak "$1/$DOC_REL" '/^  readonly audience: BrainSourceAudienceFor<S>;$/d'
}
check fail "a snippet missing the required \`audience\` member trips the gate" \
  doc_drop_audience "MISSING from the snippet (member the real declaration has): readonly audience"

# Show a required member as OPTIONAL. A membership-only comparison would pass
# this, and "you may omit audience" is the same lie as not mentioning it.
doc_audience_optional() {
  tweak "$1/$DOC_REL" 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  readonly audience?: BrainSourceAudienceFor<S>;/'
}
check fail "a required member published as optional trips the gate" \
  doc_audience_optional "readonly audience?"

# Drop the `readonly` modifier. A snippet that says a field is mutable is the
# same class of lie as one that says it is optional.
doc_audience_mutable() {
  tweak "$1/$DOC_REL" 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  audience: BrainSourceAudienceFor<S>;/'
}
check fail "a readonly member published as mutable trips the gate" \
  doc_audience_mutable "MISSING from the snippet (member the real declaration has): readonly audience"

# Rename a member in the snippet. An author copying the page writes a connector
# that does not compile.
doc_rename_member() {
  tweak "$1/$DOC_REL" 's/^  readonly catalogId: string;$/  readonly catalogID: string;/'
}
check fail "a misspelled member name in a snippet trips the gate" \
  doc_rename_member "readonly catalogID"

# INVENT a member while keeping every real one. This is the only fixture that
# exercises the `extra` direction ALONE — every other one produces `missing` at
# the same time, so without this, deleting the `extra.length === 0` arm of the
# guard leaves the suite green (measured).
doc_invent_member() {
  tweak "$1/$DOC_REL" 's/^  readonly source: S;$/  readonly source: S;\n  readonly retriesInventedByFixture: number;/'
}
check fail "a snippet inventing a member the real declaration lacks trips the gate" \
  doc_invent_member "NOT IN the real declaration (member the snippet invents): readonly retriesInventedByFixture"

# Drop one arm of the published `BrainSourceAudience` union — the second half of
# the #5165 finding, which the member comparison alone cannot see.
doc_drop_arm() {
  tweak "$1/$DOC_REL" '/^  | { readonly kind: "externally-synced" };$/d'
}
check fail "a published union missing an arm trips the gate" \
  doc_drop_arm 'MISSING from the snippet (arm the real declaration has): readonly kind:"externally-synced"'

# --- code side: the interface moves, the page does not -----------------------
# The direction a feature PR actually produces.
code_add_member() {
  tweak "$1/$TYPES_REL" 's#^  readonly audience: BrainSourceAudienceFor<S>;$#  readonly audience: BrainSourceAudienceFor<S>;\n  readonly probeAddedByFixture: string;#'
}
check fail "a new member on the real interface with no page update trips the gate" \
  code_add_member "MISSING from the snippet (member the real declaration has): readonly probeAddedByFixture"

# Add a third arm to the real union and leave the page alone.
code_add_arm() {
  tweak "$1/$TYPES_REL" 's#^  | { readonly kind: "externally-synced" };$#  | { readonly kind: "externally-synced" }\n  | { readonly kind: "probe-added-by-fixture" };#'
}
check fail "a new union arm on the real declaration with no page update trips the gate" \
  code_add_arm 'MISSING from the snippet (arm the real declaration has): readonly kind:"probe-added-by-fixture"'

# --- the REFUSAL arms: "loud, never a skip" is the guard's design claim ------
# The REAL declaration becomes a shape the gate cannot read, while the page still
# publishes a snippet for it. Replacing all three refusal bodies with `continue`
# left the suite green before these three fixtures existed.
# ⚠️ The marker must name THIS arm. `"is a shape this gate cannot compare"` appears
# in the declared-opaque message too, so it could not tell the two apart — and a
# fixture that passes on the wrong arm asserts something false.
code_opaque_union() {
  tweak "$1/$TYPES_REL" 's#^  | { readonly kind: "externally-synced" };$#  | AudienceReverifier;#'
}
check fail "an opaque REAL declaration behind a published snippet trips the gate" \
  code_opaque_union "whose real declaration in"

# The PAGE rewrites its union into a form the gate cannot read, so the published
# arms silently stop being checked.
doc_opaque_union() {
  tweak "$1/$DOC_REL" 's/^  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }$/  | ReverifiedAudienceAlias/'
}
check fail "an opaque published snippet trips the gate" \
  doc_opaque_union "snippet is a shape this gate cannot compare"

# The page publishes an INTERFACE where the real declaration is a union. The
# leftover arms are re-homed onto a NON-`Brain*` alias so this fixture reports
# only the arm it names.
doc_interface_for_union() {
  tweak "$1/$DOC_REL" 's/^type BrainSourceAudience =$/interface BrainSourceAudience {}\ntype AudienceUnusedByFixture =/'
}
check fail "an interface published against a real union trips the gate" \
  doc_interface_for_union "is declared as an interface, but"

# A snippet for a declaration that does not exist in source must FAIL rather
# than be skipped — a page documenting a deleted interface is still wrong.
doc_nonexistent() {
  tweak "$1/$DOC_REL" 's/^interface BrainSourceVendorClient {$/interface BrainSourceGoneClient {/'
}
check fail "a snippet for a nonexistent Brain* declaration trips the gate" \
  doc_nonexistent "is not an exported Brain* declaration"

# --- the roots: both globs, and the two arms only they can reach -------------
# ⚠️ ONE fixture pins BOTH default globs, and the choice of declaration is what
# does it. A second doc FILE pins the docs glob. Declaring `BrainToolReason` —
# which the seeded tree puts OUTSIDE `lib/brain/**`, exactly as the real tree
# does — pins the source glob: narrow the source side back to `lib/brain` and this
# snippet stops resolving, so the gate reports "not an exported Brain*
# declaration" instead of a drift and the marker below no longer matches.
second_doc_file() {
  cat > "$1/apps/docs/content/shared/guides/tool-reason.mdx" <<'PROBE_EOF'
---
title: Tool reasons
---

```ts
type BrainToolReason =
  | { readonly kind: "grounded" };
```
PROBE_EOF
}
check fail "a snippet in a SECOND doc file, for a declaration OUTSIDE lib/brain, trips the gate" \
  second_doc_file "has drifted from packages/api/src/lib/tools/search-brain.ts"

# The source side reading NOTHING must be loud. Unreachable while the roots were
# constants: the real tree always has exported `Brain*` declarations.
check fail "a source glob that matches nothing is refused, not passed vacuously" \
  noop "no exported Brain* declarations found under" --source-glob 'packages/*/src/**/*.tsx'

# The docs side must be glob-scoped, not "every .mdx anywhere". Pointing the docs
# glob at a subtree with no contract page leaves the gate with nothing compared,
# which is the vacuity floor's job.
check fail "a docs glob that excludes the contract page trips the vacuity floor" \
  noop "no published snippet was compared for: BrainSourceConnector, BrainSourceAudience" \
  --docs-glob 'apps/docs/content/shared/reference/**/*.mdx'

# Two source files exporting one name make the comparison depend on scan order,
# so the gate refuses rather than picking one. Also unreachable while the roots
# were constants — it needs a second declaration of a real contract name.
duplicate_source() {
  mkdir -p "$1/packages/other/src" || exit 2
  cat > "$1/packages/other/src/dup.ts" <<'DUP_EOF'
export interface BrainSourceVendorClient {
  readonly close: () => void;
}
DUP_EOF
}
check fail "the same Brain* name exported from two source files is refused" \
  duplicate_source "is exported from BOTH packages/api/src/lib/brain/ingest/types.ts and packages/other/src/dup.ts"

# --- the fence scanner: every silent-skip hole gets a fixture ---------------
# An INDENTED fence (the convention inside a numbered step or a JSX child) was
# skipped entirely by the first cut's column-anchored regex — the guard printed
# PASS with a drifted union live on the page.
#
# The indented emitter is also DRIFTED, and both at once is the point: asserting
# `fail` with the drift marker proves the indented fence is still both READ and
# COMPARED, where an indent-only variant would be satisfied by the vacuity floor
# and so could not tell "read" from "floored".
doc_indented_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence_indented doc_audience_fence doc_vendor_fence
}
check fail "an INDENTED contract fence is still read and compared" \
  doc_indented_fence "MISSING from the snippet (member the real declaration has): readonly audience"

# A MERGED fenced block — the connector fence's closing line missing, so the
# prose that follows lands inside the body. TypeScript error-recovers past it, so
# this used to drop a declaration from the comparison with the gate printing
# PASS, and the per-file fence COUNT still agreed so the arithmetic floor could
# not see it either. Caught now by reconciling the parser's output against the
# body text.
doc_merged_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence_unclosed doc_audience_fence doc_vendor_fence
}
check fail "a MERGED fenced block does not silently drop a declaration" \
  doc_merged_fence "and does not parse"

# A genuinely UNTERMINATED fence — the LAST fence on the page never closes, so
# nothing after it could close it either. Reported as a malformed page rather
# than swallowing the rest of the file as one snippet body.
doc_unterminated_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence_unclosed
}
check fail "an unterminated fence is reported, not silently swallowed" \
  doc_unterminated_fence "opened and never closed"

# A scanner that stopped tracking non-`ts` fences would read the nested block's
# body as published contract and report drift (or a duplicate declaration),
# turning this PASS red. Without this fixture the CommonMark fence-length rule is
# guarded only incidentally, by an unrelated page in the real tree happening to
# contain a 4-backtick block.
doc_nested_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence \
    doc_nested_md_block
}
check pass "a \`ts\` fence nested in a 4-backtick \`md\` block is not published contract" \
  doc_nested_fence ""

# --- vacuity: the gate must not pass by comparing nothing --------------------
# Relabel the contract fence away from ```ts. Every comparison is DISCOVERED, so
# without the floor this leaves the gate green having compared everything except
# the snippet that matters.
doc_relabel_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence_text doc_audience_fence doc_vendor_fence
}
check fail "relabelling the contract fence away from \`\`\`ts trips the vacuity floor" \
  doc_relabel_fence "no published snippet was compared for: BrainSourceConnector"

# Rename the published interface so no `BrainSourceConnector` snippet exists.
# A plausible partial page: the fence is still ```ts and still parses, so only
# the floor can catch that the contract page stopped publishing its contract.
doc_rename_interface() {
  tweak "$1/$DOC_REL" 's/^interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {$/interface ConnectorSketch {/'
}
check fail "a contract snippet renamed out of the Brain* namespace trips the vacuity floor" \
  doc_rename_interface "no published snippet was compared for: BrainSourceConnector"

# The SECOND floored name. Deleting the whole `BrainSourceAudience` fence left the
# gate green when only BrainSourceConnector was floored — so the union half of
# #5165 was unguarded by the mechanism credited with guarding it.
doc_delete_audience_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_vendor_fence
}
check fail "deleting the whole BrainSourceAudience fence trips the vacuity floor" \
  doc_delete_audience_fence "no published snippet was compared for: BrainSourceAudience"

# --- the suite itself wrote nothing tracked ---------------------------------
if [ "$DIRTIED" -eq 0 ]; then
  echo "  ok   no tracked file was mutated at any of $CHECKPOINTS checkpoints (expected pass)"
  PASS=$((PASS + 1))
else
  echo "  FAIL the working tree diverged at $DIRTIED of $CHECKPOINTS checkpoints" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "check-docs-brain-snippets.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
