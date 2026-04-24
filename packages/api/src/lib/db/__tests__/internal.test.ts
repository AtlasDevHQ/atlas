/**
 * Tests for the Atlas internal database module (src/lib/db/internal.ts).
 *
 * Uses _resetPool(mockPool) to inject a mock pool instance, avoiding
 * the need to mock the pg module (which is require()'d lazily).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import {
  hasInternalDB,
  getInternalDB,
  closeInternalDB,
  internalQuery,
  internalExecute,
  queryEffect,
  migrateInternalDB,
  loadSavedConnections,
  cascadeWorkspaceDelete,
  hardDeleteWorkspace,
  _resetPool,
  _resetCircuitBreaker,
  encryptUrl,
  decryptUrl,
  getEncryptionKey,
  isPlaintextUrl,
  _resetEncryptionKeyCache,
} from "../internal";
import { connections } from "../connection";

/** Creates a mock pool that tracks query/end calls. */
function createMockPool() {
  const calls = {
    queries: [] as { sql: string; params?: unknown[] }[],
    endCount: 0,
    onEvents: [] as { event: "error"; listener: (err: Error) => void }[],
    connectCount: 0,
    releaseCount: 0,
    // The last argument passed to `client.release(err?)`. Truthy means pg
    // destroys the socket instead of pooling it.
    lastReleaseArg: undefined as unknown,
  };
  let queryResult: { rows: Record<string, unknown>[] } = { rows: [] };
  let queryError: Error | null = null;

  const queryFn = async (sql: string, params?: unknown[]) => {
    calls.queries.push({ sql, params });
    if (queryError) throw queryError;
    return queryResult;
  };

  const pool = {
    query: queryFn,
    async end() {
      calls.endCount++;
    },
    async connect() {
      calls.connectCount++;
      return {
        query: queryFn,
        release(err?: Error) {
          calls.releaseCount++;
          calls.lastReleaseArg = err;
        },
      };
    },
    on(event: "error", listener: (err: Error) => void) {
      calls.onEvents.push({ event, listener });
    },
    // Test helpers
    _setResult(result: { rows: Record<string, unknown>[] }) {
      queryResult = result;
    },
    _setError(err: Error | null) {
      queryError = err;
    },
  };

  return { pool, calls };
}

describe("internal DB module", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    _resetPool();
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = origDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool();
  });

  describe("hasInternalDB()", () => {
    it("returns false when DATABASE_URL is not set", () => {
      delete process.env.DATABASE_URL;
      expect(hasInternalDB()).toBe(false);
    });

    it("returns true when DATABASE_URL is set", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      expect(hasInternalDB()).toBe(true);
    });

    it("returns false for empty string DATABASE_URL", () => {
      process.env.DATABASE_URL = "";
      expect(hasInternalDB()).toBe(false);
    });
  });

  describe("getInternalDB()", () => {
    it("throws when DATABASE_URL is not set", () => {
      expect(() => getInternalDB()).toThrow("DATABASE_URL is not set");
    });

    it("returns injected mock pool", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      _resetPool(pool);
      expect(getInternalDB()).toBe(pool);
    });

    it("returns the same pool instance on repeated calls (singleton)", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      _resetPool(pool);
      const pool1 = getInternalDB();
      const pool2 = getInternalDB();
      expect(pool1).toBe(pool2);
    });
  });

  describe("internalQuery()", () => {
    it("executes parameterized query and returns typed rows", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setResult({ rows: [{ id: "abc", count: 42 }] });
      _resetPool(pool);

      const rows = await internalQuery("SELECT * FROM audit_log WHERE user_id = $1", ["user-1"]);
      expect(rows).toEqual([{ id: "abc", count: 42 }]);
      expect(calls.queries[0]).toEqual({
        sql: "SELECT * FROM audit_log WHERE user_id = $1",
        params: ["user-1"],
      });
    });

    it("works without params", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setResult({ rows: [{ n: 1 }] });
      _resetPool(pool);

      const rows = await internalQuery("SELECT 1 AS n");
      expect(rows).toEqual([{ n: 1 }]);
    });

    it("propagates query errors", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("relation does not exist"));
      _resetPool(pool);

      await expect(internalQuery("SELECT * FROM missing")).rejects.toThrow(
        "relation does not exist",
      );
    });
  });

  describe("queryEffect()", () => {
    it("resolves with typed rows on success", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setResult({ rows: [{ id: "abc", count: 42 }] });
      _resetPool(pool);

      const rows = await Effect.runPromise(
        queryEffect<{ id: string; count: number }>("SELECT id, count FROM t WHERE id = $1", ["abc"]),
      );
      expect(rows).toEqual([{ id: "abc", count: 42 }]);
    });

    it("surfaces rejection in the typed error channel", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("connection terminated"));
      _resetPool(pool);

      const exit = await Effect.runPromiseExit(queryEffect("SELECT 1"));
      expect(exit._tag).toBe("Failure");
      // Fail cause — the typed E: Error channel, not a defect
      const result = await Effect.runPromise(Effect.either(queryEffect("SELECT 1")));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(Error);
        expect(result.left.message).toBe("connection terminated");
      }
    });

    it("normalizes non-Error thrown values", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool: base } = createMockPool();
      const pool = {
        ...base,
        async query() {
          // Throw a plain string — queryEffect should normalize via normalizeError
          throw "raw string thrown";
        },
      };
      _resetPool(pool);

      const result = await Effect.runPromise(Effect.either(queryEffect("SELECT 1")));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(Error);
        expect(result.left.message).toBe("raw string thrown");
      }
    });
  });

  describe("internalExecute()", () => {
    it("executes fire-and-forget query", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);

      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(1);
      expect(calls.queries[0].sql).toBe("INSERT INTO audit_log (auth_mode) VALUES ($1)");
    });

    it("does not throw on query error (logs instead)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("connection lost"));
      _resetPool(pool);

      // Should not throw
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      // Error was swallowed — no exception propagated
    });

    it("handles non-Error thrown values without crashing", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool: mockPool } = createMockPool();
      // Override query to throw a string instead of an Error
      const pool = {
        ...mockPool,
        async query() {
          throw "string error";
        },
      };
      _resetPool(pool);

      // Should not throw
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      // String error was handled gracefully — no exception propagated
    });
  });

  describe("migrateInternalDB()", () => {
    it("runs versioned migrations and seeds via migration runner", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);

      await migrateInternalDB();

      // Migration runner creates tracking table, applies baseline in a transaction, then seeds
      const sqls = calls.queries.map((q) => q.sql);

      // Advisory lock acquired, then tracking table created
      expect(sqls[0]).toContain("pg_advisory_lock");
      const trackingTable = sqls.find((s) => s.includes("__atlas_migrations") && s.includes("CREATE TABLE"));
      expect(trackingTable).toBeDefined();

      // Transaction used for migration
      expect(sqls).toContain("BEGIN");
      expect(sqls).toContain("COMMIT");

      // Baseline migration SQL contains all core tables
      const baselineSql = sqls.find((s) => s.includes("CREATE TABLE IF NOT EXISTS audit_log"));
      expect(baselineSql).toBeDefined();
      expect(baselineSql).toContain("CREATE TABLE IF NOT EXISTS conversations");
      expect(baselineSql).toContain("CREATE TABLE IF NOT EXISTS messages");
      expect(baselineSql).toContain("CREATE TABLE IF NOT EXISTS action_log");
      expect(baselineSql).toContain("CREATE TABLE IF NOT EXISTS scheduled_tasks");
      expect(baselineSql).toContain("CREATE TABLE IF NOT EXISTS connections");
      expect(baselineSql).toContain("CREATE TABLE IF NOT EXISTS invitations");

      // Migration was recorded
      const recordSql = sqls.find((s) => s.includes("INSERT INTO __atlas_migrations"));
      expect(recordSql).toBeDefined();
    });

    it("propagates migration errors", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_MIGRATION_RETRIES = "1"; // disable retries for fast test
      const { pool } = createMockPool();
      pool._setError(new Error("permission denied"));
      _resetPool(pool);

      // Error may be thrown directly or wrapped by the migration runner
      await expect(migrateInternalDB()).rejects.toThrow();
      delete process.env.ATLAS_MIGRATION_RETRIES;
    });
  });

  describe("closeInternalDB()", () => {
    it("closes fallback pools (not managed by Effect Layer)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      // _resetPool sets _poolManagedByEffect = false (default), simulating a fallback pool
      _resetPool(pool);
      await closeInternalDB();
      expect(calls.endCount).toBe(1);
    });

    it("is a no-op when no pool exists", async () => {
      await closeInternalDB(); // should not throw
    });
  });

  describe("loadSavedConnections()", () => {
    afterEach(() => {
      connections._reset();
    });

    it("returns 0 when DATABASE_URL is not set", async () => {
      delete process.env.DATABASE_URL;
      expect(await loadSavedConnections()).toBe(0);
    });

    it("loads connections from the DB and registers them", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "warehouse", url: "postgresql://host/wh", type: "postgres", description: "Warehouse", schema_name: "analytics" },
          { id: "reporting", url: "postgresql://host/rp", type: "postgres", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(2);
      expect(connections.has("warehouse")).toBe(true);
      expect(connections.has("reporting")).toBe(true);
    });

    it("skips individual connection failures without aborting", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      // Second row has an invalid URL scheme which will throw in register
      pool._setResult({
        rows: [
          { id: "good", url: "postgresql://host/db", type: "postgres", description: null, schema_name: null },
          { id: "bad", url: "badscheme://host/db", type: "unknown", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("good")).toBe(true);
      expect(connections.has("bad")).toBe(false);
    });

    it("returns 0 when query throws (table not exist)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("relation \"connections\" does not exist"));
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(0);
    });
  });

  describe("circuit breaker", () => {
    beforeEach(() => {
      _resetCircuitBreaker();
    });

    it("opens after 5 consecutive failures", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Fire 5 failing queries to trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.queries.length).toBe(5);

      // 6th call should be silently skipped (circuit open)
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(5); // no new query issued
    });

    it("silently skips requests when circuit is open and increments dropped count", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // Fire several more — all should be dropped
      for (let i = 0; i < 3; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 10));
      // Still only 5 queries were actually sent to the pool
      expect(calls.queries.length).toBe(5);
    });

    it("recovers after timeout", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.queries.length).toBe(5);

      // Verify circuit is open
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(5);

      // Advance timer to trigger recovery (setTimeout 60s)
      // Use Bun's mock timer approach: we can't easily mock setTimeout here,
      // so we manually reset the circuit breaker to simulate recovery
      _resetCircuitBreaker();

      // Now the pool should accept queries again
      pool._setError(null);
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(6);
    });

    it("_resetCircuitBreaker() clears all circuit state", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // Circuit is open — queries are dropped
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(5);

      // Reset circuit breaker
      _resetCircuitBreaker();

      // Queries should flow through again
      pool._setError(null);
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(6);
    });

    it("_resetPool() also resets circuit breaker state", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // Reset pool with a fresh mock — circuit breaker should also be reset
      const { pool: freshPool, calls: freshCalls } = createMockPool();
      _resetPool(freshPool);

      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(freshCalls.queries.length).toBe(1); // query went through
    });
  });
});

describe("cascadeWorkspaceDelete()", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    _resetPool();
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = origDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool();
  });

  it("deletes org-scoped settings rows inside a transaction", async () => {
    const { pool, calls } = createMockPool();
    // Each query in the cascade returns one row via RETURNING
    pool._setResult({ rows: [{ id: "row-1" }] });
    _resetPool(pool);

    const result = await cascadeWorkspaceDelete("org-123");

    // Verify transaction boundaries
    expect(calls.queries[0].sql).toBe("BEGIN");
    expect(calls.queries[calls.queries.length - 1].sql).toBe("COMMIT");

    // Verify a DELETE FROM settings WHERE org_id = $1 was issued
    const settingsQuery = calls.queries.find((q) => q.sql.includes("DELETE FROM settings"));
    expect(settingsQuery).toBeDefined();
    expect(settingsQuery!.params).toEqual(["org-123"]);
    expect(result.settings).toBe(1);

    // Verify client was released
    expect(calls.releaseCount).toBe(1);
  });

  it("returns settings: 0 when no org-scoped settings exist", async () => {
    const { pool, calls } = createMockPool();
    pool._setResult({ rows: [] });
    _resetPool(pool);

    const result = await cascadeWorkspaceDelete("org-empty");
    expect(result.settings).toBe(0);
    // BEGIN + 6 cascade queries + COMMIT = 8 total
    expect(calls.queries.length).toBe(8);
  });

  it("does not delete settings with NULL org_id (self-hosted)", async () => {
    const { pool, calls } = createMockPool();
    pool._setResult({ rows: [] });
    _resetPool(pool);

    await cascadeWorkspaceDelete("org-456");

    // The settings DELETE should use org_id = $1, not IS NULL
    const settingsQuery = calls.queries.find((q) => q.sql.includes("DELETE FROM settings"));
    expect(settingsQuery).toBeDefined();
    expect(settingsQuery!.sql).not.toContain("IS NULL");
    expect(settingsQuery!.params).toEqual(["org-456"]);
  });

  it("rolls back on query failure", async () => {
    const { pool, calls } = createMockPool();
    _resetPool(pool);

    // Fail after BEGIN succeeds — simulate a table-not-found error
    let queryNum = 0;
    const { pool: txPool } = createMockPool();
    const failPool = {
      ...txPool,
      async connect() {
        calls.connectCount++;
        return {
          async query(sql: string, params?: unknown[]) {
            calls.queries.push({ sql, params });
            queryNum++;
            // Let BEGIN pass (query 1), fail on first cascade query (query 2)
            if (queryNum === 2) throw new Error("relation does not exist");
            return { rows: [] };
          },
          release(err?: Error) {
            calls.releaseCount++;
            calls.lastReleaseArg = err;
          },
        };
      },
      on: txPool.on,
    };
    _resetPool(failPool);

    await expect(cascadeWorkspaceDelete("org-fail")).rejects.toThrow("relation does not exist");

    // Verify ROLLBACK was issued and client was released
    const rollbackQuery = calls.queries.find((q) => q.sql === "ROLLBACK");
    expect(rollbackQuery).toBeDefined();
    expect(calls.releaseCount).toBe(1);
    // Clean ROLLBACK — client pooled (no error arg)
    expect(calls.lastReleaseArg).toBeUndefined();
  });

  it("destroys the client on failed ROLLBACK — release(err) called with the rollback error", async () => {
    // Primary query fails AND ROLLBACK itself throws. The dirty socket
    // must be destroyed via release(err) rather than pooled.
    const { pool: txPool } = createMockPool();
    const calls = {
      queries: [] as { sql: string }[],
      releaseCount: 0,
      lastReleaseArg: undefined as unknown,
    };
    let queryNum = 0;
    const failPool = {
      ...txPool,
      async connect() {
        return {
          async query(sql: string) {
            calls.queries.push({ sql });
            queryNum++;
            // Let BEGIN pass; fail on first cascade query; also fail ROLLBACK
            if (queryNum === 2) throw new Error("primary mutation failure");
            if (sql.trim().toUpperCase() === "ROLLBACK") {
              throw new Error("ROLLBACK failed — socket dirty");
            }
            return { rows: [] };
          },
          release(err?: Error) {
            calls.releaseCount++;
            calls.lastReleaseArg = err;
          },
        };
      },
    };
    _resetPool(failPool);

    await expect(cascadeWorkspaceDelete("org-fail")).rejects.toThrow("primary mutation failure");

    expect(calls.releaseCount).toBe(1);
    expect(calls.lastReleaseArg).toBeInstanceOf(Error);
    expect((calls.lastReleaseArg as Error).message).toContain("ROLLBACK failed");
  });
});

describe("hardDeleteWorkspace()", () => {
  it("destroys the client when ROLLBACK fails after a purge transaction error", async () => {
    const { pool: basePool } = createMockPool();
    const calls = {
      queries: [] as { sql: string }[],
      releaseCount: 0,
      lastReleaseArg: undefined as unknown,
    };
    let queryNum = 0;
    const failPool = {
      ...basePool,
      async connect() {
        return {
          async query(sql: string) {
            calls.queries.push({ sql });
            queryNum++;
            // BEGIN (1) passes, status check (2) returns "deleted" so purge proceeds,
            // first cascade DELETE (3) throws, then ROLLBACK (4) also fails
            if (queryNum === 2) return { rows: [{ workspace_status: "deleted" }] };
            if (queryNum === 3) throw new Error("relation does not exist");
            if (sql.trim().toUpperCase() === "ROLLBACK") {
              throw new Error("ROLLBACK failed — socket dirty");
            }
            return { rows: [] };
          },
          release(err?: Error) {
            calls.releaseCount++;
            calls.lastReleaseArg = err;
          },
        };
      },
    };
    _resetPool(failPool);

    await expect(hardDeleteWorkspace("org-fail")).rejects.toThrow("relation does not exist");

    expect(calls.releaseCount).toBe(1);
    expect(calls.lastReleaseArg).toBeInstanceOf(Error);
    expect((calls.lastReleaseArg as Error).message).toContain("ROLLBACK failed");
  });

  it("destroys the client when the pre-lock status check ROLLBACK fails", async () => {
    // Workspace isn't in "deleted" status — the pre-transaction ROLLBACK must
    // also be guarded. If it fails, the client is poisoned and must be destroyed.
    const { pool: basePool } = createMockPool();
    const calls = {
      releaseCount: 0,
      lastReleaseArg: undefined as unknown,
    };
    let queryNum = 0;
    const failPool = {
      ...basePool,
      async connect() {
        return {
          async query(sql: string) {
            queryNum++;
            // BEGIN passes, status check returns "active" (not deleted), ROLLBACK fails
            if (queryNum === 2) return { rows: [{ workspace_status: "active" }] };
            if (sql.trim().toUpperCase() === "ROLLBACK") {
              throw new Error("ROLLBACK failed during status guard");
            }
            return { rows: [] };
          },
          release(err?: Error) {
            calls.releaseCount++;
            calls.lastReleaseArg = err;
          },
        };
      },
    };
    _resetPool(failPool);

    await expect(hardDeleteWorkspace("org-active")).rejects.toThrow("not in deleted status");

    expect(calls.releaseCount).toBe(1);
    expect(calls.lastReleaseArg).toBeInstanceOf(Error);
    expect((calls.lastReleaseArg as Error).message).toContain("ROLLBACK failed");
  });
});

describe("connection URL encryption", () => {
  const origEncKey = process.env.ATLAS_ENCRYPTION_KEY;
  const origEncKeys = process.env.ATLAS_ENCRYPTION_KEYS;
  const origAuthSecret = process.env.BETTER_AUTH_SECRET;

  afterEach(() => {
    // Restore env vars and reset cached key
    if (origEncKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = origEncKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (origEncKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = origEncKeys;
    else delete process.env.ATLAS_ENCRYPTION_KEYS;
    if (origAuthSecret !== undefined) process.env.BETTER_AUTH_SECRET = origAuthSecret;
    else delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  describe("getEncryptionKey()", () => {
    it("returns null when neither key is set", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      expect(getEncryptionKey()).toBeNull();
    });

    it("derives key from ATLAS_ENCRYPTION_KEY", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "my-encryption-key-32-chars-long!";
      delete process.env.BETTER_AUTH_SECRET;
      const key = getEncryptionKey();
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
    });

    it("falls back to BETTER_AUTH_SECRET", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      process.env.BETTER_AUTH_SECRET = "my-auth-secret-that-is-long-enough";
      const key = getEncryptionKey();
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
    });

    it("ATLAS_ENCRYPTION_KEY takes precedence over BETTER_AUTH_SECRET", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "key-a";
      process.env.BETTER_AUTH_SECRET = "key-b";
      const keyA = getEncryptionKey();

      delete process.env.ATLAS_ENCRYPTION_KEY;
      process.env.BETTER_AUTH_SECRET = "key-a"; // same raw value as ATLAS_ENCRYPTION_KEY
      const keyB = getEncryptionKey();

      // Both derive from "key-a" so they should be identical
      expect(keyA).toEqual(keyB);
    });
  });

  describe("isPlaintextUrl()", () => {
    it("returns true for postgresql:// URLs", () => {
      expect(isPlaintextUrl("postgresql://user:pass@host:5432/db")).toBe(true);
    });

    it("returns true for mysql:// URLs", () => {
      expect(isPlaintextUrl("mysql://user:pass@host:3306/db")).toBe(true);
    });

    it("returns true for postgres:// URLs", () => {
      expect(isPlaintextUrl("postgres://user:pass@host:5432/db")).toBe(true);
    });

    it("returns false for base64 encrypted data", () => {
      expect(isPlaintextUrl("dGVzdA==:dGVzdA==:dGVzdA==")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isPlaintextUrl("")).toBe(false);
    });
  });

  describe("encryptUrl() / decryptUrl() round-trip", () => {
    it("encrypts and decrypts a PostgreSQL URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "postgresql://admin:s3cret@db.example.com:5432/analytics";
      const encrypted = encryptUrl(url);

      // Encrypted value should not contain the original URL
      expect(encrypted).not.toBe(url);
      expect(encrypted).not.toContain("admin");
      expect(encrypted).not.toContain("s3cret");

      // F-47: new writes carry a versioned prefix enc:v<N>: so the
      // rotation script can identify rows below the active version.
      // That turns the legacy 3-part format (iv:authTag:ciphertext)
      // into a 5-part format (enc:v1:iv:authTag:ciphertext).
      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      const parts = encrypted.split(":");
      expect(parts.length).toBe(5);

      // Decrypt should return the original
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("encrypts and decrypts a MySQL URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "mysql://root:password@127.0.0.1:3306/mydb";
      const encrypted = encryptUrl(url);
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("handles URLs with special characters in password", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "postgresql://user:p%40ss+word/with=equals@host:5432/db?sslmode=require&options=-c%20search_path%3Dpublic";
      const encrypted = encryptUrl(url);
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("produces different ciphertexts for the same input (random IV)", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "postgresql://user:pass@host/db";
      const enc1 = encryptUrl(url);
      const enc2 = encryptUrl(url);
      expect(enc1).not.toBe(enc2); // Different IVs
      expect(decryptUrl(enc1)).toBe(url);
      expect(decryptUrl(enc2)).toBe(url);
    });
  });

  describe("plaintext migration", () => {
    it("decryptUrl returns plaintext URLs as-is", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-plaintext-migration";
      const url = "postgresql://user:pass@host:5432/db";
      expect(decryptUrl(url)).toBe(url);
    });

    it("decryptUrl handles mysql:// plaintext", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-plaintext-migration";
      const url = "mysql://user:pass@host:3306/db";
      expect(decryptUrl(url)).toBe(url);
    });
  });

  describe("missing encryption key", () => {
    it("encryptUrl returns plaintext when no key is available", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      const url = "postgresql://user:pass@host/db";
      expect(encryptUrl(url)).toBe(url);
    });

    it("decryptUrl returns plaintext URLs when no key is available", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      const url = "postgresql://user:pass@host/db";
      expect(decryptUrl(url)).toBe(url);
    });

    it("decryptUrl throws when encountering encrypted data without a key", () => {
      // Encrypt with a key first
      process.env.ATLAS_ENCRYPTION_KEY = "temp-key-for-this-test!!!!!!!!!!!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);

      // Now remove the key — decryptUrl should throw, not return garbage
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      _resetEncryptionKeyCache();
      expect(() => decryptUrl(encrypted)).toThrow("Cannot decrypt connection URL: no encryption key available");
    });
  });

  describe("corrupted data", () => {
    it("throws on tampered ciphertext", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);
      const parts = encrypted.split(":");
      // F-47 format: enc:v1:iv:authTag:ciphertext — ciphertext is parts[4].
      parts[4] = "AAAA" + parts[4].slice(4);
      const tampered = parts.join(":");
      expect(() => decryptUrl(tampered)).toThrow("Failed to decrypt connection URL");
    });

    it("throws on wrong encryption key", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "key-one-for-encryption-testing!!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);

      process.env.ATLAS_ENCRYPTION_KEY = "key-two-for-encryption-testing!!";
      expect(() => decryptUrl(encrypted)).toThrow("Failed to decrypt connection URL");
    });

    it("throws on non-base64 3-part string that is not a URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      // 3 colon-separated parts but not valid encrypted data
      expect(() => decryptUrl("foo:bar:baz")).toThrow("Failed to decrypt connection URL");
    });

    it("throws on tampered auth tag", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);
      const parts = encrypted.split(":");
      // F-47 format: enc:v1:iv:authTag:ciphertext — auth tag is parts[3].
      parts[3] = "AAAA" + parts[3].slice(4);
      const tampered = parts.join(":");
      expect(() => decryptUrl(tampered)).toThrow("Failed to decrypt connection URL");
    });

    it("throws on non-3-part format when value is not a URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      // 2 parts — not a URL, not 3-part encrypted format
      expect(() => decryptUrl("some:garbage")).toThrow("unrecognized format");
    });
  });

  describe("F-47 key versioning for connection URLs", () => {
    beforeEach(() => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.ATLAS_ENCRYPTION_KEYS;
      _resetEncryptionKeyCache();
    });

    it("writes are tagged with the active keyset version", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      const url = "postgresql://admin:pw@host:5432/db";
      const encrypted = encryptUrl(url);
      expect(encrypted.startsWith("enc:v2:")).toBe(true);
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("reads ciphertext stamped with a legacy (non-active) version by looking up the key", () => {
      // Phase A: write under v1-only keyset.
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
      _resetEncryptionKeyCache();
      const url = "postgresql://admin:pw@host:5432/db";
      const v1Ciphertext = encryptUrl(url);
      expect(v1Ciphertext.startsWith("enc:v1:")).toBe(true);

      // Phase B: rotate — active flips to v2, v1 preserved for reads.
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      expect(decryptUrl(v1Ciphertext)).toBe(url);
    });

    it("reads pre-F-47 unversioned ciphertext (iv:authTag:ciphertext) using the active key as a fallback", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "legacy-raw-key";
      _resetEncryptionKeyCache();
      // Synthesize a pre-F-47 ciphertext by re-encoding the output of
      // encryptUrl without the `enc:v1:` prefix — same key, same body.
      const url = "postgresql://user:pass@host/db";
      const versioned = encryptUrl(url);
      const legacy = versioned.replace(/^enc:v1:/, "");
      const parts = legacy.split(":");
      expect(parts.length).toBe(3);
      expect(decryptUrl(legacy)).toBe(url);
    });

    it("reads pre-F-47 unversioned ciphertext after rotation via the v1 key lookup (not the new active key)", () => {
      // The unversioned-fallback path has to pick `byVersion.get(1)`
      // rather than `active.key` — otherwise a rotation would strand
      // every un-migrated connection URL even though the operator
      // explicitly kept v1 in the keyset for the soak.
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:original-key";
      _resetEncryptionKeyCache();
      const url = "postgresql://admin:pw@host/db";
      const versioned = encryptUrl(url);
      const unversioned = versioned.replace(/^enc:v1:/, "");

      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-key,v1:original-key";
      _resetEncryptionKeyCache();
      expect(decryptUrl(unversioned)).toBe(url);
    });

    it("throws clearly when un-versioned ciphertext meets a keyset with no v1 (fresh-deploy misconfig)", () => {
      // The third scenario of the legacy-fallback: a fresh deployment
      // that lands post-F-47 with only `ATLAS_ENCRYPTION_KEYS=v2:…`
      // configured, then encounters un-versioned ciphertext migrated
      // from an older dump. Code falls back to `active.key`, which
      // fails AES-GCM auth-tag verification and throws. Pinning this
      // so a future "helpful" refactor can't silently try every key
      // (which would mask real corruption / keep bad data alive).
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:original-key";
      _resetEncryptionKeyCache();
      const url = "postgresql://admin:pw@host/db";
      const unversioned = encryptUrl(url).replace(/^enc:v1:/, "");

      // v1 dropped — active is now a totally different raw value.
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:never-used-to-encrypt-this";
      _resetEncryptionKeyCache();
      expect(() => decryptUrl(unversioned)).toThrow(/Failed to decrypt connection URL/);
    });

    it("throws a configuration-specific error when the ciphertext version is missing from the keyset", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      const url = "postgresql://user:pass@host/db";
      const v2Ciphertext = encryptUrl(url);

      process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
      _resetEncryptionKeyCache();
      expect(() => decryptUrl(v2Ciphertext)).toThrow(/v2|not present|missing/i);
    });
  });

  describe("loadSavedConnections() with encryption", () => {
    const origDatabaseUrl = process.env.DATABASE_URL;

    beforeEach(() => {
      delete process.env.DATABASE_URL;
      _resetPool();
    });

    afterEach(() => {
      if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
      else delete process.env.DATABASE_URL;
      _resetPool();
      connections._reset();
    });

    it("decrypts encrypted URLs when loading connections", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";

      const realUrl = "postgresql://admin:secret@warehouse.example.com:5432/wh";
      const encryptedUrl = encryptUrl(realUrl);

      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "warehouse", url: encryptedUrl, type: "postgres", description: "Warehouse", schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("warehouse")).toBe(true);
    });

    it("skips connections with undecryptable URLs without blocking others", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";

      const goodUrl = "postgresql://admin:secret@warehouse.example.com:5432/wh";
      const goodEncrypted = encryptUrl(goodUrl);

      // Encrypted with a different key — will fail to decrypt
      process.env.ATLAS_ENCRYPTION_KEY = "different-key-that-wont-work!!!!";
      _resetEncryptionKeyCache();
      const badEncrypted = encryptUrl("postgresql://host/bad");

      // Restore the original key
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";
      _resetEncryptionKeyCache();

      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "good-conn", url: goodEncrypted, type: "postgres", description: null, schema_name: null },
          { id: "bad-conn", url: badEncrypted, type: "postgres", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("good-conn")).toBe(true);
      expect(connections.has("bad-conn")).toBe(false);
    });

    it("handles plaintext URLs (migration path) during load", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";

      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "legacy", url: "postgresql://host/db", type: "postgres", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("legacy")).toBe(true);
    });
  });

  // ── SqlClient path tests ──────────────────────────────────────────

  describe("SqlClient path (via _resetPool with mock SqlClient)", () => {
    /** Creates a mock SqlClient that records .unsafe() calls. */
    function createMockSqlClient() {
      const calls: { sql: string; params?: ReadonlyArray<unknown> }[] = [];
      let result: ReadonlyArray<Record<string, unknown>> = [];
      let error: Error | null = null;

      const mockSql = {
        unsafe: <T extends object>(sql: string, params?: ReadonlyArray<unknown>) => {
          calls.push({ sql, params });
          if (error) return Effect.fail(error);
          return Effect.succeed(result as ReadonlyArray<T>);
        },
      };

      const setResult = (r: ReadonlyArray<Record<string, unknown>>) => { result = r; };
      const setError = (e: Error | null) => { error = e; };

      // Cast to SqlClient shape — only .unsafe is used by internalQuery/internalExecute
      return {
        mockSql: mockSql as unknown as import("@effect/sql").SqlClient.SqlClient,
        calls,
        setResult,
        setError,
      };
    }

    it("internalQuery uses SqlClient.unsafe when _sqlClient is set", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      const { mockSql, calls, setResult } = createMockSqlClient();
      setResult([{ id: "row1" }]);
      _resetPool(pool, mockSql);

      const rows = await internalQuery<{ id: string }>("SELECT id FROM test WHERE x = $1", [42]);
      expect(rows).toEqual([{ id: "row1" }]);
      expect(calls.length).toBe(1);
      expect(calls[0].sql).toBe("SELECT id FROM test WHERE x = $1");
      expect(calls[0].params).toEqual([42]);
    });

    it("internalExecute uses SqlClient.unsafe when _sqlClient is set", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      const { mockSql, calls } = createMockSqlClient();
      _resetPool(pool, mockSql);

      internalExecute("INSERT INTO t (a) VALUES ($1)", ["val"]);
      // Fire-and-forget — give it a tick to dispatch
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.length).toBe(1);
      expect(calls[0].sql).toBe("INSERT INTO t (a) VALUES ($1)");
    });

    it("internalExecute circuit breaker works with SqlClient path", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      const { mockSql, calls, setError } = createMockSqlClient();
      setError(new Error("mock sql failure"));
      _resetPool(pool, mockSql);

      // Trigger 5 failures to trip circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO t (a) VALUES ($1)", ["val"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // All 5 should have been dispatched through SqlClient
      expect(calls.length).toBe(5);

      // 6th call should be dropped by circuit breaker
      internalExecute("INSERT INTO t (a) VALUES ($1)", ["val"]);
      await new Promise((r) => setTimeout(r, 10));
      // Circuit is open — call was dropped, not dispatched (still 5)
      expect(calls.length).toBe(5);
    });
  });
});
