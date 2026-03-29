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

function createTrackingAuth(opts: { shouldThrow?: boolean } = {}) {
  let migrationCount = 0;
  return {
    instance: {
      $context: Promise.resolve({
        runMigrations: async () => {
          if (opts.shouldThrow) throw new Error("Better Auth migration error");
          migrationCount++;
        },
      }),
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
    const { pool } = createTrackingPool({ shouldThrow: true });
    _resetPool(pool);

    // Should resolve without throwing
    await expect(migrateAuthTables()).resolves.toBeUndefined();
  });

  it("getMigrationError returns error message after internal DB failure", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    const { pool } = createTrackingPool({ shouldThrow: true });
    _resetPool(pool);

    await migrateAuthTables();

    const err = getMigrationError();
    expect(err).toBeString();
    expect(err).toContain("migration failed");
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
});
