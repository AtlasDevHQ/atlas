#!/bin/bash
# Enforce expand-contract discipline on NEWLY-ADDED migrations (#3686).
#
# A single-phase `RENAME COLUMN` or `DROP COLUMN` on a live-written table is
# safe within one container but NOT across an N-1 ↔ N deploy overlap: the
# new (N) container migrates the *shared* regional DB the instant it boots,
# while the draining old (N-1) container is still serving requests against
# the pre-migration column name. The old code then hits
# `column "<name>" does not exist` → hard 500s on live traffic until the
# rollout finishes. Full rationale + the expand-contract recipe live in
# `packages/api/src/lib/db/migrations/README.md`.
#
# Migration `0133_approval_origin_rename.sql` did exactly this `surface →
# origin` rename — explicitly authorized as a pre-customer clean-break
# (CONTEXT.md / ADR-0015), acceptable only because no external customer was
# live. This guard stops the pattern from RECURRING once customers exist.
#
# Scope: ONLY migrations *added* on this branch vs the base ref are scanned
# (`git diff --diff-filter=A`). Pre-existing migrations — including 0133 —
# are never re-scanned, so they are exempt by construction (no allowlist).
#
# Escape hatch: a migration whose DROP/RENAME is a *deliberate, deploy-safe*
# step (the N+1 contract phase of a documented two-phase drop, or an
# explicitly-authorized pre-launch clean-break) declares it with a comment
# line:
#
#     -- expand-contract: <why this is deploy-safe + issue/PR ref>
#
# The marker is intentionally coarse (file-level) and REQUIRES a written
# justification — it forces the deploy-safety rationale into the migration
# header, which is the discipline this guard exists to enforce. A bare
# `-- expand-contract:` with no text does NOT exempt the file.

set -euo pipefail

MIGRATIONS_DIR="packages/api/src/lib/db/migrations"
README="$MIGRATIONS_DIR/README.md"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::migrations directory not found at $MIGRATIONS_DIR — wrong working directory?" >&2
  exit 2
fi

# ── Resolve the base ref robustly ────────────────────────────────────────
# Precedence: explicit BASE_REF override (used by the self-test) > the PR
# target branch (GITHUB_BASE_REF, set by Actions on pull_request) > main.
# We never silently pass: if the base ref can't be resolved after a fetch,
# exit 2 with an actionable message rather than scanning an empty diff
# (which would green-light a real violation).
if [ -n "${BASE_REF:-}" ]; then
  BASE="$BASE_REF"
elif [ -n "${GITHUB_BASE_REF:-}" ]; then
  BASE="origin/${GITHUB_BASE_REF}"
else
  BASE="origin/main"
fi

# Best-effort fetch so origin/<branch> exists and is current. Shallow clones
# (CI default) lack the merge-base, so deepen the fetch. Failures here are
# non-fatal on their own — the rev-parse check below is the real gate — but
# a network failure is surfaced so it isn't mistaken for "no violations".
if [ -z "${BASE_REF:-}" ]; then
  REMOTE_BRANCH="${BASE#origin/}"
  # Explicit refspec guarantees the remote-tracking ref (refs/remotes/origin/
  # <branch>) exists — a GitHub Actions checkout fetches only the PR ref and
  # may not have it. On a shallow clone, deepen so the merge-base is present.
  REFSPEC="+refs/heads/${REMOTE_BRANCH}:refs/remotes/origin/${REMOTE_BRANCH}"
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    git fetch --quiet --unshallow origin "$REFSPEC" 2>/dev/null \
      || git fetch --quiet --depth=2147483647 origin "$REFSPEC" 2>/dev/null \
      || echo "::warning::could not deepen shallow clone for $BASE; base-ref resolution may be incomplete" >&2
  else
    git fetch --quiet origin "$REFSPEC" 2>/dev/null \
      || echo "::warning::git fetch origin $REMOTE_BRANCH failed; using local copy of $BASE" >&2
  fi
fi

if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "::error::cannot resolve base ref '$BASE'." >&2
  echo "  Set BASE_REF to a valid ref, or ensure 'git fetch origin' can reach it." >&2
  echo "  In CI, check the clone is not shallow past the merge-base." >&2
  exit 2
fi

# Three-dot diff = changes on HEAD since the merge-base with BASE, so files
# merged into BASE after this branch forked don't count as "added here".
MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null || true)"
if [ -z "$MERGE_BASE" ]; then
  echo "::error::no merge-base between '$BASE' and HEAD — unrelated histories or an unfetched base." >&2
  exit 2
fi

# Newly-added migration SQL files only (status A). Modified pre-existing
# files are deliberately excluded — migrations are append-only, and a guard
# that re-scanned them would trip on history it cannot change.
mapfile -t ADDED < <(git diff --diff-filter=A --name-only "$MERGE_BASE" HEAD -- "$MIGRATIONS_DIR"/'*.sql' | sort -u)

if [ "${#ADDED[@]}" -eq 0 ]; then
  echo "Migration rename-discipline check passed — no new migrations added vs ${BASE}."
  exit 0
fi

# ── Scan each added migration ────────────────────────────────────────────
# Strip SQL line comments so a `-- DROP COLUMN foo` in prose never trips the
# gate, normalize newlines to spaces (statements span lines / DO blocks),
# then split on `;` into individual statements. Block comments are not used
# in our migrations (same assumption as check-schema-drift.sh).
strip_and_statements() {
  sed -E 's/--.*$//' "$1" | tr '\n' ' '
}

# A column-rename in any of Postgres' accepted spellings:
#   RENAME COLUMN a TO b           (explicit)
#   ALTER TABLE t RENAME a TO b    (bare — Postgres treats this as a column
#                                   rename; exclude RENAME TO / CONSTRAINT,
#                                   which rename the table / a constraint).
RENAME_COLUMN_RE='RENAME[[:space:]]+COLUMN[[:space:]]'
# Bare form: `ALTER TABLE t RENAME <ident> TO ...`. The single identifier
# between RENAME and TO is the renamed column. `RENAME TO` (table rename) has
# no identifier before TO, and `RENAME CONSTRAINT x TO y` has the identifier
# after CONSTRAINT — neither matches, so they are excluded by construction.
BARE_RENAME_RE='ALTER[[:space:]]+TABLE[[:space:]].+[[:space:]]RENAME[[:space:]]+[A-Za-z_][A-Za-z0-9_"]*[[:space:]]+TO[[:space:]]'
DROP_COLUMN_RE='DROP[[:space:]]+COLUMN[[:space:]]'

VIOLATIONS=0
declare -a OFFENDING_FILES=()

for f in "${ADDED[@]}"; do
  [ -f "$f" ] || continue

  # File-level escape hatch: a documented, deploy-safe deliberate step.
  # Requires non-whitespace after the colon (a written justification).
  if grep -Eq '^[[:space:]]*--[[:space:]]*expand-contract:[[:space:]]*[^[:space:]]' "$f"; then
    REASON="$(grep -Em1 '^[[:space:]]*--[[:space:]]*expand-contract:' "$f" | sed -E 's/^[[:space:]]*--[[:space:]]*expand-contract:[[:space:]]*//')"
    echo "  exempt $f — declared expand-contract: ${REASON}"
    continue
  fi

  STMTS="$(strip_and_statements "$f")"
  FILE_HITS=""

  while IFS= read -r stmt; do
    [ -z "${stmt// }" ] && continue
    if echo "$stmt" | grep -Eqi "$DROP_COLUMN_RE"; then
      FILE_HITS="${FILE_HITS}    DROP COLUMN: $(echo "$stmt" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+/ /g' | cut -c1-100)"$'\n'
    fi
    if echo "$stmt" | grep -Eqi "$RENAME_COLUMN_RE"; then
      FILE_HITS="${FILE_HITS}    RENAME COLUMN: $(echo "$stmt" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+/ /g' | cut -c1-100)"$'\n'
    elif echo "$stmt" | grep -Eqi "$BARE_RENAME_RE"; then
      # Bare `ALTER TABLE ... RENAME a TO b` (column rename without the COLUMN
      # keyword). BARE_RENAME_RE already excludes the table-rename (`RENAME
      # TO`) and constraint-rename (`RENAME CONSTRAINT ...`) spellings.
      FILE_HITS="${FILE_HITS}    RENAME COLUMN (bare): $(echo "$stmt" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+/ /g' | cut -c1-100)"$'\n'
    fi
  done < <(echo "$STMTS" | tr ';' '\n')

  if [ -n "$FILE_HITS" ]; then
    OFFENDING_FILES+=("$f")
    echo "::error file=$f::single-phase column rename/drop in a newly-added migration (#3686)"
    echo "  $f:"
    printf '%s' "$FILE_HITS"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "Found single-phase RENAME COLUMN / DROP COLUMN in $VIOLATIONS newly-added migration(s)."
  echo ""
  echo "During an N-1 ↔ N deploy overlap, the old pod still reads/writes the old"
  echo "column against the already-migrated shared DB → 'column does not exist' 500s."
  echo "Once external customers are live (v0.1.0, #2919) this is a customer-facing outage."
  echo ""
  echo "Use expand-contract instead (see $README):"
  echo "  • RENAME: add the new column, dual-write old+new, backfill new from old (release N);"
  echo "    stop reading old (N+1); DROP old (N+2). Never rename in place."
  echo "  • DROP COLUMN: stop writing the column in release N; DROP it in release N+1."
  echo "  • Mirror every column change in db/schema.ts in the same PR."
  echo ""
  echo "If this DROP/RENAME is genuinely deploy-safe (the N+1 contract phase of a"
  echo "documented two-phase drop, an explicitly-authorized pre-launch clean-break, or a"
  echo "table that is not live-written), declare it in the migration with a justified:"
  echo "  -- expand-contract: <why this is deploy-safe + issue/PR ref>"
  exit 1
fi

echo "Migration rename-discipline check passed — ${#ADDED[@]} new migration(s) scanned, no single-phase column rename/drop."
