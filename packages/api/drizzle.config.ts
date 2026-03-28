import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration for the internal database.
 *
 * Usage:
 *   bun drizzle-kit generate   # generate a new migration from schema changes
 *   bun drizzle-kit check      # verify schema ↔ migration consistency
 *
 * The migration runner is custom (see src/lib/db/migrate.ts) — we do NOT
 * use drizzle-kit push or drizzle-kit migrate. Only the SQL generation is used.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/migrations",
});
