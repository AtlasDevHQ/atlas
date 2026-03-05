/**
 * Schema-driven plugin migrations.
 *
 * Reads `schema` declarations from plugin objects, generates CREATE TABLE
 * SQL for the internal database, and tracks applied migrations in a
 * `plugin_migrations` table for idempotency.
 *
 * Table names are prefixed with `plugin_` to avoid collisions with Atlas
 * internal tables.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("plugins:migrate");

// ---------------------------------------------------------------------------
// Types (structural — no import from @useatlas/plugin-sdk)
// ---------------------------------------------------------------------------

interface FieldDef {
  type: "string" | "number" | "boolean" | "date";
  required?: boolean;
  references?: { model: string; field: string };
  unique?: boolean;
  defaultValue?: unknown;
}

interface TableDef {
  fields: Record<string, FieldDef>;
}

interface PluginWithSchema {
  id: string;
  schema?: Record<string, TableDef>;
}

// ---------------------------------------------------------------------------
// SQL type mapping
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  string: "TEXT",
  number: "INTEGER",
  boolean: "BOOLEAN",
  date: "TIMESTAMPTZ",
};

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(name: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid identifier "${name}" in ${context}. ` +
      `Must contain only letters, digits, and underscores, and start with a letter or underscore.`
    );
  }
}

function fieldToSQL(name: string, field: FieldDef): string {
  validateIdentifier(name, "column name");

  const sqlType = TYPE_MAP[field.type];
  if (!sqlType) {
    throw new Error(`Unknown field type "${field.type}" on column "${name}"`);
  }

  const parts = [`"${name}" ${sqlType}`];

  if (field.required) parts.push("NOT NULL");
  if (field.unique) parts.push("UNIQUE");

  if (field.defaultValue !== undefined) {
    if (typeof field.defaultValue === "string") {
      // Escape single quotes in default values
      parts.push(`DEFAULT '${field.defaultValue.replace(/'/g, "''")}'`);
    } else if (typeof field.defaultValue === "boolean") {
      parts.push(`DEFAULT ${field.defaultValue}`);
    } else if (typeof field.defaultValue === "number") {
      if (!Number.isFinite(field.defaultValue)) {
        throw new Error(
          `Invalid numeric defaultValue "${field.defaultValue}" on column "${name}". ` +
          `Default values must be finite numbers.`
        );
      }
      parts.push(`DEFAULT ${field.defaultValue}`);
    } else {
      throw new Error(
        `Unsupported defaultValue type "${typeof field.defaultValue}" on column "${name}". ` +
        `Only string, boolean, and number default values are supported.`
      );
    }
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Table name prefixing
// ---------------------------------------------------------------------------

/**
 * Build a safe prefixed table name: `plugin_{pluginId}_{tableName}`.
 * Replaces non-alphanumeric/underscore chars with underscores for safety.
 */
export function prefixTableName(pluginId: string, tableName: string): string {
  const safePlugin = pluginId.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `plugin_${safePlugin}_${safeTable}`;
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

export interface MigrationStatement {
  pluginId: string;
  tableName: string;
  prefixedName: string;
  sql: string;
  hash: string;
}

/**
 * Hash a SQL string for change detection. Uses a simple string hash
 * (not crypto — just for detecting drift, not security).
 */
function hashSQL(sql: string): string {
  let h = 0;
  for (let i = 0; i < sql.length; i++) {
    h = ((h << 5) - h + sql.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Generate CREATE TABLE IF NOT EXISTS statements from plugin schema
 * declarations. Each table gets an auto-generated `id` primary key
 * and `created_at`/`updated_at` timestamps.
 */
export function generateMigrationSQL(plugins: PluginWithSchema[]): MigrationStatement[] {
  const statements: MigrationStatement[] = [];

  for (const plugin of plugins) {
    if (!plugin.schema) continue;

    for (const [tableName, tableDef] of Object.entries(plugin.schema)) {
      const prefixed = prefixTableName(plugin.id, tableName);
      const columns: string[] = [
        '"id" UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      ];

      for (const [fieldName, fieldDef] of Object.entries(tableDef.fields)) {
        columns.push(fieldToSQL(fieldName, fieldDef));
      }

      // Add foreign key constraints after columns
      for (const [fieldName, fieldDef] of Object.entries(tableDef.fields)) {
        if (fieldDef.references) {
          validateIdentifier(fieldDef.references.field, `references.field on column "${fieldName}"`);
          const refTable = prefixTableName(plugin.id, fieldDef.references.model);
          columns.push(
            `FOREIGN KEY ("${fieldName}") REFERENCES "${refTable}"("${fieldDef.references.field}")`
          );
        }
      }

      columns.push('"created_at" TIMESTAMPTZ DEFAULT now()');
      columns.push('"updated_at" TIMESTAMPTZ DEFAULT now()');

      const sql = `CREATE TABLE IF NOT EXISTS "${prefixed}" (\n  ${columns.join(",\n  ")}\n);`;

      statements.push({
        pluginId: plugin.id,
        tableName,
        prefixedName: prefixed,
        sql,
        hash: hashSQL(sql),
      });
    }
  }

  return statements;
}

// ---------------------------------------------------------------------------
// Migration tracking table
// ---------------------------------------------------------------------------

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS plugin_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  sql_hash TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plugin_id, table_name, sql_hash)
);
`;

// ---------------------------------------------------------------------------
// Apply migrations
// ---------------------------------------------------------------------------

/** Internal DB interface — matches the shape from internal.ts */
export interface MigrateDB {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Ensure the plugin_migrations tracking table exists.
 */
export async function ensureMigrationsTable(db: MigrateDB): Promise<void> {
  await db.query(MIGRATIONS_TABLE_SQL);
}

/**
 * Check which migrations have already been applied.
 * Returns a Set of "pluginId:tableName:hash" keys.
 */
export async function getAppliedMigrations(db: MigrateDB): Promise<Set<string>> {
  const result = await db.query(
    "SELECT plugin_id, table_name, sql_hash FROM plugin_migrations"
  );
  const applied = new Set<string>();
  for (const row of result.rows) {
    applied.add(`${row.plugin_id}:${row.table_name}:${row.sql_hash}`);
  }
  return applied;
}

/**
 * Apply pending migrations to the internal database.
 * Skips already-applied migrations (idempotent).
 *
 * @returns Summary of applied and skipped migrations.
 */
export async function applyMigrations(
  db: MigrateDB,
  statements: MigrationStatement[],
): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable(db);
  const existing = await getAppliedMigrations(db);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const stmt of statements) {
    const key = `${stmt.pluginId}:${stmt.tableName}:${stmt.hash}`;
    if (existing.has(key)) {
      skipped.push(stmt.prefixedName);
      log.debug({ table: stmt.prefixedName }, "Migration already applied — skipping");
      continue;
    }

    try {
      await db.query(stmt.sql);
      await db.query(
        "INSERT INTO plugin_migrations (plugin_id, table_name, sql_hash) VALUES ($1, $2, $3)",
        [stmt.pluginId, stmt.tableName, stmt.hash],
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Migration failed for "${stmt.prefixedName}": ${detail}. ` +
        `Applied so far: [${applied.join(", ") || "none"}]. ` +
        `Remaining migrations were not attempted.`,
        { cause: err },
      );
    }
    applied.push(stmt.prefixedName);
    log.info({ table: stmt.prefixedName, pluginId: stmt.pluginId }, "Migration applied");
  }

  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Diff: compare declared schema vs actual tables
// ---------------------------------------------------------------------------

export interface SchemaDiff {
  newTables: string[];
  existingTables: string[];
}

/**
 * Compare declared plugin schemas against actual tables in the database.
 */
export async function diffSchema(
  db: MigrateDB,
  statements: MigrationStatement[],
): Promise<SchemaDiff> {
  const result = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  const existing = new Set(result.rows.map((r) => String(r.tablename)));

  const newTables: string[] = [];
  const existingTables: string[] = [];

  for (const stmt of statements) {
    if (existing.has(stmt.prefixedName)) {
      existingTables.push(stmt.prefixedName);
    } else {
      newTables.push(stmt.prefixedName);
    }
  }

  return { newTables, existingTables };
}
