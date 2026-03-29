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
  it("acquires advisory lock, creates tracking table, and applies baseline", async () => {
    const { pool, queries } = createMockPool();

    const count = await runMigrations(pool);

    expect(count).toBe(2);

    // Advisory lock acquired before anything else
    expect(queries[0]).toContain("pg_advisory_lock");

    // Tracking table created
    const createTracking = queries.find((q) => q.includes("__atlas_migrations") && q.includes("CREATE TABLE"));
    expect(createTracking).toBeDefined();

    // Transaction wraps the migration
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");

    // Baseline SQL should contain core tables
    const baselineSql = queries.find((q) => q.includes("CREATE TABLE IF NOT EXISTS audit_log"));
    expect(baselineSql).toBeDefined();

    // Migration was recorded
    const recordQuery = queries.find((q) => q.includes("INSERT INTO __atlas_migrations"));
    expect(recordQuery).toBeDefined();

    // Advisory lock released at the end
    const unlockQuery = queries.find((q) => q.includes("pg_advisory_unlock"));
    expect(unlockQuery).toBeDefined();
  });

  it("skips already-applied migrations", async () => {
    const { pool, queries } = createMockPool({ applied: ["0000_baseline.sql", "0001_teams_installations.sql"] });

    const count = await runMigrations(pool);

    expect(count).toBe(0);

    // Should still check applied status
    const selectQuery = queries.find((q) => q.includes("SELECT name FROM __atlas_migrations"));
    expect(selectQuery).toBeDefined();

    // No transaction or execution should happen
    expect(queries).not.toContain("BEGIN");
    expect(queries).not.toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");

    // No migration record inserted
    const insertMigration = queries.find((q) => q.includes("INSERT INTO __atlas_migrations"));
    expect(insertMigration).toBeUndefined();

    // Lock is still acquired and released
    expect(queries[0]).toContain("pg_advisory_lock");
    const unlockQuery = queries.find((q) => q.includes("pg_advisory_unlock"));
    expect(unlockQuery).toBeDefined();
  });

  it("rolls back on failure and still releases lock", async () => {
    const { pool, queries } = createMockPool({ failOn: "CREATE TABLE IF NOT EXISTS audit_log" });

    await expect(runMigrations(pool)).rejects.toThrow("Migration 0000_baseline.sql failed");
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");

    // Lock is released even on failure
    const unlockQuery = queries.find((q) => q.includes("pg_advisory_unlock"));
    expect(unlockQuery).toBeDefined();
  });

  it("rolls back when INSERT into tracking table fails", async () => {
    const { pool, queries } = createMockPool({ failOn: "INSERT INTO __atlas_migrations" });

    await expect(runMigrations(pool)).rejects.toThrow("Migration 0000_baseline.sql failed");

    // The baseline SQL ran (BEGIN was issued) but the record insert failed
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");

    // Baseline SQL was executed before the failure
    const baselineSql = queries.find((q) => q.includes("CREATE TABLE IF NOT EXISTS audit_log"));
    expect(baselineSql).toBeDefined();
  });

  it("verifies correct transaction ordering: BEGIN → SQL → record → COMMIT", async () => {
    const { pool, queries } = createMockPool();

    await runMigrations(pool);

    const beginIdx = queries.indexOf("BEGIN");
    const baselineIdx = queries.findIndex((q) => q.includes("CREATE TABLE IF NOT EXISTS audit_log"));
    const recordIdx = queries.findIndex((q) => q.includes("INSERT INTO __atlas_migrations"));
    const commitIdx = queries.indexOf("COMMIT");

    expect(beginIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeGreaterThan(beginIdx);
    expect(recordIdx).toBeGreaterThan(baselineIdx);
    expect(commitIdx).toBeGreaterThan(recordIdx);
  });

  it("baseline migration SQL covers all expected tables", async () => {
    const { pool, queries } = createMockPool();

    await runMigrations(pool);

    const baselineSql = queries.find((q) => q.includes("CREATE TABLE IF NOT EXISTS audit_log"));
    expect(baselineSql).toBeDefined();

    // Core tables
    const expectedTables = [
      "audit_log", "conversations", "messages",
      "slack_installations", "slack_threads",
      "action_log", "scheduled_tasks", "scheduled_task_runs",
      "connections", "token_usage", "invitations",
      "plugin_settings", "settings",
      "semantic_entities", "learned_patterns",
      "prompt_collections", "prompt_items", "query_suggestions",
      "usage_events", "usage_summaries",
      "sso_providers", "demo_leads", "ip_allowlist",
      "custom_roles", "user_onboarding",
      "audit_retention_config", "workspace_model_config",
      "approval_rules", "approval_queue",
      "workspace_branding", "onboarding_emails", "email_preferences",
      "abuse_events", "custom_domains",
      // EE tables
      "backups", "backup_config",
      "pii_column_classifications", "scim_group_mappings",
      "sla_metrics", "sla_alerts", "sla_thresholds",
    ];

    for (const table of expectedTables) {
      expect(baselineSql).toContain(table);
    }
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

    // Should insert 3 built-in collections
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

  it("handles missing EE tables gracefully (non-EE deployment)", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);

        // Prompt library works fine
        if (sql.includes("SELECT id FROM prompt_collections")) {
          return { rows: [{ id: "existing" }] };
        }

        // SLA and backup tables don't exist
        if (sql.includes("INSERT INTO sla_thresholds") || sql.includes("INSERT INTO backup_config")) {
          throw new Error('relation "sla_thresholds" does not exist');
        }

        return { rows: [] };
      },
    };

    // Should not throw — missing EE tables are handled gracefully
    await expect(runSeeds(pool)).resolves.toBeUndefined();
  });

  it("logs warning for unexpected seed errors (not missing-table)", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);

        if (sql.includes("SELECT id FROM prompt_collections")) {
          return { rows: [{ id: "existing" }] };
        }

        // Simulate a permission error on SLA seed
        if (sql.includes("INSERT INTO sla_thresholds")) {
          throw new Error("permission denied for table sla_thresholds");
        }

        return { rows: [] };
      },
    };

    // Should not throw — but internally logs a warning
    await expect(runSeeds(pool)).resolves.toBeUndefined();
  });
});
