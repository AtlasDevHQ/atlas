import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";
import { _resetPool } from "@atlas/api/lib/db/internal";
import { _setAuthInstance } from "@atlas/api/lib/auth/server";
import {
  migrateAuthTables,
  resetMigrationState,
  getMigrationError,
} from "@atlas/api/lib/auth/migrate";

// ---------------------------------------------------------------------------
// Mock pool for internal DB migration tracking
// ---------------------------------------------------------------------------

function createTrackingPool(opts: { shouldThrow?: boolean } = {}) {
  const queries: string[] = [];
  async function queryFn(sql: string) {
    if (opts.shouldThrow) throw new Error("permission denied for CREATE TABLE");
    queries.push(sql);
    return { rows: [] };
  }
  return {
    pool: {
      query: queryFn,
      async connect() {
        return { query: queryFn, release() {} };
      },
      async end() {},
      on() {},
    },
    queries,
  };
}

// ---------------------------------------------------------------------------
// Mock auth instance for Better Auth migration tracking
// ---------------------------------------------------------------------------

function createTrackingAuth(opts: { shouldThrow?: boolean; onMigrate?: () => void } = {}) {
  let migrationCount = 0;
  return {
    instance: {
      $context: Promise.resolve({
        runMigrations: async () => {
          if (opts.shouldThrow) throw new Error("Better Auth migration error");
          opts.onMigrate?.();
          migrationCount++;
        },
      }),
      // Stub so the api access in seedDevUser doesn't throw — tests don't assert seed behavior.
      api: {},
    },
    getMigrationCount: () => migrationCount,
  };
}

// ---------------------------------------------------------------------------
// Env snapshot
// ---------------------------------------------------------------------------

const MANAGED_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "ATLAS_AUTH_JWKS_URL",
  "ATLAS_API_KEY",
  "ATLAS_ADMIN_EMAIL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED_VARS) {
    saved[key] = process.env[key];
  }
  resetMigrationState();
  resetAuthModeCache();
  _resetPool();
  _setAuthInstance(null);

  // Default: no auth env vars
  delete process.env.DATABASE_URL;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_AUTH_JWKS_URL;
  delete process.env.ATLAS_API_KEY;
  delete process.env.ATLAS_ADMIN_EMAIL;
});

afterEach(() => {
  for (const key of MANAGED_VARS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
  resetMigrationState();
  resetAuthModeCache();
  _resetPool();
  _setAuthInstance(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateAuthTables", () => {
  it("runs versioned migrations when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    await migrateAuthTables();

    // Versioned migration runner:
    //   1. CREATE __atlas_migrations table
    //   2. SELECT applied migrations
    //   3. BEGIN transaction
    //   4. Execute baseline SQL
    //   5. INSERT migration record
    //   6. COMMIT
    // Then seeds (prompt library, SLA thresholds, backup config) + loadSavedConnections + loadPluginSettings + restoreAbuseState
    expect(queries.length).toBeGreaterThan(5);

    // Verify advisory lock acquired and tracking table created
    expect(queries[0]).toContain("pg_advisory_lock");
    const trackingTable = queries.find((q) => q.includes("__atlas_migrations") && q.includes("CREATE TABLE"));
    expect(trackingTable).toBeDefined();

    // Verify the baseline migration SQL was executed
    const baselineSql = queries.find((q) => q.includes("CREATE TABLE IF NOT EXISTS audit_log"));
    expect(baselineSql).toBeDefined();

    // Verify a transaction was used
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");

    // Verify migration was recorded
    const insertMigration = queries.find((q) => q.includes("INSERT INTO __atlas_migrations"));
    expect(insertMigration).toBeDefined();
  });

  it("skips internal DB migration when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    const { queries } = createTrackingPool();
    // Don't inject pool — hasInternalDB() returns false, no pool needed

    await migrateAuthTables();

    expect(queries.length).toBe(0);
  });

  it("runs Better Auth migration in managed mode", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    const { pool } = createTrackingPool();
    _resetPool(pool);
    const { instance, getMigrationCount } = createTrackingAuth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance(instance as any);

    await migrateAuthTables();

    expect(getMigrationCount()).toBe(1);
  });

  it("only runs once (idempotent guard)", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);
    const { instance, getMigrationCount } = createTrackingAuth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance(instance as any);

    await migrateAuthTables();
    const firstRunCount = queries.length;
    await migrateAuthTables();
    await migrateAuthTables();

    // No additional queries after first run — idempotent guard prevents re-execution
    expect(queries.length).toBe(firstRunCount);
    // Better Auth migration runs once
    expect(getMigrationCount()).toBe(1);
  });

  it("skips Better Auth migration when not in managed mode", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    // No BETTER_AUTH_SECRET → auth mode is "none"
    const { pool } = createTrackingPool();
    _resetPool(pool);
    const { getMigrationCount } = createTrackingAuth();

    await migrateAuthTables();

    expect(getMigrationCount()).toBe(0);
  });

  it("skips Better Auth migration when no internal DB (managed mode)", async () => {
    delete process.env.DATABASE_URL;
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);

    await migrateAuthTables();

    // No pool injected, no queries possible — migration was skipped
  });

  it("does not throw when internal DB migration fails", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.ATLAS_MIGRATION_RETRIES = "1"; // disable retries for fast test
    const { pool } = createTrackingPool({ shouldThrow: true });
    _resetPool(pool);

    // Should resolve without throwing
    await expect(migrateAuthTables()).resolves.toBeUndefined();
    delete process.env.ATLAS_MIGRATION_RETRIES;
  });

  it("getMigrationError returns error message after internal DB failure", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.ATLAS_MIGRATION_RETRIES = "1"; // disable retries for fast test
    const { pool } = createTrackingPool({ shouldThrow: true });
    _resetPool(pool);

    await migrateAuthTables();

    const err = getMigrationError();
    expect(err).toBeString();
    expect(err).toContain("migration failed");
    delete process.env.ATLAS_MIGRATION_RETRIES;
  });

  it("getMigrationError returns null on success", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    const { pool } = createTrackingPool();
    _resetPool(pool);

    await migrateAuthTables();

    expect(getMigrationError()).toBeNull();
  });

  it("skips already-applied migrations", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    const queries: string[] = [];
    async function queryFn(sql: string) {
      queries.push(sql);
      // Return "already applied" for the SELECT query
      if (sql.includes("SELECT name FROM __atlas_migrations")) {
        return {
          rows: [
            { name: "0000_baseline.sql" },
            { name: "0001_teams_installations.sql" },
            { name: "0002_discord_installations.sql" },
            { name: "0003_telegram_installations.sql" },
            { name: "0004_sandbox_credentials.sql" },
            { name: "0005_oauth_state.sql" },
            { name: "0006_byot_credentials.sql" },
            { name: "0007_gchat_installations.sql" },
            { name: "0008_github_installations.sql" },
            { name: "0009_linear_installations.sql" },
            { name: "0010_whatsapp_installations.sql" },
            { name: "0011_email_installations.sql" },
            { name: "0012_region_migrations.sql" },
            { name: "0013_region_migration_cancelled.sql" },
            { name: "0014_plugin_marketplace.sql" },
            { name: "0015_semantic_versions.sql" },
            { name: "0016_invitations_org_id.sql" },
            { name: "0017_dashboards.sql" },
            { name: "0018_dashboard_refresh.sql" },
            { name: "0019_expert_amendments.sql" },
            { name: "0020_plan_tier_rename.sql" },
            { name: "0021_connection_org_scope.sql" },
            { name: "0022_sso_domain_verification.sql" },
            { name: "0023_admin_action_log.sql" },
            { name: "0024_mode_status_columns.sql" },
            { name: "0025_fix_null_unsafe_indexes.sql" },
            { name: "0026_drop_legacy_semantic_entity_index.sql" },
            { name: "0027_organization_saas_columns.sql" },
          ],
        };
      }
      return { rows: [] };
    }
    const pool = {
      query: queryFn,
      async connect() {
        return { query: queryFn, release() {} };
      },
      async end() {},
      on() {},
    };
    _resetPool(pool);

    await migrateAuthTables();

    // Should NOT have a BEGIN/COMMIT since all migrations were already applied
    expect(queries).not.toContain("BEGIN");
  });

  it("runs Better Auth migrations BEFORE Atlas internal migrations in managed mode (#1472)", async () => {
    // Reproduces the boot-ordering bug: if Atlas migrations run before Better Auth
    // creates the organization table, the conditional ALTERs in 0000/0020 silently
    // skip and get marked applied, leaving organization missing SaaS columns forever.
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);

    let betterAuthRanAt: number | null = null;
    let firstAtlasQueryAt: number | null = null;
    let counter = 0;

    const queries: string[] = [];
    async function queryFn(sql: string) {
      const ts = ++counter;
      queries.push(sql);
      // First non-locking query that touches Atlas internal tables marks the start
      // of the Atlas migration phase. The advisory lock + tracking-table CREATE
      // are part of runMigrations(), so observing any of these means Atlas
      // migrations have begun.
      if (firstAtlasQueryAt === null && (sql.includes("__atlas_migrations") || sql.includes("pg_advisory_lock"))) {
        firstAtlasQueryAt = ts;
      }
      return { rows: [] };
    }
    const pool = {
      query: queryFn,
      async connect() {
        return { query: queryFn, release() {} };
      },
      async end() {},
      on() {},
    };
    _resetPool(pool);

    const { instance } = createTrackingAuth({
      onMigrate: () => {
        betterAuthRanAt = ++counter;
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance(instance as any);

    await migrateAuthTables();

    expect(betterAuthRanAt).not.toBeNull();
    expect(firstAtlasQueryAt).not.toBeNull();
    expect(betterAuthRanAt!).toBeLessThan(firstAtlasQueryAt!);
  });

  it("skips 0027_organization_saas_columns.sql in non-managed mode", async () => {
    // In non-managed mode, Better Auth never creates the organization table.
    // Migration 0027's unconditional ALTER would fail with a misleading error.
    // The runner must be told to skip it.
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    delete process.env.BETTER_AUTH_SECRET;

    const queries: string[] = [];
    const params: unknown[][] = [];
    async function queryFn(sql: string, p?: unknown[]) {
      queries.push(sql);
      if (p) params.push(p);
      return { rows: [] };
    }
    const pool = {
      query: queryFn,
      async connect() {
        return { query: queryFn, release() {} };
      },
      async end() {},
      on() {},
    };
    _resetPool(pool);

    await migrateAuthTables();

    // 0027 SQL never runs — match the issue reference unique to that file
    const orgSaasMigration = queries.find((q) => q.includes("issues/1472"));
    expect(orgSaasMigration).toBeUndefined();

    // 0027 is not recorded as applied
    const insertedNames = params
      .filter((p) => p.length === 1 && typeof p[0] === "string")
      .map((p) => p[0] as string);
    expect(insertedNames).not.toContain("0027_organization_saas_columns.sql");
  });

  it("still runs Atlas internal migrations when Better Auth migration fails (#1472 contract)", async () => {
    // The boot reorder runs Better Auth first, but a Better Auth failure must
    // not block Atlas migrations — operators still need audit_log, connections,
    // and the rest of the internal schema. The 0027 RAISE EXCEPTION is the
    // safety net for the resulting "missing organization" state — surfaces
    // the bug loudly rather than silently re-creating the half-migrated state.
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);

    const queries: string[] = [];
    async function queryFn(sql: string) {
      queries.push(sql);
      return { rows: [] };
    }
    const pool = {
      query: queryFn,
      async connect() {
        return { query: queryFn, release() {} };
      },
      async end() {},
      on() {},
    };
    _resetPool(pool);

    const { instance } = createTrackingAuth({ shouldThrow: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance(instance as any);

    await migrateAuthTables();

    // Better Auth failure was recorded.
    const err = getMigrationError();
    expect(err).toBeString();
    expect(err).toContain("Better Auth migration failed");

    // Atlas migrations still ran — the advisory lock is the first internal-DB
    // query, so its presence proves runMigrations() executed despite the
    // Better Auth failure.
    const lockQuery = queries.find((q) => q.includes("pg_advisory_lock"));
    expect(lockQuery).toBeDefined();
  });

  it("recovers on next boot after a non-managed → managed transition", async () => {
    // First boot in non-managed mode: 0027 is skipped and NOT recorded.
    // Second boot in managed mode: 0027 must be picked up automatically.
    // Pins the recovery contract documented on RunMigrationsOptions.skip.
    const recordedNames: string[] = [];
    let appliedSnapshot: string[] = [];

    function makePool() {
      async function queryFn(sql: string, p?: unknown[]) {
        if (sql.includes("INSERT INTO __atlas_migrations") && p && typeof p[0] === "string") {
          recordedNames.push(p[0]);
        }
        if (sql.includes("SELECT name FROM __atlas_migrations")) {
          return { rows: appliedSnapshot.map((name) => ({ name })) };
        }
        return { rows: [] };
      }
      return {
        query: queryFn,
        async connect() {
          return { query: queryFn, release() {} };
        },
      };
    }

    const { runMigrations } = await import("@atlas/api/lib/db/migrate");

    // Pass 1: non-managed — skip 0027.
    await runMigrations(makePool(), { skip: ["0027_organization_saas_columns.sql"] });
    expect(recordedNames).not.toContain("0027_organization_saas_columns.sql");
    expect(recordedNames).toContain("0000_baseline.sql");

    // Pass 2: managed — no skip; only previously-unrecorded files run.
    appliedSnapshot = [...recordedNames];
    const beforeCount = recordedNames.length;
    await runMigrations(makePool(), { skip: [] });

    const newlyRecorded = recordedNames.slice(beforeCount);
    expect(newlyRecorded).toContain("0027_organization_saas_columns.sql");
    // Already-applied files do not re-run.
    expect(newlyRecorded).not.toContain("0000_baseline.sql");
  });
});
