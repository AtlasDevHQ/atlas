#!/bin/bash
# Adversarial fixture suite for scripts/check-docs-brain-snippets.ts (#5165).
#
# The gate compares published `Brain*` contract snippets in apps/docs against the
# real declarations under packages/api/src/lib/brain/**. This suite proves it can
# actually FAIL — the guard exists because the drift it catches (a required
# `audience` member missing from a page that calls itself "the contract") sat in
# the tree unnoticed, so a green-but-vacuous guard would be worse than none.
#
# Every fixture mutates ONE side and restores it, because each direction is a
# different real mistake:
#   • doc side  — the page drifts while the code moves on (the #5165 defect);
#   • code side — the interface grows a member and the page is not updated (the
#                 same defect arriving from the other direction, and the one a
#                 feature PR actually produces);
#   • vacuity   — the page stops publishing the contract at all, or its fence
#                 stops being read, which is the failure mode a discovered-both-
#                 sides guard is uniquely exposed to.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-docs-brain-snippets.ts"
DOC="$ROOT/apps/docs/content/shared/guides/brain-connector-authoring.mdx"
TYPES="$ROOT/packages/api/src/lib/brain/ingest/types.ts"

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

PASS=0
FAIL=0

check() {
  local expected="$1" name="$2"
  local status=0
  (cd "$ROOT" && bun "$GUARD") > /dev/null 2>&1 || status=$?
  if { [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; } ||
     { [ "$expected" = "fail" ] && [ "$status" -ne 0 ]; }; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi
}

# Back both mutated files up so the committed tree is restored even on error.
# CLAUDE.md: this repo is a SHARED working tree, and this suite rewrites tracked
# files in place — a lost restore would ship a mutated source file as though it
# were a real change.
DOC_BACKUP="$(mktemp)"
TYPES_BACKUP="$(mktemp)"
cp "$DOC" "$DOC_BACKUP"
cp "$TYPES" "$TYPES_BACKUP"
restore() {
  cp "$DOC_BACKUP" "$DOC"
  cp "$TYPES_BACKUP" "$TYPES"
  rm -f "$DOC_BACKUP" "$TYPES_BACKUP"
}
trap restore EXIT

# Shared-worktree race tripwire, on check-pricing-parity.test.sh's precedent.
# Every fixture below regresses FROM a tree where the `audience` member is
# present on both sides. If a concurrent run had either file mid-mutation when we
# copied it, restore() would later write the WRONG baseline back — reintroducing
# the very drift this guard exists to catch, silently. Assert the baseline we
# captured is the in-sync one, and exit LOUDLY if not.
if ! grep -q 'readonly audience: BrainSourceAudienceFor<S>' "$TYPES_BACKUP"; then
  echo "::error::the types.ts backup is missing \`readonly audience\` — a concurrent run may have mutated the tree mid-backup. Failing loudly rather than persisting a bad baseline." >&2
  exit 2
fi
if ! grep -q 'readonly audience:' "$DOC_BACKUP"; then
  echo "::error::the connector-authoring backup is missing its \`audience\` snippet member — a concurrent run may have mutated the tree mid-backup. Failing loudly rather than persisting a bad baseline." >&2
  exit 2
fi

# --- the committed tree is in sync ------------------------------------------
check pass "committed snippets match their declarations"

# --- doc side: the #5165 defect, reproduced ---------------------------------
# Delete the `audience` line from the published interface snippet. This is
# byte-for-byte the state main was in when #5165 was filed.
sed -i '/^  readonly audience: BrainSourceAudienceFor<S>;$/d' "$DOC"
check fail "a snippet missing the required \`audience\` member trips the gate"
cp "$DOC_BACKUP" "$DOC"

# Show a required member as OPTIONAL. A membership-only comparison would pass
# this, and "you may omit audience" is the same lie as not mentioning it.
sed -i 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  readonly audience?: BrainSourceAudienceFor<S>;/' "$DOC"
check fail "a required member published as optional trips the gate"
cp "$DOC_BACKUP" "$DOC"

# Rename a member in the snippet. An author copying the page writes a connector
# that does not compile.
sed -i 's/^  readonly catalogId: string;$/  readonly catalogID: string;/' "$DOC"
check fail "a misspelled member name in a snippet trips the gate"
cp "$DOC_BACKUP" "$DOC"

# Drop one arm of the published `BrainSourceAudience` union — the second half of
# the #5165 finding, which the member comparison alone cannot see.
sed -i '/^  | { readonly kind: "externally-synced" };$/d' "$DOC"
check fail "a published union missing an arm trips the gate"
cp "$DOC_BACKUP" "$DOC"

# --- code side: the interface moves, the page does not -----------------------
# The direction a feature PR actually produces. Add a member to the real
# interface and leave the page alone.
sed -i 's#^  readonly audience: BrainSourceAudienceFor<S>;$#  readonly audience: BrainSourceAudienceFor<S>;\n  readonly probeAddedByFixture: string;#' "$TYPES"
check fail "a new member on the real interface with no page update trips the gate"
cp "$TYPES_BACKUP" "$TYPES"

# Add a third arm to the real union and leave the page alone.
sed -i 's#^  | { readonly kind: "externally-synced" };$#  | { readonly kind: "externally-synced" }\n  | { readonly kind: "probe-added-by-fixture" };#' "$TYPES"
check fail "a new union arm on the real declaration with no page update trips the gate"
cp "$TYPES_BACKUP" "$TYPES"

# --- vacuity: the gate must not pass by comparing nothing --------------------
# Relabel the contract fence away from ```ts. Every comparison here is
# DISCOVERED, so without the floor this leaves the gate green while reading no
# snippet at all — the failure mode this guard is most exposed to.
sed -i '0,/^```ts$/{s/^```ts$/```text/}' "$DOC"
check fail "relabelling the contract fence away from \`\`\`ts trips the vacuity floor"
cp "$DOC_BACKUP" "$DOC"

# Rename the published interface so no `BrainSourceConnector` snippet exists.
# A plausible partial page: the fence is still ```ts and still parses, so only
# the floor can catch that the contract page stopped publishing its contract.
sed -i 's/^interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {$/interface ConnectorSketch {/' "$DOC"
check fail "a contract snippet renamed out of the Brain* namespace trips the vacuity floor"
cp "$DOC_BACKUP" "$DOC"

# A snippet for a declaration that does not exist in source must FAIL rather
# than be skipped — a page documenting a deleted interface is still wrong.
sed -i 's/^interface BrainSourceVendorClient {$/interface BrainSourceGoneClient {/' "$DOC"
check fail "a snippet for a nonexistent Brain* declaration trips the gate"
cp "$DOC_BACKUP" "$DOC"

# --- restored tree passes again ---------------------------------------------
check pass "restored doc + types are in sync again"

echo ""
echo "check-docs-brain-snippets.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
