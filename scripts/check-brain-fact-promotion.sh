#!/bin/bash
# Refuse any write to `brain_facts.status` outside the atomic publish endpoint
# (#4769, ADR-0036 — acceptance criterion 4). Scope + blind spots below.
#
# `brain_facts.status` is the fact class's review gate. ADR-0036 makes the gate
# the brain's conflict-resolution mechanism, which only holds if `draft →
# published` happens in exactly ONE place: the exotic content-mode adapter that
# `/api/v1/admin/publish` runs inside its transaction. A second writer — a
# connector shortcut, an "just mark it reviewed" admin action, a backfill — would
# not merely duplicate logic; it would bypass the no-provenance / no-grant
# refusals and stamp trust on a claim nothing checked.
#
# WHAT IS REFUSED
#   - `UPDATE brain_facts … SET … status …`   (any status mutation)
#   - `INSERT INTO brain_facts (… status …)`  (any status-naming insert)
#   - `db.update(brainFacts).set({ status … })` (the Drizzle write-builder form)
#
# WHAT THIS GATE CANNOT SEE, stated plainly so nobody mistakes it for a proof of
# more than it is: a table name assembled at runtime (`UPDATE ${t} SET status`)
# is ungreppable by construction. Today the codebase writes this table only as
# raw SQL through `pg` — there are no Drizzle write-builder call sites at all
# (`schema.ts`'s `brainFacts` pgTable exists for migration generation and the
# drift check) — so the ORM pattern below is a tripwire for a style that does
# not exist yet rather than a filter on current code. The structural half of the
# guarantee is `adapters/__tests__/brain-facts.test.ts`, which asserts the
# registry entry stays `exotic`: flipping it to `simple` would route promotion
# through the registry's blanket UPDATE and bypass every refusal without any
# file in this scan changing.
#
# An INSERT that does NOT name `status` is fine and is the expected shape for
# every writer: migration 0180 defaults the column to `draft`, so the ingest
# path (#4770 / #4771) gets the review gate by construction rather than by
# remembering to ask for it. That is the whole point of the default.
#
# ALLOWLIST — each entry is a recorded carve-out, per CLAUDE.md § Content Mode:
#
#   packages/api/src/lib/content-mode/adapters/brain-facts.ts
#     THE promotion path. Runs only from `runPublishPhases`, inside the publish
#     transaction.
#
#   packages/api/src/api/routes/admin-migrate.ts
#     Region import (ADR-0024). Preserves the SOURCE workspace's review status
#     verbatim — 0180's header states this explicitly — because a migration must
#     not silently demote a tenant's already-reviewed facts back to draft, which
#     would re-queue a human's completed review work at every region cutover.
#     It is a restore of a prior gate decision, not a new one; the import's own
#     `grantProblem` validation is paired with the 0180 CHECK.
#
# Comments are stripped before matching so prose like this file's own docstring,
# or an explanatory comment in a source file, cannot trip the gate. Tests and
# migrations are excluded at the directory/pattern level: the migration IS the
# schema, and tests must be able to construct published fixtures.
#
# A regression here means a new promotion path appeared. Route it through
# `promoteBrainFacts` (or, if it is genuinely a restore-not-a-decision like the
# region import, add it to ALLOWLIST below WITH the rationale).

set -euo pipefail

ALLOWLIST=(
  "packages/api/src/lib/content-mode/adapters/brain-facts.ts"
  "packages/api/src/api/routes/admin-migrate.ts"
)

# `BRAIN_PROMOTION_ROOT` points the scan at a throwaway tree — used ONLY by the
# adversarial fixture suite (`scripts/__tests__/check-brain-fact-promotion.test.sh`),
# so the fixtures can assert the guard actually fires without editing real files.
if [ -n "${BRAIN_PROMOTION_ROOT:-}" ]; then
  SEARCH_ROOTS=("$BRAIN_PROMOTION_ROOT")
else
  SEARCH_ROOTS=(packages apps ee examples create-atlas create-atlas-plugin plugins)
fi
EXISTING_ROOTS=()
for root in "${SEARCH_ROOTS[@]}"; do
  [ -d "$root" ] && EXISTING_ROOTS+=("$root")
done

if [ ${#EXISTING_ROOTS[@]} -eq 0 ]; then
  echo "::error::no search roots present — wrong working directory?" >&2
  exit 2
fi

# Candidate files: anything naming the table in EITHER spelling — the raw-SQL
# `brain_facts` or the Drizzle export `brainFacts`. Cheap pre-filter; the precise
# (multi-line, comment-stripped) match happens per file below.
CANDIDATES=$(grep -rlE 'brain_facts|\bbrainFacts\b' "${EXISTING_ROOTS[@]}" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.js' \
  --exclude='*.test.ts' \
  --exclude='*.test.tsx' \
  --exclude='*.spec.ts' \
  --exclude='*.spec.tsx' \
  --exclude-dir='migrations' \
  --exclude-dir='__tests__' \
  --exclude-dir='__mocks__' \
  --exclude-dir='__test-utils__' \
  --exclude-dir='node_modules' \
  --exclude-dir='.next' \
  --exclude-dir='dist' \
  --exclude-dir='__snapshots__' \
  || true)

# Same comment-stripping program as check-ee-imports.sh / the legacy-SQL gate.
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*\$##"'

# SQL spans lines inside template literals, so flatten whitespace before
# matching. The bounded `.{0,400}` keeps the UPDATE…SET…status window from
# spanning into an unrelated later statement in the same file.
# Quoted identifiers (`UPDATE "brain_facts"`) are admitted by the optional quote.
UPDATE_PATTERN='UPDATE[[:space:]]+"?brain_facts"?\b.{0,400}\bSET\b.{0,400}\bstatus\b'
INSERT_PATTERN='INSERT[[:space:]]+INTO[[:space:]]+"?brain_facts"?[[:space:]]*\([^)]*\bstatus\b'
# Drizzle write-builder: `.update(brainFacts)` … `.set({ … status … })`.
ORM_PATTERN='\.update\([[:space:]]*brainFacts[[:space:]]*\).{0,400}\.set\([^)]{0,400}\bstatus\b'

OFFENDERS=""
if [ -n "$CANDIDATES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Suffix match, not equality, so the fixture suite can stage the same
    # repo-relative paths under a temporary root.
    allowed=0
    for a in "${ALLOWLIST[@]}"; do
      [[ "$f" == *"$a" ]] && allowed=1 && break
    done
    [ "$allowed" -eq 1 ] && continue
    FLAT=$(eval "$STRIP_COMMENTS \"\$f\"" | tr '\n' ' ')
    # `-i`: SQL keyword casing is a style choice, not a security boundary — a
    # lowercase `update brain_facts set status` must not slip past. The ORM
    # pattern is case-SENSITIVE (it matches TypeScript identifiers, where case
    # is meaning), so it is tested separately.
    if echo "$FLAT" | grep -qiE "$UPDATE_PATTERN" \
      || echo "$FLAT" | grep -qiE "$INSERT_PATTERN" \
      || echo "$FLAT" | grep -qE "$ORM_PATTERN"; then
      OFFENDERS="${OFFENDERS}${f}"$'\n'
    fi
  done <<<"$CANDIDATES"
fi

OFFENDERS=$(echo "${OFFENDERS%$'\n'}" | grep -v '^$' || true)

if [ -n "$OFFENDERS" ]; then
  echo "::error::a company-brain fact's \`status\` is written outside the atomic publish endpoint (#4769)."
  echo ""
  echo "\`brain_facts.status\` is the review gate (ADR-0036). Promotion must happen"
  echo "ONLY in \`promoteBrainFacts\`, which \`/api/v1/admin/publish\` runs inside its"
  echo "transaction — that is where no-provenance-no-promotion and"
  echo "no-grant-no-promotion are enforced. A second writer bypasses both."
  echo ""
  echo "Offending files:"
  echo "$OFFENDERS" | sed 's/^/  /'
  echo ""
  echo "Fixes:"
  echo "  * Writing a NEW fact? Omit \`status\` entirely — migration 0180 defaults it"
  echo "    to 'draft', which is the review gate applying itself."
  echo "  * Promoting? Don't. Let \`/api/v1/admin/publish\` do it."
  echo "  * Retracting? Stamp \`invalidated_at\` — a fact is never deleted and never"
  echo "    demoted by status (ADR-0036: supersession is not deletion)."
  echo "  * Genuinely restoring a PRIOR gate decision (a region import)? Add the file"
  echo "    to ALLOWLIST in this script WITH the rationale, per CLAUDE.md § Content Mode."
  exit 1
fi

echo "Brain-fact promotion check passed — no status write to brain_facts outside the atomic publish endpoint."
