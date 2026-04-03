/**
 * atlas migrate — Generate or apply plugin schema migrations.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

export async function handleMigrate(args: string[]): Promise<void> {
  const shouldApply = args.includes("--apply");

  // Require DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL is required for atlas migrate.");
    console.error(
      "  Set DATABASE_URL to a PostgreSQL connection string for the Atlas internal database.",
    );
    process.exit(1);
  }

  // Load config to get plugin list
  const { loadConfig } = await import("@atlas/api/lib/config");
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(
      `Error loading config: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const plugins = config.plugins as
    | Array<{ id: string; schema?: Record<string, unknown> }>
    | undefined;
  if (!plugins?.length) {
    console.log(
      "No plugins configured in atlas.config.ts — nothing to migrate.",
    );
    return;
  }

  // Check which plugins have schemas
  const pluginsWithSchema = plugins.filter(
    (p) => p.schema && Object.keys(p.schema).length > 0,
  );
  if (pluginsWithSchema.length === 0) {
    console.log("No plugins declare a schema — nothing to migrate.");
    return;
  }

  // Generate migration SQL
  const { generateMigrationSQL, applyMigrations, diffSchema } =
    await import("@atlas/api/lib/plugins/migrate");

  const statements = generateMigrationSQL(
    pluginsWithSchema as Parameters<typeof generateMigrationSQL>[0],
  );
  if (statements.length === 0) {
    console.log("No migration statements generated.");
    return;
  }

  if (!shouldApply) {
    // Dry run — print SQL
    console.log("-- Plugin schema migrations (dry run)\n");
    console.log(
      `-- ${statements.length} table(s) from ${pluginsWithSchema.length} plugin(s)\n`,
    );
    for (const stmt of statements) {
      console.log(
        `-- Plugin: ${stmt.pluginId}, Table: ${stmt.tableName} → ${stmt.prefixedName}`,
      );
      console.log(stmt.sql);
      console.log();
    }
    console.log("-- Run with --apply to execute these migrations.");

    // Show diff if possible
    try {
      const { getInternalDB } = await import(
        "@atlas/api/lib/db/internal"
      );
      const db = getInternalDB();
      const diff = await diffSchema(db, statements);
      if (diff.newTables.length > 0) {
        console.log(
          `\nNew tables: ${diff.newTables.join(", ")}`,
        );
      }
      if (diff.existingTables.length > 0) {
        console.log(
          `Already existing: ${diff.existingTables.join(", ")}`,
        );
      }
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : String(err);
      console.log(
        `\n-- Skipped schema diff: could not connect to internal database.`,
      );
      console.log(`--   Reason: ${detail}`);
    }
    return;
  }

  // Apply migrations
  console.log("Applying plugin schema migrations...\n");

  const { getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );
  let db;
  try {
    db = getInternalDB();
  } catch (err) {
    console.error(
      `Error connecting to internal database: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  let result;
  try {
    result = await applyMigrations(db, statements);
  } catch (err) {
    console.error(
      `Migration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "\nYour database may be in a partially migrated state.",
    );
    console.error(
      "Run 'atlas migrate' (without --apply) to review pending migrations.",
    );
    process.exit(1);
  }

  if (result.applied.length > 0) {
    console.log(
      `Applied ${result.applied.length} migration(s):`,
    );
    for (const table of result.applied) {
      console.log(`  \u2713 ${table}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log(
      `Skipped ${result.skipped.length} already-applied migration(s):`,
    );
    for (const table of result.skipped) {
      console.log(`  - ${table}`);
    }
  }
  if (
    result.applied.length === 0 &&
    result.skipped.length > 0
  ) {
    console.log(
      "\nAll migrations already applied — nothing to do.",
    );
  } else if (result.applied.length > 0) {
    console.log("\nPlugin schema migrations complete.");
  }
}
