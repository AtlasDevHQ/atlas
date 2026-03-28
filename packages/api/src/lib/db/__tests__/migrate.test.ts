import { describe, it, expect } from "bun:test";
import { runMigrations, runSeeds } from "@atlas/api/lib/db/migrate";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

function createMockPool(opts: { applied?: string[]; failOn?: string } = {}) {
  const queries: string[] = [];
  const params: unknown[][] = [];

  const pool = {
    async query(sql: string, p?: unknown[]) {
      queries.push(sql);
      if (p) params.push(p);

      if (opts.failOn && sql.includes(opts.failOn)) {
        throw new Error(`Mock failure on: ${opts.failOn}`);
      }

      // Return applied migrations for the SELECT query
      if (sql.includes("SELECT name FROM __atlas_migrations")) {
        return {
          rows: (opts.applied ?? []).map((name) => ({ name })),
        };
      }

      // Return empty rows for seed checks (prompt_collections lookup)
      if (sql.includes("SELECT id FROM prompt_collections")) {
        return { rows: [] };
      }

      // Return a mock id for INSERT ... RETURNING id
      if (sql.includes("RETURNING id")) {
        return { rows: [{ id: "mock-uuid" }] };
      }

      return { rows: [] };
    },
  };

  return { pool, queries, params };
}

// ---------------------------------------------------------------------------
// Tests: runMigrations
// ---------------------------------------------------------------------------

describe("runMigrations", () => {
  it("creates tracking table and applies baseline", async () => {
    const { pool, queries } = createMockPool();

    const count = await runMigrations(pool);

    expect(count).toBe(1);
    expect(queries[0]).toContain("CREATE TABLE IF NOT EXISTS __atlas_migrations");
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");

    // Baseline SQL should contain core tables
    const baselineSql = queries.find((q) => q.includes("CREATE TABLE IF NOT EXISTS audit_log"));
    expect(baselineSql).toBeDefined();

    // Migration was recorded
    const recordQuery = queries.find((q) => q.includes("INSERT INTO __atlas_migrations"));
    expect(recordQuery).toBeDefined();
  });

  it("skips already-applied migrations", async () => {
    const { pool, queries } = createMockPool({ applied: ["0000_baseline.sql"] });

    const count = await runMigrations(pool);

    expect(count).toBe(0);
    expect(queries).not.toContain("BEGIN");
  });

  it("rolls back on failure", async () => {
    const { pool, queries } = createMockPool({ failOn: "CREATE TABLE IF NOT EXISTS audit_log" });

    await expect(runMigrations(pool)).rejects.toThrow("Migration 0000_baseline.sql failed");
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });
});

// ---------------------------------------------------------------------------
// Tests: runSeeds
// ---------------------------------------------------------------------------

describe("runSeeds", () => {
  it("seeds prompt library on empty database", async () => {
    const { pool, queries } = createMockPool();

    await runSeeds(pool);

    // Should check for existing collections
    const selectPrompt = queries.find((q) => q.includes("SELECT id FROM prompt_collections"));
    expect(selectPrompt).toBeDefined();

    // Should insert collections (3 built-in collections)
    const inserts = queries.filter((q) => q.includes("INSERT INTO prompt_collections"));
    expect(inserts.length).toBe(3);
  });

  it("skips prompt library when collections already exist", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("SELECT id FROM prompt_collections")) {
          return { rows: [{ id: "existing" }] };
        }
        return { rows: [] };
      },
    };

    await runSeeds(pool);

    const inserts = queries.filter((q) => q.includes("INSERT INTO prompt_collections"));
    expect(inserts.length).toBe(0);
  });

  it("seeds SLA threshold and backup config defaults", async () => {
    const { pool, queries } = createMockPool();

    await runSeeds(pool);

    const slaInsert = queries.find((q) => q.includes("INSERT INTO sla_thresholds"));
    expect(slaInsert).toBeDefined();

    const backupInsert = queries.find((q) => q.includes("INSERT INTO backup_config"));
    expect(backupInsert).toBeDefined();
  });
});
