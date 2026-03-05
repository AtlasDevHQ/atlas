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
  return {
    pool: {
      async query(sql: string) {
        if (opts.shouldThrow) throw new Error("permission denied for CREATE TABLE");
        queries.push(sql);
        return { rows: [] };
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
  it("runs internal DB migration when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    await migrateAuthTables();

    // migrateInternalDB: 3 audit_log + 4 conversations/messages + 2 starred column + 3 slack + 5 action_log + 2 source tracking + 7 scheduled_tasks = 26 queries
    expect(queries.length).toBe(26);
    expect(queries[0]).toContain("CREATE TABLE IF NOT EXISTS audit_log");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setAuthInstance(instance as any);

    await migrateAuthTables();
    await migrateAuthTables();
    await migrateAuthTables();

    // Internal DB migration runs once (26 queries) + 1 ALTER TABLE for password_change_required (managed mode)
    expect(queries.length).toBe(27);
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
});
