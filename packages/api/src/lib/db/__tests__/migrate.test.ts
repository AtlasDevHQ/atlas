import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { runMigrations, runSeeds } from "@atlas/api/lib/db/migrate";
import { BACKUP_STATUSES } from "@useatlas/types";

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

    expect(count).toBe(48);

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
        "0029_user_favorite_prompts.sql",
        "0030_starter_prompt_approval.sql",
        "0031_abuse_events_enum_checks.sql",
        "0032_backups_status_check.sql",
        "0033_custom_domains_dns_verification.sql",
        "0034_share_mode_org_requires_org_id.sql",
        "0035_admin_action_retention.sql",
        "0036_integration_credentials_encryption.sql",
        "0037_plugin_config_encryption.sql",
        "0038_encryption_key_versioning.sql",
        "0039_conversation_step_cap.sql",
        "0040_drop_integration_plaintext.sql",
        "0041_dashboard_card_layout.sql",
        "0042_audit_retention_default.sql",
        "0043_region_migration_region_updated.sql",
        "0044_scheduled_tasks_plugin_id.sql",
        "0045_sub_processor_subscriptions.sql",
        "0046_mcp_tokens.sql",
        "0047_drop_mcp_tokens.sql",
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
// Tests: 0031_abuse_events_enum_checks.sql
// ---------------------------------------------------------------------------

describe("0031_abuse_events_enum_checks.sql", () => {
  const filePath = path.join(MIGRATIONS_DIR, "0031_abuse_events_enum_checks.sql");

  it("file exists in the migrations directory", () => {
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("cleans pre-drifted rows before adding CHECK constraints", () => {
    const sql = fs.readFileSync(filePath, "utf-8");

    const updateLevelIdx = sql.search(/UPDATE\s+abuse_events\s+SET\s+level\s*=\s*'none'/i);
    const updateTriggerIdx = sql.search(/UPDATE\s+abuse_events\s+SET\s+trigger_type\s*=\s*'manual'/i);
    const checkLevelIdx = sql.search(/CHECK\s*\(\s*level\s+IN\b/i);
    const checkTriggerIdx = sql.search(/CHECK\s*\(\s*trigger_type\s+IN\b/i);

    // All four statements must exist
    expect(updateLevelIdx).toBeGreaterThan(-1);
    expect(updateTriggerIdx).toBeGreaterThan(-1);
    expect(checkLevelIdx).toBeGreaterThan(-1);
    expect(checkTriggerIdx).toBeGreaterThan(-1);

    // Ordering: cleanup UPDATEs must come before the ADD CONSTRAINTs,
    // otherwise pre-drifted rows block the migration from applying.
    expect(updateLevelIdx).toBeLessThan(checkLevelIdx);
    expect(updateTriggerIdx).toBeLessThan(checkTriggerIdx);
  });

  it("enumerates all canonical values for both columns", () => {
    const sql = fs.readFileSync(filePath, "utf-8");

    for (const v of ["none", "warning", "throttled", "suspended"]) {
      expect(sql).toContain(`'${v}'`);
    }
    for (const v of ["query_rate", "error_rate", "unique_tables", "manual"]) {
      expect(sql).toContain(`'${v}'`);
    }
  });

  it("wraps both ADD CONSTRAINTs in idempotent DO $$ … EXCEPTION guards", () => {
    const sql = fs.readFileSync(filePath, "utf-8");

    // Two DO $$ blocks — one per constraint — each catching duplicate_object
    // so re-running the migration on an already-constrained DB is a no-op.
    const doBlocks = sql.match(/DO\s*\$\$\s*BEGIN[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+NULL;\s*END\s*\$\$\s*;/gi) ?? [];
    expect(doBlocks.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: 0032_backups_status_check.sql
// ---------------------------------------------------------------------------

describe("0032_backups_status_check.sql", () => {
  const filePath = path.join(MIGRATIONS_DIR, "0032_backups_status_check.sql");

  it("file exists in the migrations directory", () => {
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("coerces pre-drifted rows to 'failed' before adding the CHECK", () => {
    // Ordering is load-bearing: if the CHECK runs first, a single pre-drifted
    // row would block the migration from applying on an upgrade. See 0031.
    const sql = fs.readFileSync(filePath, "utf-8");

    const updateIdx = sql.search(/UPDATE\s+backups\s+SET\s+status\s*=\s*'failed'/i);
    const checkIdx = sql.search(/CHECK\s*\(\s*status\s+IN\b/i);

    expect(updateIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeLessThan(checkIdx);
  });

  it("enumerates every canonical BACKUP_STATUSES value", () => {
    // Pull the canonical tuple from @useatlas/types rather than hardcoding.
    // If the tuple changes there, this test tracks it automatically.
    const sql = fs.readFileSync(filePath, "utf-8");
    for (const v of BACKUP_STATUSES) {
      expect(sql).toContain(`'${v}'`);
    }
  });

  it("emits a RAISE NOTICE when drift rows are coerced", () => {
    // Operators need a post-mortem breadcrumb for "why did my completed
    // backup show as failed?" — 0031 shipped without one, 0032 must not.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(/RAISE\s+NOTICE[^;]*coerced/i);
    expect(sql).toMatch(/GET\s+DIAGNOSTICS[^;]*ROW_COUNT/i);
  });

  it("wraps the ADD CONSTRAINT in an idempotent DO $$ … duplicate_object guard", () => {
    const sql = fs.readFileSync(filePath, "utf-8");
    // Exactly one idempotency guard (the ADD CONSTRAINT). The RAISE
    // NOTICE block is a separate DO $$ without an EXCEPTION clause.
    const idempotentBlocks = sql.match(
      /DO\s*\$\$\s*BEGIN[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+NULL;\s*END\s*\$\$\s*;/gi,
    ) ?? [];
    expect(idempotentBlocks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: 0034_share_mode_org_requires_org_id.sql
// ---------------------------------------------------------------------------

describe("0034_share_mode_org_requires_org_id.sql", () => {
  const filePath = path.join(MIGRATIONS_DIR, "0034_share_mode_org_requires_org_id.sql");

  it("file exists in the migrations directory", () => {
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("remediates bad rows on both tables before adding the CHECK constraint", () => {
    // Ordering is load-bearing: a pre-drifted row with share_mode='org' and
    // org_id IS NULL would block the ADD CONSTRAINT if the remediation ran
    // second. See 0031 / 0032 for the same pattern.
    const sql = fs.readFileSync(filePath, "utf-8");

    const updateConvIdx = sql.search(/UPDATE\s+conversations[\s\S]*?share_mode\s*=\s*'public'/i);
    const updateDashIdx = sql.search(/UPDATE\s+dashboards[\s\S]*?share_mode\s*=\s*'public'/i);
    const checkConvIdx = sql.search(/ALTER\s+TABLE\s+conversations[\s\S]*?CONSTRAINT\s+chk_org_scoped_share/i);
    const checkDashIdx = sql.search(/ALTER\s+TABLE\s+dashboards[\s\S]*?CONSTRAINT\s+chk_org_scoped_share/i);

    expect(updateConvIdx).toBeGreaterThan(-1);
    expect(updateDashIdx).toBeGreaterThan(-1);
    expect(checkConvIdx).toBeGreaterThan(-1);
    expect(checkDashIdx).toBeGreaterThan(-1);

    expect(updateConvIdx).toBeLessThan(checkConvIdx);
    expect(updateDashIdx).toBeLessThan(checkDashIdx);
  });

  it("targets exactly the share_mode='org' AND org_id IS NULL predicate in both remediations", () => {
    const sql = fs.readFileSync(filePath, "utf-8");

    const convPredicate = /UPDATE\s+conversations\s+SET\s+share_mode\s*=\s*'public'[\s\S]*?WHERE\s+share_mode\s*=\s*'org'\s+AND\s+org_id\s+IS\s+NULL/i;
    const dashPredicate = /UPDATE\s+dashboards\s+SET\s+share_mode\s*=\s*'public'[\s\S]*?WHERE\s+share_mode\s*=\s*'org'\s+AND\s+org_id\s+IS\s+NULL/i;

    expect(sql).toMatch(convPredicate);
    expect(sql).toMatch(dashPredicate);
  });

  it("revokes share_token and share_expires_at on coerced rows so drifted org-shares don't become live-as-public", () => {
    // Without this, post-migration rows with share_mode='public' + live
    // share_token would silently flip from F-01 fail-closed 403 to a
    // publicly-viewable link. See #1737 PR review.
    const sql = fs.readFileSync(filePath, "utf-8");

    const convRevoke = /UPDATE\s+conversations\s+SET[\s\S]*?share_token\s*=\s*NULL[\s\S]*?share_expires_at\s*=\s*NULL[\s\S]*?WHERE\s+share_mode\s*=\s*'org'\s+AND\s+org_id\s+IS\s+NULL/i;
    const dashRevoke = /UPDATE\s+dashboards\s+SET[\s\S]*?share_token\s*=\s*NULL[\s\S]*?share_expires_at\s*=\s*NULL[\s\S]*?WHERE\s+share_mode\s*=\s*'org'\s+AND\s+org_id\s+IS\s+NULL/i;

    expect(sql).toMatch(convRevoke);
    expect(sql).toMatch(dashRevoke);
  });

  it("encodes the CHECK as `share_mode <> 'org' OR org_id IS NOT NULL` on both tables", () => {
    // This is the invariant from #1737 — any deviation (e.g. swapping the
    // operator) would silently drop enforcement for rows with share_mode
    // <> 'org', which is fine, but an equality check would block valid
    // 'public' rows. Pin the exact shape.
    const sql = fs.readFileSync(filePath, "utf-8");
    const convCheck = /ALTER\s+TABLE\s+conversations\s+ADD\s+CONSTRAINT\s+chk_org_scoped_share\s+CHECK\s*\(\s*share_mode\s*<>\s*'org'\s+OR\s+org_id\s+IS\s+NOT\s+NULL\s*\)/i;
    const dashCheck = /ALTER\s+TABLE\s+dashboards\s+ADD\s+CONSTRAINT\s+chk_org_scoped_share\s+CHECK\s*\(\s*share_mode\s*<>\s*'org'\s+OR\s+org_id\s+IS\s+NOT\s+NULL\s*\)/i;

    expect(sql).toMatch(convCheck);
    expect(sql).toMatch(dashCheck);
  });

  it("emits a RAISE NOTICE for each table when drift rows are coerced", () => {
    // Operators need to see "we just flipped N shares back to public" —
    // silent rewrites are the failure mode 0031 shipped with.
    // Strip comment lines before matching so the header's prose
    // reference to RAISE NOTICE doesn't inflate the count.
    const raw = fs.readFileSync(filePath, "utf-8");
    const sql = raw.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const notices = sql.match(/RAISE\s+NOTICE\s+'[^']*coerced/gi) ?? [];
    expect(notices.length).toBe(2);

    const diagnostics = sql.match(/GET\s+DIAGNOSTICS[^;]*ROW_COUNT/gi) ?? [];
    expect(diagnostics.length).toBe(2);
  });

  it("wraps both ADD CONSTRAINTs in idempotent DO $$ … duplicate_object guards", () => {
    const sql = fs.readFileSync(filePath, "utf-8");
    // Two idempotency guards — one per constraint. The RAISE NOTICE
    // blocks are separate DO $$ without an EXCEPTION clause.
    const idempotentBlocks = sql.match(
      /DO\s*\$\$\s*BEGIN[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+NULL;\s*END\s*\$\$\s*;/gi,
    ) ?? [];
    expect(idempotentBlocks.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: 0035_admin_action_retention.sql  (F-36 phase 1)
// ---------------------------------------------------------------------------

describe("0035_admin_action_retention.sql", () => {
  const filePath = path.join(MIGRATIONS_DIR, "0035_admin_action_retention.sql");

  it("file exists in the migrations directory", () => {
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("adds anonymized_at column to admin_action_log", () => {
    // The column backs the GDPR erasure contract — its absence would silently
    // break the anonymizeUserAdminActions promise (no positive scrubbed-row
    // signal). Pin the exact column + type.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+admin_action_log\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+anonymized_at\s+TIMESTAMPTZ/i,
    );
  });

  it("relaxes actor_id and actor_email to nullable (so erasure can write NULL)", () => {
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(/ALTER\s+COLUMN\s+actor_id\s+DROP\s+NOT\s+NULL/i);
    expect(sql).toMatch(/ALTER\s+COLUMN\s+actor_email\s+DROP\s+NOT\s+NULL/i);
  });

  it("creates admin_action_retention_config mirroring audit_retention_config shape", () => {
    // Parallel-table decision (D4 in the design doc) — schema shape must match
    // so the library can reuse row-mapping conventions from the audit_log side.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+admin_action_retention_config/i);
    expect(sql).toMatch(/org_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    expect(sql).toMatch(/retention_days\s+INTEGER/i);
    expect(sql).toMatch(/hard_delete_delay_days\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+30/i);
    expect(sql).toMatch(/last_purge_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/last_purge_count\s+INTEGER/i);
  });

  it("creates partial index on admin_action_log.anonymized_at for scrubbed-row queries", () => {
    // Forensic queries filtering anonymized rows need the partial index to
    // stay fast as the table grows; a full-table index would bloat with
    // NULL entries, which are the majority.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_admin_action_log_anonymized_at[\s\S]*?WHERE\s+anonymized_at\s+IS\s+NOT\s+NULL/i,
    );
  });

  it("creates org_id index on admin_action_retention_config", () => {
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_admin_action_retention_config_org\s+ON\s+admin_action_retention_config\(org_id\)/i,
    );
  });

  it("references the design doc and audit row in header comments", () => {
    // Stops a future session from re-litigating the erasure option 1/2/3
    // decision — pins a single doc as the canonical reference.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(/admin-action-log-retention\.md/);
    expect(sql).toMatch(/F-36/);
  });
});

// ---------------------------------------------------------------------------
// Tests: 0042_audit_retention_default.sql  (#1927)
// ---------------------------------------------------------------------------

describe("0042_audit_retention_default.sql", () => {
  const filePath = path.join(MIGRATIONS_DIR, "0042_audit_retention_default.sql");

  it("file exists in the migrations directory", () => {
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("sets audit_retention_config.retention_days DEFAULT to 365", () => {
    // Pins the literal `365` in the migration SQL. The privacy page also
    // pins the literal — drift between the two is then visible at code
    // review (no shared symbol, but no silent skew either).
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+audit_retention_config\s+ALTER\s+COLUMN\s+retention_days\s+SET\s+DEFAULT\s+365/i,
    );
  });

  it("backfills existing orgs with retention_days=365 and hard_delete_delay_days=30, in that column order", () => {
    // Single regex pins BOTH the INSERT column order AND the SELECT
    // projection so a future edit that reorders one without the other
    // (e.g., flips the column list to put hard_delete_delay_days second
    // while leaving SELECT id, 365, 30 unchanged) silently inverts the
    // values — admins would get 30-day retention and 365-day hard-delete
    // delay. The combined pattern catches that drift.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(
      /INSERT\s+INTO\s+audit_retention_config\s*\(\s*org_id\s*,\s*retention_days\s*,\s*hard_delete_delay_days\s*\)\s*SELECT\s+id\s*,\s*365\s*,\s*30\s+FROM\s+organization/i,
    );
  });

  it("backfill is idempotent via WHERE NOT EXISTS — never via ON CONFLICT", () => {
    // `WHERE NOT EXISTS` and `ON CONFLICT (org_id) DO NOTHING` look
    // interchangeable, but the design point is "don't touch an admin's
    // explicit policy row." `ON CONFLICT DO UPDATE` is the easy-to-miss
    // edit that would silently overwrite an admin's `retention_days =
    // NULL` (unlimited) choice with the 365-day default. Pin the chosen
    // mechanism and forbid the alternative outright.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).toMatch(
      /WHERE\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+audit_retention_config\s+arc\s+WHERE\s+arc\.org_id\s*=\s*organization\.id\s*\)/i,
    );
    expect(sql).not.toMatch(/ON\s+CONFLICT/i);
  });

  it("does not touch hard_delete_delay_days default — that one stays at 30 from baseline", () => {
    // Bisecting a regression should land on a single column at a time. A
    // future edit that bundles a second ALTER COLUMN ... SET DEFAULT in
    // here would couple two retention-policy concerns into one revert.
    const sql = fs.readFileSync(filePath, "utf-8");
    expect(sql).not.toMatch(
      /ALTER\s+COLUMN\s+hard_delete_delay_days\s+SET\s+DEFAULT/i,
    );
  });

  it("Drizzle schema declares the matching .default(365) on retentionDays", () => {
    // The DB DEFAULT lives in this migration; the ORM-level default lives
    // in `schema.ts`. If they diverge, `bun x drizzle-kit generate` on
    // the next schema diff would emit a migration to REMOVE the DB
    // DEFAULT (silent rollback of #1927). This test pins them in lockstep.
    const schemaPath = path.join(import.meta.dir, "..", "schema.ts");
    const schemaSrc = fs.readFileSync(schemaPath, "utf-8");
    expect(schemaSrc).toMatch(
      /retentionDays:\s*integer\(\s*"retention_days"\s*\)\.default\(365\)/,
    );
  });

  it("is registered in ORG_DEPENDENT_MIGRATIONS so non-managed deploys skip it (#1472)", () => {
    // Postgres parses `INSERT … FROM organization` at plan time, so on
    // a non-managed deploy without Better Auth's organization plugin the
    // migration aborts boot before evaluating row count. The skip list in
    // `internal.ts` keeps the file out of the runner's pending set in
    // that mode (mirrors the 0027 contract). Pin the registration so a
    // future `internal.ts` cleanup can't silently drop it.
    const internalPath = path.join(import.meta.dir, "..", "internal.ts");
    const internalSrc = fs.readFileSync(internalPath, "utf-8");
    expect(internalSrc).toMatch(/ORG_DEPENDENT_MIGRATIONS\s*=\s*\[[^\]]*"0042_audit_retention_default\.sql"/);
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
