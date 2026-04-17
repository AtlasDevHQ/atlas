import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { runMigrations, runSeeds } from "@atlas/api/lib/db/migrate";

const MIGRATIONS_DIR = path.join(import.meta.dir, "..", "migrations");

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

function createMockPool(
  opts: { applied?: string[]; failOn?: string; failOnRollback?: boolean } = {},
) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const release = { called: false, arg: undefined as unknown };

  async function queryFn(sql: string, p?: unknown[]) {
    queries.push(sql);
    if (p) params.push(p);

    // Simulate a broken socket on ROLLBACK to exercise the
    // release(err)-on-failed-rollback path.
    if (opts.failOnRollback && sql.trim().toUpperCase() === "ROLLBACK") {
      throw new Error("Mock ROLLBACK failure — socket dirty");
    }

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
  }

  const pool = {
    query: queryFn,
    // connect() returns a dedicated client (same mock) to match pg.Pool behavior.
    // This ensures advisory lock, transactions, and queries all hit the same "connection".
    async connect() {
      return {
        query: queryFn,
        release(err?: Error) {
          release.called = true;
          release.arg = err;
        },
      };
    },
  };

  return { pool, queries, params, release };
}

// ---------------------------------------------------------------------------
// Tests: runMigrations
// ---------------------------------------------------------------------------

describe("runMigrations", () => {
  it("acquires advisory lock, creates tracking table, and applies baseline", async () => {
    const { pool, queries } = createMockPool();

    const count = await runMigrations(pool);

    expect(count).toBe(30);

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
    const { pool, queries } = createMockPool({
      applied: [
        "0000_baseline.sql",
        "0001_teams_installations.sql",
        "0002_discord_installations.sql",
        "0003_telegram_installations.sql",
        "0004_sandbox_credentials.sql",
        "0005_oauth_state.sql",
        "0006_byot_credentials.sql",
        "0007_gchat_installations.sql",
        "0008_github_installations.sql",
        "0009_linear_installations.sql",
        "0010_whatsapp_installations.sql",
        "0011_email_installations.sql",
        "0012_region_migrations.sql",
        "0013_region_migration_cancelled.sql",
        "0014_plugin_marketplace.sql",
        "0015_semantic_versions.sql",
        "0016_invitations_org_id.sql",
        "0017_dashboards.sql",
        "0018_dashboard_refresh.sql",
        "0019_expert_amendments.sql",
        "0020_plan_tier_rename.sql",
        "0021_connection_org_scope.sql",
        "0022_sso_domain_verification.sql",
        "0023_admin_action_log.sql",
        "0024_mode_status_columns.sql",
        "0025_fix_null_unsafe_indexes.sql",
        "0026_drop_legacy_semantic_entity_index.sql",
        "0027_organization_saas_columns.sql",
        "0028_fix_semantic_entity_uniqueness.sql",
        "0029_starter_prompt_approval.sql",
      ],
    });

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
    const { pool, queries, release } = createMockPool({ failOn: "CREATE TABLE IF NOT EXISTS audit_log" });

    await expect(runMigrations(pool)).rejects.toThrow("Migration 0000_baseline.sql failed");
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");

    // Lock is released even on failure
    const unlockQuery = queries.find((q) => q.includes("pg_advisory_unlock"));
    expect(unlockQuery).toBeDefined();

    // Clean ROLLBACK — client is safe to pool, so release() takes no arg
    expect(release.called).toBe(true);
    expect(release.arg).toBeUndefined();
  });

  it("destroys the client on failed ROLLBACK — release(err) called with the rollback error", async () => {
    // Migration SQL fails AND ROLLBACK itself throws. The client must
    // be released with the rollback error so pg destroys the socket
    // rather than pooling a dirty connection.
    const { pool, release } = createMockPool({
      failOn: "CREATE TABLE IF NOT EXISTS audit_log",
      failOnRollback: true,
    });

    await expect(runMigrations(pool)).rejects.toThrow("Migration 0000_baseline.sql failed");

    expect(release.called).toBe(true);
    expect(release.arg).toBeInstanceOf(Error);
    expect((release.arg as Error).message).toContain("ROLLBACK failure");
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

  it("skips files listed in options.skip without recording them", async () => {
    const { pool, queries, params } = createMockPool();

    const skip = ["0027_organization_saas_columns.sql"];
    await runMigrations(pool, { skip });

    // The 0027 SQL never runs — match the issue reference unique to 0027.
    const orgSaasMigration = queries.find((q) => q.includes("issues/1472"));
    expect(orgSaasMigration).toBeUndefined();

    // The 0027 row is not recorded as applied
    const insertedNames = params
      .filter((p) => p.length === 1 && typeof p[0] === "string")
      .map((p) => p[0] as string);
    expect(insertedNames).not.toContain("0027_organization_saas_columns.sql");

    // Other migrations still applied (baseline recorded)
    expect(insertedNames).toContain("0000_baseline.sql");
  });

  it("does not crash when skip-list entries don't match any migration file", async () => {
    // A typo in the skip list (#1472) silently no-ops the safeguard. The
    // runner emits a warning but must not fail the boot; otherwise a stale
    // entry would bring the server down.
    const { pool, params } = createMockPool();

    await expect(runMigrations(pool, { skip: ["0099_does_not_exist.sql"] })).resolves.toBeNumber();

    // Real migrations still recorded.
    const insertedNames = params
      .filter((p) => p.length === 1 && typeof p[0] === "string")
      .map((p) => p[0] as string);
    expect(insertedNames).toContain("0000_baseline.sql");
  });
});

// ---------------------------------------------------------------------------
// Tests: 0027_organization_saas_columns.sql
// ---------------------------------------------------------------------------

describe("0027_organization_saas_columns.sql", () => {
  const filePath = path.join(MIGRATIONS_DIR, "0027_organization_saas_columns.sql");

  it("file exists in the migrations directory", () => {
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("ALTERs organization unconditionally with all SaaS columns", () => {
    const sql = fs.readFileSync(filePath, "utf-8");

    // The point of 0027 is that it does NOT silently skip when organization
    // is missing — that was the bug in 0000/0020. So the SQL must NOT wrap
    // ALTERs in a conditional `IF EXISTS (... table_name = 'organization')` skip.
    // It may use IF NOT EXISTS at the column level for idempotency on existing installs.
    const hasSilentSkip = /IF EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+information_schema\.tables\s+WHERE\s+table_name\s*=\s*'organization'\s*\)\s+THEN\s+ALTER/i.test(sql);
    expect(hasSilentSkip).toBe(false);

    // All required SaaS columns
    expect(sql).toContain("workspace_status");
    expect(sql).toContain("plan_tier");
    expect(sql).toContain("byot");
    expect(sql).toContain("stripe_customer_id");
    expect(sql).toContain("trial_ends_at");
    expect(sql).toContain("suspended_at");
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("region");
    expect(sql).toContain("region_assigned_at");

    // Idempotent on existing installs
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
  });

  it("raises a clear error if organization table is missing", () => {
    const sql = fs.readFileSync(filePath, "utf-8");

    // Must fail loudly — surface the boot-ordering bug rather than silently
    // marking the migration applied with no columns added (the 0000/0020 bug).
    expect(sql).toMatch(/RAISE\s+EXCEPTION/i);
    expect(sql).toContain("organization");
    expect(sql).toContain("1472");
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
