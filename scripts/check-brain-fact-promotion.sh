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
# WHAT IS REFUSED (each has a fixture in the adversarial suite)
#   - `UPDATE [schema.]brain_facts … SET … status …`
#   - `INSERT INTO [schema.]brain_facts (… status …)`
#   - `INSERT INTO … brain_facts … ON CONFLICT … DO UPDATE SET … status …`
#     — the path-upsert shape ADR-0030's connector engine uses, and therefore
#     the single most likely way #4770/#4771 would reach this column. It names
#     no table after `UPDATE` and no `status` in the column list, so it evaded
#     both of the patterns above until it was called out.
#   - `INSERT INTO brain_facts VALUES (…)` with NO column list — positional, so
#     whether it sets `status` is unknowable by grep. Refused on principle:
#     a positional insert into a 17-column table is unreviewable anyway.
#   - `db.update([schema.]brainFacts).set({ status … })` and
#     `db.insert([schema.]brainFacts).values({ … status … })` — both Drizzle
#     write-builder halves, including the `.onConflictDoUpdate({ set: { status
#     … } })` upsert (covered by the insert pattern's window).
#
# Matching is case-INSENSITIVE for the SQL forms (keyword casing is a style
# choice, not a security boundary) and accepts an optional schema qualifier and
# double-quoted identifier.
#
# WHAT THIS GATE STILL CANNOT SEE. Stated in full so nobody reads the list above
# as a completeness proof:
#   - A table name assembled at runtime (`UPDATE ${t} SET status`) — ungreppable
#     by construction.
#   - A statement whose `SET … status` is more than 400 characters past the
#     table name (the window bound below).
#   - Any language or file type outside `--include` (`.ts`/`.tsx`/`.js`).
# The structural half of the guarantee is therefore NOT this script: it is
# `adapters/__tests__/brain-facts.test.ts`, which asserts the registry entry
# stays `exotic`. Flipping it to `simple` would route promotion through the
# registry's blanket UPDATE and bypass every refusal without any file in this
# scan changing.
#
# NOTE the deliberate over-breadth. Matching is per-STATEMENT, and within a
# statement the rules ask only "does it touch the table AND mention `status`" —
# so `status` in a WHERE clause counts. Both of these are refused even though
# neither mutates the review state:
#   UPDATE brain_facts SET invalidated_at = now() WHERE … status = 'published'
#   INSERT INTO brain_facts (…) SELECT … WHERE status = 'draft'
# That is the safe direction for a security gate. A legitimate case — a
# retraction or backfill that FILTERS on status, which #4772/#4773 may well
# want — needs an allowlist entry WITH a rationale, not a quiet loosening. Both
# shapes have fixtures, so relaxing this has to fail a test first.
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
# Comments are stripped before matching so an explanatory comment in a source
# file cannot trip the gate. (Not this file — a `.sh` under `scripts/` is in
# neither the search roots nor `--include`, so the gate can never scan itself.)
# Two caveats on the stripping, which is the shared sed from check-ee-imports.sh:
# an UNTERMINATED `/*` truncates the rest of the file, which hides real
# offenders below it — the safe direction is the one it does NOT take, so treat
# a suspiciously clean result on a file with odd comment syntax with suspicion.
#
# Tests are excluded by filename pattern: a fixture must be able to construct a
# published row. `db/migrations/` is NOT excluded by directory — the `.sql`
# migrations are already out of scope via `--include`, and excluding the
# directory would have let a one-shot backfill under
# `db/migrations/scripts/*.ts` (where CLAUDE.md says they live) write this
# column with no gate at all.
#
# A regression here means a new promotion path appeared. Route it through
# `promoteBrainFacts` (or, if it is genuinely a restore-not-a-decision like the
# region import, add it to ALLOWLIST below WITH the rationale).

set -euo pipefail

# Matched as GLOBS against the full path, naming each file's two real homes:
# the source of truth under `packages/api/`, and the gitignored copy that
# `create-atlas/scripts/prepare-templates.sh` mirrors into
# `create-atlas/templates/*/src/`. The scan covers `create-atlas` on purpose — a
# template that grew a rogue writer must still fail — so both spellings have to
# be listed.
#
# Deliberately NOT a bare `src/...` suffix, even though that is shorter and
# covers both. It would exempt those two relative paths in EVERY scanned root,
# so a `plugins/anything/src/api/routes/admin-migrate.ts` would inherit the
# region-import carve-out for free. A carve-out has to name the file it trusts,
# not a shape any package can adopt.
ALLOWLIST=(
  "packages/api/src/lib/content-mode/adapters/brain-facts.ts"
  "packages/api/src/api/routes/admin-migrate.ts"
  "create-atlas/templates/*/src/lib/content-mode/adapters/brain-facts.ts"
  "create-atlas/templates/*/src/api/routes/admin-migrate.ts"
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

# Once a file is split into STATEMENTS (below), "these two tokens belong to the
# same statement" is structural — so each rule is a set of cheap independent
# greps AND-ed together, not one regex with `.{0,400}`-style windows.
#
# That is not only simpler, it is why this gate is fast. The window form was
# catastrophically backtracking: a single pattern took 1.6s on `schema.ts`
# alone, and the whole gate ran >200s in `/ci` stage 1.
#
# `QUALIFIED` admits an optional schema qualifier with either identifier
# independently quoted, so `public.brain_facts`, `"public"."brain_facts"`, and
# `"brain_facts"` all match. `ORM_TABLE` does the same for a namespace-qualified
# Drizzle reference (`schema.brainFacts`).
QUALIFIED='("?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?brain_facts"?'
ORM_TABLE='([a-zA-Z_$][a-zA-Z0-9_$]*\.)?brainFacts'

# Does one statement write `brain_facts.status`? Echoes nothing; exit 0 = yes.
statement_writes_status() {
  local stmt="$1"

  # Raw SQL — UPDATE … SET … status
  if grep -qiE "UPDATE[[:space:]]+${QUALIFIED}\b" <<<"$stmt" \
    && grep -qiE '\bSET\b' <<<"$stmt" \
    && grep -qiE '\bstatus\b' <<<"$stmt"; then
    return 0
  fi

  # Raw SQL — INSERT INTO brain_facts … status. Covers BOTH the column-list form
  # and `ON CONFLICT … DO UPDATE SET status`, because within one statement they
  # are the same question. Deliberately over-broad: an INSERT that merely reads
  # `status` in a sub-SELECT also trips this. That is the safe direction, and a
  # legitimate case wants an allowlist entry with a rationale, not a loosening.
  if grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+${QUALIFIED}\b" <<<"$stmt" \
    && grep -qiE '\bstatus\b' <<<"$stmt"; then
    return 0
  fi

  # Raw SQL — a column-less positional INSERT. `status` cannot appear by name,
  # so this is refused on shape: a positional insert into a 17-column table is
  # unreviewable regardless of whether it happens to set the review state.
  if grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+${QUALIFIED}[[:space:]]+VALUES\b" <<<"$stmt"; then
    return 0
  fi

  # Drizzle write-builders, both halves. The insert half matters as much as the
  # update half: without it the ORM and raw-SQL spellings of one write would
  # disagree, and the ORM insert is the shape an ingest fiber reaches for.
  if grep -qE "\.update\([[:space:]]*${ORM_TABLE}[[:space:]]*\)" <<<"$stmt" \
    && grep -qE '\.set\(' <<<"$stmt" \
    && grep -qE '\bstatus\b' <<<"$stmt"; then
    return 0
  fi
  if grep -qE "\.insert\([[:space:]]*${ORM_TABLE}[[:space:]]*\)" <<<"$stmt" \
    && grep -qE '\bstatus\b' <<<"$stmt"; then
    return 0
  fi

  return 1
}

OFFENDERS=""
if [ -n "$CANDIDATES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Glob match against a `*/`-prefixed pattern, so the fixture suite can stage
    # the same repo-relative paths under a temporary root while the pattern
    # still pins the package. `$a` is intentionally unquoted — it IS the glob.
    allowed=0
    for a in "${ALLOWLIST[@]}"; do
      # shellcheck disable=SC2053
      [[ "$f" == $a || "$f" == */$a ]] && allowed=1 && break
    done
    [ "$allowed" -eq 1 ] && continue
    # Split into STATEMENTS, then keep only those naming the table. Two reasons:
    #
    #   CORRECTNESS — each rule above AND-s independent tokens, which only means
    #   "in the same write" because the unit here is a statement. Per-file, an
    #   UPDATE on one table could pair with a `status` belonging to another.
    #
    #   COST — `schema.ts` is a candidate (it holds the `brainFacts` pgTable) and
    #   is 167KB; the statement filter cuts what the rules ever see to a handful
    #   of short lines. Atlas SQL is single-statement by rule, so a `;` inside a
    #   query literal is not a case this has to handle.
    while IFS= read -r stmt; do
      [ -z "$stmt" ] && continue
      if statement_writes_status "$stmt"; then
        OFFENDERS="${OFFENDERS}${f}"$'\n'
        break
      fi
    done < <(eval "$STRIP_COMMENTS \"\$f\"" | tr '\n' ' ' | tr ';' '\n' \
      | grep -iE 'brain_facts|brainFacts' || true)
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
