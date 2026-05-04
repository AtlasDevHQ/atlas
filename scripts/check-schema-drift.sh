#!/bin/bash
# Verify that every CREATE TABLE in migration SQL files has a corresponding
# pgTable() definition in schema.ts. Catches the case where a hand-written
# migration adds a table but schema.ts isn't updated — which would cause
# drizzle-kit generate to produce a DROP TABLE migration.
#
# Tables that have been dropped by a later migration (`DROP TABLE [IF
# EXISTS] <name>`) are subtracted from the expected set — schema.ts no
# longer needs to declare them, since the migration runner ends up with
# no such table after replay. Without this subtraction step, dropping
# any table (e.g. mcp_tokens removed in 0047 after 0046 created it)
# would surface as a false-positive drift.

set -euo pipefail

MIGRATIONS_DIR="packages/api/src/lib/db/migrations"
SCHEMA_FILE="packages/api/src/lib/db/schema.ts"

# Fail loudly if the migrations directory disappears (rename, move, or
# typo here). Silencing stderr on the greps below would otherwise let
# the checker pass with an empty SQL_TABLES set, masking real drift.
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::migrations directory not found at $MIGRATIONS_DIR" >&2
  exit 2
fi

# Strip SQL line comments before extracting CREATE / DROP statements.
# Migrations include long prose headers that frequently mention table
# names — `-- DROP TABLE foo` in a comment would otherwise subtract
# `foo` from the expected set and silently mask drift on a critical
# table. We keep block comments (`/* … */`) intact for two reasons:
#   1. our migrations don't use them, so they're a no-op today
#   2. handling them robustly requires an actual SQL parser, and bash
#      isn't the place. If we ever start using block comments, switch
#      to a node-sql-parser script.
STRIP_COMMENTS='sed -E "s/--.*$//"'

# Tables created by SQL: CREATE TABLE IF NOT EXISTS <name>
CREATED=$(eval "$STRIP_COMMENTS \"$MIGRATIONS_DIR\"/*.sql" \
  | grep -ohP 'CREATE TABLE IF NOT EXISTS \K\w+' \
  | sort -u)

# Tables dropped by SQL: DROP TABLE [IF EXISTS] <name> [CASCADE]
# `\K` resets the match start so `\w+` captures only the table name.
# `|| true` keeps `set -e` happy when no migrations have any DROPs.
DROPPED=$(eval "$STRIP_COMMENTS \"$MIGRATIONS_DIR\"/*.sql" \
  | grep -ohiP 'DROP TABLE\s+(?:IF\s+EXISTS\s+)?\K\w+' \
  | sort -u || true)

# Final expected set = created MINUS dropped.
SQL_TABLES=$(comm -23 <(echo "$CREATED") <(echo "$DROPPED"))

# Tables from schema.ts: pgTable(\n  "<name>", ...) — name may be on same or next line
SCHEMA_TABLES=$(grep -zoP 'pgTable\(\s*"\K[^"]+' "$SCHEMA_FILE" | tr '\0' '\n' | sort -u)

MISSING=0
for table in $SQL_TABLES; do
  # Skip the migrations tracking table — it's created by the runner, not in schema
  if [ "$table" = "__atlas_migrations" ]; then continue; fi

  if ! echo "$SCHEMA_TABLES" | grep -qx "$table"; then
    echo "::error::Table '$table' exists in migration SQL but not in schema.ts"
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "Found $MISSING table(s) in migrations missing from schema.ts."
  echo "Add them to packages/api/src/lib/db/schema.ts so future"
  echo "drizzle-kit generate runs don't produce a DROP TABLE migration."
  exit 1
fi

SQL_COUNT=$(echo "$SQL_TABLES" | grep -cv '^__atlas_migrations$' || true)
DROPPED_COUNT=$(echo "$DROPPED" | grep -cv '^$' || true)
echo "Schema drift check passed — $SQL_COUNT migration table(s) found in schema.ts; $DROPPED_COUNT dropped table(s) excluded."
