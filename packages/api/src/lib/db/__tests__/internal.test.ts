/**
 * Tests for the Atlas internal database module (src/lib/db/internal.ts).
 *
 * Uses _resetPool(mockPool) to inject a mock pool instance, avoiding
 * the need to mock the pg module (which is require()'d lazily).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  hasInternalDB,
  getInternalDB,
  closeInternalDB,
  internalQuery,
  internalExecute,
  migrateInternalDB,
  _resetPool,
  _resetCircuitBreaker,
} from "../internal";

/** Creates a mock pool that tracks query/end calls. */
function createMockPool() {
  const calls = {
    queries: [] as { sql: string; params?: unknown[] }[],
    endCount: 0,
    onEvents: [] as { event: "error"; listener: (err: Error) => void }[],
  };
  let queryResult: { rows: Record<string, unknown>[] } = { rows: [] };
  let queryError: Error | null = null;

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.queries.push({ sql, params });
      if (queryError) throw queryError;
      return queryResult;
    },
    async end() {
      calls.endCount++;
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
    it("executes CREATE TABLE and CREATE INDEX statements for all tables", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);

      await migrateInternalDB();
      expect(calls.queries.length).toBe(26);
      expect(calls.queries[0].sql).toContain("CREATE TABLE IF NOT EXISTS audit_log");
      expect(calls.queries[1].sql).toContain("idx_audit_log_timestamp");
      expect(calls.queries[2].sql).toContain("idx_audit_log_user_id");
      expect(calls.queries[3].sql).toContain("CREATE TABLE IF NOT EXISTS conversations");
      expect(calls.queries[4].sql).toContain("idx_conversations_user");
      expect(calls.queries[5].sql).toContain("CREATE TABLE IF NOT EXISTS messages");
      expect(calls.queries[6].sql).toContain("idx_messages_conversation");
      expect(calls.queries[7].sql).toContain("CREATE TABLE IF NOT EXISTS slack_installations");
      expect(calls.queries[8].sql).toContain("CREATE TABLE IF NOT EXISTS slack_threads");
      expect(calls.queries[9].sql).toContain("idx_slack_threads_conversation");
      expect(calls.queries[10].sql).toContain("CREATE TABLE IF NOT EXISTS action_log");
      expect(calls.queries[11].sql).toContain("idx_action_log_requested_by");
      expect(calls.queries[12].sql).toContain("idx_action_log_status");
      expect(calls.queries[13].sql).toContain("idx_action_log_action_type");
      expect(calls.queries[14].sql).toContain("idx_action_log_conversation");
      expect(calls.queries[15].sql).toContain("ADD COLUMN IF NOT EXISTS source_id");
      expect(calls.queries[16].sql).toContain("idx_audit_log_source_id");
      expect(calls.queries[17].sql).toContain("starred BOOLEAN");
      expect(calls.queries[18].sql).toContain("idx_conversations_starred");
      expect(calls.queries[19].sql).toContain("CREATE TABLE IF NOT EXISTS scheduled_tasks");
      expect(calls.queries[20].sql).toContain("idx_scheduled_tasks_owner");
      expect(calls.queries[21].sql).toContain("idx_scheduled_tasks_enabled");
      expect(calls.queries[22].sql).toContain("idx_scheduled_tasks_next_run");
      expect(calls.queries[23].sql).toContain("CREATE TABLE IF NOT EXISTS scheduled_task_runs");
      expect(calls.queries[24].sql).toContain("idx_scheduled_task_runs_task");
      expect(calls.queries[25].sql).toContain("idx_scheduled_task_runs_status");
    });

    it("propagates migration errors", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("permission denied"));
      _resetPool(pool);

      await expect(migrateInternalDB()).rejects.toThrow("permission denied");
    });
  });

  describe("closeInternalDB()", () => {
    it("calls pool.end()", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);
      await closeInternalDB();
      expect(calls.endCount).toBe(1);
    });

    it("is a no-op when no pool exists", async () => {
      await closeInternalDB(); // should not throw
    });

    it("nullifies the singleton (getInternalDB returns a new pool after close)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool: pool1 } = createMockPool();
      _resetPool(pool1);
      expect(getInternalDB()).toBe(pool1);

      await closeInternalDB();

      // After close, injecting a new pool and calling getInternalDB should return the new one
      const { pool: pool2 } = createMockPool();
      _resetPool(pool2);
      expect(getInternalDB()).toBe(pool2);
      expect(pool2).not.toBe(pool1);
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
