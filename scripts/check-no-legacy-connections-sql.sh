#!/bin/bash
# Verify that no source file outside `packages/api/src/lib/db/migrations/`
# still references the dropped `connections` or `connection_groups`
# tables in raw SQL. Closes the 1.5.3 cutover (#2744 / ADR-0007) by
# locking in the table-drop: every read/write path must go through
# `workspace_plugins (pillar='datasource')` with JSONB `config.group_id`.
#
# Matches real SQL clauses on word boundaries:
#   FROM connections\b   FROM connection_groups\b
#   INTO connections\b   INTO connection_groups\b
#   UPDATE connections\b UPDATE connection_groups\b
#   DELETE FROM connections\b   DELETE FROM connection_groups\b
#
# The `\b` boundary prevents `workspace_connections` / similar from
# false-matching. Documentation/comment references are excluded by
# stripping `//` line and `/* … */` block comments before matching
# (mirrors `check-ee-imports.sh`).
#
# Exempt paths:
#   - packages/api/src/lib/db/migrations/   (the migration files themselves)
#   - scripts/check-no-legacy-connections-sql.sh   (this script's own pattern)
#
# A regression in this script means a new SQL site slipped in OR a
# migration's data-shape contract is being assumed by runtime code.
# Either way: pivot to `workspace_plugins WHERE pillar='datasource'`
# with `config->>'group_id'` for the group concept, mirroring the
# patterns in `admin-connections.ts` / `loadSavedConnections`.

set -euo pipefail

# Real SQL clauses we want to refuse. Word boundary `\b` keeps
# `workspace_connections` / `slack_connections` from matching.
PATTERN='\b(FROM|INTO|UPDATE|DELETE FROM)\s+(connections|connection_groups)\b'

# Strip comments before matching so a historical reference like
# `// Inverts SELECT * FROM connections…` in a docstring doesn't
# false-positive. Same sed program as check-ee-imports.sh.
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*\$##"'

SEARCH_ROOTS=(packages apps ee examples create-atlas create-atlas-plugin)
EXISTING_ROOTS=()
for root in "${SEARCH_ROOTS[@]}"; do
  [ -d "$root" ] && EXISTING_ROOTS+=("$root")
done

if [ ${#EXISTING_ROOTS[@]} -eq 0 ]; then
  echo "::error::no search roots present — wrong working directory?" >&2
  exit 2
fi

# Candidate files: any tracked text file whose raw content contains
# the pattern. The migration directory is excluded at the directory
# level so the dropped-table SQL inside `0096_drop_connections_table.sql`
# itself (and its companion script) doesn't trip the gate.
CANDIDATES=$(grep -rlnE "$PATTERN" "${EXISTING_ROOTS[@]}" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.js' \
  --include='*.sql' \
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

# Skip this script itself so the literal pattern in the docstring
# above doesn't false-positive.
SELF="$(basename "$0")"

OFFENDERS=""
if [ -n "$CANDIDATES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [[ "$f" == *"$SELF" ]] && continue
    if eval "$STRIP_COMMENTS \"\$f\"" | grep -qE "$PATTERN"; then
      OFFENDERS="${OFFENDERS}${f}"$'\n'
    fi
  done <<<"$CANDIDATES"
fi

OFFENDERS=$(echo "${OFFENDERS%$'\n'}" | grep -v '^$' || true)

if [ -n "$OFFENDERS" ]; then
  echo "::error::raw SQL references to dropped tables \`connections\` or \`connection_groups\` outside the migrations directory."
  echo ""
  echo "These tables were dropped by migration 0096 (#2744 / ADR-0007)."
  echo "Datasource installs live in \`workspace_plugins\` (pillar='datasource');"
  echo "group_id is now a JSONB string in \`config->>'group_id'\` with no separate"
  echo "\`connection_groups\` row."
  echo ""
  echo "Offending files:"
  echo "$OFFENDERS" | sed 's/^/  /'
  echo ""
  echo "Migration recipes:"
  echo "  FROM connections WHERE org_id=\$1 AND status != 'archived'"
  echo "    → FROM workspace_plugins WHERE workspace_id=\$1 AND pillar='datasource' AND status != 'archived'"
  echo ""
  echo "  SELECT group_id FROM connections WHERE id=\$1"
  echo "    → SELECT config->>'group_id' AS group_id FROM workspace_plugins"
  echo "       WHERE install_id=\$1 AND pillar='datasource'"
  echo ""
  echo "  INSERT INTO connections (id, url, type, ...)"
  echo "    → use WorkspaceInstaller.installDatasource (Effect facade) OR"
  echo "      INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id,"
  echo "        pillar, config, ...) with catalog_id looked up from plugin_catalog"
  echo "        by slug, and config built via encryptSecretFields(catalog.config_schema)."
  echo ""
  echo "See \`packages/api/src/api/routes/admin-connections.ts\` for the canonical pattern."
  exit 1
fi

echo "Legacy connections/connection_groups SQL check passed — no offending references found."
